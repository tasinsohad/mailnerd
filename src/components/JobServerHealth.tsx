import { useQuery } from "@tanstack/react-query";
import { Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { getBatchServerHealth } from "@/server/health-actions";
import { sortByPriority } from "@/server/health-checks";
import type { DomainHealth } from "@/server/health";

const TONE: Record<string, string> = {
  healthy: "text-success",
  warning: "text-warning",
  critical: "text-destructive",
  unknown: "text-muted-foreground",
};

// Compact per-server (VPS/IP) status list for the job dashboard. Each unique server in the job
// shows a status dot + its most urgent open issue. Populated by runJobHealth ("Re-check job").
export function JobServerHealth({ batchId }: { batchId: string }) {
  const { data } = useQuery({
    queryKey: ["batch-server-health", batchId],
    queryFn: () => getBatchServerHealth({ data: { batchId } }),
  });

  const servers = ((data as any)?.servers ?? []) as {
    id: string;
    ipAddress: string;
    mailcowHostname?: string | null;
    health?: DomainHealth | null;
    checkedAt?: string | null;
  }[];

  if (servers.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <Server className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-display text-sm font-semibold text-foreground">Servers</h3>
        <span className="text-xs text-muted-foreground">{servers.length} in this job</span>
      </div>
      <ul className="divide-y divide-border">
        {servers.map((s) => {
          const status = s.health?.status ?? "unknown";
          const indicators = s.health?.indicators ?? [];
          const top = sortByPriority(indicators).find((i) => i.status === "fail" || i.status === "warn");
          return (
            <li key={s.id} className="flex items-center gap-3 px-5 py-3">
              <span className={cn("status-dot shrink-0", TONE[status], status === "critical" && "status-dot--pulse")} />
              <span className="w-36 shrink-0 font-mono text-sm text-foreground">{s.ipAddress}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={top ? `${top.label}: ${top.detail}` : "All checks passing"}>
                {top ? (
                  <>
                    <span className={cn("font-medium", TONE[top.status === "fail" ? "critical" : "warning"])}>{top.label}</span>
                    <span className="text-muted-foreground"> — {top.detail}</span>
                  </>
                ) : (
                  <span className="text-success">All server checks passing</span>
                )}
              </span>
              {s.health && (
                <span className="ident shrink-0 text-xs text-muted-foreground">{s.health.score}%</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
