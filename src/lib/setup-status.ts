// What the setup board shows for a domain's setup run: the status line, the step chips, which button it
// offers, and the job summary. Pure and browser-safe; the board and the domain page render these.

import { SETUP_STEPS, boardSummary, isActive, type SetupState, type SetupStep, type StepStatus } from "./setup-state";
import { formatEta, progressPercent, secondsLeft, type MailboxProgress } from "./mailbox-progress";

/** The part of a board row these helpers read: the domain's status, its setup run and mailbox progress. */
export interface SetupRowInfo {
  status: string;
  setupState: SetupState | null;
  mailboxProgress: MailboxProgress | null;
}

/** A step chip: the step's own status, or "waiting" for the step the run paused on to ask the user. */
export type ChipStatus = StepStatus | "waiting";

/**
 * The mailbox progress of this run, or null when there is none yet or what's saved is from an earlier run
 * (mailbox_progress keeps the latest mailbox run, which may predate this setup run).
 */
export function currentMailboxProgress(
  state: SetupState | null,
  progress: MailboxProgress | null,
): MailboxProgress | null {
  if (!state || !progress) return null;
  return Date.parse(progress.startedAt) >= Date.parse(state.startedAt) ? progress : null;
}

/** How long a step has been running, e.g. "12 min so far"; null when its start isn't known. */
function elapsedText(startedAt: string | null | undefined, nowMs: number): string | null {
  if (!startedAt) return null;
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return null;
  // Clamped: the browser's clock may run a little behind the server's.
  const minutes = Math.floor(Math.max(0, nowMs - startedMs) / 60_000);
  return minutes < 1 ? "under a minute so far" : `${minutes} min so far`;
}

/**
 * One line saying where the domain's setup is. Null while the run waits for the user's server choice: the
 * choice panel takes its place.
 *
 * The Mailcow install shows its elapsed time from stepStartedAt (not updatedAt: the liveness heartbeat
 * refreshes that about once a minute). Runs saved before stepStartedAt existed show the plain text.
 */
export function setupStatusLine(row: SetupRowInfo, nowMs: number = Date.now()): string | null {
  const s = row.setupState;
  if (!s) return row.status === "ready" ? "Set up" : "Not started";
  switch (s.status) {
    case "queued":
      return "Queued";
    case "waiting":
      return null;
    case "failed":
      return s.error ? `Needs attention: ${s.error}` : "Needs attention";
    case "done":
      return "Set up";
    case "running":
      switch (s.step) {
        case "dns":
          return "Setting up DNS…";
        case "server": {
          const elapsed = elapsedText(s.stepStartedAt, nowMs);
          return `Installing Mailcow (usually 20–40 min)${elapsed ? ` · ${elapsed}` : ""}`;
        }
        case "mailboxes": {
          const p = currentMailboxProgress(s, row.mailboxProgress);
          if (!p) return "Setting up mailboxes…";
          return `Mailboxes ${p.done}/${p.total} · ${progressPercent(p)}% · ${formatEta(secondsLeft(p))}`;
        }
        case "dkim":
          return "Syncing DKIM…";
        default:
          return "Starting…";
      }
  }
}

/** Where Retry resumes: the first failed step, else the first step not done. */
export function retryStep(state: SetupState): SetupStep | undefined {
  return (
    SETUP_STEPS.find((step) => state.steps[step] === "failed") ??
    SETUP_STEPS.find((step) => state.steps[step] !== "done")
  );
}

/** The button a row offers: Start (no run yet and not ready), Retry (its run failed), or none. */
export function rowAction(row: SetupRowInfo): "start" | "retry" | null {
  if (!row.setupState) return row.status === "ready" ? null : "start";
  return row.setupState.status === "failed" ? "retry" : null;
}

export function chipStatuses(state: SetupState | null): Record<SetupStep, ChipStatus> {
  const chips = {} as Record<SetupStep, ChipStatus>;
  for (const step of SETUP_STEPS) {
    if (state?.status === "waiting" && state.step === step) chips[step] = "waiting";
    else chips[step] = state?.steps[step] ?? "pending";
  }
  return chips;
}

// A domain that is ready with no run on record was set up before runs were tracked: startJobSetup skips it,
// so the board counts it as done rather than "not started".
function readyWithoutRun(row: SetupRowInfo): boolean {
  return !row.setupState && row.status === "ready";
}

export function jobBoardSummary(rows: SetupRowInfo[]) {
  const summary = boardSummary(rows.map((r) => r.setupState));
  const legacyReady = rows.filter(readyWithoutRun).length;
  summary.notStarted -= legacyReady;
  summary.done += legacyReady;
  return summary;
}

export function summaryText(summary: ReturnType<typeof boardSummary>): string {
  const parts: [number, string][] = [
    [summary.done, "done"],
    [summary.running, "running"],
    [summary.waiting, "waiting for you"],
    [summary.failed, "needs attention"],
    [summary.notStarted, "not started"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(" · ");
}

/** Whether "Set up everything" would start anything: the same rows startJobSetup skips are skipped here. */
export function canStartJobSetup(rows: SetupRowInfo[]): boolean {
  return rows.some(
    (r) => !(isActive(r.setupState) || r.setupState?.status === "done" || readyWithoutRun(r)),
  );
}
