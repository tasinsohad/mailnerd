import { describe, it, expect } from "vitest";
import {
  isFinalAttempt,
  retryDelayMs,
  runAttempts,
  ServerBusyError,
  isServerBusyError,
  SERVER_BUSY_RECHECK_MS,
} from "../setup-attempts";

// A setup run gets 3 attempts. The last one marks the run failed and frees the domain; earlier ones leave it
// running for the retry. A server busy with another setup isn't a failed attempt.

describe("isFinalAttempt", () => {
  it("is false while attempts remain", () => {
    expect(isFinalAttempt(0, 3)).toBe(false);
    expect(isFinalAttempt(1, 3)).toBe(false);
  });

  it("is true on the last attempt", () => {
    expect(isFinalAttempt(2, 3)).toBe(true);
  });

  it("is true past the limit and for a job without an attempts option (one attempt)", () => {
    expect(isFinalAttempt(5, 3)).toBe(true);
    expect(isFinalAttempt(0, undefined)).toBe(true);
    expect(isFinalAttempt(0, 1)).toBe(true);
  });
});

describe("retryDelayMs", () => {
  it("waits 30 s after the first failure and 60 s after the second, like the queue's backoff", () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
  });
});

describe("isServerBusyError", () => {
  it("recognises the class and a same-named error from another module copy", () => {
    expect(isServerBusyError(new ServerBusyError("1.2.3.4"))).toBe(true);
    const copy = new Error("busy");
    copy.name = "ServerBusyError";
    expect(isServerBusyError(copy)).toBe(true);
    expect(isServerBusyError(new Error("boom"))).toBe(false);
    expect(isServerBusyError("ServerBusyError")).toBe(false);
  });
});

function harness(outcomes: (string | Error)[]) {
  const calls: { attempt: number; finalAttempt: boolean }[] = [];
  const sleeps: number[] = [];
  const retries: number[] = [];
  const busy: number[] = [];
  const run = () =>
    runAttempts({
      attempts: 3,
      run: async (attempt, finalAttempt) => {
        calls.push({ attempt, finalAttempt });
        const next = outcomes.shift();
        if (next === undefined) throw new Error("no outcome left");
        if (next instanceof Error) throw next;
        return next;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onRetry: (failed) => retries.push(failed),
      onServerBusy: (_err, waitMs) => busy.push(waitMs),
    });
  return { run, calls, sleeps, retries, busy };
}

describe("runAttempts", () => {
  it("returns the first attempt's result without waiting", async () => {
    const h = harness(["done"]);
    await expect(h.run()).resolves.toBe("done");
    expect(h.calls).toEqual([{ attempt: 1, finalAttempt: false }]);
    expect(h.sleeps).toEqual([]);
  });

  it("retries a failed attempt after 30 s", async () => {
    const h = harness([new Error("dns down"), "waiting"]);
    await expect(h.run()).resolves.toBe("waiting");
    expect(h.calls.map((c) => c.attempt)).toEqual([1, 2]);
    expect(h.sleeps).toEqual([30_000]);
    expect(h.retries).toEqual([1]);
  });

  it("gives up after 3 attempts, flags only the last as final, and throws its error", async () => {
    const h = harness([new Error("one"), new Error("two"), new Error("three")]);
    await expect(h.run()).rejects.toThrow("three");
    expect(h.calls).toEqual([
      { attempt: 1, finalAttempt: false },
      { attempt: 2, finalAttempt: false },
      { attempt: 3, finalAttempt: true },
    ]);
    expect(h.sleeps).toEqual([30_000, 60_000]);
  });

  it("waits for a busy server without using up an attempt", async () => {
    const h = harness([new ServerBusyError("1.2.3.4"), new ServerBusyError("1.2.3.4"), new Error("x"), "done"]);
    await expect(h.run()).resolves.toBe("done");
    expect(h.calls.map((c) => c.attempt)).toEqual([1, 1, 1, 2]);
    expect(h.sleeps).toEqual([SERVER_BUSY_RECHECK_MS, SERVER_BUSY_RECHECK_MS, 30_000]);
    expect(h.busy).toEqual([SERVER_BUSY_RECHECK_MS, SERVER_BUSY_RECHECK_MS]);
    expect(h.retries).toEqual([1]);
  });

  it("still gets its final attempt after waiting for a busy server on it", async () => {
    const h = harness([new Error("a"), new Error("b"), new ServerBusyError("1.2.3.4"), new Error("c")]);
    await expect(h.run()).rejects.toThrow("c");
    expect(h.calls).toEqual([
      { attempt: 1, finalAttempt: false },
      { attempt: 2, finalAttempt: false },
      { attempt: 3, finalAttempt: true },
      { attempt: 3, finalAttempt: true },
    ]);
  });
});
