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
import { Plus, Loader2, ChevronRight, FolderGit2, X } from "lucide-react";
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
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-foreground">Domains</h1>
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
        <div className="flex flex-wrap gap-2 sm:gap-3">
          {batches.length > 0 && (
            <Select value={batchFilter} onValueChange={setFilter}>
              <SelectTrigger className="w-full rounded-lg sm:w-44">
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
        <div className="elev-card rounded-xl border border-border bg-card">
          <div className="max-w-md px-6 py-10 sm:px-8">
            <p className="font-display text-[15px] font-semibold text-foreground">No domains here</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {activeJobName ? "This job has no domains." : 'Use "Add domains" to get started.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="elev-card overflow-hidden rounded-xl border border-border bg-card">
          <div className="hidden items-center gap-3 border-b border-border px-4 py-2.5 text-xs font-medium text-muted-foreground sm:flex">
            <span className="flex-1">Domain</span>
            <span className="w-32">Status</span>
            <span className="w-4" />
            <span className="w-9" />
          </div>
          {domains.map((d: any, i: number) => (
            <div
              key={d.id}
              className={`flex items-center gap-2 px-4 py-2.5 transition-colors hover:bg-muted/40 sm:gap-3 ${i > 0 ? "border-t border-border" : ""}`}
            >
              <Link
                to="/domains/$id"
                params={{ id: d.id }}
                className="flex min-w-0 flex-1 items-center gap-3"
              >
                <div className="min-w-0">
                  <div className="ident truncate text-sm font-medium text-foreground">{d.name}</div>
                  <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    {d.batchName ? (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <FolderGit2 className="h-3 w-3 shrink-0" /> <span className="truncate">{d.batchName}</span>
                      </span>
                    ) : (
                      <span className="shrink-0">No job</span>
                    )}
                    <span aria-hidden className="shrink-0">·</span>
                    <span className="truncate">{d.plannedInboxCount ? `${d.plannedInboxCount} mailboxes` : "No plan yet"}</span>
                  </div>
                </div>
              </Link>
              <span className="shrink-0 sm:w-32"><StatusPill status={d.status} /></span>
              <Link to="/domains/$id" params={{ id: d.id }} className="hidden text-muted-foreground hover:text-foreground sm:inline">
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
