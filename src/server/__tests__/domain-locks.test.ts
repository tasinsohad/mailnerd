import { describe, it, expect, vi, afterEach } from "vitest";
import {
  claimDomain,
  releaseDomain,
  activeRun,
  busyMessage,
  newClaimOwner,
  STALE_CLAIM_MS,
} from "../domain-locks";

// Regression: dentimaxfirst.com had three server setups started within 11 minutes, two of them running
// at once. Each re-installs Mailcow, so they trampled each other's mailboxes and logs.

const held: string[] = [];
function claim(kind: Parameters<typeof claimDomain>[1], owner = newClaimOwner(), now?: number) {
  const result = claimDomain("d1", kind, owner, now);
  if (result.ok) held.push(owner);
  return result;
}

afterEach(() => {
  for (const owner of held.splice(0)) releaseDomain("d1", owner);
});

describe("domain run locks", () => {
  it("lets one run claim a domain and refuses any other while it's held", () => {
    expect(claim("server setup", "a")).toEqual({ ok: true, owner: "a" });
    expect(claim("mailbox setup", "b")).toEqual({ ok: false, running: "server setup" });
    expect(claim("server setup", "c")).toEqual({ ok: false, running: "server setup" });
    expect(activeRun("d1")).toBe("server setup");
  });

  it("lets the owner claim again, so a queued job keeps its domain across retries and restarts", () => {
    expect(claim("server setup", "job-1")).toEqual({ ok: true, owner: "job-1" });
    expect(claim("server setup", "job-1")).toEqual({ ok: true, owner: "job-1" });
  });

  it("frees the domain only when the owner releases it", () => {
    claim("mailbox setup", "a");
    releaseDomain("d1", "someone-else");
    expect(activeRun("d1")).toBe("mailbox setup");
    releaseDomain("d1", "a");
    expect(activeRun("d1")).toBeUndefined();
    expect(claim("server setup")).toMatchObject({ ok: true });
  });

  it("treats a claim nobody refreshed for STALE_CLAIM_MS as abandoned", () => {
    const start = Date.now();
    claim("mailbox setup", "a", start);
    expect(claim("server setup", "b", start + STALE_CLAIM_MS - 1)).toEqual({ ok: false, running: "mailbox setup" });
    expect(claim("server setup", "b", start + STALE_CLAIM_MS + 1)).toEqual({ ok: true, owner: "b" });
  });

  it("gives every run its own owner id", () => {
    expect(newClaimOwner()).not.toBe(newClaimOwner());
  });

  it("keeps claims across module re-instantiation (server functions and the worker load separately)", async () => {
    claim("server setup", "a");
    vi.resetModules();
    const again = await import("../domain-locks");
    expect(again.activeRun("d1")).toBe("server setup");
  });

  it("says what's already running", () => {
    expect(busyMessage("server setup")).toMatch(/server setup is already running/i);
    expect(busyMessage("mailbox setup")).toMatch(/mailbox setup is already running/i);
  });
});
