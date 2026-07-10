import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Wrench, AlertTriangle, CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { HealthAction, DomainHealth, Indicator } from "@/server/health";
import { runJobHealth } from "@/server/health-actions";
import {
  ACTION_LABEL,
  ACTION_ORDER,
  DESTRUCTIVE_ACTIONS,
  runHealthFix,
} from "@/lib/health-fixes";

type Domain = { id: string; name: string; health?: DomainHealth | null };

// One recommended fix, aggregated across the job's domains.
interface FixBucket {
  action: HealthAction;
  domainIds: string[];
  domainNames: string[];
  issueLabels: string[]; // e.g. ["MX records", "SPF"]
  hasFail: boolean; // any affected indicator is a hard fail (vs warn)
}

// A manual issue (no auto-fix action) — surfaced with its instruction text.
interface ManualIssue {
  id: string;
  label: string;
  fix: string;
  domainNames: string[];
}

function collect(domains: Domain[]): { fixes: FixBucket[]; manual: ManualIssue[] } {
  const byAction = new Map<HealthAction, FixBucket>();
  const manualById = new Map<string, ManualIssue>();

  for (const d of domains) {
    const indicators: Indicator[] = d.health?.indicators ?? [];
    for (const ind of indicators) {
      if (ind.status !== "fail" && ind.status !== "warn") continue;

      if (ind.action) {
        let b = byAction.get(ind.action);
        if (!b) {
          b = { action: ind.action, domainIds: [], domainNames: [], issueLabels: [], hasFail: false };
          byAction.set(ind.action, b);
        }
        if (!b.domainIds.includes(d.id)) {
          b.domainIds.push(d.id);
          b.domainNames.push(d.name);
        }
        if (!b.issueLabels.includes(ind.label)) b.issueLabels.push(ind.label);
        if (ind.status === "fail") b.hasFail = true;
      } else if (ind.fix) {
        let m = manualById.get(ind.id);
        if (!m) {
          m = { id: ind.id, label: ind.label, fix: ind.fix, domainNames: [] };
          manualById.set(ind.id, m);
        }
        if (!m.domainNames.includes(d.name)) m.domainNames.push(d.name);
      }
    }
  }

  const fixes = ACTION_ORDER.map((a) => byAction.get(a)).filter(Boolean) as FixBucket[];
  // Criticals (hard fails) first.
  fixes.sort((a, b) => Number(b.hasFail) - Number(a.hasFail));
  return { fixes, manual: [...manualById.values()] };
}

function namesLabel(names: string[]): string {
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

// Job-level "Recommended fixes": groups the domains' health issues by the fix that resolves them
// and runs each fix across only its affected domains, then re-scans the job.
export function JobIssuesPanel({
  batchId,
  domains,
  onChanged,
}: {
  batchId: string;
  domains: Domain[];
  onChanged?: () => void;
}) {
  const [runningAction, setRunningAction] = useState<HealthAction | null>(null);
  const { fixes, manual } = collect(domains);

  if (fixes.length === 0 && manual.length === 0) return null;

  const runFix = async (bucket: FixBucket) => {
    const label = ACTION_LABEL[bucket.action];
    const n = bucket.domainIds.length;
    if (DESTRUCTIVE_ACTIONS.has(bucket.action)) {
      const verb = bucket.action === "provision" ? "wipe & re-provision" : "delete & recreate mailboxes for";
      if (!confirm(`This will ${verb} ${n} domain${n === 1 ? "" : "s"}. Continue?`)) return;
    }

    setRunningAction(bucket.action);
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < n; i++) {
      toast.loading(`${label} — ${i + 1}/${n}…`, { id: "jobfix" });
      try {
        const res: any = await runHealthFix(bucket.action, bucket.domainIds[i]);
        if (res?.error || (res?.summary && res.summary.failed > 0)) fail++;
        else ok++;
      } catch {
        fail++;
      }
    }

    toast.loading(`Re-checking ${n} domain${n === 1 ? "" : "s"}…`, { id: "jobfix" });
    try {
      await runJobHealth({ data: { batchId } });
    } catch {
      /* re-check failure is non-fatal; the fixes still ran */
    }
    setRunningAction(null);
    onChanged?.();
    toast[fail ? "error" : "success"](
      `${label}: ${ok} ok${fail ? `, ${fail} failed` : ""} across ${n} domain${n === 1 ? "" : "s"}.`,
      { id: "jobfix", duration: 8000 },
    );
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <Wrench className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-display text-base font-semibold text-foreground">Recommended fixes</h2>
        <span className="text-xs text-muted-foreground">
          Resolve issues across the job's domains in one click
        </span>
      </div>

      {fixes.length > 0 ? (
        <ul className="divide-y divide-border">
          {fixes.map((b) => (
            <li key={b.action} className="flex items-center gap-4 px-6 py-4">
              <span
                className={cn(
                  "status-dot shrink-0",
                  b.hasFail ? "text-destructive status-dot--pulse" : "text-warning",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  {b.hasFail ? (
                    <CircleAlert className="h-4 w-4 text-destructive" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-warning" />
                  )}
                  {ACTION_LABEL[b.action]}
                  <span className="text-xs font-normal text-muted-foreground">
                    fixes {b.issueLabels.join(" / ")}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground" title={b.domainNames.join(", ")}>
                  {b.domainIds.length} domain{b.domainIds.length === 1 ? "" : "s"}: {namesLabel(b.domainNames)}
                </div>
              </div>
              <Button
                size="sm"
                variant={b.hasFail ? "default" : "outline"}
                className="h-9 shrink-0 gap-1.5"
                disabled={runningAction !== null}
                onClick={() => runFix(b)}
              >
                {runningAction === b.action ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Wrench className="h-4 w-4" />
                )}
                Fix {b.domainIds.length} domain{b.domainIds.length === 1 ? "" : "s"}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {manual.length > 0 && (
        <div className="border-t border-border px-6 py-4">
          <div className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Manual — no automatic fix
          </div>
          <ul className="flex flex-col gap-3">
            {manual.map((m) => (
              <li key={m.id} className="text-sm">
                <span className="font-medium text-foreground">{m.label}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {m.domainNames.length} domain{m.domainNames.length === 1 ? "" : "s"}
                </span>
                <div className="mt-0.5 text-xs text-muted-foreground">{m.fix}</div>
                <div className="truncate text-[11px] text-muted-foreground/80" title={m.domainNames.join(", ")}>
                  {namesLabel(m.domainNames)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
