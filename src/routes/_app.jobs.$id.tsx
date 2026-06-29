import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getBatchDetails,
  batchPushDnsToCloudflare,
  checkDnsPropagation,
  deleteDomainBatch,
  updateDomain,
} from "@/server/domains";
import { testSshConnection, provisionServer } from "@/server/provisioning";
import { setupMailcowDomain } from "@/server/mailcow";
import {
  Globe,
  FolderGit2,
  ArrowLeft,
  Loader2,
  Mail,
  Send,
  Server,
  CheckCircle2,
  XCircle,
  Terminal,
  Trash2,
  Download,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/_app/jobs/$id")({
  component: JobPipelinePage,
});

type Step = "VIEW" | "PRE_FLIGHT" | "DNS_PUSH" | "SERVER_SETUP";

function JobPipelinePage() {
  const { id } = Route.useParams();
  const [step, setStep] = useState<Step>("VIEW");
  const [autoStepped, setAutoStepped] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);

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

  const handleExportCsv = () => {
    // Wrap a field in quotes if it contains a comma, quote, or newline (RFC 4180).
    const esc = (v: any) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const headers = [
      "Name",
      "Email",
      "Password",
      "IMAP Server",
      "IMAP Port",
      "SMTP Server",
      "SMTP Port",
      "Daily Limit",
      "SMTP Secure",
      "IMAP Secure",
    ];

    const rows: string[][] = [];
    domains.forEach((d: any) => {
      const mailServer = d.mailcowHostname || `mail.${d.name}`;
      inboxes
        .filter((i: any) => i.domainId === d.id && i.password) // only created mailboxes
        .forEach((ib: any) => {
          const name =
            ib.fullName ||
            ib.personName ||
            [ib.firstName, ib.lastName].filter(Boolean).join(" ") ||
            ib.localPart ||
            "";
          rows.push([
            name,
            ib.email,
            ib.password || "",
            mailServer, // IMAP Server
            "993", // IMAP Port
            mailServer, // SMTP Server
            "587", // SMTP Port (STARTTLS)
            "15", // Daily Limit
            "TLS", // SMTP Secure (STARTTLS on 587)
            "SSL", // IMAP Secure (implicit TLS on 993)
          ]);
        });
    });

    if (!rows.length) {
      alert("No created mailboxes to export yet. Create the mailboxes first.");
      return;
    }

    const csvContent = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `job_${batch.name}_export.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const batch = (data as any)?.batch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const domains = (data as any)?.domains ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inboxes = (data as any)?.inboxes ?? [];

  // Batch: delete & recreate mailboxes (clean slate) across every domain in the job.
  const handleBatchRecreateMailboxes = async () => {
    if (!domains.length) return;
    if (
      !confirm(
        `Recreate mailboxes for ALL ${domains.length} domains (clean slate)?\n\nThis DELETES every mailbox in Mailcow and recreates them with NEW passwords. Old passwords will stop working. Mail domains and DKIM are kept.\n\nContinue?`,
      )
    )
      return;
    setBatchBusy(true);
    let created = 0;
    let failed = 0;
    for (const d of domains) {
      if (!d.mailcowHostname) continue; // server not provisioned yet
      try {
        const res: any = await setupMailcowDomain({ data: { domainId: d.id, recreate: true } });
        if (res?.summary) {
          created += res.summary.created;
          failed += res.summary.failed;
        } else if (res?.error) {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
    setBatchBusy(false);
    qc.invalidateQueries({ queryKey: ["batch", id] });
    if (failed > 0)
      toast.error(`Recreated ${created} mailboxes; ${failed} failed. Open a domain to see why.`, {
        duration: 10000,
      });
    else toast.success(`Recreated ${created} mailboxes across ${domains.length} domains.`);
  };

  // Batch: wipe Docker/Mailcow and re-provision every server from scratch.
  const handleBatchWipeReprovision = async () => {
    if (!domains.length) return;
    if (
      !confirm(
        `Wipe & re-provision ALL ${domains.length} servers from scratch?\n\nThis reinstalls Docker/Mailcow on each server (20-40 min each) and regenerates everything. Continue?`,
      )
    )
      return;
    setBatchBusy(true);
    let startedOk = 0;
    let startFailed = 0;
    for (const d of domains) {
      try {
        const res: any = await provisionServer({ data: { domainId: d.id } });
        if (res?.error) startFailed += 1;
        else startedOk += 1;
      } catch {
        startFailed += 1;
      }
    }
    setBatchBusy(false);
    qc.invalidateQueries({ queryKey: ["batch", id] });
    toast[startFailed ? "error" : "success"](
      `Re-provision started for ${startedOk} server(s)${startFailed ? `, ${startFailed} failed to start` : ""}. Open "Server Setup" to watch progress.`,
    );
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const records = (data as any)?.records ?? [];

  // Auto-jump to SERVER_SETUP if any domain is already in provisioning or failed state
  useEffect(() => {
    if (autoStepped || !domains.length) return;
    const needsSetup = domains.some((d: any) =>
      d.status === "failed" || d.status === "provisioning" || d.status === "configuring"
    );
    if (needsSetup) {
      setStep("SERVER_SETUP");
      setAutoStepped(true);
    }
  }, [domains, autoStepped]);

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
    <div className="flex flex-col gap-6 p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {step === "VIEW" ? (
            <Link to="/jobs">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-card shadow-sm ring-1 ring-border hover:bg-muted transition-colors">
                <ArrowLeft className="h-5 w-5 text-muted-foreground" />
              </div>
            </Link>
          ) : (
            <Button variant="ghost" size="icon" onClick={() => setStep("VIEW")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
          )}
          <div>
            <h1 className="text-2xl font-bold text-foreground">{batch.name}</h1>
            <div className="flex gap-2 items-center text-sm text-muted-foreground mt-1">
              <span>Step:</span>
              <span className={`font-bold ${step === "VIEW" ? "text-primary" : ""}`}>Plan</span>
              <span>→</span>
              <span className={`font-bold ${step === "PRE_FLIGHT" ? "text-primary" : ""}`}>
                Pre-Flight
              </span>
              <span>→</span>
              <span className={`font-bold ${step === "DNS_PUSH" ? "text-primary" : ""}`}>
                DNS Push
              </span>
              <span>→</span>
              <span className={`font-bold ${step === "SERVER_SETUP" ? "text-primary" : ""}`}>
                Server Setup
              </span>
            </div>
          </div>
        </div>
        {step === "VIEW" && (
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={handleExportCsv}
              className="h-11 px-4 rounded-2xl border-border text-muted-foreground hover:bg-muted"
            >
              <Download className="h-4 w-4 mr-2" />
              Export CSV
            </Button>
            <Button
              variant="outline"
              onClick={handleBatchRecreateMailboxes}
              disabled={batchBusy}
              className="h-11 px-4 rounded-2xl border-warning/30 text-warning hover:bg-warning/10"
              title="Delete & recreate every mailbox in this job with fresh passwords"
            >
              {batchBusy ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Recreate Mailboxes
            </Button>
            <Button
              variant="outline"
              onClick={handleBatchWipeReprovision}
              disabled={batchBusy}
              className="h-11 px-4 rounded-2xl border-destructive/30 text-destructive hover:bg-destructive/10"
              title="Wipe Docker/Mailcow and re-provision every server in this job from scratch"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Wipe &amp; Re-provision
            </Button>
            <Button
              variant="outline"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="h-11 px-4 rounded-2xl border-destructive/30 text-destructive hover:bg-destructive/10"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              Delete Job
            </Button>
            {domains.some((d: any) => d.status === "failed" || d.status === "provisioning" || d.status === "configuring") && (
              <Button
                variant="outline"
                onClick={() => setStep("SERVER_SETUP")}
                className="h-11 px-4 rounded-2xl border-warning/30 text-warning hover:bg-warning/10"
              >
                <Server className="h-4 w-4 mr-2" />
                Go to Server Setup
              </Button>
            )}
            <Button
              onClick={() => setStep("PRE_FLIGHT")}
              className="h-11 px-8 rounded-2xl bg-primary hover:bg-primary/90 text-white shadow-lg"
            >
              Start Provisioning Pipeline
            </Button>
          </div>
        )}
      </div>

      {step === "VIEW" && <ViewStep domains={domains} inboxes={inboxes} records={records} />}
      {step === "PRE_FLIGHT" && (
        <PreFlightStep
          domains={domains}
          inboxes={inboxes}
          records={records}
          onNext={() => setStep("DNS_PUSH")}
        />
      )}
      {step === "DNS_PUSH" && (
        <DnsPushStep domains={domains} records={records} onNext={() => setStep("SERVER_SETUP")} />
      )}
      {step === "SERVER_SETUP" && <ServerSetupStep domains={domains} />}
    </div>
  );
}

// --- STEP 1: VIEW (Original Read-Only View) ---
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

  if (!isEditing) {
    return (
      <tr className="border-b border-border last:border-0 hover:bg-muted/50 transition-colors">
        <td className="p-4 font-medium text-foreground">{domain.name}</td>
        <td className="p-4 font-mono text-xs text-muted-foreground">{domain.ipAddress || "-"}</td>
        <td className="p-4 font-mono text-xs text-muted-foreground">{domain.sshUser || "-"}</td>
        <td className="p-4 font-mono text-xs text-muted-foreground italic">
          {domain.sshPassword ? "••••••••" : "Not set"}
        </td>
        <td className="p-4 text-right">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsEditing(true)}
            className="text-primary hover:text-primary hover:bg-primary/10"
          >
            Edit
          </Button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-border last:border-0 bg-primary/10/30">
      <td className="p-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9 text-sm rounded-xl" />
      </td>
      <td className="p-3">
        <Input value={ipAddress} onChange={(e) => setIpAddress(e.target.value)} className="h-9 text-sm font-mono rounded-xl" />
      </td>
      <td className="p-3">
        <Input value={sshUser} onChange={(e) => setSshUser(e.target.value)} className="h-9 text-sm font-mono rounded-xl" />
      </td>
      <td className="p-3">
        <Input type="password" value={sshPassword} onChange={(e) => setSshPassword(e.target.value)} className="h-9 text-sm font-mono rounded-xl" placeholder="Password" />
      </td>
      <td className="p-3 text-right">
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)} className="rounded-xl">
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={updateMut.isPending} className="rounded-xl bg-primary hover:bg-primary/90 text-white">
            {updateMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
          </Button>
        </div>
      </td>
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
  return (
    <div className="grid gap-6">
      <div className="grid gap-6 md:grid-cols-3">
        <div className="rounded-3xl bg-card p-6 shadow-sm ring-1 ring-border flex flex-col gap-2">
          <div className="text-xs font-bold text-muted-foreground uppercase">Total Domains</div>
          <div className="text-3xl font-black text-primary">{domains.length}</div>
        </div>
        <div className="rounded-3xl bg-card p-6 shadow-sm ring-1 ring-border flex flex-col gap-2">
          <div className="text-xs font-bold text-muted-foreground uppercase">Total Inboxes</div>
          <div className="text-3xl font-black text-primary">{inboxes.length}</div>
        </div>
        <div className="rounded-3xl bg-card p-6 shadow-sm ring-1 ring-border flex flex-col gap-2">
          <div className="text-xs font-bold text-muted-foreground uppercase">DNS Records</div>
          <div className="text-3xl font-black text-purple-500">{records.length}</div>
        </div>
      </div>

      <div className="rounded-3xl bg-card p-6 shadow-sm ring-1 ring-border">
        <h3 className="text-lg font-bold text-foreground mb-4">Domains in Job</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
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

// --- STEP 2: PRE_FLIGHT ---
function PreFlightStep({
  domains,
  inboxes,
  records,
  onNext,
}: {
  domains: any[];
  inboxes: any[];
  records: any[];
  onNext: () => void;
}) {
  const [sshStatuses, setSshStatuses] = useState<Record<string, "testing" | "ok" | "fail">>({});

  const testSsh = useMutation({
    mutationFn: (args: { data: { domainId: string } }) => testSshConnection(args),
    onSuccess: (res: any, variables: { data: { domainId: string } }) => {
      setSshStatuses((prev) => ({
        ...prev,
        [variables.data.domainId]: res.success ? "ok" : "fail",
      }));
    },
  });

  const runSshTests = () => {
    domains.forEach((d) => {
      setSshStatuses((prev) => ({ ...prev, [d.id]: "testing" }));
      testSsh.mutate({ data: { domainId: d.id } });
    });
  };

  return (
    <div className="flex flex-col gap-4 bg-card rounded-3xl p-6 shadow-sm ring-1 ring-border">
      <Tabs
        defaultValue="dns"
        onValueChange={(v) => {
          if (v === "server") runSshTests();
        }}
      >
        <TabsList className="mb-4">
          <TabsTrigger value="dns">DNS Preview</TabsTrigger>
          <TabsTrigger value="mailboxes">Mailbox Plan</TabsTrigger>
          <TabsTrigger value="server">Server Check</TabsTrigger>
        </TabsList>

        <TabsContent value="dns" className="flex flex-col gap-4">
          {domains.map((d) => {
            const dRecords = records.filter((r) => r.domainId === d.id);
            return (
              <div key={d.id} className="border rounded-xl p-4">
                <h3 className="font-bold mb-2 flex items-center gap-2">
                  <Globe className="w-4 h-4" />
                  {d.name}
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead>
                      <tr className="bg-muted">
                        <th className="p-2">Name</th>
                        <th className="p-2">Type</th>
                        <th className="p-2">Content</th>
                        <th className="p-2">TTL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dRecords.map((r) => (
                        <tr key={r.id} className="border-b last:border-0">
                          <td className="p-2">{r.name}</td>
                          <td className="p-2">
                            <span className="bg-secondary px-1 rounded text-xs">{r.type}</span>
                          </td>
                          <td className="p-2 truncate max-w-[200px]" title={r.content}>
                            {r.content}
                          </td>
                          <td className="p-2">{r.ttl}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </TabsContent>

        <TabsContent value="mailboxes">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {domains.map((d) => {
              const dInboxes = inboxes.filter((i) => i.domainId === d.id);
              return (
                <div key={d.id} className="border rounded-xl p-4">
                  <h3 className="font-bold mb-2">{d.name}</h3>
                  <div className="text-sm text-muted-foreground">{dInboxes.length} inboxes planned</div>
                </div>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="server" className="flex flex-col gap-4">
          {domains.map((d) => (
            <div key={d.id} className="border rounded-xl p-4 flex items-center justify-between">
              <div className="flex flex-col">
                <span className="font-bold">{d.name}</span>
                <span className="text-xs text-muted-foreground">
                  {d.ipAddress} | {d.sshUser}
                </span>
              </div>
              <div>
                {sshStatuses[d.id] === "testing" && (
                  <Loader2 className="animate-spin text-primary" />
                )}
                {sshStatuses[d.id] === "ok" && <CheckCircle2 className="text-green-500" />}
                {sshStatuses[d.id] === "fail" && <XCircle className="text-red-500" />}
              </div>
            </div>
          ))}
          {Object.values(sshStatuses).includes("fail") && (
            <div className="p-4 bg-destructive/10 text-destructive rounded-xl text-sm flex items-center gap-2">
              <XCircle className="w-4 h-4" /> Warning: Some servers are unreachable. You may
              proceed, but server setup will fail.
            </div>
          )}
        </TabsContent>
      </Tabs>
      <div className="pt-4 border-t flex justify-end">
        <Button onClick={onNext} className="bg-primary hover:bg-primary/90 text-white rounded-xl">
          Confirm & Start
        </Button>
      </div>
    </div>
  );
}

// --- STEP 3: DNS PUSH ---
function DnsPushStep({
  domains,
  records,
  onNext,
}: {
  domains: any[];
  records: any[];
  onNext: () => void;
}) {
  const [progress, setProgress] = useState<
    Record<
      string,
      { current: number; total: number; status: "pending" | "pushing" | "done" | "error" }
    >
  >({});
  const [logs, setLogs] = useState<Record<string, any[]>>({});
  const [propagation, setPropagation] = useState<Record<string, "pending" | "ok" | "fail">>({});
  const [isRunning, setIsRunning] = useState(false);

  const pushMutation = useMutation({
    mutationFn: (args: { data: { domainId: string } }) => batchPushDnsToCloudflare(args),
  });
  const propMutation = useMutation({
    mutationFn: (args: { data: { domainName: string } }) => checkDnsPropagation(args),
  });

  const startPush = async () => {
    setIsRunning(true);
    for (const d of domains) {
      const dRecords = records.filter((r) => r.domainId === d.id);
      setProgress((p) => ({
        ...p,
        [d.id]: { current: 0, total: dRecords.length, status: "pushing" },
      }));

      const res = await pushMutation.mutateAsync({ data: { domainId: d.id } });

      setLogs((l) => ({ ...l, [d.id]: res.results }));
      const hasError = res.results?.some((r: any) => !r.success) || false;
      setProgress((p) => ({
        ...p,
        [d.id]: {
          current: dRecords.length,
          total: dRecords.length,
          status: hasError ? "error" : "done",
        },
      }));

      // Propagation check
      if (!hasError) {
        const propRes = await propMutation.mutateAsync({ data: { domainName: d.name } });
        setPropagation((p) => ({ ...p, [d.id]: propRes.success ? "ok" : "fail" }));
      }
    }
    setIsRunning(false);
  };

  useEffect(() => {
    startPush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalDone = Object.values(progress).filter(
    (p) => p.status === "done" || p.status === "error",
  ).length;

  return (
    <div className="flex flex-col gap-6 bg-card rounded-3xl p-6 shadow-sm ring-1 ring-border">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Cloudflare DNS Push</h2>
        <div className="text-sm text-muted-foreground">
          {totalDone} / {domains.length} domains processed
        </div>
      </div>

      {domains.map((d) => {
        const p = progress[d.id];
        const l = logs[d.id] || [];
        if (!p) return null;
        return (
          <div key={d.id} className="border rounded-xl p-4 flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <span className="font-bold flex items-center gap-2">
                <Globe className="w-4 h-4" /> {d.name}
              </span>
              <span className="text-xs text-muted-foreground">
                {p.status === "pushing" && <Loader2 className="w-3 h-3 animate-spin inline mr-1" />}
                {p.current} / {p.total} records
              </span>
            </div>
            <div className="w-full bg-muted h-2 rounded-full overflow-hidden">
              <div
                className={`h-full ${p.status === "error" ? "bg-red-500" : "bg-primary"} transition-all`}
                style={{ width: `${(p.current / (p.total || 1)) * 100}%` }}
              />
            </div>
            {l.length > 0 && (
              <div className="max-h-32 overflow-y-auto text-xs font-mono bg-muted p-2 rounded border">
                {l.map((res: any, i) => (
                  <div key={i} className={res.success ? "text-success" : "text-destructive"}>
                    {res.success ? "✅" : "❌"} {res.name} {res.error ? `- ${res.error}` : ""}
                  </div>
                ))}
              </div>
            )}
            {p.status === "done" && (
              <div className="text-xs flex items-center gap-2 mt-2">
                Propagation Check:
                {propagation[d.id] === "pending" && (
                  <Loader2 className="w-3 h-3 animate-spin text-primary" />
                )}
                {propagation[d.id] === "ok" && (
                  <span className="text-success font-bold">Passed</span>
                )}
                {propagation[d.id] === "fail" && (
                  <span className="text-warning font-bold">Awaiting Global Propagation</span>
                )}
              </div>
            )}
          </div>
        );
      })}

      <div className="pt-4 border-t flex justify-end">
        <Button
          onClick={onNext}
          disabled={isRunning}
          className="bg-primary hover:bg-primary/90 text-white rounded-xl"
        >
          Proceed to Server Setup
        </Button>
      </div>
    </div>
  );
}

// --- STEP 4: SERVER SETUP ---
function ServerSetupStep({ domains }: { domains: any[] }) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {domains.map((d) => (
        <TerminalWindow key={d.id} domain={d} />
      ))}
    </div>
  );
}

function TerminalWindow({ domain }: { domain: any }) {
  const [logs, setLogs] = useState<string[]>(domain.terminalLogs && domain.status !== "failed" ? [domain.terminalLogs] : []);
  const [status, setStatus] = useState(
    domain.status === "ready" ? "Ready" :
    domain.status === "failed" ? "Failed" :
    domain.status === "provisioning" ? "Provisioning" :
    domain.status === "configuring" ? "Configuring" :
    "Queued"
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  const provMutation = useMutation({
    mutationFn: (args: { data: { domainId: string } }) => provisionServer(args),
  });
  const [startTrigger, setStartTrigger] = useState<number>(0);

  const sseRef = useRef<(() => void) | null>(null);

  const connectSse = () => {
    if (sseRef.current) {
      sseRef.current();
    }
    const eventSource = new EventSource(`/api/sse?domainId=${domain.id}`);
    eventSource.onmessage = (event) => {
      const parsed = JSON.parse(event.data);
      if (parsed.status) setStatus(parsed.status);
      if (parsed.chunk) {
        setLogs((prev) => {
          if (prev.length > 0 && parsed.chunk.startsWith(prev.join(""))) {
            return [parsed.chunk];
          }
          if (prev.includes(parsed.chunk)) return prev;
          return [...prev, parsed.chunk];
        });
      } else if (parsed.msg) {
        setLogs((prev) => {
          const systemMsg = `[System] ${parsed.msg}\n`;
          if (prev.includes(systemMsg)) return prev;
          return [...prev, systemMsg];
        });
      }
    };
    eventSource.onerror = () => eventSource.close();
    sseRef.current = () => eventSource.close();
    return sseRef.current;
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sseRef.current) sseRef.current();
    };
  }, []);

  // Auto-connect SSE for in-progress domains on first mount (no new job needed)
  // Auto-start for pending domains
  useEffect(() => {
    if (domain.status === "provisioning" || domain.status === "configuring") {
      return connectSse();
    } else if (domain.status === "pending" || !domain.status) {
      setStartTrigger(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Trigger provisioning when startTrigger increments (0 = skip initial)
  useEffect(() => {
    if (startTrigger === 0) return;

    setStatus("Connecting");
    provMutation.mutateAsync({ data: { domainId: domain.id } }).then((res) => {
      if (res.jobId) {
        connectSse();
      } else {
        setStatus("Failed");
        setLogs([`Error starting job: ${res.error}`]);
      }
    }).catch((err) => {
      setStatus("Failed");
      setLogs([`Error starting job: ${err.message}`]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTrigger]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  let statusColor = "bg-gray-500";
  if (
    status === "Connecting" ||
    status === "Updating System" ||
    status === "Pulling Images" ||
    status.includes("Docker") ||
    status === "Configuring" ||
    status === "Cloning Mailcow" ||
    status === "Starting Containers" ||
    status === "Provisioning"
  )
    statusColor = "bg-primary";
  if (status === "Failed") statusColor = "bg-red-500";
  if (status === "Ready") statusColor = "bg-green-500";

  return (
    <div className="flex flex-col bg-black rounded-lg overflow-hidden shadow-2xl border border-gray-800">
      <div className="bg-gray-900 px-4 py-2 flex justify-between items-center border-b border-gray-800">
        <div className="flex items-center gap-3">
          <Terminal className="w-4 h-4 text-muted-foreground" />
          <span className="text-gray-200 font-mono text-sm">{domain.ipAddress}</span>
        </div>
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${statusColor} ${statusColor === "bg-primary" ? "animate-pulse" : ""}`}
          />
          <span className="text-muted-foreground text-xs font-mono">{status}</span>
        </div>
      </div>
      <div className="p-4 h-80 overflow-y-auto font-mono text-xs text-green-400 leading-relaxed custom-scrollbar">
        <pre className="whitespace-pre-wrap font-inherit break-all">{logs.join("")}</pre>
        <div ref={bottomRef} />
      </div>
      {status === "Failed" && (
        <TerminalWindowFailedFooter
          domain={domain}
          onRetry={() => {
            setLogs([]);
            setStartTrigger((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

function TerminalWindowFailedFooter({ domain, onRetry }: { domain: any; onRetry: () => void }) {
  const [editPassword, setEditPassword] = useState(domain.sshPassword || "");
  const [showEdit, setShowEdit] = useState(false);
  const updatePasswordMutation = useMutation({
    mutationFn: (newPassword: string) =>
      updateDomain({ data: { id: domain.id, sshPassword: newPassword } }),
    onSuccess: (res: any) => {
      if (res.ok) {
        toast.success("SSH Password updated successfully");
        setShowEdit(false);
      } else {
        toast.error(res.error || "Failed to update SSH Password");
      }
    },
  });

  return (
    <div className="bg-gray-900 p-3 flex flex-col gap-3 border-t border-gray-800">
      {showEdit ? (
        <div className="flex gap-2 items-center">
          <Input
            type="password"
            placeholder="Enter correct SSH Password"
            value={editPassword}
            onChange={(e) => setEditPassword(e.target.value)}
            className="h-9 text-xs font-mono bg-black border-gray-800 text-gray-200 placeholder-gray-500 rounded-xl"
          />
          <Button
            size="sm"
            onClick={async () => {
              await updatePasswordMutation.mutateAsync(editPassword);
            }}
            disabled={updatePasswordMutation.isPending}
            className="h-9 text-xs rounded-xl bg-primary hover:bg-primary/90 text-white"
          >
            {updatePasswordMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              "Save"
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowEdit(false)}
            className="h-9 text-xs rounded-xl text-muted-foreground hover:text-gray-200"
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex justify-between items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowEdit(true)}
            className="h-9 text-xs rounded-xl border-gray-800 bg-gray-950 text-muted-foreground hover:bg-gray-800 hover:text-white"
          >
            Change SSH Password
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={onRetry}
            className="h-9 text-xs rounded-xl"
          >
            Retry Setup
          </Button>
        </div>
      )}
    </div>
  );
}
