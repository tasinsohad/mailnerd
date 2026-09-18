import { domains } from "../lib/db/schema";
import { eq } from "drizzle-orm";
import { getDb } from "../lib/db";
import { jobEvents, inProcessProvisions } from "./events";
import { createRedis, waitForRedis } from "./redis";
import { consoleChannel } from "./console-bus";
import { readAuthConfig, readCookie, SESSION_COOKIE } from "./auth-core";
import { resolveSession, WORKSPACE_COOKIE } from "./accounts-db";
import type { IncomingMessage, ServerResponse } from "node:http";

// Live console for an ad-hoc troubleshoot run. Not tied to a domain — the runId is an
// unguessable UUID the client generates, so it can subscribe before starting the run.
function streamConsole(runId: string, req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const channel = consoleChannel(runId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const send = (data: any) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (res as any).flush === "function") (res as any).flush();
  };

  send({ kind: "info", text: "Console connected." });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listener = (data: any) => send(data);
  jobEvents.on(channel, listener);

  // Proxies drop idle event streams; a comment line keeps it open without emitting an event.
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    jobEvents.off(channel, listener);
  });
}

const redis = process.env.REDIS_URL ? createRedis(process.env.REDIS_URL) : null;

export default async function sseHandler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "", "http://localhost");

  // The same session check every server function makes (requireAuth): these streams carry server output and
  // setup logs. EventSource sends the session cookie by itself on same-site requests.
  const auth = readAuthConfig(process.env);
  let workspaceId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  try {
    db = getDb();
    const session = auth.ok
      ? await resolveSession(
          db,
          readCookie(req.headers.cookie, SESSION_COOKIE),
          readCookie(req.headers.cookie, WORKSPACE_COOKIE),
          auth.config,
        )
      : ({ state: "signed-out" } as const);
    if (session.state !== "ok") {
      res.statusCode = session.state === "locked" ? 403 : 401;
      res.end(session.state === "locked" ? "Account locked" : "Sign in required");
      return;
    }
    workspaceId = session.workspaceId;
  } catch (dbErr) {
    console.error("Session check failed in SSE handler:", dbErr);
    if (!res.headersSent && !res.destroyed) {
      res.statusCode = 503;
      res.end("Database unavailable");
    }
    return;
  }

  // Troubleshoot console stream — no domain involved (the runId is an unguessable UUID the client made).
  const runId = url.searchParams.get("runId");
  if (runId) {
    streamConsole(runId, req, res);
    return;
  }

  const domainId = url.searchParams.get("domainId");
  if (!domainId) {
    res.statusCode = 400;
    res.end("Missing domainId or runId");
    return;
  }

  let domain;
  try {
    domain = await db.query.domains.findFirst({ where: eq(domains.id, domainId) });
  } catch (dbErr) {
    console.error("Domain lookup failed in SSE handler:", dbErr);
    if (!res.headersSent && !res.destroyed) {
      res.statusCode = 503;
      res.end("Database unavailable");
    }
    return;
  }
  // Only the workspace this session is in: a user's own domains, or the workspace the admin opened.
  if (!domain || domain.userId !== workspaceId) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  // This domain's live logs arrive over Redis pub/sub only when its setup runs on the BullMQ queue,
  // which needs Redis to be answering. A setup running in-process (Redis was down when it started)
  // emits on jobEvents instead, so subscribing to Redis then would leave the terminal silent.
  const useRedis =
    !!redis && !inProcessProvisions.has(domainId) && (await waitForRedis(redis.client, 1000));

  // The browser may have closed the stream during the lookups above (page left, tab closed). Writing
  // headers to that response would throw ERR_HTTP_HEADERS_SENT.
  if (res.destroyed || res.headersSent || res.writableEnded) return;

  // Set up SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const channel = `server-log:${domainId}`;

  const send = (data: any) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (typeof (res as any).flush === "function") {
        (res as any).flush();
      }
    }
  };

  const activeStatus =
    domain?.status === "provisioning" || domain?.status === "configuring"
      ? domain.status
      : undefined;
  send({ msg: "Connected to terminal stream", ...(activeStatus ? { status: activeStatus } : {}) });

  if (domain && domain.terminalLogs) {
    send({ chunk: domain.terminalLogs });
  }

  if (redis && useRedis) {
    const subscriber = redis.client.duplicate();
    // duplicate() copies options, not listeners: without this a Redis blip mid-stream prints raw errors.
    subscriber.on("error", redis.report);

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
