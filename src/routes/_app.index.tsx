import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getOverviewStats } from "@/server/stats";
import { getHealthOverview, runAllHealth } from "@/server/health-actions";
import { listDomains } from "@/server/domains";
import { ArrowUpRight, Check, Loader2, RefreshCw, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/StatusPill";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/")({
  component: IndexPage,
});

const IN_FLIGHT = new Set(["provisioning", "configuring", "queued", "pending"]);
const FAILED = new Set(["failed", "error"]);

const HEALTH_BAR: { key: "healthy" | "warning" | "critical" | "unknown"; cls: string; status: string }[] = [
  { key: "healthy", cls: "bg-success", status: "healthy" },
  { key: "warning", cls: "bg-warning", status: "warning" },
  { key: "critical", cls: "bg-destructive", status: "critical" },
  { key: "unknown", cls: "bg-input", status: "unknown" },
];

/* One cell of the KPI band: a number in ink with its label above and one line of context under it. */
function Kpi({ label, value, sub, progress }: { label: string; value: string; sub?: string; progress?: number }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-4 sm:px-5">
      <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
      <span className="font-display text-[28px] font-semibold leading-8 tracking-tight tabular-nums text-foreground">
        {value}
      </span>
      {typeof progress === "number" && (
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-success" style={{ width: `${Math.min(100, Math.round(progress * 100))}%` }} />
        </div>
      )}
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

function IndexPage() {
  const qc = useQueryClient();
  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ["overview-stats"],
    queryFn: () => getOverviewStats(),
  });
  const { data: health } = useQuery({ queryKey: ["health-overview"], queryFn: () => getHealthOverview() });
  const { data: domains = [], isLoading: domainsLoading } = useQuery({
    queryKey: ["domains", "all"],
    queryFn: () => listDomains({ data: {} }),
  });

  const recheck = useMutation({
    mutationFn: () => {
      toast.loading("Checking all domains…", { id: "health-all" });
      return runAllHealth({ data: {} });
    },
    onSuccess: (res: any) => {
      if (res?.error) toast.error(res.error, { id: "health-all" });
      else toast.success("Health check complete", { id: "health-all" });
      qc.invalidateQueries({ queryKey: ["health-overview"] });
    },
    onError: (e: any) => toast.error(e.message, { id: "health-all" }),
  });

  const loading = statsLoading || domainsLoading;
  const counts = health?.counts ?? { healthy: 0, warning: 0, critical: 0, unknown: 0 };
  const issues: any[] = health?.topIssues ?? [];
  const healthTotal = HEALTH_BAR.reduce((n, c) => n + (counts[c.key] ?? 0), 0);

  const failedDomains = (domains as any[]).filter((d) => FAILED.has(String(d.status ?? "").toLowerCase()));
  const inFlight = (domains as any[]).filter((d) => IN_FLIGHT.has(String(d.status ?? "").toLowerCase()));
  const plannedTotal = (domains as any[]).reduce((n, d) => n + (d.plannedInboxCount ?? 0), 0);
  const createdTotal = (domains as any[]).reduce((n, d) => n + (d.createdInboxCount ?? 0), 0);
  const needsYou = failedDomains.length + (counts.critical ?? 0) + (counts.warning ?? 0);

  // In-flight domains grouped by job, for the "Provisioning now" table.
  const jobs = new Map<string, { id: string; name: string; domains: any[] }>();
  for (const d of inFlight) {
    const id = d.batchId ?? "none";
    if (!jobs.has(id)) jobs.set(id, { id, name: d.batchName ?? "No job", domains: [] });
    jobs.get(id)!.domains.push(d);
  }
  const runningJobs = [...jobs.values()];

  const hasDomains = (stats?.totalDomains ?? 0) > 0 || (domains as any[]).length > 0;
  const summary = loading
    ? ""
    : `${stats?.totalDomains ?? 0} domain${stats?.totalDomains === 1 ? "" : "s"} across ${stats?.totalServers ?? 0} server${stats?.totalServers === 1 ? "" : "s"}.${needsYou > 0 ? ` ${needsYou} thing${needsYou === 1 ? "" : "s"} need${needsYou === 1 ? "s" : ""} you.` : " Nothing needs you right now."}`;

  if (!loading && !hasDomains) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
        <div>
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-foreground">Overview</h1>
        </div>
        <div className="elev-card rounded-xl border border-border bg-card">
          <div className="max-w-md px-6 py-10 sm:px-8">
            <h2 className="font-display text-[15px] font-semibold text-foreground">No domains yet</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A domain needs a server and DNS before it can send. Set up in this order:
            </p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Add a server (Contabo or any SSH host)</li>
              <li>Connect Cloudflare in Settings</li>
              <li>Add domains and start a job</li>
            </ol>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button asChild className="gap-2">
                <Link to="/servers">
                  <TrendingUp className="h-4 w-4" /> Add a server
                </Link>
              </Button>
              <Button asChild variant="ghost">
                <Link to="/settings">Open settings</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 p-4 sm:p-6 lg:p-8">
      {/* Header: the verdict, then the one action that refreshes it */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-foreground">Overview</h1>
          {loading ? (
            <div className="mt-1.5 h-4 w-72 animate-pulse rounded bg-muted" />
          ) : (
            <p className="mt-0.5 text-sm text-muted-foreground">{summary}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {health?.lastCheckedAt ? `Checked ${new Date(health.lastCheckedAt).toLocaleString()}` : "Not checked yet"}
          </span>
          <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
            {recheck.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Re-check all
          </Button>
        </div>
      </div>

      {/* KPI band: four numbers, one panel, hairline-divided */}
      {loading ? (
        <div className="elev-card h-[104px] animate-pulse rounded-xl border border-border bg-card" />
      ) : (
        <div className="elev-card grid grid-cols-2 divide-y divide-border rounded-xl border border-border bg-card sm:grid-cols-4 sm:divide-x sm:divide-y-0">
          <Kpi
            label="Domains"
            value={(stats?.totalDomains ?? 0).toLocaleString()}
            sub={counts.healthy > 0 ? `${counts.healthy} healthy` : undefined}
          />
          <Kpi
            label="Mailboxes"
            value={createdTotal.toLocaleString()}
            sub={plannedTotal > 0 ? `of ${plannedTotal.toLocaleString()} planned` : "none planned yet"}
            progress={plannedTotal > 0 ? createdTotal / plannedTotal : undefined}
          />
          <Kpi label="Servers" value={(stats?.totalServers ?? 0).toLocaleString()} sub="registered" />
          <Kpi
            label="In flight"
            value={inFlight.length.toLocaleString()}
            sub={inFlight.length > 0 ? `across ${runningJobs.length} job${runningJobs.length === 1 ? "" : "s"}` : "nothing provisioning"}
          />
        </div>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-3">
        {/* Needs you now: problems in the order to fix them, each with its route to the fix */}
        <div className="elev-card rounded-xl border border-border bg-card lg:col-span-2">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
            <h2 className="font-display text-[15px] font-semibold text-foreground">Needs you now</h2>
            <span className="text-xs text-muted-foreground">
              {failedDomains.length + issues.length === 0 ? "clear" : `${failedDomains.length + issues.length} item${failedDomains.length + issues.length === 1 ? "" : "s"}`}
            </span>
          </div>
          {failedDomains.length === 0 && issues.length === 0 ? (
            <div className="flex items-center gap-2.5 px-4 py-6 text-sm text-muted-foreground sm:px-5">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success-soft text-success">
                <Check className="h-3.5 w-3.5" />
              </span>
              Everything is passing. {health?.lastCheckedAt ? `Last checked ${new Date(health.lastCheckedAt).toLocaleTimeString()}.` : "Run a check to confirm."}
            </div>
          ) : (
            <ul className="flex flex-col">
              {failedDomains.slice(0, 5).map((d: any) => (
                <li key={d.id} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:px-5">
                  <StatusPill status={d.status} className="shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      <span className="ident">{d.name}</span> stopped during setup
                    </div>
                    <div className="truncate text-[13px] text-muted-foreground">
                      {d.batchName ? `Job: ${d.batchName}. ` : ""}Open the domain to see the failing step and retry.
                    </div>
                  </div>
                  <Button asChild variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs">
                    <Link to="/domains/$id" params={{ id: d.id }}>Open</Link>
                  </Button>
                </li>
              ))}
              {issues.slice(0, 4).map((iss: any) => (
                <li key={iss.label} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:px-5">
                  <StatusPill status="warning" className="shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{iss.label}</div>
                    <div className="text-[13px] text-muted-foreground">
                      Affects {iss.count} domain{iss.count === 1 ? "" : "s"}
                    </div>
                  </div>
                  <Button asChild variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs">
                    <Link to="/troubleshoot">Fix</Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Deliverability: the four states as one segmented bar, then the legend with counts */}
        <div className="elev-card rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
            <h2 className="font-display text-[15px] font-semibold text-foreground">Deliverability</h2>
            <Link to="/troubleshoot" className="text-xs font-medium text-brand hover:underline">
              Troubleshoot
            </Link>
          </div>
          <div className="flex flex-col gap-4 p-4 sm:p-5">
            {healthTotal > 0 ? (
              <div
                className="flex h-2 gap-0.5 overflow-hidden rounded-full"
                role="img"
                aria-label={`${counts.healthy} healthy, ${counts.warning} need attention, ${counts.critical} critical, ${counts.unknown} not checked`}
              >
                {HEALTH_BAR.filter((c) => (counts[c.key] ?? 0) > 0).map((c) => (
                  <span key={c.key} className={`${c.cls} min-w-[3px] rounded-[2px]`} style={{ flex: counts[c.key] }} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No checks recorded yet. Run "Re-check all".</p>
            )}
            <div className="flex flex-col">
              {HEALTH_BAR.map((c, i) => (
                <div key={c.key} className={`flex items-center justify-between gap-2 py-2 ${i > 0 ? "border-t border-border" : ""}`}>
                  <StatusPill status={c.status} />
                  <span className="font-display text-sm font-semibold tabular-nums text-foreground">{counts[c.key] ?? 0}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Provisioning now: only present while work is moving */}
      {runningJobs.length > 0 && (
        <div className="elev-card overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
            <h2 className="font-display text-[15px] font-semibold text-foreground">Provisioning now</h2>
            <Link to="/jobs" className="text-xs font-medium text-brand hover:underline">
              All jobs
            </Link>
          </div>
          <div className="hidden items-center gap-3 border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground sm:flex sm:px-5">
            <span className="flex-1">Job</span>
            <span className="w-40">Mailboxes</span>
            <span className="w-28 text-right">Domains</span>
            <span className="w-24" />
          </div>
          {runningJobs.map((job, i) => {
            const planned = job.domains.reduce((n, d) => n + (d.plannedInboxCount ?? 0), 0);
            const created = job.domains.reduce((n, d) => n + (d.createdInboxCount ?? 0), 0);
            return (
              <div key={job.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5 ${i > 0 ? "border-t border-border" : ""}`}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">{job.name}</div>
                  <div className="text-[13px] text-muted-foreground">
                    {created.toLocaleString()} of {planned.toLocaleString()} mailboxes created
                  </div>
                </div>
                <div className="w-full sm:w-40">
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <div
                      className="h-full rounded-full bg-brand"
                      style={{ width: `${planned > 0 ? Math.min(100, Math.round((created / planned) * 100)) : 0}%` }}
                    />
                  </div>
                </div>
                <span className="w-28 text-right text-sm tabular-nums text-muted-foreground">{job.domains.length}</span>
                {job.id !== "none" ? (
                  <Button asChild variant="outline" size="sm" className="h-7 w-24 justify-center gap-1 px-2 text-xs">
                    <Link to="/jobs/$id" params={{ id: job.id }}>
                      Pipeline <ArrowUpRight className="h-3 w-3" />
                    </Link>
                  </Button>
                ) : (
                  <span className="w-24" />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
