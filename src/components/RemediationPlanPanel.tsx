import { Button } from "@/components/ui/button";
import { Loader2, Wrench, TriangleAlert } from "lucide-react";
import { LiveConsole, type ConsoleLine } from "@/components/LiveConsole";
import type { RemediationPlan } from "@/server/remediation-planner";

export function RemediationPlanPanel({
  plan,
  running,
  consoleLines,
  onApprove,
  onClose,
}: {
  plan: RemediationPlan;
  running: boolean;
  consoleLines: ConsoleLine[];
  onApprove: () => void;
  onClose: () => void;
}) {
  const hasSteps = plan.steps.length > 0;
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Wrench className="h-4 w-4 text-primary" />
        <h3 className="font-display text-sm font-semibold text-foreground">Auto-heal plan</h3>
        <span className="ml-auto text-xs text-muted-foreground">{plan.summary}</span>
      </div>

      {hasSteps ? (
        <ol className="flex flex-col gap-2">
          {plan.steps.map((s, i) => (
            <li
              key={s.id}
              className="flex gap-3 rounded-lg border border-border bg-background/60 p-3"
            >
              <span className="ident text-xs text-muted-foreground">{i + 1}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                  {s.label}
                  {s.disruptive && (
                    <span className="rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                      brief mail interruption
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground text-pretty">{s.why}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing to auto-fix.</p>
      )}

      {plan.manual.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold text-foreground">Manual — can’t auto-fix</h4>
          {plan.manual.map((m) => (
            <div
              key={m.id}
              className="flex gap-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground"
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span>
                <span className="font-medium text-foreground">{m.label}. </span>
                {m.why}
              </span>
            </div>
          ))}
        </div>
      )}

      {(running || consoleLines.length > 0) && (
        <LiveConsole lines={consoleLines} running={running} filenameBase="auto-heal" />
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={running}>
          Close
        </Button>
        {hasSteps && (
          <Button onClick={onApprove} disabled={running} className="gap-1.5">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
            Approve &amp; run
          </Button>
        )}
      </div>
    </div>
  );
}
