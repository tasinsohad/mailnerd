import { describe, it, expect } from "vitest";
import {
  FOREIGN_MAIL_DOMAIN,
  OTHER_ACCOUNT_DOMAIN,
  foreignMailDomains,
  isOwnUnfinishedInstall,
  otherDomainsOnServer,
  serverDecision,
  runDomainSetup,
  type ServerInspection,
  type SetupDeps,
} from "../domain-setup-core";
import { newSetupState, mergeSetupState, type SetupState, type SetupStep } from "../../lib/setup-state";

// The rule for what to do with a server that already runs Mailcow: wiping it deletes every mailbox on
// it, so that only happens when the user chose it, or when the only Mailcow there is this domain's own
// unfinished install (nothing else to lose).

function inspection(overrides: Partial<ServerInspection> = {}): ServerInspection {
  return {
    hasMailcow: true,
    hostname: "mail.example.com",
    otherDomainsOnServer: [],
    ownInstallComplete: false,
    ownUnfinishedInstall: false,
    ...overrides,
  };
}

describe("serverDecision", () => {
  it("installs when the server has no Mailcow", () => {
    expect(serverDecision(inspection({ hasMailcow: false }), null)).toBe("install");
  });

  it("installs when the user chose reinstall, regardless of inspection", () => {
    expect(serverDecision(inspection({ ownInstallComplete: true }), "reinstall")).toBe("install");
  });

  it("reuses when the user chose reuse", () => {
    expect(serverDecision(inspection({ otherDomainsOnServer: ["other.com"] }), "reuse")).toBe("reuse");
  });

  it("reuses when this domain's own install already completed", () => {
    expect(serverDecision(inspection({ ownInstallComplete: true }), null)).toBe("reuse");
  });

  it("installs when this domain's own unfinished install is the only thing on the server", () => {
    expect(
      serverDecision(inspection({ ownUnfinishedInstall: true, otherDomainsOnServer: [] }), null),
    ).toBe("install");
  });

  it("asks when this domain's own unfinished install shares the server with other domains", () => {
    expect(
      serverDecision(inspection({ ownUnfinishedInstall: true, otherDomainsOnServer: ["other.com"] }), null),
    ).toBe("ask");
  });

  it("asks about a foreign Mailcow that isn't this domain's own install", () => {
    expect(serverDecision(inspection(), null)).toBe("ask");
  });

  it("never reinstalls without asking while the domain has live mailboxes", () => {
    expect(
      serverDecision(inspection({ ownUnfinishedInstall: true, activeMailboxes: 3 }), null),
    ).toBe("ask");
    // The user's explicit choice still wins.
    expect(
      serverDecision(inspection({ ownUnfinishedInstall: true, activeMailboxes: 3 }), "reinstall"),
    ).toBe("install");
  });

  it("asks when the server's Mailcow serves mail domains no app domain accounts for", () => {
    const sharing = otherDomainsOnServer({
      userId: "u1",
      domainName: "example.com",
      others: [],
      mailDomains: ["example.com", "sales.example.com", "someone-else.net"],
    });
    expect(sharing).toEqual([FOREIGN_MAIL_DOMAIN]);
    expect(
      serverDecision(inspection({ ownUnfinishedInstall: true, otherDomainsOnServer: sharing }), null),
    ).toBe("ask");
  });
});

describe("isOwnUnfinishedInstall", () => {
  it("is this domain's unfinished install when it isn't ready, the host matches and no mailbox is live", () => {
    expect(isOwnUnfinishedInstall({ domainReady: false, hostMatches: true, activeMailboxes: 0 })).toBe(true);
  });

  it("isn't when the domain has live mailboxes (a failed or provisioning legacy domain with a working Mailcow)", () => {
    expect(isOwnUnfinishedInstall({ domainReady: false, hostMatches: true, activeMailboxes: 1 })).toBe(false);
  });

  it("isn't when the domain is ready or the server's host name isn't this domain's", () => {
    expect(isOwnUnfinishedInstall({ domainReady: true, hostMatches: true, activeMailboxes: 0 })).toBe(false);
    expect(isOwnUnfinishedInstall({ domainReady: false, hostMatches: false, activeMailboxes: 0 })).toBe(false);
  });
});

describe("foreignMailDomains", () => {
  it("ignores the domain itself and its subdomains, in any case and with a trailing dot", () => {
    expect(foreignMailDomains(["Example.com", "a.example.com.", "b.a.EXAMPLE.com"], "example.com")).toEqual([]);
  });

  it("returns mail domains that belong to neither this domain nor a known one", () => {
    expect(
      foreignMailDomains(["x.example.com", "notexample.com", "mail.other.io", "third.org"], "example.com", [
        "other.io",
      ]),
    ).toEqual(["notexample.com", "third.org"]);
  });
});

