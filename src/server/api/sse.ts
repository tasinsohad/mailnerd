import { defineEventHandler, getQuery, getHeader } from "h3";
import Redis from "ioredis";
import { createClient } from "@supabase/supabase-js";
import { users, domains } from "../../lib/db/schema";
import { eq } from "drizzle-orm";
import { getDb } from "../../lib/db";
import { jobEvents } from "../events";

const DEFAULT_USER_EMAIL = "admin@smtpforge.local";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";
const supabase = (supabaseUrl && supabaseAnonKey) ? createClient(supabaseUrl, supabaseAnonKey) : null;

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const domainId = query.domainId as string;

  if (!domainId) {
    return new Response("Missing domainId", { status: 400 });
  }

  // Retrieve token from Authorization header or URL query parameter
  const authHeader = getHeader(event, "authorization");
  const token = (query.token as string) || authHeader?.replace("Bearer ", "");

  let email = DEFAULT_USER_EMAIL;

  if (token && token !== "mock-token" && supabase) {
    try {
      const {
        data: { user: supabaseUser },
        error,
      } = await supabase.auth.getUser(token);

      if (!error && supabaseUser?.email) {
        email = supabaseUser.email;
      }
    } catch (err) {
      console.warn("Supabase token verification failed, falling back to local credentials:", err);
    }
  }

  // Get database connection and verify user owns this domain
  let user;
  let domain;

  try {
    const db = getDb();
    user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user) {
      // Seed user locally if database is empty/starting up
      const [newUser] = await db
        .insert(users)
        .values({ email })
        .returning();
      user = newUser;
    }

    // Verify the domain belongs to the user
    domain = await db.query.domains.findFirst({
      where: eq(domains.id, domainId),
    });

    if (!domain || domain.userId !== user.id) {
      return new Response("Forbidden", { status: 403 });
    }
  } catch (dbErr) {
    console.error("Database check failed in SSE handler:", dbErr);
    // Continue in local mode if DB is disconnected/mocking
    if (email !== DEFAULT_USER_EMAIL) {
      return new Response("Unauthorized Database Check", { status: 401 });
    }
  }

  const res = (event as any).node?.res;
  if (!res) return new Response("SSE not supported", { status: 500 });

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const channel = `server-log:${domainId}`;

  // Send initial connection message — only relay status if it's an active provisioning state
  const activeStatus = domain?.status === "provisioning" || domain?.status === "configuring" ? domain.status : undefined;
  res.write(`data: ${JSON.stringify({ msg: "Connected to terminal stream", ...(activeStatus ? { status: activeStatus } : {}) })}\n\n`);

  // Send existing terminal logs so late-connecting clients (page refresh, retry) see full history
  // Only skip for 'failed' status when there are no logs (clean retry scenario)
  if (domain && domain.terminalLogs) {
    res.write(`data: ${JSON.stringify({ chunk: domain.terminalLogs })}\n\n`);
  }

  if (redis) {
    const subscriber = redis.duplicate();

    subscriber.subscribe(channel, (err) => {
      if (err) {
        console.error("Redis subscribe error:", err);
        res.write(`data: ${JSON.stringify({ error: "Failed to subscribe" })}\n\n`);
      }
    });

    subscriber.on("message", (ch, message) => {
      if (ch === channel) {
        res.write(`data: ${message}\n\n`);
      }
    });

    // Handle client disconnect
    const req = (event as any).node?.req;
    if (req) {
      req.on("close", () => {
        subscriber.unsubscribe(channel);
        subscriber.quit();
      });
    }
  } else {
    // In-memory fallback: listen to jobEvents AND poll DB every 3s as a safety net
    // This ensures logs are never lost even if the browser connected after events fired
    let lastSentLength = domain?.terminalLogs?.length ?? 0;
    let closed = false;

    const listener = (data: any) => {
      if (!closed) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    jobEvents.on(channel, listener);

    // Poll DB every 3 seconds for new log content (catches anything jobEvents missed)
    const pollInterval = setInterval(async () => {
      if (closed) return;
      try {
        const db = getDb();
        const fresh = await db.query.domains.findFirst({
          where: eq(domains.id, domainId),
        });
        if (!fresh) return;

        // If domain finished or failed, notify client and stop polling
        if (fresh.status === "ready" || fresh.status === "failed") {
          if (fresh.terminalLogs && fresh.terminalLogs.length > lastSentLength) {
            const newChunk = fresh.terminalLogs.slice(lastSentLength);
            res.write(`data: ${JSON.stringify({ chunk: newChunk })}\n\n`);
            lastSentLength = fresh.terminalLogs.length;
          }
          res.write(`data: ${JSON.stringify({ status: fresh.status === "ready" ? "Ready" : "Failed" })}\n\n`);
          clearInterval(pollInterval);
          return;
        }

        // Send any new log content that wasn't delivered via jobEvents
        if (fresh.terminalLogs && fresh.terminalLogs.length > lastSentLength) {
          const newChunk = fresh.terminalLogs.slice(lastSentLength);
          lastSentLength = fresh.terminalLogs.length;
          res.write(`data: ${JSON.stringify({ chunk: newChunk })}\n\n`);
        }
      } catch (err) {
        console.error("SSE poll error:", err);
      }
    }, 3000);

    // Handle client disconnect
    const req = (event as any).node?.req;
    if (req) {
      req.on("close", () => {
        closed = true;
        clearInterval(pollInterval);
        jobEvents.off(channel, listener);
      });
    }
  }
});
