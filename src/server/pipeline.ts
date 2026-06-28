// Shared, idempotent provisioning pipeline. Each step checks live state first and skips
// work already done, so a retry resumes cleanly instead of redoing slow steps (e.g. the
// 20-minute Mailcow image pull). Both the BullMQ worker and the manual per-step buttons
// call these same functions, so there is exactly one code path.

export type StepName =
  | "pushDns"
  | "provision"
  | "ensureMailDomains"
  | "createMailboxes"
  | "syncDkim"
  | "verify";

export type StepState = "pending" | "running" | "ok" | "failed";

export interface PipelineProgress {
  currentStep: StepName | null;
  steps: Partial<Record<StepName, StepState>>;
  error: string | null;
  updatedAt: string;
}

export const ALL_STEPS: StepName[] = [
  "pushDns",
  "provision",
  "ensureMailDomains",
  "createMailboxes",
  "syncDkim",
  "verify",
];

// Merge a progress patch onto the previous progress without dropping already-set steps.
// `error` is only changed when the patch explicitly includes an `error` key.
export function mergeProgress(
  prev: PipelineProgress | null,
  patch: Partial<PipelineProgress>,
): PipelineProgress {
  return {
    currentStep: patch.currentStep ?? prev?.currentStep ?? null,
    steps: { ...(prev?.steps ?? {}), ...(patch.steps ?? {}) },
    error: "error" in patch ? (patch.error ?? null) : (prev?.error ?? null),
    updatedAt: new Date().toISOString(),
  };
}
