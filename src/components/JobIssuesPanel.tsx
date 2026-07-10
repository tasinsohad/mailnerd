import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, Wrench, AlertTriangle, CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { HealthAction, DomainHealth, Indicator } from "@/server/health";
import { runJobHealth, getBatchServerHealth } from "@/server/health-actions";
import { ACTION_LABEL, ACTION_ORDER, DESTRUCTIVE_ACTIONS, runHealthFix } from "@/lib/health-fixes";

type Domain = { id: string; name: string; ipAddress?: string | null; health?: DomainHealth | null };

// One recommended fix, aggregated across the job's domains/servers.
interface FixBucket {
  action: HealthAction;
  domainIds: string[];
  domainNames: string[];
  issueLabels: string[];
  hasFail: boolean;
}

// A manual issue (no auto-fix) — surfaced with its remediation. Scopes are domain names or server IPs.
interface ManualIssue {
  id: string;
  label: string;
  fix: string;
  hasFail: boolean;
  scopes: string[];
}

interface ServerIssues {
  ip: string;
  indicators: Indicator[];
  repDomain: { id: string; name: string } | null;
}

function collect(domains: Domain[], servers: ServerIssues[]): { fixes: FixBucket[]; manual: ManualIssue[] } {
  const byAction = new Map<HealthAction, FixBucket>();
  const manual = new Map<string, ManualIssue>();

  const addFix = (action: HealthAction, domainId: string | null, domainName: string, label: string, isFail: boolean) => {
    let b = byAction.get(action);
    if (!b) {
      b = { action, domainIds: [], domainNames: [], issueLabels: [], hasFail: false };
      byAction.set(action, b);
    }
    if (domainId && !b.domainIds.includes(domainId)) {
      b.domainIds.push(domainId);
      b.domainNames.push(domainName);
    }
    if (!b.issueLabels.includes(label)) b.issueLabels.push(label);
    if (isFail) b.hasFail = true;
  };

  const addManual = (key: string, label: string, fix: string, scope: string, isFail: boolean) => {
    let m = manual.get(key);
    if (!m) {
      m = { id: key, label, fix, hasFail: false, scopes: [] };
      manual.set(key, m);
    }
    if (!m.scopes.includes(scope)) m.scopes.push(scope);
    if (isFail) m.hasFail = true;
  };

  // Domain (DNS-auth) issues.
  for (const d of domains) {
    for (const ind of (d.health?.indicators ?? []) as Indicator[]) {
      if (ind.status !== "fail" && ind.status !== "warn") continue;
      if (ind.action) addFix(ind.action, d.id, d.name, ind.label, ind.status === "fail");
      else if (ind.fix) addManual(ind.id, ind.label, ind.fix, d.name, ind.status === "fail");
    }
  }

  // Server (VPS/IP) issues — actionable ones run on a representative domain of that IP.
  for (const s of servers) {
    for (const ind of s.indicators) {
      if (ind.status !== "fail" && ind.status !== "warn") continue;
      if (ind.action && s.repDomain) {
        addFix(ind.action, s.repDomain.id, s.repDomain.name, `${ind.label} · ${s.ip}`, ind.status === "fail");
      } else if (ind.fix) {
        addManual(`${ind.id}@${s.ip}`, `${ind.label} (server)`, ind.fix, s.ip, ind.status === "fail");
      }
    }
  }

  const fixes = (ACTION_ORDER.map((a) => byAction.get(a)).filter(Boolean) as FixBucket[]).sort(
    (a, b) => Number(b.hasFail) - Number(a.hasFail),
  );
  const manualList = [...manual.values()].sort((a, b) => Number(b.hasFail) - Number(a.hasFail));
  return { fixes, manual: manualList };
}

function scopeLabel(scopes: string[]): string {
  if (scopes.length <= 3) return scopes.join(", ");
  return `${scopes.slice(0, 3).join(", ")} +${scopes.length - 3} more`;
}

