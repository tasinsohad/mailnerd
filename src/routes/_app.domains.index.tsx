import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listDomains, deleteDomain, listDomainBatches } from "@/server/domains";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Globe, Trash2, Loader2, ChevronRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { AddDomainWizard } from "@/components/AddDomainWizard";

export const Route = createFileRoute("/_app/domains/")({
  component: DomainsPage,
});

const STATUS_COLOR: Record<string, string> = {
  pending: "bg-warning/15 text-warning",
  active: "bg-success/15 text-success",
  error: "bg-destructive/15 text-destructive",
  configuring: "bg-primary/15 text-primary",
};

function DomainsPage() {
  const qc = useQueryClient();
  const [batchFilter, setBatchFilter] = useState<string>("all");
  const [wizardOpen, setWizardOpen] = useState(false);

  const { data: batches = [] } = useQuery({
    queryKey: ["domain-batches"],
    queryFn: () => listDomainBatches(),
  });

  const { data: domains = [], isLoading } = useQuery({
    queryKey: ["domains", batchFilter],
    queryFn: () =>
      listDomains({ data: batchFilter !== "all" ? { batchId: batchFilter } : {} }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteDomain({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["domains"] });
      toast.success("Domain deleted");
    },
    onError: () => toast.error("Failed to delete domain"),
  });

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Domains</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {domains.length} domain{domains.length !== 1 ? "s" : ""} total
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            onClick={() => setWizardOpen(true)}
            className="bg-primary hover:bg-primary/90 rounded-lg gap-2 shadow-lg shadow-primary/20"
          >
            <Plus className="h-4 w-4" /> Add Domains
          </Button>

          {batches.length > 0 && (
            <Select value={batchFilter} onValueChange={setBatchFilter}>
              <SelectTrigger className="w-44 rounded-lg">
                <SelectValue placeholder="All batches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All batches</SelectItem>
                {batches.map((b: any) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <AddDomainWizard open={wizardOpen} onOpenChange={setWizardOpen} />

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : domains.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl bg-card p-16 text-center ring-1 ring-border">
          <Globe className="h-12 w-12 text-muted-foreground" />
          <p className="text-lg font-medium text-foreground">No domains yet</p>
          <p className="text-sm text-muted-foreground">Use "Add Domains" to get started.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {domains.map((d: any) => (
            <Link
              key={d.id}
              to="/domains/$id"
              params={{ id: d.id }}
              className="flex items-center justify-between rounded-lg bg-card px-5 py-4 ring-1 ring-border shadow-sm hover:shadow-md transition-all group"
            >
              <div className="flex items-center gap-4">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
                  <Globe className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <div className="font-medium text-foreground">{d.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {d.plannedInboxCount ? `${d.plannedInboxCount} inboxes planned` : "No plan yet"}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`rounded-lg px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[d.status] ?? "bg-muted text-muted-foreground"}`}
                >
                  {d.status}
                </span>
                <div className="rounded-xl p-2 text-muted-foreground group-hover:text-primary">
                  <ChevronRight className="h-4 w-4" />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-xl text-red-300 hover:text-destructive hover:bg-destructive/10"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (confirm(`Delete ${d.name}?`)) deleteMutation.mutate(d.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
