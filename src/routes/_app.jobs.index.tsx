import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { listDomainBatches, listDomains, deleteDomainBatch } from "@/server/domains";
import { Loader2, Globe, FolderGit2, Plus, Trash2, ChevronRight, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { toast } from "sonner";
import { StatusPill } from "@/components/StatusPill";
import { DomainActionsMenu } from "@/components/DomainActionsMenu";
import { JobActionsMenu } from "@/components/JobActionsMenu";
import { AddDomainWizard } from "@/components/AddDomainWizard";

export const Route = createFileRoute("/_app/jobs/")({
  component: JobsPage,
});

function JobsPage() {
  const [wizardOpen, setWizardOpen] = useState(false);
  const { data: batches = [], isLoading } = useQuery({
    queryKey: ["domain-batches"],
    queryFn: () => listDomainBatches(),
  });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <div className="ident text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            Control console
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Jobs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {batches.length} job{batches.length !== 1 ? "s" : ""} · domains grouped by job
          </p>
        </div>
        <Button onClick={() => setWizardOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" /> New job
        </Button>
      </div>

      <AddDomainWizard open={wizardOpen} onOpenChange={setWizardOpen} />

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : batches.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40 p-16 text-center">
          <FolderGit2 className="h-10 w-10 text-muted-foreground" />
          <p className="font-display text-lg font-medium text-foreground">No jobs yet</p>
          <p className="text-sm text-muted-foreground">Click "New job" to add domains and start.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {batches.map((b: any) => (
            <JobGroup key={b.id} batch={b} />
          ))}
        </div>
      )}
    </div>
  );
}

function JobGroup({ batch }: { batch: any }) {
  const qc = useQueryClient();
  const { data: domains = [] } = useQuery({
    queryKey: ["domains", batch.id],
    queryFn: () => listDomains({ data: { batchId: batch.id } }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["domains", batch.id] });
    qc.invalidateQueries({ queryKey: ["domain-batches"] });
  };

  const deleteMutation = useMutation({
    mutationFn: () => deleteDomainBatch({ data: { id: batch.id } }),
    onSuccess: (res: any) => {
      if (res.ok) {
        toast.success("Job deleted");
        qc.invalidateQueries({ queryKey: ["domain-batches"] });
      } else toast.error(res.error || "Failed to delete job");
    },
  });

  const domainIds = domains.map((d: any) => d.id);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {/* Job header */}
      <div className="flex items-center gap-3 border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/12">
          <FolderGit2 className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <Link
            to="/jobs/$id"
            params={{ id: batch.id }}
            className="font-display text-sm font-semibold text-foreground hover:underline"
          >
            {batch.name}
          </Link>
          <div className="text-xs text-muted-foreground">
            {domains.length} domain{domains.length !== 1 ? "s" : ""} ·{" "}
            {new Date(batch.createdAt).toLocaleDateString()}
          </div>
        </div>
        <JobActionsMenu domainIds={domainIds} onChanged={refresh} />
        <Link to="/jobs/$id" params={{ id: batch.id }}>
          <Button variant="outline" size="sm" className="h-10 gap-1.5">
            Open <ArrowUpRight className="h-3.5 w-3.5" />
          </Button>
        </Link>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={() => {
            if (confirm("Delete this job and all its domains?")) deleteMutation.mutate();
          }}
          disabled={deleteMutation.isPending}
          title="Delete job"
        >
          {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </Button>
      </div>

      {/* Domains nested under the job */}
      {domains.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">No domains in this job.</div>
      ) : (
        domains.map((d: any, i: number) => (
          <div
            key={d.id}
            className={`flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40 ${i > 0 ? "border-t border-border" : ""}`}
          >
            <Link to="/domains/$id" params={{ id: d.id }} className="flex min-w-0 flex-1 items-center gap-3">
              <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="ident truncate text-sm text-foreground">{d.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {d.plannedInboxCount ? `${d.plannedInboxCount} mailboxes` : "no plan"}
              </span>
            </Link>
            <StatusPill status={d.status} />
            <Link to="/domains/$id" params={{ id: d.id }} className="text-muted-foreground hover:text-foreground">
              <ChevronRight className="h-4 w-4" />
            </Link>
            <DomainActionsMenu domainId={d.id} domainName={d.name} onChanged={refresh} />
          </div>
        ))
      )}
    </div>
  );
}
