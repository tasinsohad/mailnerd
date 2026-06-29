import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listDomains, listDomainBatches } from "@/server/domains";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Globe, Loader2, ChevronRight, FolderGit2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { StatusPill } from "@/components/StatusPill";
import { DomainActionsMenu } from "@/components/DomainActionsMenu";
import { AddDomainWizard } from "@/components/AddDomainWizard";

export const Route = createFileRoute("/_app/domains/")({
  component: DomainsPage,
});

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

  const refresh = () => qc.invalidateQueries({ queryKey: ["domains"] });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <div className="ident text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            Control console
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">Domains</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {domains.length} domain{domains.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex gap-3">
          {batches.length > 0 && (
            <Select value={batchFilter} onValueChange={setBatchFilter}>
              <SelectTrigger className="w-44 rounded-lg">
                <SelectValue placeholder="All jobs" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All jobs</SelectItem>
                {batches.map((b: any) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button onClick={() => setWizardOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" /> Add domains
          </Button>
        </div>
      </div>

      <AddDomainWizard open={wizardOpen} onOpenChange={setWizardOpen} />

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : domains.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40 p-16 text-center">
          <Globe className="h-10 w-10 text-muted-foreground" />
          <p className="font-display text-lg font-medium text-foreground">No domains yet</p>
          <p className="text-sm text-muted-foreground">Use "Add domains" to get started.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {domains.map((d: any, i: number) => (
            <div
              key={d.id}
              className={`flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40 ${i > 0 ? "border-t border-border" : ""}`}
            >
              <Link
                to="/domains/$id"
                params={{ id: d.id }}
                className="flex min-w-0 flex-1 items-center gap-3"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <Globe className="h-4 w-4 text-primary" />
                </div>
                <div className="min-w-0">
                  <div className="ident truncate text-sm font-medium text-foreground">{d.name}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {d.batchName ? (
                      <span className="inline-flex items-center gap-1">
                        <FolderGit2 className="h-3 w-3" /> {d.batchName}
                      </span>
                    ) : (
                      <span>No job</span>
                    )}
                    <span aria-hidden>·</span>
                    <span>{d.plannedInboxCount ? `${d.plannedInboxCount} mailboxes` : "No plan yet"}</span>
                  </div>
                </div>
              </Link>
              <StatusPill status={d.status} />
              <Link to="/domains/$id" params={{ id: d.id }} className="text-muted-foreground hover:text-foreground">
                <ChevronRight className="h-4 w-4" />
              </Link>
              <DomainActionsMenu domainId={d.id} domainName={d.name} onChanged={refresh} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
