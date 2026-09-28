import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Loader2, Pause, Play, RotateCcw, ScrollText, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { startDomainSetup } from "@/server/domain-setup-fns";
import { SETUP_STEPS, STEP_LABELS, type SetupStep } from "@/lib/setup-state";
import { progressPercent } from "@/lib/mailbox-progress";
import {
  chipStatuses,
  currentMailboxProgress,
  retryStep,
  rowAction,
  setupStatusLine,
  type ChipStatus,
  type SetupRowData,
} from "@/lib/setup-status";
import { ServerChoicePanel } from "./ServerChoicePanel";
import { FcrdnsWaitPanel } from "./FcrdnsWaitPanel";
import { SetupLogDialog } from "./SetupLogDialog";

const CHIP: Record<ChipStatus, { tone: string; label: string }> = {
  done: { tone: "text-success", label: "done" },
  running: { tone: "text-primary", label: "running" },
  failed: { tone: "text-destructive", label: "failed" },
  pending: { tone: "text-muted-foreground", label: "not done yet" },
  waiting: { tone: "text-warning", label: "waiting for you" },
};

function ChipIcon({ status }: { status: ChipStatus }) {
  const cls = "h-3.5 w-3.5 shrink-0";
  switch (status) {
    case "done":
      return <Check aria-hidden className={cls} />;
    case "running":
      return <Loader2 aria-hidden className={cn(cls, "animate-spin")} />;
    case "failed":
      return <X aria-hidden className={cls} />;
    case "waiting":
      return <Pause aria-hidden className={cls} />;
    default:
      return (
        <span aria-hidden className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      );
  }
}

function StepChip({ step, status }: { step: SetupStep; status: ChipStatus }) {
  const chip = CHIP[status];
  return (
    <li
      title={`${STEP_LABELS[step]}: ${chip.label}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs",
        chip.tone,
      )}
    >
      <ChipIcon status={status} />
      <span className={status === "pending" ? "text-muted-foreground" : "text-foreground"}>
        {STEP_LABELS[step]}
      </span>
      <span className="sr-only">: {chip.label}</span>
    </li>
  );
}

// Determinate while mailboxes are created (value = percent); otherwise a sliding segment (value null).
// Also used by the domain page for its manual mailbox runs.
export function SetupProgress({ value, label }: { value: number | null; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      aria-valuetext={value === null ? "In progress" : `${value}%`}
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted text-primary"
    >
      {value === null ? (
        <div className="progress-indeterminate" />
      ) : (
        <div
          className="h-full rounded-full bg-current transition-[width] duration-500"
          style={{ width: `${value}%` }}
        />
      )}
    </div>
  );
}

function lineTone(row: SetupRowData): string {
  const s = row.setupState;
  if (s?.status === "failed") return "text-destructive";
  if (s?.status === "done" || (!s && row.status === "ready")) return "text-success";
  if (!s) return "text-muted-foreground";
  return "text-foreground";
}

/**
 * One domain's setup: name and IP, the four step chips, a status line, a progress bar while it runs, the
 * server-choice panel while it waits, and Start / Retry / Open log. `onChanged` runs after every action so
 * the caller can refetch its data (the job board, or the domain page's own row).
 */
export function SetupRow({
  row,
  onChanged,
  className,
}: {
  row: SetupRowData;
  /** May return a promise (e.g. the board's invalidate/refetch): awaited before the busy state clears, so
   * Start/Retry stay disabled until the fresh row lands instead of flashing back to their old state. */
  onChanged: () => void | Promise<unknown>;
  className?: string;
}) {
  const [logOpen, setLogOpen] = useState(false);
  const state = row.setupState;
  const action = rowAction(row);
  const chips = chipStatuses(state);
  // A domain that was ready before setup runs existed has no steps to show.
  const showChips = !!state || row.status !== "ready";
  const line =
    setupStatusLine(row) ?? (state?.status === "waiting" && !state.waiting ? "Waiting for you" : null);

  const running = state?.status === "running";
  const mailboxes = running && state.step === "mailboxes" ? currentMailboxProgress(state, row.mailboxProgress) : null;

  const start = useMutation({
    mutationFn: (fromStep: SetupStep | undefined) =>
      startDomainSetup({ data: { domainId: row.id, ...(fromStep ? { fromStep } : {}) } }),
    onSuccess: (res, fromStep) => {
      if (res.ok) {
        toast.success(
          fromStep
            ? `Retrying ${row.name} from the ${STEP_LABELS[fromStep]} step`
            : `Setup started for ${row.name}. It keeps running if you close this page.`,
        );
      } else {
        toast.error(res.error ?? "Couldn't start setup");
      }
      return onChanged();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err));
      return onChanged();
    },
  });

  const buttonClass = "h-10 gap-1.5 sm:h-9";

  return (
    <div className={cn("flex flex-col gap-3 px-4 py-4 sm:px-5", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="ident break-all text-sm font-medium text-foreground">{row.name}</div>
          <div className="ident mt-0.5 break-all text-xs text-muted-foreground">
            {row.ipAddress || "No IP set"}
          </div>
        </div>
        {showChips && (
          <ul aria-label="Setup steps" className="flex flex-wrap gap-1.5">
            {SETUP_STEPS.map((step) => (
              <StepChip key={step} step={step} status={chips[step]} />
            ))}
          </ul>
        )}
      </div>

      {line && <p className={cn("break-words text-sm", lineTone(row))}>{line}</p>}

      {running && (
        <SetupProgress
          value={mailboxes ? progressPercent(mailboxes) : null}
          label={`${row.name} setup progress`}
        />
      )}

      {state?.status === "waiting" && state.waiting?.kind === "server-choice" && (
        <ServerChoicePanel domainId={row.id} waiting={state.waiting} onChanged={onChanged} />
      )}
      {state?.status === "waiting" && state.waiting?.kind === "fcrdns" && (
        <FcrdnsWaitPanel domainId={row.id} waiting={state.waiting} onChanged={onChanged} />
      )}

      <div className="flex flex-wrap gap-2">
        {action === "start" && (
          <Button
            size="sm"
            className={buttonClass}
            onClick={() => start.mutate(undefined)}
            disabled={start.isPending}
          >
            {start.isPending ? <Loader2 className="animate-spin" /> : <Play />}
            Start
          </Button>
        )}
        {action === "retry" && state && (
          <Button
            size="sm"
            variant="outline"
            className={buttonClass}
            onClick={() => start.mutate(retryStep(state))}
            disabled={start.isPending}
          >
            {start.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            Retry
          </Button>
        )}
        <Button size="sm" variant="outline" className={buttonClass} onClick={() => setLogOpen(true)}>
          <ScrollText />
          Open log
        </Button>
      </div>

      <SetupLogDialog
        domainId={row.id}
        domainName={row.name}
        ipAddress={row.ipAddress}
        setupState={state}
        open={logOpen}
        onOpenChange={setLogOpen}
      />
    </div>
  );
}
