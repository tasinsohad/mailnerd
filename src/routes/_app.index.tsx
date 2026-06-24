import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getOverviewStats } from "@/server/stats";
import { Globe, Server, Mail, Briefcase, TrendingUp, Activity } from "lucide-react";

export const Route = createFileRoute("/_app/")({
  component: IndexPage,
});

function StatCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: number;
  icon: any;
  color: string;
}) {
  return (
    <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-black/5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-500">{label}</span>
        <div className={`flex h-10 w-10 items-center justify-center rounded-2xl ${color}`}>
          <Icon className="h-5 w-5 text-white" />
        </div>
      </div>
      <div className="text-4xl font-bold text-gray-900">{value.toLocaleString()}</div>
    </div>
  );
}

function IndexPage() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ["overview-stats"],
    queryFn: () => getOverviewStats(),
  });

  return (
    <div className="flex flex-col gap-8 p-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Overview</h1>
        <p className="text-sm text-gray-500 mt-1">Your SMTP Forge at a glance</p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="rounded-3xl bg-white p-6 h-32 animate-pulse ring-1 ring-black/5"
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          <StatCard
            label="Total Domains"
            value={stats?.totalDomains ?? 0}
            icon={Globe}
            color="bg-blue-500"
          />
          <StatCard
            label="Total Inboxes"
            value={stats?.totalInboxes ?? 0}
            icon={Mail}
            color="bg-[#4DB584]"
          />
          <StatCard
            label="Servers"
            value={stats?.totalServers ?? 0}
            icon={Server}
            color="bg-purple-500"
          />
          <StatCard
            label="Active Jobs"
            value={stats?.activeJobs ?? 0}
            icon={Briefcase}
            color="bg-orange-500"
          />
        </div>
      )}

      <div className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-black/5 flex flex-col items-center justify-center gap-4 text-center min-h-[200px]">
        <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-[#4DB584]/10">
          <TrendingUp className="h-8 w-8 text-[#4DB584]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Welcome to SMTP Forge</h2>
          <p className="text-sm text-gray-500 mt-1 max-w-sm">
            Add servers and domains to start provisioning mailboxes at scale.
          </p>
        </div>
      </div>
    </div>
  );
}
