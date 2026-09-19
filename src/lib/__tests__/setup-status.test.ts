import { describe, it, expect } from "vitest";
import { newSetupState, type SetupState } from "../setup-state";
import { newMailboxProgress, type MailboxProgress } from "../mailbox-progress";
import {
  canStartJobSetup,
  chipStatuses,
  currentMailboxProgress,
  jobBoardSummary,
  retryStep,
  rowAction,
  setupStatusLine,
  summaryText,
  type SetupRowInfo,
} from "../setup-status";

const T0 = "2026-09-18T10:00:00.000Z";
const T1 = "2026-09-18T10:05:00.000Z";
const TEARLIER = "2026-09-18T09:00:00.000Z";

function state(patch: Partial<SetupState> = {}): SetupState {
  const s = newSetupState("r1", T0);
  return { ...s, ...patch, steps: { ...s.steps, ...(patch.steps ?? {}) } };
}

function row(patch: Partial<SetupRowInfo> = {}): SetupRowInfo {
  return { status: "pending", setupState: null, mailboxProgress: null, ...patch };
}

function progress(patch: Partial<MailboxProgress> = {}): MailboxProgress {
  return { ...newMailboxProgress(500, T1), ...patch };
}

describe("setupStatusLine", () => {
  it("no run yet: not started, or set up for a domain that is already ready", () => {
    expect(setupStatusLine(row())).toBe("Not started");
    expect(setupStatusLine(row({ status: "ready" }))).toBe("Set up");
  });
  it("queued, done", () => {
    expect(setupStatusLine(row({ setupState: state() }))).toBe("Queued");
    expect(setupStatusLine(row({ setupState: state({ status: "done" }) }))).toBe("Set up");
  });
  it("running, per step", () => {
    const running = (step: SetupState["step"]) => row({ setupState: state({ status: "running", step }) });
    expect(setupStatusLine(running("dns"))).toBe("Setting up DNS…");
    expect(setupStatusLine(running("server"))).toBe("Installing Mailcow (usually 20–40 min)");
    expect(setupStatusLine(running("dkim"))).toBe("Syncing DKIM…");
    expect(setupStatusLine(running(null))).toBe("Starting…");
  });
  it("server: how long the install has been running, from stepStartedAt", () => {
    const server = (stepStartedAt: string | null) =>
      row({ setupState: state({ status: "running", step: "server", stepStartedAt }) });
    const now = Date.parse(T1);
    expect(setupStatusLine(server("2026-09-18T09:53:00.000Z"), now)).toBe(
      "Installing Mailcow (usually 20–40 min) · 12 min so far",
    );
    expect(setupStatusLine(server("2026-09-18T10:04:30.000Z"), now)).toBe(
      "Installing Mailcow (usually 20–40 min) · under a minute so far",
    );
    // A browser clock behind the server's doesn't show a negative time.
    expect(setupStatusLine(server("2026-09-18T10:06:00.000Z"), now)).toBe(
      "Installing Mailcow (usually 20–40 min) · under a minute so far",
    );
    expect(setupStatusLine(server(null), now)).toBe("Installing Mailcow (usually 20–40 min)");
  });
  it("mailboxes: count, percent and time left from this run's progress", () => {
    const r = row({
      setupState: state({ status: "running", step: "mailboxes" }),
      mailboxProgress: progress({ done: 240, secondsPerMailbox: 0.72 }),
    });
    // 260 left × 0.72 s ≈ 187 s ≈ 3 min
    expect(setupStatusLine(r)).toBe("Mailboxes 240/500 · 48% · about 3 min left");
  });
  it("mailboxes: no progress yet, or progress left over from an earlier run", () => {
    const s = state({ status: "running", step: "mailboxes" });
    expect(setupStatusLine(row({ setupState: s }))).toBe("Setting up mailboxes…");
    expect(
      setupStatusLine(row({ setupState: s, mailboxProgress: progress({ startedAt: TEARLIER, done: 500 }) })),
    ).toBe("Setting up mailboxes…");
  });
  it("failed shows the error; waiting has no line (the choice panel replaces it)", () => {
    expect(setupStatusLine(row({ setupState: state({ status: "failed", error: "SSH refused" }) }))).toBe(
      "Needs attention: SSH refused",
    );
    expect(setupStatusLine(row({ setupState: state({ status: "failed" }) }))).toBe("Needs attention");
    expect(setupStatusLine(row({ setupState: state({ status: "waiting", step: "server" }) }))).toBeNull();
  });
});

