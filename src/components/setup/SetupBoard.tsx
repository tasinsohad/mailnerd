import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Rocket } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getJobSetupBoard, startJobSetup } from "@/server/domain-setup-fns";
import { isActive, type SetupState } from "@/lib/setup-state";
import { canStartJobSetup, jobBoardSummary, summaryText } from "@/lib/setup-status";
import { SetupRow, toSetupRowData } from "./SetupRow";

function domainsCount(n: number): string {
  return `${n} domain${n === 1 ? "" : "s"}`;
}

// The job's setup board: every domain's server-side setup run (DNS → server → mailboxes → DKIM), with one
// button to start them all. Runs keep going on the server, so the board only reads and polls: every 3 s
// while any run is queued, running or waiting for the user.
export function SetupBoard({ batchId }: { batchId: string }) {
  const qc = useQueryClient();
  const board = useQuery({
    queryKey: ["setup-board", batchId],
    queryFn: () => getJobSetupBoard({ data: { batchId } }),
    refetchInterval: (query) => {
      const rows = (query.state.data as { domains?: { setupState?: unknown }[] } | undefined)?.domains ?? [];
      return rows.some((r) => isActive(r.setupState as SetupState | null)) ? 3000 : false;
    },
  });

  const rows = ((board.data?.domains ?? []) as Parameters<typeof toSetupRowData>[0][]).map(toSetupRowData);
  const summary = summaryText(jobBoardSummary(rows));
  const canStart = canStartJobSetup(rows);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["setup-board", batchId] });
    qc.invalidateQueries({ queryKey: ["batch", batchId] });
  };

  // When a run moves on (a step finishes, a run ends), the rest of the job page changes with it: domain
  // statuses, and the mailboxes the export lists. Refetch the job's details then.
  const signature = rows
    .map((r) => `${r.id}:${r.setupState?.runId}:${r.setupState?.status}:${r.setupState?.step}`)
    .join("|");
  const lastSignature = useRef<string | null>(null);
  useEffect(() => {
    if (!board.data) return;
    if (lastSignature.current !== null && lastSignature.current !== signature) {
      qc.invalidateQueries({ queryKey: ["batch", batchId] });
    }
    lastSignature.current = signature;
  }, [signature, board.data, batchId, qc]);

  const startAll = useMutation({
    mutationFn: () => startJobSetup({ data: { batchId } }),
    onSuccess: (res) => {
      const { started, skipped, errors } = res;
      const skippedText = skipped ? ` ${skipped} already set up or running.` : "";
      if (started > 0) {
        toast.success(
          `Setup started for ${domainsCount(started)}. It keeps running if you close this page.${skippedText}`,
        );
      } else if (!errors.length) {
        toast.info("Nothing to start: every domain is already set up or running.");
      }
      if (errors.length) {
        toast.error(
          `Couldn't start ${domainsCount(errors.length)}: ${errors.map((e) => `${e.domain}: ${e.error}`).join("; ")}`,
          { duration: 15000 },
        );
      }
      refresh();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err));
      refresh();
    },
  });

  return (
    <section
      aria-labelledby="setup-board-title"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-border px-4 py-4 sm:px-5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id="setup-board-title" className="font-display text-base font-semibold text-foreground">
            Setup
          </h2>
          {summary && <p className="text-sm text-muted-foreground">{summary}</p>}
        </div>
        <Button
          className="h-11 w-full gap-2 sm:w-auto"
          onClick={() => startAll.mutate()}
          disabled={!canStart || startAll.isPending}
          title={!canStart && rows.length ? "Every domain is set up or already running" : undefined}
        >
          {startAll.isPending ? <Loader2 className="animate-spin" /> : <Rocket />}
          Set up everything
        </Button>
      </div>

      {board.isLoading ? (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground sm:px-5">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading setup…
        </div>
      ) : board.isError ? (
        <div className="flex flex-wrap items-center gap-3 px-4 py-4 text-sm sm:px-5">
          <span className="min-w-0 break-words text-destructive">
            Couldn't load the setup board:{" "}
            {board.error instanceof Error ? board.error.message : String(board.error)}
          </span>
          <Button variant="outline" size="sm" className="h-9" onClick={() => board.refetch()}>
            Try again
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">This job has no domains.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id}>
              <SetupRow row={row} onChanged={refresh} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
