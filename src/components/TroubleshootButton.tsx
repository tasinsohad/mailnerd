import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, Stethoscope } from "lucide-react";
import { toast } from "sonner";
import { runJobHealth } from "@/server/health-actions";

// Runs the full deliverability troubleshoot for a job — every domain (DNS auth) and every unique
// server (port 25, submission ports, queue, FCrDNS, blacklist, TLS, containers) — then reveals the
// results in the Troubleshooting panel + Servers list below. Manual, on-demand (no scheduling).
export function TroubleshootButton({ batchId, className }: { batchId: string; className?: string }) {
  const qc = useQueryClient();

  const run = useMutation({
    mutationFn: () => {
      toast.loading("Troubleshooting — checking domains & servers…", { id: "troubleshoot" });
      return runJobHealth({ data: { batchId } });
    },
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ["batch", batchId] });
      qc.invalidateQueries({ queryKey: ["batch-server-health", batchId] });
      if (res?.error) {
        toast.error(res.error, { id: "troubleshoot" });
        return;
      }
      const c = res?.summary?.counts ?? { critical: 0, warning: 0 };
      const critical = c.critical ?? 0;
      const warning = c.warning ?? 0;
      if (critical + warning === 0) {
        toast.success("All checks passing — nothing to fix.", { id: "troubleshoot", duration: 6000 });
      } else {
        toast.error(
          `Found ${critical} critical and ${warning} needing attention. See Troubleshooting below.`,
          { id: "troubleshoot", duration: 9000 },
        );
      }
    },
    onError: (e: any) => toast.error(e?.message ?? "Troubleshoot failed", { id: "troubleshoot" }),
  });

  return (
    <Button
      variant="outline"
      onClick={() => run.mutate()}
      disabled={run.isPending}
      className={className}
      title="Run all deliverability checks across this job's domains and servers"
    >
      {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}
      Troubleshoot
    </Button>
  );
}
