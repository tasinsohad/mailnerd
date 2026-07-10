import Redis from "ioredis";
import { createClient } from "@supabase/supabase-js";
import { users, domains } from "../lib/db/schema";
import { eq } from "drizzle-orm";
import { getDb } from "../lib/db";
import { jobEvents } from "./events";
import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_USER_EMAIL = "admin@smtpforge.local";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";
const supabase = (supabaseUrl && supabaseAnonKey) ? createClient(supabaseUrl, supabaseAnonKey) : null;

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

export default async function sseHandler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "", "http://localhost");
  const domainId = url.searchParams.get("domainId");

  if (!domainId) {
    res.statusCode = 400;
    res.end("Missing domainId");
    return;
  }

  const authHeader = req.headers.authorization;
  const token = url.searchParams.get("token") || authHeader?.replace("Bearer ", "");

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

  let user;
  let domain;

  try {
    const db = getDb();
    user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user) {
      const [newUser] = await db
        .insert(users)
        .values({ email })
        .returning();
      user = newUser;
    }

    domain = await db.query.domains.findFirst({
      where: eq(domains.id, domainId),
    });

    if (!domain || domain.userId !== user.id) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
  } catch (dbErr) {
    console.error("Database check failed in SSE handler:", dbErr);
    if (email !== DEFAULT_USER_EMAIL) {
      res.statusCode = 401;
      res.end("Unauthorized Database Check");
      return;
    }
  }

  // Set up SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();

  const channel = `server-log:${domainId}`;
  
  const send = (data: any) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
    }
  };

  const activeStatus = domain?.status === "provisioning" || domain?.status === "configuring" ? domain.status : undefined;
  send({ msg: "Connected to terminal stream", ...(activeStatus ? { status: activeStatus } : {}) });

  if (domain && domain.terminalLogs) {
    send({ chunk: domain.terminalLogs });
  }

  if (redis) {
    const subscriber = redis.duplicate();

    subscriber.subscribe(channel, (err) => {
      if (err) {
        console.error("Redis subscribe error:", err);
        send({ error: "Failed to subscribe" });
      }
    });

    subscriber.on("message", (ch, message) => {
      if (ch === channel && !res.writableEnded) {
        res.write(`data: ${message}\n\n`);
      }
    });

    req.on("close", () => {
      subscriber.unsubscribe(channel);
      subscriber.quit();
    });
  } else {
    let lastSentLength = domain?.terminalLogs?.length ?? 0;
    
    const listener = (data: any) => send(data);
    jobEvents.on(channel, listener);

    const pollInterval = setInterval(async () => {
      if (res.writableEnded) {
        clearInterval(pollInterval);
        return;
      }
      try {
        const db = getDb();
        const fresh = await db.query.domains.findFirst({
          where: eq(domains.id, domainId),
        });
        if (!fresh) return;

        if (fresh.status === "ready" || fresh.status === "failed") {
          if (fresh.terminalLogs && fresh.terminalLogs.length > lastSentLength) {
            const newChunk = fresh.terminalLogs.slice(lastSentLength);
            send({ chunk: newChunk });
            lastSentLength = fresh.terminalLogs.length;
          }
          send({ status: fresh.status === "ready" ? "Ready" : "Failed" });
          clearInterval(pollInterval);
          return;
        }

        if (fresh.terminalLogs && fresh.terminalLogs.length > lastSentLength) {
          const newChunk = fresh.terminalLogs.slice(lastSentLength);
          lastSentLength = fresh.terminalLogs.length;
          send({ chunk: newChunk });
        }
      } catch (err) {
        console.error("SSE poll error:", err);
      }
    }, 3000);

    req.on("close", () => {
      clearInterval(pollInterval);
      jobEvents.off(channel, listener);
    });
  }
}
