import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, ShieldCheck, ChevronDown, Server, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { runDomainHealth } from "@/server/health-actions";
import { runRemediationPlan } from "@/server/remediation";
import { flushQueueForDomain } from "@/server/server-fixes";
import type { DomainHealth, HealthStatus, Indicator } from "@/server/health";
import { sortByPriority } from "@/server/health-checks";
import {
  buildRemediationPlan,
  summarizePlan,
  type RemediationPlan,
  type RemediationStep,
} from "@/server/remediation-planner";
import { RemediationPlanPanel } from "@/components/RemediationPlanPanel";
import { openConsole, type ConsoleLine } from "@/components/LiveConsole";
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

// Maps a health indicator id to the remediation plan ids (auto-steps AND manual notes) the planner
// can emit for it. Drives which rows get a "Fix" button and scopes a focused single-issue plan.
// Manual-only indicators (port25, blacklist) are absent by design — their guidance shows via the
// "How to fix" expander, not a Fix button.
const INDICATOR_PLAN_IDS: Record<string, string[]> = {
  containers: ["restartMailcow"],
  listeners: ["restartMailcow"],
  // fail → restart the stack; warn → create an API key. The planner emits whichever fits the
  // status, so the row surfaces the right one.
  mailcow: ["createApiKey", "restartMailcow"],
  mailhost: ["fixDns"],
  fcrdns: ["fixDns", "ptr"],
  firewall: ["openFirewall"],
  ipv6: ["forcePostfixIPv4"],
  queue: ["flushQueue", "queue-port25", "queue-reputation"],
  mx: ["pushDns"],
  spf: ["pushDns"],
  dmarc: ["pushDns"],
  dkim: ["syncDkim"],
};

