import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getBatchDetails, deleteDomainBatch, updateDomain } from "@/server/domains";
import { Globe, FolderGit2, ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { toast } from "sonner";
import { JobActionsMenu } from "@/components/JobActionsMenu";
import { DomainActionsMenu } from "@/components/DomainActionsMenu";
import { ExportButton } from "@/components/ExportButton";
import { ExportSubdomainsDialog } from "@/components/ExportSubdomainsDialog";
import { buildExportCsv } from "@/lib/export-formats";
import { subdomainExportRows } from "@/lib/subdomains";
import { downloadCsv } from "@/lib/csv";
import { StatusPill } from "@/components/StatusPill";
import { JobHealthSummary } from "@/components/JobHealthSummary";
import { JobIssuesPanel } from "@/components/JobIssuesPanel";
import { JobServerHealth } from "@/components/JobServerHealth";
import { TroubleshootButton } from "@/components/TroubleshootButton";
import { SetupBoard } from "@/components/setup/SetupBoard";

export const Route = createFileRoute("/_app/jobs/$id")({
  component: JobPipelinePage,
});

function JobPipelinePage() {
  const { id } = Route.useParams();
  const [subOpen, setSubOpen] = useState(false);

  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["batch", id],
    queryFn: () => getBatchDetails({ data: { id } }),
    // Live-poll every 3s while any domain is still being provisioned/configured, so the
    // batch view reflects the queue (3 at a time, rest queued) without a manual refresh.
    refetchInterval: (query) => {
      const d = query.state.data as { domains?: { status?: string }[] } | undefined;
      const inProgress = (d?.domains ?? []).some((x) =>
        ["queued", "provisioning", "configuring"].includes(x.status ?? ""),
      );
      return inProgress ? 3000 : false;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteDomainBatch({ data: { id } }),
    onSuccess: (res: any) => {
      if (res.ok) {
        toast.success("Job deleted successfully");
        qc.invalidateQueries({ queryKey: ["domain-batches"] });
        navigate({ to: "/jobs" });
      } else {
        toast.error(res.error || "Failed to delete job");
      }
    },
  });

  const handleDelete = () => {
    if (confirm("Are you sure you want to delete this job and all its domains?")) {
      deleteMutation.mutate();
    }
  };

  const handleExportCsv = (formatId: string) => {
    // Build one platform-formatted CSV across every created mailbox in the job. The format
    // registry (buildExportCsv) owns the headers + column mapping.
    const rows = domains.flatMap((d: any) => {
      const mailServer = d.mailcowHostname || `mail.${d.name}`;
      return inboxes
        .filter((i: any) => i.domainId === d.id && i.status === "active" && i.password) // only created mailboxes
        .map((ib: any) => ({
          name:
            ib.fullName ||
            [ib.firstName, ib.lastName].filter(Boolean).join(" ") ||
            ib.localPart ||
            "",
          firstName: ib.firstName || "",
          lastName: ib.lastName || "",
          email: ib.email,
          password: ib.password || "",
          mailServer,
        }));
    });

    if (!rows.length) {
      toast.error("No created mailboxes to export yet. Create the mailboxes first.");
      return;
    }

    downloadCsv(`job_${batch.name}_${formatId}.csv`, buildExportCsv(formatId, rows));
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const batch = (data as any)?.batch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const domains = (data as any)?.domains ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inboxes = (data as any)?.inboxes ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const records = (data as any)?.records ?? [];

  // Unique subdomains (apex excluded) across every domain in the job — ready once inboxes are
  // planned, mailboxes need not exist.
  const nameById = new Map<string, string>(domains.map((d: any) => [d.id, d.name]));
  const ipById = new Map<string, string | null>(domains.map((d: any) => [d.id, d.ipAddress]));
  const subRows = subdomainExportRows(
    inboxes.map((ib: any) => ({
      domainName: nameById.get(ib.domainId) ?? "",
      subdomainPrefix: ib.subdomainPrefix,
      subdomainFqdn: ib.subdomainFqdn,
      ipAddress: ipById.get(ib.domainId),
    })),
  );

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!batch) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <FolderGit2 className="h-12 w-12 text-red-500 mb-4" />
        <h2 className="text-xl font-bold">Job not found</h2>
        <Link to="/jobs" className="text-primary hover:underline mt-2">
          Back to Jobs
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <Link to="/jobs" className="shrink-0" aria-label="Back to Jobs">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-card shadow-sm ring-1 ring-border hover:bg-muted transition-colors">
              <ArrowLeft className="h-5 w-5 text-muted-foreground" />
            </div>
          </Link>
          <div className="min-w-0">
            <h1 className="break-words text-xl font-bold text-foreground sm:text-2xl">{batch.name}</h1>
            <div className="mt-1 text-sm text-muted-foreground">
              {domains.length} domain{domains.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end sm:gap-3">
          <Button
            variant="outline"
            onClick={() => setSubOpen(true)}
            disabled={subRows.length === 0}
            title={subRows.length === 0 ? "Available once inboxes are planned" : undefined}
            className="h-11 px-4 rounded-lg border-border text-muted-foreground hover:bg-muted gap-2"
          >
            <Globe className="h-4 w-4" /> Subdomains
          </Button>
          <TroubleshootButton
            batchId={id}
            className="h-11 px-4 rounded-lg border-primary/40 text-primary hover:bg-primary/10 gap-2"
          />
          <ExportButton
            onExport={handleExportCsv}
            className="h-11 px-4 rounded-lg border-border text-muted-foreground hover:bg-muted gap-2"
          />
          <JobActionsMenu
            domainIds={domains.map((d: any) => d.id)}
            batchId={id}
            onChanged={() => {
              qc.invalidateQueries({ queryKey: ["batch", id] });
              // "Provision servers" starts setup runs, which the board shows.
              qc.invalidateQueries({ queryKey: ["setup-board", id] });
            }}
          />
          <Button
            variant="outline"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
            className="h-11 px-4 rounded-lg border-destructive/30 text-destructive hover:bg-destructive/10"
          >
            {deleteMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4 mr-2" />
            )}
            Delete Job
          </Button>
        </div>
      </div>

      <ExportSubdomainsDialog
        open={subOpen}
        onOpenChange={setSubOpen}
        rows={subRows}
        filenameBase={`job_${batch.name}`}
        title="Export job subdomains"
      />

      <div className="flex flex-col gap-6">
        <SetupBoard batchId={id} />
        <JobHealthSummary batchId={id} domains={domains} />
        <JobServerHealth batchId={id} />
        <JobIssuesPanel
          batchId={id}
          domains={domains}
          onChanged={() => qc.invalidateQueries({ queryKey: ["batch", id] })}
        />
        <ViewStep domains={domains} inboxes={inboxes} records={records} />
      </div>
    </div>
  );
}

