import { describe, it, expect } from "vitest";
import { serverDecision, runDomainSetup, type ServerInspection, type SetupDeps } from "../domain-setup-core";
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
