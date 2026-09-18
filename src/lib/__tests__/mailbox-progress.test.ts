import { describe, it, expect } from "vitest";
import { finishProgress, formatEta, newMailboxProgress, progressPercent, recordProgress, secondsLeft } from "../mailbox-progress";

const T0 = Date.UTC(2026, 8, 18, 10, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

describe("mailbox progress", () => {
  it("starts at 0% with no estimate yet", () => {
    const p = newMailboxProgress(100, iso(T0));
    expect(progressPercent(p)).toBe(0);
    expect(secondsLeft(p)).toBeNull();
    expect(formatEta(secondsLeft(p))).toBe("estimating time left…");
  });

  it("measures seconds per mailbox and projects the rest", () => {
    let p = newMailboxProgress(100, iso(T0));
    p = recordProgress(p, 10, T0 + 20_000); // 10 mailboxes in 20 s → 2 s each
    expect(p.secondsPerMailbox).toBeCloseTo(2);
    expect(progressPercent(p)).toBe(10);
    expect(secondsLeft(p)).toBeCloseTo(180); // 90 left × 2 s
  });

  it("smooths the rate so one slow mailbox doesn't swing the estimate", () => {
    let p = newMailboxProgress(100, iso(T0));
    p = recordProgress(p, 10, T0 + 20_000); // 2 s each
    p = recordProgress(p, 11, T0 + 30_000); // one took 10 s
    expect(p.secondsPerMailbox).toBeGreaterThan(2);
    expect(p.secondsPerMailbox).toBeLessThan(10);
  });

  it("ignores an update with no new mailboxes", () => {
    const p = recordProgress(newMailboxProgress(10, iso(T0)), 0, T0 + 5_000);
    expect(p.secondsPerMailbox).toBeNull();
  });

  it("finishes at 100% with nothing left", () => {
    const p = finishProgress(newMailboxProgress(10, iso(T0)), 9, 1, iso(T0 + 60_000));
    expect(progressPercent(p)).toBe(100);
    expect(secondsLeft(p)).toBe(0);
    expect(p).toMatchObject({ done: 9, failed: 1 });
  });

  it("treats an empty run as complete", () => {
    expect(progressPercent(newMailboxProgress(0, iso(T0)))).toBe(100);
  });

  it("formats the time left", () => {
    expect(formatEta(0)).toBe("finishing…");
    expect(formatEta(40)).toBe("under a minute left");
    expect(formatEta(6 * 60 + 10)).toBe("about 6 min left");
    expect(formatEta(80 * 60)).toBe("about 1 h 20 min left");
  });
});
