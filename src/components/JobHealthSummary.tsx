import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ShieldCheck, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { runJobHealth } from "@/server/health-actions";

const TONE: Record<string, string> = {
  healthy: "text-success",
  warning: "text-warning",
  critical: "text-destructive",
  unknown: "text-muted-foreground",
};

// Compact job-level health rollup from the domains' persisted health, with a "Re-check job"
// that scans every domain in the batch.
export function JobHealthSummary({ batchId, domains }: { batchId: string; domains: any[] }) {
  const qc = useQueryClient();
  const counts = { healthy: 0, warning: 0, critical: 0, unknown: 0 };
  for (const d of domains) {
    const s = (d.health?.status ?? "unknown") as keyof typeof counts;
    counts[s] = (counts[s] ?? 0) + 1;
  }

  const recheck = useMutation({
    mutationFn: () => {
      toast.loading("Checking all domains in this job…", { id: "jobhealth" });
      return runJobHealth({ data: { batchId } });
    },
    onSuccess: (res: any) => {
      if (res?.error) toast.error(res.error, { id: "jobhealth" });
      else toast.success("Job health check complete", { id: "jobhealth" });
      qc.invalidateQueries({ queryKey: ["batch", batchId] });
    },
    onError: (e: any) => toast.error(e.message, { id: "jobhealth" }),
  });

  const cells: { key: keyof typeof counts; label: string }[] = [
    { key: "healthy", label: "Healthy" },
    { key: "warning", label: "Attention" },
    { key: "critical", label: "Critical" },
    { key: "unknown", label: "Unchecked" },
  ];

  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card px-5 py-4">
      <ShieldCheck className="h-5 w-5 text-muted-foreground" />
      <span className="font-display text-sm font-semibold text-foreground">Deliverability</span>
      <div className="flex flex-1 flex-wrap items-center gap-4">
        {cells.map((c) => (
          <span key={c.key} className="inline-flex items-center gap-1.5 text-sm">
            <span className={cn("status-dot", TONE[c.key])} />
            <span className="ident text-foreground">{counts[c.key]}</span>
            <span className="text-muted-foreground">{c.label}</span>
          </span>
        ))}
      </div>
      <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
        {recheck.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Re-check job
      </Button>
    </div>
  );
}