describe("otherDomainsOnServer", () => {
  it("names the owner's other domains, hides other accounts' names, and skips the Mailcow check when unread", () => {
    expect(
      otherDomainsOnServer({
        userId: "u1",
        domainName: "example.com",
        others: [
          { name: "mine.com", userId: "u1", installed: true },
          { name: "theirs.com", userId: "u2", installed: true },
        ],
        mailDomains: null,
      }),
    ).toEqual(["mine.com", OTHER_ACCOUNT_DOMAIN]);
  });

  it("counts only other domains that were installed (a new job's domains on the same fresh server don't)", () => {
    expect(
      otherDomainsOnServer({
        userId: "u1",
        domainName: "example.com",
        others: [
          { name: "new1.com", userId: "u1", installed: false },
          { name: "new2.com", userId: "u2", installed: false },
          { name: "live.com", userId: "u1", installed: true },
        ],
        mailDomains: null,
      }),
    ).toEqual(["live.com"]);
    expect(
      otherDomainsOnServer({
        userId: "u1",
        domainName: "example.com",
        others: [{ name: "new1.com", userId: "u1", installed: false }],
        mailDomains: [],
      }),
    ).toEqual([]);
  });

  it("still flags an uninstalled domain's mail domains that are on the server's Mailcow", () => {
    expect(
      otherDomainsOnServer({
        userId: "u1",
        domainName: "example.com",
        others: [{ name: "legacy.com", userId: "u1", installed: false }],
        mailDomains: ["a.legacy.com"],
      }),
    ).toEqual([FOREIGN_MAIL_DOMAIN]);
  });

  it("doesn't flag mail domains that belong to the other app domains on the server", () => {
    expect(
      otherDomainsOnServer({
        userId: "u1",
        domainName: "example.com",
        others: [{ name: "mine.com", userId: "u1", installed: true }],
        mailDomains: ["a.example.com", "b.mine.com"],
      }),
    ).toEqual(["mine.com"]);
  });

  it("is empty for a server with only this domain's mail domains", () => {
    expect(
      otherDomainsOnServer({ userId: "u1", domainName: "example.com", others: [], mailDomains: ["a.example.com"] }),
    ).toEqual([]);
  });
});

// --- runDomainSetup, driven by an in-memory fake SetupDeps ---

interface FakeOpts {
  hasMailcow?: boolean;
  hostname?: string | null;
  otherDomainsOnServer?: string[];
  ownInstallComplete?: boolean;
  ownUnfinishedInstall?: boolean;
  ip?: string;
  mailboxResult?: { created: number; failed: number; total: number };
  /** dns() throws this error, but only on its first-ever call across the life of this fake. */
  dnsFailsOnce?: Error;
  /** dns() throws this error every time it's called. */
  dnsAlwaysFails?: Error;
}

function makeFake(initial: SetupState, opts: FakeOpts = {}) {
  let state = initial;
  const calls: string[] = [];
  let dnsCalls = 0;

  const deps: SetupDeps = {
    async load() {
      return state;
    },
    async save(patch) {
      state = mergeSetupState(state, patch, new Date().toISOString());
      return state;
    },
    log() {
      // no-op; logging isn't asserted on
    },
    async dns() {
      calls.push("dns");
      dnsCalls++;
      if (opts.dnsAlwaysFails) throw opts.dnsAlwaysFails;
      if (opts.dnsFailsOnce && dnsCalls === 1) throw opts.dnsFailsOnce;
    },
    async inspectServer() {
      calls.push("inspectServer");
      return {
        ip: opts.ip ?? "1.2.3.4",
        hasMailcow: opts.hasMailcow ?? false,
        hostname: opts.hostname ?? null,
        otherDomainsOnServer: opts.otherDomainsOnServer ?? [],
        ownInstallComplete: opts.ownInstallComplete ?? false,
        ownUnfinishedInstall: opts.ownUnfinishedInstall ?? false,
      };
    },
    async install() {
      calls.push("install");
    },
    async reuse() {
      calls.push("reuse");
    },
    async mailboxes() {
      calls.push("mailboxes");
      return opts.mailboxResult ?? { created: 10, failed: 0, total: 10 };
    },
    async dkim() {
      calls.push("dkim");
    },
  };

  return { deps, calls, getState: () => state };
}

function freshState(opts: { fromStep?: SetupStep; serverChoice?: "reuse" | "reinstall" | null } = {}): SetupState {
  return newSetupState("run-1", "2026-09-18T00:00:00.000Z", opts);
}

