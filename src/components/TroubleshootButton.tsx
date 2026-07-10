import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, Stethoscope } from "lucide-react";
import { toast } from "sonner";
import { runJobHealth, runDomainHealth } from "@/server/health-actions";

// Runs the full deliverability troubleshoot on demand (manual — no scheduling/alerting) and reveals
// the results. Job scope checks every domain + every unique server; domain scope checks the one
// domain and its server. Pass exactly one of `batchId` / `domainId`.
export function TroubleshootButton({
  batchId,
  domainId,
  className,
}: {
  batchId?: string;
  domainId?: string;
  className?: string;
}) {
  const qc = useQueryClient();

  const run = useMutation({
    mutationFn: () => {
      toast.loading("Troubleshooting — running checks…", { id: "troubleshoot" });
      return domainId ? runDomainHealth({ data: { domainId } }) : runJobHealth({ data: { batchId: batchId! } });
    },
    onSuccess: (res: any) => {
      if (domainId) {
        qc.invalidateQueries({ queryKey: ["domain", domainId] });
        qc.invalidateQueries({ queryKey: ["health-history"] });
      } else {
        qc.invalidateQueries({ queryKey: ["batch", batchId] });
        qc.invalidateQueries({ queryKey: ["batch-server-health", batchId] });
      }

      if (res?.error) {
        toast.error(res.error, { id: "troubleshoot" });
        return;
      }

      let critical = 0;
      let warning = 0;
      if (domainId) {
        const inds = [...(res?.health?.indicators ?? []), ...(res?.serverHealth?.indicators ?? [])];
        critical = inds.filter((i: any) => i.status === "fail").length;
        warning = inds.filter((i: any) => i.status === "warn").length;
      } else {
        const c = res?.summary?.counts ?? {};
        critical = c.critical ?? 0;
        warning = c.warning ?? 0;
      }

      if (critical + warning === 0) {
        toast.success("All checks passing — nothing to fix.", { id: "troubleshoot", duration: 6000 });
      } else {
        toast.error(`Found ${critical} critical and ${warning} needing attention. See the results below.`, {
          id: "troubleshoot",
          duration: 9000,
        });
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
      title="Run all deliverability checks and show issues + fixes"
    >
      {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}
      Troubleshoot
    </Button>
  );
}