// --- The domains in the job: editable connection details ---
function EditableDomainRow({ domain }: { domain: any }) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(domain.name);
  const [ipAddress, setIpAddress] = useState(domain.ipAddress || "");
  const [sshUser, setSshUser] = useState(domain.sshUser || "");
  const [sshPassword, setSshPassword] = useState(domain.sshPassword || "");
  const qc = useQueryClient();

  const updateMut = useMutation({
    mutationFn: (data: any) => updateDomain({ data }),
    onSuccess: (res: any) => {
      if (res.ok) {
        toast.success("Domain updated");
        setIsEditing(false);
        qc.invalidateQueries({ queryKey: ["batch"] });
      } else {
        toast.error(res.error || "Failed to update domain");
      }
    },
  });

  const handleSave = () => {
    updateMut.mutate({ id: domain.id, name, ipAddress, sshUser, sshPassword });
  };

  // Each row renders a phone layout (one full-width md:hidden cell with stacked, labelled fields)
  // and the md+ column cells. Both share this component's state, so editing works the same in either.
  const phoneLabel = "text-[10px] font-bold uppercase tracking-wider text-muted-foreground";

  if (!isEditing) {
    const actions = (
      <>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsEditing(true)}
          className="text-primary hover:text-primary hover:bg-primary/10"
        >
          Edit
        </Button>
        <DomainActionsMenu
          domainId={domain.id}
          domainName={domain.name}
          onChanged={() => qc.invalidateQueries({ queryKey: ["batch"] })}
        />
      </>
    );
    return (
      <tr className="border-b border-border last:border-0 hover:bg-muted/50 transition-colors">
        <td colSpan={5} className="p-3 md:hidden">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="ident break-all text-sm font-medium text-foreground">{domain.name}</div>
              <div className="mt-1.5">
                <StatusPill status={domain.status} />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">{actions}</div>
          </div>
          <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1">
            <dt className={phoneLabel}>IP Address</dt>
            <dd className="break-all font-mono text-xs text-muted-foreground">{domain.ipAddress || "-"}</dd>
            <dt className={phoneLabel}>SSH User</dt>
            <dd className="break-all font-mono text-xs text-muted-foreground">{domain.sshUser || "-"}</dd>
            <dt className={phoneLabel}>SSH Password</dt>
            <dd className="font-mono text-xs text-muted-foreground italic">
              {domain.hasSshPassword ? "••••••••" : "Not set"}
            </dd>
          </dl>
        </td>
        <td className="hidden p-4 md:table-cell">
          <div className="ident text-sm font-medium text-foreground">{domain.name}</div>
          <div className="mt-1.5">
            <StatusPill status={domain.status} />
          </div>
        </td>
        <td className="hidden p-4 font-mono text-xs text-muted-foreground md:table-cell">{domain.ipAddress || "-"}</td>
        <td className="hidden p-4 font-mono text-xs text-muted-foreground md:table-cell">{domain.sshUser || "-"}</td>
        <td className="hidden p-4 font-mono text-xs text-muted-foreground italic md:table-cell">
          {domain.hasSshPassword ? "••••••••" : "Not set"}
        </td>
        <td className="hidden p-4 md:table-cell">
          <div className="flex items-center justify-end gap-1">{actions}</div>
        </td>
      </tr>
    );
  }

  const nameInput = (
    <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9 text-sm rounded-xl" />
  );
  const ipInput = (
    <Input value={ipAddress} onChange={(e) => setIpAddress(e.target.value)} className="h-9 text-sm font-mono rounded-xl" />
  );
  const userInput = (
    <Input value={sshUser} onChange={(e) => setSshUser(e.target.value)} className="h-9 text-sm font-mono rounded-xl" />
  );
  const passwordInput = (
    <Input type="password" value={sshPassword} onChange={(e) => setSshPassword(e.target.value)} className="h-9 text-sm font-mono rounded-xl" placeholder="Blank = keep current" />
  );
  const editButtons = (
    <div className="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)} className="rounded-xl">
        Cancel
      </Button>
      <Button size="sm" onClick={handleSave} disabled={updateMut.isPending} className="rounded-xl bg-primary hover:bg-primary/90 text-white">
        {updateMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
      </Button>
    </div>
  );

  return (
    <tr className="border-b border-border last:border-0 bg-primary/10/30">
      <td colSpan={5} className="p-3 md:hidden">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className={phoneLabel}>Domain</span>
            {nameInput}
          </label>
          <label className="flex flex-col gap-1">
            <span className={phoneLabel}>IP Address</span>
            {ipInput}
          </label>
          <label className="flex flex-col gap-1">
            <span className={phoneLabel}>SSH User</span>
            {userInput}
          </label>
          <label className="flex flex-col gap-1">
            <span className={phoneLabel}>SSH Password</span>
            {passwordInput}
          </label>
          {editButtons}
        </div>
      </td>
      <td className="hidden p-3 md:table-cell">{nameInput}</td>
      <td className="hidden p-3 md:table-cell">{ipInput}</td>
      <td className="hidden p-3 md:table-cell">{userInput}</td>
      <td className="hidden p-3 md:table-cell">{passwordInput}</td>
      <td className="hidden p-3 text-right md:table-cell">{editButtons}</td>
    </tr>
  );
}

