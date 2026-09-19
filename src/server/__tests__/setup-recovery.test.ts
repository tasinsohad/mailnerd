import { describe, it, expect } from "vitest";
import { newSetupState, type SetupState } from "../../lib/setup-state";
import {
  INTERRUPTED_MESSAGE,
  RECONCILE_MIN_INTERVAL_MS,
  RUN_STALE_AFTER_MS,
  interruptedRunError,
  interruptedRunPatch,
  isStuckSetupRun,
  reconcileDue,
  resumeStep,
  reuseMustWait,
  takesOverStuckRuns,
} from "../setup-recovery";

// A run is taken over only when its state says queued or running, nothing in this process holds it, the
// queue has no job for it, and no process has refreshed it for RUN_STALE_AFTER_MS.

const T0 = Date.parse("2026-09-19T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function state(patch: Partial<SetupState> = {}, touchedMs = T0): SetupState {
  return { ...newSetupState("run-1", iso(touchedMs)), ...patch };
}

const idle = { claimed: false, queued: false };
const stale = T0 + RUN_STALE_AFTER_MS;

describe("isStuckSetupRun", () => {
  it("is stuck when queued or running, unclaimed, not in the queue and not refreshed for the stale time", () => {
    expect(isStuckSetupRun(state({ status: "queued" }), idle, stale)).toBe(true);
    expect(isStuckSetupRun(state({ status: "running" }), idle, stale)).toBe(true);
  });

  it("isn't stuck while a run in this process holds the domain", () => {
    expect(
      isStuckSetupRun(state({ status: "running" }), { claimed: true, queued: false }, stale),
    ).toBe(false);
  });

  it("isn't stuck while the queue still has a job for the domain", () => {
    expect(
      isStuckSetupRun(state({ status: "queued" }), { claimed: false, queued: true }, stale),
    ).toBe(false);
  });

  it("isn't stuck while another process may still be refreshing it", () => {
    expect(isStuckSetupRun(state({ status: "running" }), idle, stale - 1)).toBe(false);
  });

  it("never takes over a run that waits for the user, has ended, or doesn't exist", () => {
    for (const status of ["waiting", "done", "failed"] as const) {
      expect(isStuckSetupRun(state({ status }), idle, stale)).toBe(false);
    }
    expect(isStuckSetupRun(null, idle, stale)).toBe(false);
    expect(isStuckSetupRun(undefined, idle, stale)).toBe(false);
  });

  it("treats an unreadable updatedAt as stale", () => {
    expect(isStuckSetupRun(state({ status: "running", updatedAt: "garbage" }), idle, T0)).toBe(
      true,
    );
  });
});

describe("resumeStep", () => {
  it("picks the first step not done, whatever state it was left in", () => {
    expect(resumeStep(state())).toBe("dns");
    expect(
      resumeStep(
        state({ steps: { dns: "done", server: "running", mailboxes: "pending", dkim: "pending" } }),
      ),
    ).toBe("server");
    expect(
      resumeStep(
        state({ steps: { dns: "done", server: "done", mailboxes: "failed", dkim: "pending" } }),
      ),
    ).toBe("mailboxes");
  });

  it("is null when every step is done (only the final save was lost)", () => {
    expect(
      resumeStep(
        state({ steps: { dns: "done", server: "done", mailboxes: "done", dkim: "done" } }),
      ),
    ).toBeNull();
  });
});