// One group of indicators (Domain or Server), most-urgent first.
function IndicatorRows({
  indicators,
  busy,
  fixStepFor,
  onFix,
  onForceFlush,
}: {
  indicators: Indicator[];
  busy: boolean;
  fixStepFor: (indicatorId: string) => RemediationStep | null;
  onFix: (indicatorId: string) => void;
  onForceFlush: () => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <ul className="divide-y divide-border">
      {sortByPriority(indicators).map((ind) => {
        const isOpen = open[ind.id];
        const fixStep = fixStepFor(ind.id);
        return (
          <li key={ind.id} className="px-6 py-3">
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "status-dot",
                  DOT[ind.status],
                  ind.status === "fail" && "status-dot--pulse",
                )}
              />
              <span className="w-40 shrink-0 text-sm font-medium text-foreground">{ind.label}</span>
              <span className="flex-1 truncate text-sm text-muted-foreground" title={ind.detail}>
                {ind.detail}
              </span>
              {ind.id === "queue" && (ind.status === "fail" || ind.status === "warn") ? (
                // The queue always gets a direct "Flush now" that bypasses the planner's smart
                // gating — so a stuck queue can always be retried on demand, even when the planner
                // would otherwise withhold the flush (e.g. a suspected upstream block).
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={busy}
                  onClick={onForceFlush}
                  title="Run postqueue -f on the server now, regardless of the auto-heal plan"
                >
                  Flush now
                </Button>
              ) : (
                fixStep &&
                ind.status !== "ok" &&
                ind.status !== "skip" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    disabled={busy}
                    onClick={() => onFix(ind.id)}
                  >
                    {fixStep.label}
                  </Button>
                )
              )}
              {ind.fix && (
                <button
                  onClick={() => setOpen((o) => ({ ...o, [ind.id]: !o[ind.id] }))}
                  className="text-muted-foreground hover:text-foreground"
                  title="How to fix"
                >
                  <ChevronDown
                    className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")}
                  />
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
  hasCloudflareToken = true,
}: {
  domainId: string;
  serverIp?: string | null;
  initialHealth?: DomainHealth | null;
  initialServerHealth?: DomainHealth | null;
  initialCheckedAt?: string | null;
  // Only affects the CLIENT preview plan (un-proxy DNS shows as auto vs manual). The server
  // re-plans authoritatively from its own secrets, so a wrong default here is corrected on run.
  hasCloudflareToken?: boolean;
}) {
  const [health, setHealth] = useState<DomainHealth | null>(initialHealth ?? null);
  const [serverHealth, setServerHealth] = useState<DomainHealth | null>(
    initialServerHealth ?? null,
  );
  const [checkedAt, setCheckedAt] = useState<string | null>(initialCheckedAt ?? null);
  const [busy, setBusy] = useState(false);
  const [trendVersion, setTrendVersion] = useState(0); // bump to refetch the sparklines after a run

  // Auto-heal plan approval + live run state.
  const [plan, setPlan] = useState<RemediationPlan | null>(null);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [running, setRunning] = useState(false);

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

  // Direct "Flush now" override — runs postqueue -f on the server regardless of the planner's
  // gating, so a stuck queue can always be retried on demand, then re-checks so the row updates.
  const flushNow = useCallback(async () => {
    setBusy(true);
    toast.loading("Flushing the mail queue…", { id: "flushnow" });
    try {
      const res: any = await flushQueueForDomain({ data: { domainId } });
      if (res?.error) toast.error(res.error, { id: "flushnow" });
      else
        toast.success(`${res?.detail ?? "Queue flushed"} — re-checking…`, {
          id: "flushnow",
          duration: 7000,
        });
    } catch (e: any) {
      toast.error(e?.message ?? "Flush failed", { id: "flushnow" });
    } finally {
      await recheck();
    }
  }, [domainId, recheck]);

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

  // The current plan derived from live health — the preview shown on approval and the source for
  // which rows are auto-fixable. Pure + cheap, so recompute whenever health changes.
  const previewPlan = useMemo(
    () => (health ? buildRemediationPlan(health, serverHealth, { hasCloudflareToken }) : null),
    [health, serverHealth, hasCloudflareToken],
  );

  // The auto-step (if any) the planner would run for a given indicator — null means "no Fix button".
  const fixStepFor = useCallback(
    (indicatorId: string): RemediationStep | null => {
      const related = INDICATOR_PLAN_IDS[indicatorId] ?? [];
      return previewPlan?.steps.find((s) => related.includes(s.id)) ?? null;
    },
    [previewPlan],
  );

  const hasHealables =
    !!previewPlan && (previewPlan.steps.length > 0 || previewPlan.manual.length > 0);

  // Open the approval panel. No focus id -> the whole plan; a focus id -> just that indicator's
  // steps + manual notes, re-summarised so the header count matches what's shown.
  const openPlan = (focusId?: string) => {
    if (!previewPlan) return;
    let next = previewPlan;
    if (focusId) {
      const ids = INDICATOR_PLAN_IDS[focusId] ?? [];
      const steps = previewPlan.steps.filter((s) => ids.includes(s.id));
      const manual = previewPlan.manual.filter((m) => ids.includes(m.id));
      next = { steps, manual, summary: summarizePlan(steps, manual) };
    }
    setConsoleLines([]);
    setPlan(next);
  };

  const closePlan = () => {
    setPlan(null);
    setConsoleLines([]);
  };

  // Subscribe to the console stream (client-generated runId), run the approved steps, then re-check
  // so the persisted health + badge reflect the result (the run itself diagnoses but doesn't persist).
  const approve = async () => {
    if (!plan) return;
    setRunning(true);
    setConsoleLines([]);
    const { runId, close } = openConsole(setConsoleLines);
    try {
      const res: any = await runRemediationPlan({
        data: { domainId, stepIds: plan.steps.map((s) => s.id), runId },
      });
      if (Array.isArray(res?.transcript) && res.transcript.length) {
        setConsoleLines((prev) => (prev.length ? prev : res.transcript));
      }
      if (res?.error) toast.error(res.error);
      else {
        const applied = (res.ranSteps ?? []).filter((r: any) => r.status === "fixed").length;
        toast.success(`Applied ${applied} fix${applied === 1 ? "" : "es"} — re-checking…`);
      }
      await recheck();
    } catch (e: any) {
      toast.error(e?.message ?? "Auto-heal failed");
    } finally {
      close();
      setRunning(false);
    }
  };

  const overall = OVERALL[health?.status ?? "unknown"];
  const rowsBusy = busy || running;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <ShieldCheck className="h-5 w-5 text-muted-foreground" />
        <div className="flex-1">
          <h2 className="font-display text-base font-semibold text-foreground">
            Deliverability health
          </h2>
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
        {hasHealables && (
          <Button
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => openPlan()}
            disabled={rowsBusy}
            title="Diagnose and fix the issues in the right order"
          >
            <Wrench className="h-4 w-4" />
            Auto-heal
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-1.5"
          onClick={recheck}
          disabled={rowsBusy}
        >
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
          <IndicatorRows
            indicators={health.indicators}
            busy={rowsBusy}
            fixStepFor={fixStepFor}
            onFix={openPlan}
            onForceFlush={flushNow}
          />

          <div className="flex items-center justify-between border-t border-border px-6 pt-4 pb-1">
            <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              <Server className="h-3.5 w-3.5" />
              Server{serverIp ? ` — ${serverIp}` : ""}
            </span>
            {serverIp && <HealthTrend scope="server" targetKey={serverIp} version={trendVersion} />}
          </div>
          {serverHealth ? (
            <IndicatorRows
              indicators={serverHealth.indicators}
              busy={rowsBusy}
              fixStepFor={fixStepFor}
              onFix={openPlan}
              onForceFlush={flushNow}
            />
          ) : (
            <div className="px-6 py-3 text-sm text-muted-foreground">
              {busy ? "Checking server…" : "No server result yet — Re-check to run server checks."}
            </div>
          )}

          {plan && (
            <div className="border-t border-border p-6">
              <RemediationPlanPanel
                plan={plan}
                running={running}
                consoleLines={consoleLines}
                onApprove={approve}
                onClose={closePlan}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
