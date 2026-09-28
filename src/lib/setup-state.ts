// The server-side setup run of one domain: DNS → server → mailboxes → DKIM. Stored in domains.setup_state
// (src/server/domain-setup*.ts) and shown on the job board. Pure and browser-safe.

export const SETUP_STEPS = ["dns", "server", "mailboxes", "dkim"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export type StepStatus = "pending" | "running" | "done" | "failed";
export type SetupStatus = "queued" | "running" | "waiting" | "done" | "failed";
export type ServerChoice = "reuse" | "reinstall";

export interface SetupState {
  runId: string;
  status: SetupStatus;
  step: SetupStep | null;
  steps: Record<SetupStep, StepStatus>;
  attempt: number;
  error: string | null;
  /** Set while the run waits for the user. Either a server-already-runs-Mailcow choice, or a reverse-DNS
   *  (FCrDNS) gate before mailboxes go live: the user sets the PTR, then re-checks and continues. */
  waiting:
    | null
    | { kind: "server-choice"; ip: string; hostname: string | null; otherDomains: string[] }
    | { kind: "fcrdns"; ip: string; ptrHost: string | null; expected: string; message: string };
  serverChoice: ServerChoice | null;
  /** When the current step started running (set by runDomainSetup each time a step starts); null before that. */
  stepStartedAt: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export const STEP_LABELS: Record<SetupStep, string> = {
  dns: "DNS",
  server: "Server",
  mailboxes: "Mailboxes",
  dkim: "DKIM",
};

export function newSetupState(
  runId: string,
  nowIso: string,
  opts: { fromStep?: SetupStep; serverChoice?: ServerChoice | null } = {},
): SetupState {
  const from = opts.fromStep ? SETUP_STEPS.indexOf(opts.fromStep) : 0;
  const steps = Object.fromEntries(
    SETUP_STEPS.map((step, i) => [step, i < from ? "done" : "pending"]),
  ) as Record<SetupStep, StepStatus>;
  return {
    runId,
    status: "queued",
    step: null,
    steps,
    attempt: 0,
    error: null,
    waiting: null,
    serverChoice: opts.serverChoice ?? null,
    stepStartedAt: null,
    startedAt: nowIso,
    updatedAt: nowIso,
    finishedAt: null,
  };
}

export function mergeSetupState(prev: SetupState, patch: Partial<SetupState>, nowIso: string): SetupState {
  return { ...prev, ...patch, steps: { ...prev.steps, ...(patch.steps ?? {}) }, updatedAt: nowIso };
}

/** Queued, running or waiting for the user: a new run for this domain must not start. */
export function isActive(state: SetupState | null | undefined): boolean {
  return state?.status === "queued" || state?.status === "running" || state?.status === "waiting";
}

export function boardSummary(states: (SetupState | null | undefined)[]) {
  const summary = { done: 0, running: 0, waiting: 0, failed: 0, notStarted: 0 };
  for (const s of states) {
    if (!s) summary.notStarted++;
    else if (s.status === "done") summary.done++;
    else if (s.status === "waiting") summary.waiting++;
    else if (s.status === "failed") summary.failed++;
    else summary.running++;
  }
  return summary;
}
