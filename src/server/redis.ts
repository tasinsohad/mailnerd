import Redis, { type RedisOptions } from "ioredis";

// Redis is optional infrastructure for server setup. When it answers, setups run on the durable
// BullMQ queue and their logs stream over pub/sub; when it doesn't, both happen in-process.
//
// "Configured but unreachable" used to be fatal instead. With REDIS_URL pointing at a host that no
// longer exists (a deleted Upstash database), ioredis retries forever, BullMQ's Queue.add() waits
// forever for a "ready" that never comes, and provisionServer hung with no error while the console
// printed the same getaddrinfo ENOTFOUND stack trace on every retry.
//
// Leaf module (only ioredis) so tests can import it without pulling in the SSH/DB stack.

type RedisErrorLike = { code?: string; message?: string };

// The parts of an ioredis client waitForRedis reads, so tests can drive it with an EventEmitter.
export interface RedisStatusSource {
  readonly status: string;
  once(event: "ready" | "error", listener: (...args: unknown[]) => void): unknown;
  off(event: "ready" | "error", listener: (...args: unknown[]) => void): unknown;
}

/** Hostname from a Redis URL, for log lines. Never includes the credentials. */
export function redisHost(url: string): string {
  try {
    return new URL(url).hostname || "(no host in REDIS_URL)";
  } catch {
    return "(unparseable REDIS_URL)";
  }
}

const UNREACHABLE_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);
const FALLBACK_NOTE =
  "Until it is reachable, server setup runs inside the app process and won't survive an app restart.";

export function describeRedisError(err: RedisErrorLike, host: string): string {
  const message = err.message ?? "unknown error";
  if (err.code === "ENOTFOUND") {
    return (
      `REDIS_URL host ${host} does not resolve (ENOTFOUND): this machine is offline, or that Redis no ` +
      `longer exists (a deleted Upstash database fails exactly like this). Fix or remove REDIS_URL. ${FALLBACK_NOTE}`
    );
  }
  if (/WRONGPASS|NOAUTH/.test(message)) {
    return `Redis at ${host} rejected the credentials in REDIS_URL. ${FALLBACK_NOTE}`;
  }
  if (err.code && UNREACHABLE_CODES.has(err.code)) {
    return `Redis at ${host} is unreachable (${err.code}). ${FALLBACK_NOTE}`;
  }
  return `Redis error from ${host}: ${message}`;
}

const REPEAT_AFTER_MS = 5 * 60_000;

// Every retry against a dead host raises the same error again: on the client, and again on each
// BullMQ Queue/Worker sharing it. Log each distinct failure once, with a reminder every five minutes.
export function createRedisErrorLog(host: string, now: () => number = Date.now) {
  const lastLogged = new Map<string, number>();
  return {
    report: (err: RedisErrorLike) => {
      const key = err.code ?? err.message ?? "unknown";
      const at = now();
      const last = lastLogged.get(key);
      if (last !== undefined && at - last < REPEAT_AFTER_MS) return;
      lastLogged.set(key, at);
      console.error(`[redis] ${describeRedisError(err, host)}`);
    },
    // Connected again, so the next failure is news: let it through immediately.
    reset: () => lastLogged.clear(),
  };
}

/**
 * An ioredis client that backs off gently and reports failures once. Also pass `report` to the
 * "error" event of any BullMQ Queue/Worker built on it — without a listener BullMQ prints the raw
 * error itself, on every retry.
 */
export function createRedis(url: string, options: RedisOptions = {}) {
  const host = redisHost(url);
  const errors = createRedisErrorLog(host);
  let failing = false;

  const client = new Redis(url, {
    // Keep retrying (a laptop that dropped off Wi-Fi reports the same ENOTFOUND and should recover
    // without a restart), but back off to one attempt every 30s so a dead host costs next to nothing.
    retryStrategy: (times) => Math.min(times * 1000, 30_000),
    ...options,
  });
  client.on("error", (err) => {
    failing = true;
    errors.report(err);
  });
  client.on("ready", () => {
    if (failing) console.log(`[redis] Reconnected to ${host}.`);
    failing = false;
    errors.reset();
  });

  return { client, report: errors.report };
}

/**
 * Whether the client can take commands, waiting at most `timeoutMs` for a connection attempt still
 * in flight (right after boot). A client already known to be down answers immediately, so requests
 * don't each sit through the timeout while Redis is dead.
 */
export function waitForRedis(client: RedisStatusSource, timeoutMs = 3000): Promise<boolean> {
  if (client.status === "ready") return Promise.resolve(true);
  // "reconnecting": the last attempt failed and it's waiting to retry. "close"/"end": shut down.
  if (client.status === "reconnecting" || client.status === "close" || client.status === "end") {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const finish = (usable: boolean) => {
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
      resolve(usable);
    };
    const onReady = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    client.once("ready", onReady);
    client.once("error", onError);
  });
}