function ViewStep({
  domains,
  inboxes,
  records,
}: {
  domains: any[];
  inboxes: any[];
  records: any[];
}) {
  // Unique mail subdomains across the job (apex excluded) — same set the "Subdomains" export uses.
  const subdomainCount = subdomainExportRows(
    inboxes.map((ib) => ({
      domainName: "",
      subdomainPrefix: ib.subdomainPrefix,
      subdomainFqdn: ib.subdomainFqdn,
    })),
  ).length;

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-6 lg:grid-cols-4">
        <div className="rounded-xl bg-card p-4 sm:p-6 shadow-sm ring-1 ring-border flex flex-col gap-2">
          <div className="text-xs font-bold text-muted-foreground uppercase">Total Domains</div>
          <div className="text-2xl sm:text-3xl font-black text-primary">{domains.length}</div>
        </div>
        <div className="rounded-xl bg-card p-4 sm:p-6 shadow-sm ring-1 ring-border flex flex-col gap-2">
          <div className="text-xs font-bold text-muted-foreground uppercase">Total Subdomains</div>
          <div className="text-2xl sm:text-3xl font-black text-primary">{subdomainCount}</div>
        </div>
        <div className="rounded-xl bg-card p-4 sm:p-6 shadow-sm ring-1 ring-border flex flex-col gap-2">
          <div className="text-xs font-bold text-muted-foreground uppercase">Total Inboxes</div>
          <div className="text-2xl sm:text-3xl font-black text-primary">{inboxes.length}</div>
        </div>
        <div className="rounded-xl bg-card p-4 sm:p-6 shadow-sm ring-1 ring-border flex flex-col gap-2">
          <div className="text-xs font-bold text-muted-foreground uppercase">DNS Records</div>
          <div className="text-2xl sm:text-3xl font-black text-purple-500">{records.length}</div>
        </div>
      </div>

      <div className="rounded-xl bg-card p-4 sm:p-6 shadow-sm ring-1 ring-border">
        <h3 className="text-lg font-bold text-foreground mb-4">Domains in Job</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            {/* Phones get one stacked cell per row (see EditableDomainRow), so no column headers. */}
            <thead className="hidden md:table-header-group">
              <tr className="border-b-2 border-border">
                <th className="p-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">Domain</th>
                <th className="p-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">IP Address</th>
                <th className="p-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">SSH User</th>
                <th className="p-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">SSH Password</th>
                <th className="p-4 text-xs font-bold text-muted-foreground uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <EditableDomainRow key={d.id} domain={d} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