// Job-level troubleshooting results: every open issue across the job's domains AND servers, grouped
// by the fix that resolves it (run across only the affected targets) with remediation for the rest.
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

  const { data: serverData } = useQuery({
    queryKey: ["batch-server-health", batchId],
    queryFn: () => getBatchServerHealth({ data: { batchId } }),
  });

  // Map each server IP to a representative domain (for running server fixes) and its issues.
  const ipToRep = new Map<string, { id: string; name: string }>();
  for (const d of domains) if (d.ipAddress && !ipToRep.has(d.ipAddress)) ipToRep.set(d.ipAddress, { id: d.id, name: d.name });
  const servers: ServerIssues[] = (((serverData as any)?.servers ?? []) as any[]).map((s) => ({
    ip: s.ipAddress,
    indicators: (s.health?.indicators ?? []) as Indicator[],
    repDomain: ipToRep.get(s.ipAddress) ?? null,
  }));

  const { fixes, manual } = collect(domains, servers);

  if (fixes.length === 0 && manual.length === 0) return null;

  const runFix = async (bucket: FixBucket) => {
    const label = ACTION_LABEL[bucket.action];
    const n = bucket.domainIds.length;
    if (DESTRUCTIVE_ACTIONS.has(bucket.action)) {
      const verb = bucket.action === "provision" ? "wipe & re-provision" : "delete & recreate mailboxes for";
      if (!confirm(`This will ${verb} ${n} target${n === 1 ? "" : "s"}. Continue?`)) return;
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
    toast.loading(`Re-checking ${n} target${n === 1 ? "" : "s"}…`, { id: "jobfix" });
    try {
      await runJobHealth({ data: { batchId } });
    } catch {
      /* non-fatal */
    }
    setRunningAction(null);
    onChanged?.();
    toast[fail ? "error" : "success"](
      `${label}: ${ok} ok${fail ? `, ${fail} failed` : ""}.`,
      { id: "jobfix", duration: 8000 },
    );
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <Wrench className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-display text-base font-semibold text-foreground">Troubleshooting</h2>
        <span className="text-xs text-muted-foreground">Issues across this job's domains &amp; servers</span>
      </div>

      {fixes.length > 0 && (
        <ul className="divide-y divide-border">
          {fixes.map((b) => (
            <li key={b.action} className="flex items-center gap-4 px-6 py-4">
              <span className={cn("status-dot shrink-0", b.hasFail ? "text-destructive status-dot--pulse" : "text-warning")} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  {b.hasFail ? <CircleAlert className="h-4 w-4 text-destructive" /> : <AlertTriangle className="h-4 w-4 text-warning" />}
                  {ACTION_LABEL[b.action]}
                  <span className="text-xs font-normal text-muted-foreground">fixes {b.issueLabels.join(" / ")}</span>
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground" title={b.domainNames.join(", ")}>
                  {b.domainIds.length} target{b.domainIds.length === 1 ? "" : "s"}: {scopeLabel(b.domainNames)}
                </div>
              </div>
              <Button
                size="sm"
                variant={b.hasFail ? "default" : "outline"}
                className="h-9 shrink-0 gap-1.5"
                disabled={runningAction !== null}
                onClick={() => runFix(b)}
              >
                {runningAction === b.action ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
                Fix {b.domainIds.length}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {manual.length > 0 && (
        <div className="border-t border-border px-6 py-4">
          <div className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Needs your action — no automatic fix
          </div>
          <ul className="flex flex-col gap-3">
            {manual.map((m) => (
              <li key={m.id} className="text-sm">
                <div className="flex items-center gap-2">
                  <span className={cn("status-dot", m.hasFail ? "text-destructive" : "text-warning")} />
                  <span className="font-medium text-foreground">{m.label}</span>
                  <span className="text-xs text-muted-foreground">{m.scopes.length}×</span>
                </div>
                <div className="mt-0.5 ml-4 text-xs text-muted-foreground">{m.fix}</div>
                <div className="ml-4 truncate text-[11px] text-muted-foreground/80" title={m.scopes.join(", ")}>
                  {scopeLabel(m.scopes)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