describe("runDomainSetup", () => {
  it("runs dns, inspectServer, install, mailboxes, dkim in order from a fresh state", async () => {
    const { deps, calls, getState } = makeFake(freshState(), { hasMailcow: false });

    const result = await runDomainSetup(deps);

    expect(result).toBe("done");
    expect(calls).toEqual(["dns", "inspectServer", "install", "mailboxes", "dkim"]);
    const state = getState();
    expect(state.steps).toEqual({ dns: "done", server: "done", mailboxes: "done", dkim: "done" });
    expect(state.status).toBe("done");
    expect(state.finishedAt).not.toBeNull();
  });

  it("stamps stepStartedAt in the save that marks each step running", async () => {
    const { deps, getState } = makeFake(freshState(), { hasMailcow: false });
    const startsRunning: Partial<SetupState>[] = [];
    const save = deps.save;
    deps.save = async (patch) => {
      if (patch.step && patch.steps?.[patch.step] === "running") startsRunning.push(patch);
      return save(patch);
    };
    const before = Date.now();

    await runDomainSetup(deps);

    expect(startsRunning.map((p) => p.step)).toEqual(["dns", "server", "mailboxes", "dkim"]);
    for (const patch of startsRunning) {
      expect(typeof patch.stepStartedAt).toBe("string");
      const ms = Date.parse(patch.stepStartedAt as string);
      expect(ms).toBeGreaterThanOrEqual(before);
      expect(ms).toBeLessThanOrEqual(Date.now());
    }
    expect(getState().stepStartedAt).toBe(startsRunning[3].stepStartedAt);
  });

  it("only runs mailboxes and dkim when dns and server are already done", async () => {
    const { deps, calls } = makeFake(freshState({ fromStep: "mailboxes" }), { hasMailcow: false });

    const result = await runDomainSetup(deps);

    expect(result).toBe("done");
    expect(calls).toEqual(["mailboxes", "dkim"]);
  });

  it("waits for a server choice when Mailcow is already there and no choice was made", async () => {
    const { deps, calls, getState } = makeFake(freshState(), {
      hasMailcow: true,
      hostname: "mail.other.com",
      otherDomainsOnServer: ["other.com"],
      ip: "9.9.9.9",
    });

    const result = await runDomainSetup(deps);

    expect(result).toBe("waiting");
    const state = getState();
    expect(state.status).toBe("waiting");
    expect(state.waiting).toEqual({
      kind: "server-choice",
      ip: "9.9.9.9",
      hostname: "mail.other.com",
      otherDomains: ["other.com"],
    });
    expect(state.steps.server).toBe("pending");
    expect(calls).not.toContain("mailboxes");
    expect(calls).not.toContain("install");
    expect(calls).not.toContain("reuse");
  });

  it("calls reuse, not install, when the user chose reuse", async () => {
    const { deps, calls } = makeFake(freshState({ serverChoice: "reuse" }), {
      hasMailcow: true,
      otherDomainsOnServer: ["other.com"],
    });

    const result = await runDomainSetup(deps);

    expect(result).toBe("done");
    expect(calls).toContain("reuse");
    expect(calls).not.toContain("install");
  });

  it("rejects with a step's thrown error and marks that step failed", async () => {
    const { deps, getState } = makeFake(freshState(), { dnsAlwaysFails: new Error("zone missing") });

    await expect(runDomainSetup(deps)).rejects.toThrow("zone missing");

    const state = getState();
    expect(state.steps.dns).toBe("failed");
    expect(state.error).toBe("zone missing");
  });

  it("throws a count message when mailboxes fail, and marks the step failed", async () => {
    const { deps, getState } = makeFake(freshState({ fromStep: "mailboxes" }), {
      mailboxResult: { created: 8, failed: 2, total: 10 },
    });

    await expect(runDomainSetup(deps)).rejects.toThrow("2 of 10 mailboxes couldn't be created");

    const state = getState();
    expect(state.steps.mailboxes).toBe("failed");
  });

  it("resumes after a dns failure: a second call on the same fake retries dns and continues", async () => {
    const { deps, calls } = makeFake(freshState(), {
      hasMailcow: false,
      dnsFailsOnce: new Error("dns blew up"),
    });

    await expect(runDomainSetup(deps)).rejects.toThrow("dns blew up");

    const result = await runDomainSetup(deps);

    expect(result).toBe("done");
    expect(calls.filter((c) => c === "dns")).toHaveLength(2);
    expect(calls[calls.length - 1]).toBe("dkim");
  });
});
