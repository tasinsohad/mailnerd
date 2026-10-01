import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getOverviewStats } from "@/server/stats";
import { getHealthOverview, runAllHealth } from "@/server/health-actions";
import { Loader2, RefreshCw, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/StatusPill";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/")({
  component: IndexPage,
});

const HEALTH_BAR: { key: "healthy" | "warning" | "critical" | "unknown"; cls: string; status: string }[] = [
  { key: "healthy", cls: "bg-success", status: "healthy" },
  { key: "warning", cls: "bg-warning", status: "warning" },
  { key: "critical", cls: "bg-destructive", status: "critical" },
  { key: "unknown", cls: "bg-input", status: "unknown" },
];

function HealthPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["health-overview"], queryFn: () => getHealthOverview() });

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

  const counts = data?.counts ?? { healthy: 0, warning: 0, critical: 0, unknown: 0 };
  const total = HEALTH_BAR.reduce((n, c) => n + (counts[c.key] ?? 0), 0);
  const issues: any[] = data?.topIssues ?? [];

  return (
    <div className="elev-card rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3.5 sm:px-5">
        <div className="min-w-48 flex-1">
          <h2 className="font-display text-[15px] font-semibold text-foreground">Deliverability</h2>
          <div className="break-words text-xs text-muted-foreground">
            {data?.lastCheckedAt ? `Last checked ${new Date(data.lastCheckedAt).toLocaleString()}` : "Not checked yet"}
          </div>
        </div>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
          {recheck.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Re-check all
        </Button>
      </div>
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        {total > 0 && (
          <div
            className="flex h-2 gap-0.5 overflow-hidden rounded-full"
            role="img"
            aria-label={`${counts.healthy} healthy, ${counts.warning} need attention, ${counts.critical} critical, ${counts.unknown} not checked`}
          >
            {HEALTH_BAR.filter((c) => (counts[c.key] ?? 0) > 0).map((c) => (
              <span key={c.key} className={`${c.cls} min-w-[3px] rounded-[2px]`} style={{ flex: counts[c.key] }} />
            ))}
          </div>
        )}
        <div className="flex flex-col">
          {HEALTH_BAR.map((c, i) => (
            <div
              key={c.key}
              className={`flex items-center justify-between gap-2 py-2 ${i > 0 ? "border-t border-border" : ""}`}
            >
              <StatusPill status={c.status} />
              <span className="font-display text-sm font-semibold tabular-nums text-foreground">{counts[c.key] ?? 0}</span>
            </div>
          ))}
        </div>
      </div>
      {issues.length > 0 && (
        <div className="border-t border-border px-4 py-4 sm:px-5">
          <h3 className="mb-2 text-[13px] font-medium text-foreground">Top issues</h3>
          <ul className="flex flex-col">
            {issues.map((iss: any, i: number) => (
              <li
                key={iss.label}
                className={`flex items-baseline justify-between gap-3 py-2 text-sm ${i > 0 ? "border-t border-border" : ""}`}
              >
                <span className="min-w-0 text-foreground">{iss.label}</span>
                <span className="ident shrink-0 text-xs text-muted-foreground">×{iss.count}</span>
              </li>
            ))}
          </ul>
          <Link to="/troubleshoot" className="mt-2 inline-block text-sm font-medium text-brand hover:underline">
            Open troubleshooter
          </Link>
        </div>
      )}
    </div>
  );
}

function IndexPage() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ["overview-stats"],
    queryFn: () => getOverviewStats(),
  });

  const hasDomains = (stats?.totalDomains ?? 0) > 0;
  const summary = stats
    ? `${stats.totalDomains ?? 0} domain${stats.totalDomains === 1 ? "" : "s"}, ${(stats.totalInboxes ?? 0).toLocaleString()} mailbox${stats.totalInboxes === 1 ? "" : "es"}, ${stats.totalServers ?? 0} server${stats.totalServers === 1 ? "" : "s"}${stats.activeJobs ? `. ${stats.activeJobs} job${stats.activeJobs === 1 ? "" : "s"} running.` : "."}`
    : "";

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-foreground">Overview</h1>
        {isLoading ? (
          <div className="mt-1.5 h-4 w-72 animate-pulse rounded bg-muted" />
        ) : (
          <p className="mt-0.5 text-sm text-muted-foreground">{summary}</p>
        )}
      </div>

      {hasDomains ? (
        <HealthPanel />
      ) : isLoading ? (
        <div className="elev-card h-56 animate-pulse rounded-xl border border-border bg-card" />
      ) : (
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
      )}
    </div>
  );
}
