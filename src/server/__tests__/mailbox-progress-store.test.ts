import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMailboxProgressWriter, UPDATE_INTERVAL_MS } from "../mailbox-progress-store";
import type { MailboxProgress } from "@/lib/mailbox-progress";

// The writer throttles progress writes to one per 2 s without losing the last count, lands them in order,
// always lands `finish` last, and never throws into the mailbox run.

type Write = { progress: MailboxProgress; land: () => void; fail: (err: unknown) => void };

// A db whose writes stay in flight until the test lands them (or `auto` lands them at once).
function fakeDb(opts: { auto?: boolean; throwSync?: boolean } = {}) {
  const started: Write[] = [];
  const landed: MailboxProgress[] = [];
  const db = {
    update: () => ({
      set: (values: { mailboxProgress: MailboxProgress }) => ({
        where: () => {
          if (opts.throwSync) throw new Error("db is down");
          return new Promise<void>((resolve, reject) => {
            const write: Write = {
              progress: values.mailboxProgress,
              land: () => {
                landed.push(values.mailboxProgress);
                resolve();
              },
              fail: reject,
            };
            started.push(write);
            if (opts.auto) write.land();
          });
        },
      }),
    }),
  };
  return { db, started, landed };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createMailboxProgressWriter", () => {
  it("writes the first update at once and a throttled one within the interval (trailing write)", async () => {
    const { db, landed } = fakeDb({ auto: true });
    const w = createMailboxProgressWriter(db, "dom-1", 10);

    await vi.advanceTimersByTimeAsync(1000);
    w.update(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(landed.map((p) => p.done)).toEqual([1]);

    await vi.advanceTimersByTimeAsync(500);
    w.update(2);
    w.update(3); // both inside the interval: only the newest count is kept
    await vi.advanceTimersByTimeAsync(0);
    expect(landed.map((p) => p.done)).toEqual([1]);

    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS - 500);
    expect(landed.map((p) => p.done)).toEqual([1, 3]);
    expect(landed[1].secondsPerMailbox).toBeCloseTo(1); // 2 mailboxes in 2 s
  });

  it("lands writes in the order they were made, one at a time", async () => {
    const { db, started, landed } = fakeDb();
    const w = createMailboxProgressWriter(db, "dom-1", 10);

    w.update(1);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    w.update(2);
    await vi.advanceTimersByTimeAsync(0);
    // The second write waits for the first to land.
    expect(started.map((s) => s.progress.done)).toEqual([1]);

    started[0].land();
    await vi.advanceTimersByTimeAsync(0);
    expect(started.map((s) => s.progress.done)).toEqual([1, 2]);
    started[1].land();
    await w.settled();
    expect(landed.map((p) => p.done)).toEqual([1, 2]);
  });

  it("always lands finish last, drops a pending trailing write and ignores later updates", async () => {
    const { db, started, landed } = fakeDb();
    const w = createMailboxProgressWriter(db, "dom-1", 10);

    w.update(4); // in flight (slow)
    w.update(6); // throttled: trailing write pending
    let finished = false;
    const done = w.finish(9, 1).then(() => {
      finished = true;
    });
    w.update(7); // after finish: ignored
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 2);

    expect(started.map((s) => s.progress.done)).toEqual([4]);
    expect(finished).toBe(false);
    started[0].land();
    await vi.advanceTimersByTimeAsync(0);
    started[1].land();
    await done;

    expect(finished).toBe(true);
    expect(landed.map((p) => [p.done, p.failed])).toEqual([
      [4, 0],
      [9, 1],
    ]);
    expect(landed[1].finishedAt).not.toBeNull();
    // A second finish writes nothing more.
    await w.finish(9, 1);
    expect(started).toHaveLength(2);
  });

  it("skips a write when the count didn't change", async () => {
    const { db, landed } = fakeDb({ auto: true });
    const w = createMailboxProgressWriter(db, "dom-1", 10);
    w.update(2);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    w.update(2);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(landed.map((p) => p.done)).toEqual([2]);
  });

  it("never throws or rejects when the database fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const sync = fakeDb({ throwSync: true });
    const a = createMailboxProgressWriter(sync.db, "dom-1", 10);
    expect(() => a.update(1)).not.toThrow();
    await expect(a.finish(1, 0)).resolves.toBeUndefined();

    const async = fakeDb();
    const b = createMailboxProgressWriter(async.db, "dom-2", 10);
    b.update(1);
    await vi.advanceTimersByTimeAsync(0);
    async.started[0].fail(new Error("timeout"));
    const finish = b.finish(2, 0);
    await vi.advanceTimersByTimeAsync(0);
    async.started[1].land();
    await expect(finish).resolves.toBeUndefined();
    expect(async.landed.map((p) => p.done)).toEqual([2]);

    expect(errors).toHaveBeenCalled();
  });
});
