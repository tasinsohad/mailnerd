import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getOverviewStats } from "@/server/stats";
import { Globe, Server, Mail, Briefcase, TrendingUp } from "lucide-react";

export const Route = createFileRoute("/_app/")({
  component: IndexPage,
});

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: any;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/40">
      <div className="flex items-center justify-between">
        <span className="ident text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
          {label}
        </span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="font-display text-4xl font-semibold tabular-nums text-foreground">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function IndexPage() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ["overview-stats"],
    queryFn: () => getOverviewStats(),
  });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 p-8">
      <div>
        <div className="ident text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          Control console
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">
          Overview
        </h1>
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

      <div className="flex min-h-[220px] flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
          <TrendingUp className="h-7 w-7 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">Provision at scale</h2>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
            Add a server and domains, then run a job to spin up mail servers and create
            mailboxes — three domains at a time, the rest queued.
          </p>
        </div>
      </div>
    </div>
  );
}
