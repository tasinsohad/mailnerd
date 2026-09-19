import { describe, it, expect } from "vitest";
import { boardSummary, isActive, mergeSetupState, newSetupState, SETUP_STEPS } from "../setup-state";

const T0 = "2026-09-18T10:00:00.000Z";
const T1 = "2026-09-18T10:05:00.000Z";

describe("newSetupState", () => {
  it("starts queued with every step pending", () => {
    const s = newSetupState("r1", T0);
    expect(s).toMatchObject({ runId: "r1", status: "queued", step: null, attempt: 0, error: null, waiting: null, serverChoice: null, stepStartedAt: null, startedAt: T0, updatedAt: T0, finishedAt: null });
    expect(SETUP_STEPS.map((k) => s.steps[k])).toEqual(["pending", "pending", "pending", "pending"]);
  });
  it("marks the steps before fromStep as done", () => {
    const s = newSetupState("r1", T0, { fromStep: "mailboxes" });
    expect(s.steps).toEqual({ dns: "done", server: "done", mailboxes: "pending", dkim: "pending" });
  });
  it("carries a server choice", () => {
    expect(newSetupState("r1", T0, { fromStep: "server", serverChoice: "reinstall" }).serverChoice).toBe("reinstall");
  });
});

describe("mergeSetupState", () => {
  it("merges steps instead of replacing them and stamps updatedAt", () => {
    const s = newSetupState("r1", T0);
    const m = mergeSetupState(s, { status: "running", step: "dns", steps: { ...s.steps, dns: "running" } }, T1);
    expect(m.steps.dns).toBe("running");
    expect(m.steps.server).toBe("pending");
    expect(m.updatedAt).toBe(T1);
    expect(m.startedAt).toBe(T0);
  });
});

describe("isActive and boardSummary", () => {
  it("counts each domain once", () => {
    const base = newSetupState("r", T0);
    const states = [
      null,
      { ...base, status: "queued" as const },
      { ...base, status: "running" as const },
      { ...base, status: "waiting" as const },
      { ...base, status: "failed" as const },
      { ...base, status: "done" as const },
    ];
    expect(states.map(isActive)).toEqual([false, true, true, true, false, false]);
    expect(boardSummary(states)).toEqual({ done: 1, running: 2, waiting: 1, failed: 1, notStarted: 1 });
  });
});