describe("reconcileDue", () => {
  it("runs the first time, then at most once per interval", () => {
    expect(reconcileDue(null, T0)).toBe(true);
    expect(reconcileDue(T0, T0 + RECONCILE_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(reconcileDue(T0, T0 + RECONCILE_MIN_INTERVAL_MS)).toBe(true);
  });
});

describe("interruptedRunPatch", () => {
  const nowIso = iso(T0 + 1000);

  it("ends a running run of the same id as failed, marking its current step failed", () => {
    const s = state({
      status: "running",
      step: "server",
      steps: { dns: "done", server: "running", mailboxes: "pending", dkim: "pending" },
    });
    expect(interruptedRunPatch(s, "run-1", INTERRUPTED_MESSAGE, nowIso)).toEqual({
      status: "failed",
      error: INTERRUPTED_MESSAGE,
      finishedAt: nowIso,
      steps: { dns: "done", server: "failed", mailboxes: "pending", dkim: "pending" },
    });
  });

  it("ends a queued run without touching its steps", () => {
    const s = state({ status: "queued", step: "server" });
    expect(interruptedRunPatch(s, "run-1", "x", nowIso)).toMatchObject({
      status: "failed",
      steps: s.steps,
    });
  });

  it("leaves a newer run, a finished run and a waiting run alone", () => {
    expect(interruptedRunPatch(state({ status: "running" }), "run-0", "x", nowIso)).toBeNull();
    for (const status of ["waiting", "done", "failed"] as const) {
      expect(interruptedRunPatch(state({ status }), "run-1", "x", nowIso)).toBeNull();
    }
    expect(interruptedRunPatch(null, "run-1", "x", nowIso)).toBeNull();
  });
});

describe("interruptedRunError", () => {
  it("explains a stall as an interruption", () => {
    expect(interruptedRunError("job stalled more than allowable limit")).toBe(INTERRUPTED_MESSAGE);
    expect(interruptedRunError(undefined)).toBe(INTERRUPTED_MESSAGE);
  });

  it("shows any other reason", () => {
    expect(interruptedRunError("connect ECONNREFUSED")).toBe(
      "The setup stopped: connect ECONNREFUSED. Retry to continue.",
    );
  });
});

describe("reuseMustWait", () => {
  it("waits for a queued or running reinstall whose server step isn't done", () => {
    expect(
      reuseMustWait([{ serverChoice: "reinstall", status: "queued", serverStepDone: false }]),
    ).toBe(true);
    expect(
      reuseMustWait([{ serverChoice: "reinstall", status: "running", serverStepDone: false }]),
    ).toBe(true);
  });

  it("doesn't wait once the reinstall's server step is done", () => {
    expect(
      reuseMustWait([{ serverChoice: "reinstall", status: "running", serverStepDone: true }]),
    ).toBe(false);
  });

  it("doesn't wait for a reinstall that's done, failed or waiting", () => {
    for (const status of ["done", "failed", "waiting"] as const) {
      expect(reuseMustWait([{ serverChoice: "reinstall", status, serverStepDone: false }])).toBe(
        false,
      );
    }
  });

  it("doesn't wait for a domain that chose reuse itself, or has no choice yet", () => {
    expect(
      reuseMustWait([{ serverChoice: "reuse", status: "queued", serverStepDone: false }]),
    ).toBe(false);
    expect(
      reuseMustWait([{ serverChoice: null, status: "queued", serverStepDone: false }]),
    ).toBe(false);
  });

  it("waits when any one of several others is a pending reinstall", () => {
    expect(
      reuseMustWait([
        { serverChoice: "reuse", status: "running", serverStepDone: true },
        { serverChoice: "reinstall", status: "done", serverStepDone: true },
        { serverChoice: "reinstall", status: "queued", serverStepDone: false },
      ]),
    ).toBe(true);
  });

  it("doesn't wait when there's nothing else on the server", () => {
    expect(reuseMustWait([])).toBe(false);
  });
});

describe("takesOverStuckRuns", () => {
  it("takes over only when SETUP_RECONCILE is exactly 1 (the production server)", () => {
    expect(takesOverStuckRuns({ SETUP_RECONCILE: "1" })).toBe(true);
    expect(takesOverStuckRuns({})).toBe(false);
    expect(takesOverStuckRuns({ SETUP_RECONCILE: "0" })).toBe(false);
    expect(takesOverStuckRuns({ SETUP_RECONCILE: "true" })).toBe(false);
  });
});
