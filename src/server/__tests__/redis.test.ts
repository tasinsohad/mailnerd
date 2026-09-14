import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { waitForRedis, describeRedisError, createRedisErrorLog, redisHost } from "../redis";

// Regression tests for server setup hanging forever when REDIS_URL pointed at a deleted Upstash
// database: BullMQ's Queue.add() waited on a "ready" that never came, and ioredis printed the same
// getaddrinfo ENOTFOUND stack trace on every retry.

function fakeClient(status: string) {
  return Object.assign(new EventEmitter(), { status });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("waitForRedis", () => {
  it("answers true at once when the client is ready", async () => {
    await expect(waitForRedis(fakeClient("ready"))).resolves.toBe(true);
  });

  it("answers false at once, without waiting out the timeout, when the client is known down", async () => {
    vi.useFakeTimers(); // a timer-based answer would never resolve here
    for (const status of ["reconnecting", "close", "end"]) {
      await expect(waitForRedis(fakeClient(status))).resolves.toBe(false);
    }
  });

  it("waits for an in-flight connection that becomes ready", async () => {
    const client = fakeClient("connecting");
    const result = waitForRedis(client, 5000);
    client.emit("ready");
    await expect(result).resolves.toBe(true);
  });

  it("answers false when the in-flight connection errors (e.g. ENOTFOUND)", async () => {
    const client = fakeClient("connecting");
    const result = waitForRedis(client, 5000);
    client.emit("error", Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" }));
    await expect(result).resolves.toBe(false);
  });

  it("gives up after the timeout and removes its listeners", async () => {
    vi.useFakeTimers();
    const client = fakeClient("connecting");
    const result = waitForRedis(client, 3000);
    vi.advanceTimersByTime(3000);
    await expect(result).resolves.toBe(false);
    expect(client.listenerCount("ready")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
  });
});

describe("redisHost", () => {
  it("returns only the hostname, never the credentials in the URL", () => {
    expect(redisHost("rediss://default:not-a-real-password@example-db-12345.upstash.io:6379")).toBe(
      "example-db-12345.upstash.io",
    );
  });

  it("does not throw on a malformed URL", () => {
    expect(() => redisHost("not a url")).not.toThrow();
  });
});

describe("describeRedisError", () => {
  const host = "example-db-12345.upstash.io";

  it("explains ENOTFOUND as a missing host and points at REDIS_URL", () => {
    const text = describeRedisError({ code: "ENOTFOUND", message: `getaddrinfo ENOTFOUND ${host}` }, host);
    expect(text).toContain(host);
    expect(text).toContain("REDIS_URL");
    expect(text).toMatch(/offline|no longer exists/);
  });

  it("recognises rejected credentials", () => {
    const text = describeRedisError({ message: "WRONGPASS invalid username-password pair" }, host);
    expect(text).toMatch(/credentials/);
  });

  it("recognises other network failures", () => {
    expect(describeRedisError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" }, host)).toMatch(
      /unreachable \(ECONNREFUSED\)/,
    );
  });

  it("passes unrelated errors through verbatim", () => {
    expect(describeRedisError({ message: "ERR unknown command" }, host)).toContain("ERR unknown command");
  });
});

describe("createRedisErrorLog", () => {
  const enotfound = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND h" };

  it("logs a failure once, then stays quiet while every retry repeats it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let now = 0;
    const log = createRedisErrorLog("h", () => now);

    log.report(enotfound);
    for (let i = 0; i < 20; i++) {
      now += 2000;
      log.report(enotfound);
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reminds again after five minutes of the same failure", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let now = 0;
    const log = createRedisErrorLog("h", () => now);

    log.report(enotfound);
    now += 5 * 60_000;
    log.report(enotfound);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("logs a different failure immediately", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createRedisErrorLog("h", () => 0);

    log.report(enotfound);
    log.report({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("lets the same failure through again after a reset (Redis came back, then dropped)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createRedisErrorLog("h", () => 0);

    log.report(enotfound);
    log.reset();
    log.report(enotfound);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
