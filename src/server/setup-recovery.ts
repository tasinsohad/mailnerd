// Rules for setup runs whose process went away: the periodic check in domain-setup.ts
// (reconcileStuckSetupRuns) and the queue worker's "failed" handler in queue.ts. Pure leaf (types and the
// step list only), so tests load it without the DB, SSH or queue stack.
//
// Claims (domain-locks.ts) and the queue are only visible to the process that holds them, but several
// processes can share one database (the deployed app, plus a dev server or a local build). So a run is
// taken over only when no process has shown it's alive for RUN_STALE_AFTER_MS: every process's check
// refreshes the updatedAt of the runs it holds (a domain claim, or a job in its queue), about once a minute.

import { SETUP_STEPS, type SetupState, type SetupStep } from "../lib/setup-state";

/** First check after the app starts: the queue is up, and BullMQ has put back jobs that stalled in the restart. */
export const RECONCILE_BOOT_DELAY_MS = 30_000;
/** How often the check's timer fires. RECONCILE_MIN_INTERVAL_MS still spaces the checks themselves. */
export const RECONCILE_TICK_MS = 30_000;
/** At most one check per this long in one process, whoever asks (the timer or the job board). */
export const RECONCILE_MIN_INTERVAL_MS = 60_000;
/** A run nobody has refreshed for this long has no process behind it. Several refresh intervals, for margin. */
export const RUN_STALE_AFTER_MS = 5 * 60_000;

export const INTERRUPTED_MESSAGE =
  "The setup was interrupted (the app restarted during it). Retry to continue.";

/** Whether a check may start now: at most one per `minIntervalMs`. */
export function reconcileDue(
  lastStartedMs: number | null,
  nowMs: number,
  minIntervalMs = RECONCILE_MIN_INTERVAL_MS,
): boolean {
  return lastStartedMs === null || nowMs - lastStartedMs >= minIntervalMs;
}

/** Queued or running: the states a live run keeps refreshing, and the only ones that can be stuck. */
export function isInFlight(state: SetupState | null | undefined): state is SetupState {
  return state?.status === "queued" || state?.status === "running";
}

/**
 * A run whose state says queued or running, but nothing is behind it: no run in this process holds the
 * domain (`claimed`), the queue has no job for it (`queued`; false when Redis isn't answering), and no
 * process has refreshed it for `staleAfterMs`. That run died with its process (an in-process run lost to a
 * restart, or a crash before its final state was saved). A run waiting for the user's choice isn't stuck.
 */
export function isStuckSetupRun(
  state: SetupState | null | undefined,
  live: { claimed: boolean; queued: boolean },
  nowMs: number,
  staleAfterMs = RUN_STALE_AFTER_MS,
): state is SetupState {
  if (!isInFlight(state) || live.claimed || live.queued) return false;
  const touchedMs = Date.parse(state.updatedAt);
  return !Number.isFinite(touchedMs) || nowMs - touchedMs >= staleAfterMs;
}

/** Where a stuck run picks up: its first step not done yet, or null when every step is done. */
export function resumeStep(state: SetupState): SetupStep | null {
  return SETUP_STEPS.find((step) => state.steps[step] !== "done") ?? null;
}

/** The error shown for a run whose queue job failed for good without the run recording why. */
export function interruptedRunError(failedReason: string | null | undefined): string {
  if (!failedReason || /stalled/i.test(failedReason)) return INTERRUPTED_MESSAGE;
  return `The setup stopped: ${failedReason}. Retry to continue.`;
}

/**
 * How to end run `runId` whose queue job failed for good without the run recording it: failed, with the
 * error and the step it was on marked failed. Null when there's nothing to end: the state belongs to another
 * run, or the run already ended (or is waiting for the user).
 */
export function interruptedRunPatch(
  state: SetupState | null | undefined,
  runId: string,
  error: string,
  nowIso: string,
): Partial<SetupState> | null {
  if (!isInFlight(state) || state.runId !== runId) return null;
  const steps =
    state.step && state.steps[state.step] === "running"
      ? { ...state.steps, [state.step]: "failed" as const }
      : state.steps;
  return { status: "failed", error, finishedAt: nowIso, steps };
}
