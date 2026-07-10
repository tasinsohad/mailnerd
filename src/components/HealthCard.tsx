import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, ShieldCheck, ChevronDown, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { runDomainHealth } from "@/server/health-actions";
import type { DomainHealth, HealthAction, HealthStatus, Indicator } from "@/server/health";
import { sortByPriority } from "@/server/health-checks";
import { ACTION_LABEL, runHealthFix } from "@/lib/health-fixes";
import { HealthTrend } from "@/components/HealthTrend";

const DOT: Record<HealthStatus, string> = {
  ok: "text-success",
  warn: "text-warning",
  fail: "text-destructive",
  skip: "text-muted-foreground",
};

const OVERALL: Record<string, { color: string; label: string }> = {
  healthy: { color: "text-success", label: "Healthy" },
  warning: { color: "text-warning", label: "Needs attention" },
  critical: { color: "text-destructive", label: "Critical" },
  unknown: { color: "text-muted-foreground", label: "Not checked" },
};

// One group of indicators (Domain or Server), most-urgent first.
function IndicatorRows({
  indicators,
  busy,
  onFix,
}: {
  indicators: Indicator[];
  busy: boolean;
  onFix: (action: HealthAction) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <ul className="divide-y divide-border">
      {sortByPriority(indicators).map((ind) => {
        const isOpen = open[ind.id];
        return (
          <li key={ind.id} className="px-6 py-3">
            <div className="flex items-center gap-3">
              <span className={cn("status-dot", DOT[ind.status], ind.status === "fail" && "status-dot--pulse")} />
              <span className="w-40 shrink-0 text-sm font-medium text-foreground">{ind.label}</span>
              <span className="flex-1 truncate text-sm text-muted-foreground" title={ind.detail}>
                {ind.detail}
              </span>
              {ind.action && ind.status !== "ok" && ind.status !== "skip" && (
                <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => onFix(ind.action!)}>
                  {ACTION_LABEL[ind.action]}
                </Button>
              )}
              {ind.fix && (
                <button
                  onClick={() => setOpen((o) => ({ ...o, [ind.id]: !o[ind.id] }))}
                  className="text-muted-foreground hover:text-foreground"
                  title="How to fix"
                >
                  <ChevronDown className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")} />
                </button>
              )}
            </div>
            {isOpen && ind.fix && (
              <div className="mt-2 ml-7 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">How to fix: </span>
                {ind.fix}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function HealthCard({
  domainId,
  serverIp,
  initialHealth,
  initialServerHealth,
  initialCheckedAt,
}: {
  domainId: string;
  serverIp?: string | null;
  initialHealth?: DomainHealth | null;
  initialServerHealth?: DomainHealth | null;
  initialCheckedAt?: string | null;
}) {
  const [health, setHealth] = useState<DomainHealth | null>(initialHealth ?? null);
  const [serverHealth, setServerHealth] = useState<DomainHealth | null>(initialServerHealth ?? null);
  const [checkedAt, setCheckedAt] = useState<string | null>(initialCheckedAt ?? null);
  const [busy, setBusy] = useState(false);
  const [trendVersion, setTrendVersion] = useState(0); // bump to refetch the sparklines after a run

  const recheck = useCallback(async () => {
    setBusy(true);
    try {
      const res: any = await runDomainHealth({ data: { domainId } });
      if (res?.error) toast.error(res.error);
      else {
        if (res?.health) {
          setHealth(res.health);
          setCheckedAt(res.health.checkedAt);
        }
        if (res?.serverHealth) setServerHealth(res.serverHealth);
        setTrendVersion((v) => v + 1);
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Health check failed");
    } finally {
      setBusy(false);
    }
  }, [domainId]);

  useEffect(() => {
    if (!health && !busy) void recheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync from props when the parent refetches (e.g. the header "Troubleshoot" button ran a check),
  // and refresh the sparklines to include the new run.
  useEffect(() => {
    if (initialHealth) {
      setHealth(initialHealth);
      setCheckedAt(initialCheckedAt ?? null);
    }
    if (initialServerHealth) setServerHealth(initialServerHealth);
    setTrendVersion((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialHealth, initialServerHealth, initialCheckedAt]);

  const runFix = async (action: HealthAction) => {
    setBusy(true);
    toast.loading(`${ACTION_LABEL[action]}…`, { id: "healthfix" });
    try {
      const res: any = await runHealthFix(action, domainId);
      if (res?.error) toast.error(res.error, { id: "healthfix" });
      else toast.success(`${ACTION_LABEL[action]} done — re-checking…`, { id: "healthfix" });
    } catch (e: any) {
      toast.error(e?.message ?? "Fix failed", { id: "healthfix" });
    } finally {
      await recheck();
    }
  };

  const overall = OVERALL[health?.status ?? "unknown"];

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <ShieldCheck className="h-5 w-5 text-muted-foreground" />
        <div className="flex-1">
          <h2 className="font-display text-base font-semibold text-foreground">Deliverability health</h2>
          <div className="text-xs text-muted-foreground">
            {checkedAt ? `Checked ${new Date(checkedAt).toLocaleString()}` : "Not checked yet"}
          </div>
        </div>
        {health && (
          <span className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs font-medium">
            <span className={cn("status-dot", overall.color)} />
            {overall.label}
            <span className="ident text-muted-foreground">{health.score}%</span>
          </span>
        )}
        <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={recheck} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Re-check
        </Button>
      </div>

      {!health ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {busy ? "Running checks…" : "No result yet."}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between px-6 pt-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Domain — DNS authentication
            </span>
            <HealthTrend scope="domain" targetKey={domainId} version={trendVersion} />
          </div>
          <IndicatorRows indicators={health.indicators} busy={busy} onFix={runFix} />

          <div className="flex items-center justify-between border-t border-border px-6 pt-4 pb-1">
            <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              <Server className="h-3.5 w-3.5" />
              Server{serverIp ? ` — ${serverIp}` : ""}
            </span>
            {serverIp && <HealthTrend scope="server" targetKey={serverIp} version={trendVersion} />}
          </div>
          {serverHealth ? (
            <IndicatorRows indicators={serverHealth.indicators} busy={busy} onFix={runFix} />
          ) : (
            <div className="px-6 py-3 text-sm text-muted-foreground">
              {busy ? "Checking server…" : "No server result yet — Re-check to run server checks."}
            </div>
          )}
        </>
      )}
    </div>
  );
}
