import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getOverviewStats } from "@/server/stats";
import { getHealthOverview, runAllHealth } from "@/server/health-actions";
import { Globe, Server, Mail, Briefcase, TrendingUp, ShieldCheck, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/")({
  component: IndexPage,
});

function StatCard({ label, value, icon: Icon }: { label: string; value: number; icon: any }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/40">
      <div className="flex items-center justify-between">
        <span className="ident text-[11px] uppercase tracking-[0.15em] text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="font-display text-4xl font-semibold tabular-nums text-foreground">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

const HEALTH_TONE: Record<string, string> = {
  healthy: "text-success",
  warning: "text-warning",
  critical: "text-destructive",
  unknown: "text-muted-foreground",
};

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
  const cells: { key: keyof typeof counts; label: string }[] = [
    { key: "healthy", label: "Healthy" },
    { key: "warning", label: "Needs attention" },
    { key: "critical", label: "Critical" },
    { key: "unknown", label: "Not checked" },
  ];

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <ShieldCheck className="h-5 w-5 text-muted-foreground" />
        <div className="flex-1">
          <h2 className="font-display text-base font-semibold text-foreground">Deliverability health</h2>
          <div className="text-xs text-muted-foreground">
            {data?.lastCheckedAt ? `Last checked ${new Date(data.lastCheckedAt).toLocaleString()}` : "Not checked yet"}
          </div>
        </div>
        <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
          {recheck.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Re-check all
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 p-6 sm:grid-cols-4">
        {cells.map((c) => (
          <div key={c.key} className="rounded-lg border border-border bg-muted/30 p-4">
            <div className="flex items-center gap-2">
              <span className={cn("status-dot", HEALTH_TONE[c.key])} />
              <span className="text-xs text-muted-foreground">{c.label}</span>
            </div>
            <div className="mt-2 font-display text-2xl font-semibold tabular-nums text-foreground">
              {counts[c.key] ?? 0}
            </div>
          </div>
        ))}
      </div>
      {data?.topIssues && data.topIssues.length > 0 && (
        <div className="border-t border-border px-6 py-4">
          <div className="ident mb-2 text-[11px] uppercase tracking-[0.15em] text-muted-foreground">Top issues</div>
          <div className="flex flex-wrap gap-2">
            {data.topIssues.map((iss: any) => (
              <span key={iss.label} className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-foreground">
                {iss.label} <span className="text-muted-foreground">×{iss.count}</span>
              </span>
            ))}
          </div>
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

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-8">
      <div>
        <div className="ident text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Control console</div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Overview</h1>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl border border-border bg-card" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <StatCard label="Domains" value={stats?.totalDomains ?? 0} icon={Globe} />
          <StatCard label="Mailboxes" value={stats?.totalInboxes ?? 0} icon={Mail} />
          <StatCard label="Servers" value={stats?.totalServers ?? 0} icon={Server} />
          <StatCard label="Active jobs" value={stats?.activeJobs ?? 0} icon={Briefcase} />
        </div>
      )}

      {hasDomains ? (
        <HealthPanel />
      ) : (
        <div className="flex min-h-[220px] flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
            <TrendingUp className="h-7 w-7 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-lg font-semibold text-foreground">Provision at scale</h2>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
              Add a server and domains, then run a job to spin up mail servers and create mailboxes —
              three domains at a time, the rest queued.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
