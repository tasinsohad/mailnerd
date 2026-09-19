import { describe, it, expect, vi, afterEach } from "vitest";
import {
  claimDomain,
  releaseDomain,
  activeRun,
  busyMessage,
  WAITING_FOR_CHOICE_MESSAGE,
  newClaimOwner,
  claimServer,
  releaseServer,
  serverIpKey,
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

const heldServers: { ip: string; owner: string }[] = [];
function claimSrv(ip: string, owner: string, now?: number) {
  const result = claimServer(ip, owner, now);
  if (result.ok) heldServers.push({ ip, owner });
  return result;
}

afterEach(() => {
  for (const owner of held.splice(0)) releaseDomain("d1", owner);
  for (const { ip, owner } of heldServers.splice(0)) releaseServer(ip, owner);
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

  it("keeps the busy wording for every run kind, and a distinct message for a run waiting for the user", () => {
    const kinds = ["server setup", "mailbox setup", "mailbox count change", "password reset"] as const;
    for (const kind of kinds) expect(busyMessage(kind)).toMatch(/is already running for this domain/);
    expect(WAITING_FOR_CHOICE_MESSAGE).not.toMatch(/is already running for this domain/);
    expect(WAITING_FOR_CHOICE_MESSAGE).toMatch(/waiting for your choice about its server/);
  });
});

// Regression: two Mailcow installs on the same server IP would trample each other, even across
// different domains (each domain has its own domain-lock, but they can share a server).
describe("server run locks", () => {
  it("lets one owner claim a server IP and refuses a second owner with heldBy", () => {
    expect(claimSrv("1.2.3.4", "a")).toEqual({ ok: true });
    expect(claimSrv("1.2.3.4", "b")).toEqual({ ok: false, heldBy: "a" });
  });

  it("lets the same owner re-claim the server", () => {
    expect(claimSrv("1.2.3.4", "a")).toEqual({ ok: true });
    expect(claimSrv("1.2.3.4", "a")).toEqual({ ok: true });
  });

  it("ignores a release from a non-owner", () => {
    claimSrv("1.2.3.4", "a");
    releaseServer("1.2.3.4", "someone-else");
    expect(claimServer("1.2.3.4", "b")).toEqual({ ok: false, heldBy: "a" });
    releaseServer("1.2.3.4", "a");
  });

  it("compares IPs trimmed and lowercased, the same key the other-domains query uses", () => {
    expect(serverIpKey(" Mail.Example.COM ")).toBe("mail.example.com");
    expect(claimSrv("1.2.3.4", "a")).toEqual({ ok: true });
    expect(claimServer(" 1.2.3.4 ", "b")).toEqual({ ok: false, heldBy: "a" });
  });

  it("treats a different IP as independent", () => {
    expect(claimSrv("1.2.3.4", "a")).toEqual({ ok: true });
    expect(claimSrv("5.6.7.8", "b")).toEqual({ ok: true });
  });

  it("treats a claim nobody refreshed for STALE_CLAIM_MS as abandoned", () => {
    const start = Date.now();
    claimSrv("1.2.3.4", "a", start);
    expect(claimServer("1.2.3.4", "b", start + STALE_CLAIM_MS - 1)).toEqual({ ok: false, heldBy: "a" });
    expect(claimSrv("1.2.3.4", "b", start + STALE_CLAIM_MS + 1)).toEqual({ ok: true });
  });
});