describe("currentMailboxProgress", () => {
  it("keeps progress that started with or after the run, drops older", () => {
    const s = state();
    expect(currentMailboxProgress(s, progress())).not.toBeNull();
    expect(currentMailboxProgress(s, progress({ startedAt: T0 }))).not.toBeNull();
    expect(currentMailboxProgress(s, progress({ startedAt: TEARLIER }))).toBeNull();
    expect(currentMailboxProgress(null, progress())).toBeNull();
    expect(currentMailboxProgress(s, null)).toBeNull();
  });
});

describe("retryStep", () => {
  it("the first failed step, else the first step not done", () => {
    expect(retryStep(state({ steps: { dns: "done", server: "done", mailboxes: "failed", dkim: "pending" } }))).toBe(
      "mailboxes",
    );
    expect(retryStep(state({ steps: { dns: "done", server: "pending", mailboxes: "pending", dkim: "pending" } }))).toBe(
      "server",
    );
    expect(retryStep(state({ steps: { dns: "done", server: "done", mailboxes: "done", dkim: "done" } }))).toBeUndefined();
  });
});

describe("rowAction", () => {
  it("start with no run unless ready; retry when failed; nothing otherwise", () => {
    expect(rowAction(row())).toBe("start");
    expect(rowAction(row({ status: "failed" }))).toBe("start");
    expect(rowAction(row({ status: "ready" }))).toBeNull();
    expect(rowAction(row({ setupState: state({ status: "failed" }) }))).toBe("retry");
    expect(rowAction(row({ setupState: state({ status: "running" }) }))).toBeNull();
    expect(rowAction(row({ setupState: state({ status: "done" }) }))).toBeNull();
  });
});

describe("chipStatuses", () => {
  it("every step pending with no run; the paused step shows as waiting", () => {
    expect(chipStatuses(null)).toEqual({ dns: "pending", server: "pending", mailboxes: "pending", dkim: "pending" });
    const w = state({ status: "waiting", step: "server", steps: { dns: "done", server: "pending", mailboxes: "pending", dkim: "pending" } });
    expect(chipStatuses(w)).toEqual({ dns: "done", server: "waiting", mailboxes: "pending", dkim: "pending" });
  });
});

describe("jobBoardSummary and summaryText", () => {
  it("counts a ready domain with no run as done, like startJobSetup skips it", () => {
    const rows = [
      row({ status: "ready" }),
      row(),
      row({ setupState: state({ status: "running" }) }),
      row({ setupState: state({ status: "waiting" }) }),
      row({ setupState: state({ status: "failed" }) }),
      row({ setupState: state({ status: "done" }) }),
    ];
    expect(jobBoardSummary(rows)).toEqual({ done: 2, running: 1, waiting: 1, failed: 1, notStarted: 1 });
  });
  it("lists only the non-zero counts", () => {
    expect(summaryText({ done: 3, running: 2, waiting: 1, failed: 1, notStarted: 4 })).toBe(
      "3 done · 2 running · 1 waiting for you · 1 needs attention · 4 not started",
    );
    expect(summaryText({ done: 2, running: 0, waiting: 0, failed: 0, notStarted: 0 })).toBe("2 done");
    expect(summaryText({ done: 0, running: 0, waiting: 0, failed: 0, notStarted: 0 })).toBe("");
  });
});

describe("canStartJobSetup", () => {
  it("false when every row is done or active (or there are none)", () => {
    expect(canStartJobSetup([])).toBe(false);
    expect(
      canStartJobSetup([
        row({ status: "ready" }),
        row({ setupState: state({ status: "done" }) }),
        row({ setupState: state({ status: "queued" }) }),
        row({ setupState: state({ status: "waiting" }) }),
      ]),
    ).toBe(false);
  });
  it("true when some row has no run or failed", () => {
    expect(canStartJobSetup([row()])).toBe(true);
    expect(canStartJobSetup([row({ setupState: state({ status: "failed" }) })])).toBe(true);
  });
});
