import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listDomains, listDomainBatches } from "@/server/domains";
import { getInboxExport } from "@/server/plans";
import { downloadCsv } from "@/lib/csv";
import { buildExportCsv } from "@/lib/export-formats";
import { ExportButton } from "@/components/ExportButton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Globe, Loader2, ChevronRight, FolderGit2, X, Download } from "lucide-react";
import { toast } from "sonner";
import { StatusPill } from "@/components/StatusPill";
import { DomainActionsMenu } from "@/components/DomainActionsMenu";
import { AddDomainWizard } from "@/components/AddDomainWizard";

export const Route = createFileRoute("/_app/domains/")({
  component: DomainsPage,
  // Allow ?batch=<jobId> so jobs can deep-link into a filtered domain view.
  validateSearch: (search: Record<string, unknown>): { batch?: string } => ({
    batch: typeof search.batch === "string" ? search.batch : undefined,
  }),
});

function DomainsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { batch } = Route.useSearch();
  const batchFilter = batch ?? "all";
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

  const [exportingAll, setExportingAll] = useState(false);
  const anyReady = domains.some((d: any) => (d.createdInboxCount ?? 0) > 0);

  const downloadAll = async (formatId: string) => {
    setExportingAll(true);
    toast.loading("Building combined CSV…", { id: "export-all" });
    try {
      const res: any = await getInboxExport({ data: {} });
      if (!res?.rows?.length) {
        toast.error("No created mailboxes to export yet.", { id: "export-all" });
        return;
      }
      downloadCsv(`all_inboxes_${formatId}.csv`, buildExportCsv(formatId, res.rows));
      toast.success(`Exported ${res.rows.length} mailboxes`, { id: "export-all" });
    } catch (e: any) {
      toast.error(e?.message ?? "Export failed", { id: "export-all" });
    } finally {
      setExportingAll(false);
    }
  };

  const setFilter = (v: string) =>
    navigate({ to: "/domains", search: v === "all" ? {} : { batch: v } });

  const activeJobName =
    batchFilter !== "all" ? batches.find((b: any) => b.id === batchFilter)?.name : null;
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
            {activeJobName ? (
              <>
                {" in "}
                <span className="text-foreground">{activeJobName}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex gap-3">
          {batches.length > 0 && (
            <Select value={batchFilter} onValueChange={setFilter}>
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
          {domains.length > 0 && (
            <ExportButton
              label="Download all CSVs"
              onExport={downloadAll}
              disabled={!anyReady}
              busy={exportingAll}
              title={anyReady ? "Download one combined CSV of all created mailboxes" : "Available once mailboxes are created"}
            />
          )}
          <Button onClick={() => setWizardOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" /> Add domains
          </Button>
        </div>
      </div>

      {activeJobName && (
        <button
          onClick={() => setFilter("all")}
          className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <FolderGit2 className="h-3 w-3" /> Filtered by job: {activeJobName}
          <X className="h-3 w-3" />
        </button>
      )}

      <AddDomainWizard open={wizardOpen} onOpenChange={setWizardOpen} />

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : domains.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40 p-16 text-center">
          <Globe className="h-10 w-10 text-muted-foreground" />
          <p className="font-display text-lg font-medium text-foreground">No domains here</p>
          <p className="text-sm text-muted-foreground">
            {activeJobName ? "This job has no domains." : 'Use "Add domains" to get started.'}
          </p>
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
              <DomainActionsMenu
                domainId={d.id}
                domainName={d.name}
                onChanged={refresh}
                canExport={(d.createdInboxCount ?? 0) > 0}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
