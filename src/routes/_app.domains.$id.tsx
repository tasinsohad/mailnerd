import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getDomainDetails, pushDnsToCloudflare, updateDomain, repairDomainDns } from "@/server/domains";
import { provisionServer } from "@/server/provisioning";
import { setupMailcowDomain, fetchDkimAndSync } from "@/server/mailcow";
import { regeneratePlan } from "@/server/plans";
import { getDomainSetup, startDomainSetup } from "@/server/domain-setup-fns";
import { SetupProgress, SetupRow } from "@/components/setup/SetupRow";
import { isActive, type ServerChoice, type SetupState, type SetupStep } from "@/lib/setup-state";
import { mailboxProgressText, manualRunProgress, toSetupRowData } from "@/lib/setup-status";
import { progressPercent } from "@/lib/mailbox-progress";
import { downloadCsv } from "@/lib/csv";
import { buildExportCsv } from "@/lib/export-formats";
import { ExportButton } from "@/components/ExportButton";
import { ExportSubdomainsDialog } from "@/components/ExportSubdomainsDialog";
import { TroubleshootButton } from "@/components/TroubleshootButton";
import { subdomainExportRows } from "@/lib/subdomains";
import {
  Globe,
  Server,
  AlertCircle,
  Loader2,
  ArrowLeft,
  Send,
  Zap,
  Mail,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
  Network,
  Key,
  Eye,
  EyeOff,
  Terminal,
  RefreshCw,
  Trash2,
  ListPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { MoreHorizontal } from "lucide-react";
import { HealthCard } from "@/components/HealthCard";
import { MailcowAdminReset } from "@/components/MailcowAdminReset";
import { toast } from "sonner";
import { useState, useEffect, useRef } from "react";

// Shared status presentation: an LED dot whose color carries meaning.
const STATUS_STYLE: Record<string, { color: string; label: string; pulse?: boolean }> = {
  ready: { color: "text-success", label: "Ready" },
  active: { color: "text-success", label: "Active" },
  provisioning: { color: "text-warning", label: "Provisioning", pulse: true },
  configuring: { color: "text-warning", label: "Configuring", pulse: true },
  queued: { color: "text-muted-foreground", label: "Queued" },
  pending: { color: "text-muted-foreground", label: "Pending" },
  failed: { color: "text-destructive", label: "Failed" },
  error: { color: "text-destructive", label: "Error" },
};

function StatusPill({ status }: { status?: string }) {
  const s = STATUS_STYLE[String(status ?? "").toLowerCase()] ?? {
    color: "text-muted-foreground",
    label: status ? String(status) : "Unknown",
  };
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground">
      <span className={cn("status-dot", s.color, s.pulse && "status-dot--pulse")} />
      {s.label}
    </span>
  );
}

export const Route = createFileRoute("/_app/domains/$id")({
  component: DomainDetailsPage,
});

function DomainDetailsPage() {
  const qc = useQueryClient();
  const { id } = Route.useParams();

  const { data, isLoading } = useQuery({
    queryKey: ["domain", id],
    queryFn: () => getDomainDetails({ data: { id } }),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const domain = (data as any)?.domain;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const records = (data as any)?.records ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inboxes = (data as any)?.inboxes ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plan = (data as any)?.plan;

  // Group inboxes by subdomain for the breakdown
  const subdomainBreakdown = inboxes.reduce((acc: any, ib: any) => {
    acc[ib.subdomainPrefix] = (acc[ib.subdomainPrefix] || 0) + 1;
    return acc;
  }, {});

  // Mailboxes not usable yet once the server is set up and idle: failed, never created, or created
  // without a saved password (e.g. an interrupted run). Listed with a retry. Status must be "ready":
  // mailcowHostname is saved halfway through a Mailcow install, so it alone would show this mid-setup.
  const unfinishedInboxes =
    domain?.status === "ready" && domain?.mailcowHostname
      ? inboxes.filter((ib: any) => ib.status !== "active" || !ib.password)
      : [];
  // Mailcow's reason per mailbox from the last run, keyed by lower-cased address.
  const [mailboxErrors, setMailboxErrors] = useState<Record<string, string>>({});

  const [logs, setLogs] = useState<string[]>([]);
  const [terminalStatus, setTerminalStatus] = useState<string>("");
  const [subOpen, setSubOpen] = useState(false);
  // The scrollable log pane itself — auto-scroll moves only this box, never the page.
  const logPaneRef = useRef<HTMLDivElement>(null);

  // Unique subdomains (apex excluded) for this domain — available as soon as inboxes are planned.
  const subRows = subdomainExportRows(
    inboxes.map((ib: any) => ({
      domainName: domain?.name ?? "",
      subdomainPrefix: ib.subdomainPrefix,
      subdomainFqdn: ib.subdomainFqdn,
      ipAddress: domain?.ipAddress,
    })),
  );

  const [isEditingServer, setIsEditingServer] = useState(false);
  const [ipAddress, setIpAddress] = useState("");
  const [sshUser, setSshUser] = useState("root");
  const [sshPassword, setSshPassword] = useState("");
  const [dnsOpen, setDnsOpen] = useState(false);

  useEffect(() => {
    if (domain) {
      setIpAddress(domain.ipAddress || "");
      setSshUser(domain.sshUser || "root");
      setSshPassword(domain.sshPassword || "");
    }
  }, [domain]);

  useEffect(() => {
    if (domain?.terminalLogs && logs.length === 0) {
      setLogs([domain.terminalLogs]);
    }
  }, [domain?.terminalLogs, logs.length]);

  useEffect(() => {
    if (domain?.status === "configuring" || domain?.status === "provisioning") {
      setTerminalStatus(domain.status === "configuring" ? "Configuring" : "Provisioning");
      const eventSource = new EventSource(`/api/sse?domainId=${domain.id}`);
      
      eventSource.onmessage = (event) => {
        const parsed = JSON.parse(event.data);
        if (parsed.status) setTerminalStatus(parsed.status);
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
      return () => eventSource.close();
    }
  }, [domain?.status, domain?.id]);

  useEffect(() => {
    // Only auto-scroll to the live log while actively provisioning — not when opening a
    // ready domain (which would yank the page down to its historical logs on load).
    if (domain?.status === "configuring" || domain?.status === "provisioning") {
      const el = logPaneRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [logs, domain?.status]);

  const pushDnsMutation = useMutation({
    mutationFn: () => pushDnsToCloudflare({ data: { domainId: id } }),
    onSuccess: (res: any) => {
      if (res?.error) toast.error(res.error);
      else toast.success("DNS records pushed successfully");
      qc.invalidateQueries({ queryKey: ["domain", id] });
    },
  });

  const repairDnsMutation = useMutation({
    mutationFn: () => {
      toast.loading("Fixing Cloudflare DNS (un-proxying mail records)...", { id: "repairdns" });
      return repairDomainDns({ data: { domainId: id } });
    },
    onSuccess: (res: any) => {
      if (res?.error) toast.error(res.error, { id: "repairdns" });
      else
        toast.success(
          `DNS fixed: un-proxied ${res.unproxied}, removed ${res.removed} bad mail record(s). Allow ~1 min for DNS to propagate.`,
          { id: "repairdns", duration: 10000 },
        );
      qc.invalidateQueries({ queryKey: ["domain", id] });
    },
    onError: (err: any) => toast.error(err.message, { id: "repairdns" }),
  });

  const updateDomainMutation = useMutation({
    mutationFn: (args: { id: string; ipAddress: string; sshUser: string; sshPassword?: string }) =>
      updateDomain({ data: args }),
    onSuccess: (res: any) => {
      if (res.ok) {
        toast.success("Deployment target updated successfully");
        setIsEditingServer(false);
        qc.invalidateQueries({ queryKey: ["domain", id] });
      } else {
        toast.error(res.error || "Failed to update deployment target");
      }
    },
  });

  // After starting (or answering) a setup run: refetch the setup row and the domain's details. Returns the
  // invalidate/refetch promise so SetupRow/ServerChoicePanel can await it before clearing their busy state.
  const refreshSetup = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["domain-setup", id] }),
      qc.invalidateQueries({ queryKey: ["domain", id] }),
    ]);

  // provisionServer starts a setup run from the server step (the run itself asks before wiping a server
  // other domains use).
  const provisionMutation = useMutation({
    mutationFn: () => {
      setLogs([]);
      setTerminalStatus("");
      return provisionServer({ data: { domainId: id } });
    },
    onSuccess: (res: any) => {
      if (res?.error) toast.error(res.error);
      else toast.success("Server setup started — follow it in the setup row above.");
      refreshSetup();
    },
    onError: (err: any) => {
      toast.error(err.message);
      refreshSetup();
    },
  });

  // Run Full Automation (every step) and Wipe & re-provision (from the server step, reinstalling Mailcow):
  // a setup run on the server, which keeps going when this page is closed.
  const startRunMutation = useMutation({
    mutationFn: (opts: { fromStep?: SetupStep; serverChoice?: ServerChoice }) => {
      setLogs([]);
      setTerminalStatus("");
      return startDomainSetup({ data: { domainId: id, ...opts } });
    },
    onSuccess: (res, opts) => {
      if (!res.ok) toast.error(res.error ?? "Couldn't start setup");
      else if (opts.serverChoice === "reinstall")
        toast.success("Wipe & re-provision started — it keeps running if you close this page.");
      else toast.success("Setup started — it keeps running if you close this page.");
      refreshSetup();
    },
    onError: (err: any) => {
      toast.error(err.message);
      refreshSetup();
    },
  });

  // Report the ACTUAL outcome from Mailcow (verified against get/mailbox/all),
  // not just "no top-level error". Surfaces real per-mailbox failures.
  const reportMailcowResult = (res: any) => {
    if (res?.error) {
      toast.error(res.error, { id: "mailcow" });
      return;
    }
    setMailboxErrors(
      Object.fromEntries((res?.failed ?? []).map((f: any) => [String(f.email).toLowerCase(), String(f.error)])),
    );
    const s = res?.summary;
    if (s && s.failed > 0) {
      const firstErr = res.results?.find((r: any) => r.type === "mailbox" && !r.success)?.error;
      toast.error(
        `${s.created}/${s.total} mailboxes ready. ${s.failed} still failing after 3 retries` +
          `${firstErr ? ` (${firstErr})` : ""}. They're listed on this page to retry.`,
        { id: "mailcow", duration: 12000 },
      );
    } else if (s) {
      toast.success(`Verified ${s.created}/${s.total} mailboxes in Mailcow`, { id: "mailcow" });
    } else {
      toast.success("Mailbox setup finished", { id: "mailcow" });
    }
    qc.invalidateQueries({ queryKey: ["domain", id] });
  };

  const setupMailcowMutation = useMutation({
    mutationFn: () => {
      toast.loading(`Creating ${plan?.totalInboxes || 0} mailboxes in Mailcow...`, { id: "mailcow" });
      return setupMailcowDomain({ data: { domainId: id } });
    },
    onSuccess: reportMailcowResult,
    onError: (err: any) => {
      toast.error(err.message, { id: "mailcow" });
    }
  });

  // Clean slate: delete the mailboxes in Mailcow and recreate them with fresh passwords.
  const recreateMailboxesMutation = useMutation({
    mutationFn: () => {
      toast.loading(`Deleting & recreating mailboxes in Mailcow...`, { id: "mailcow" });
      return setupMailcowDomain({ data: { domainId: id, recreate: true } });
    },
    onSuccess: reportMailcowResult,
    onError: (err: any) => {
      toast.error(err.message, { id: "mailcow" });
    },
  });

  const handleRecreateMailboxes = () => {
    if (
      confirm(
        "Recreate mailboxes (clean slate)?\n\nThis DELETES the existing mailboxes for this domain in Mailcow and recreates them with NEW passwords. Old passwords will stop working. The mail domain and DKIM are kept.\n\nContinue?",
      )
    ) {
      recreateMailboxesMutation.mutate();
    }
  };

  // Change the mailbox count: regenerate the inbox plan from the saved prefixes/names snapshot with a new
  // total. handleRegeneratePlan then replaces the mailboxes in Mailcow too when the server is set up.
  // Toasts for the outcome are shown by the handler.
  const regeneratePlanMutation = useMutation({
    mutationFn: (count: number) => {
      toast.loading("Regenerating inbox plan...", { id: "replan" });
      return regeneratePlan({
        data: {
          domainId: id,
          totalInboxes: count,
          prefixes: plan?.prefixesSnapshot ?? [],
          names: plan?.namesSnapshot ?? [],
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["domain", id] });
    },
    onError: (err: any) => toast.error(err.message, { id: "replan" }),
  });

  const handleRegeneratePlan = async () => {
    if (!plan?.prefixesSnapshot?.length || !plan?.namesSnapshot?.length) {
      toast.error("No saved prefixes/names to regenerate from — re-add the domain instead.");
      return;
    }
    const domainName = domain?.name ?? "this domain";
    const currentTotal = plan?.totalInboxes ?? inboxes.length;
    const serverSetUp = Boolean(domain?.mailcowHostname);
    const answer = window.prompt(
      `How many mailboxes should ${domainName} have?\n\n` +
        (serverSetUp
          ? `The ${inboxes.length} current mailboxes are replaced with a new set (new addresses and passwords).`
          : `This replaces the ${inboxes.length} planned mailboxes with a new set (new addresses).`),
      String(currentTotal),
    );
    if (answer === null) return;
    const count = Number(answer.trim());
    if (!Number.isInteger(count) || count < 1 || count > 10000) {
      toast.error("Enter a whole number from 1 to 10000.");
      return;
    }
    if (count === currentTotal) {
      toast.info("That's the current count — nothing changed.");
      return;
    }

    // Mailboxes that may already exist in Mailcow get deleted by the recreate below: say so first.
    const hasLiveMailboxes = inboxes.some((ib: any) => ib.status === "active" || ib.password);
    if (
      serverSetUp &&
      hasLiveMailboxes &&
      !confirm(
        `Replace the ${inboxes.length} mailboxes on ${domainName} with ${count} new ones?\n\n` +
          `The existing mailboxes are deleted in Mailcow (their passwords stop working), then ${count} new ` +
          `addresses are created with new passwords.`,
      )
    ) {
      return;
    }

    let res: any;
    try {
      res = await regeneratePlanMutation.mutateAsync(count);
    } catch {
      return; // onError already replaced the loading toast with the error.
    }
    if (res?.error) {
      toast.error(res.error, { id: "replan" });
      return;
    }

    if (!serverSetUp) {
      toast.success(`The plan for ${domainName} now has ${count} mailboxes.`, { id: "replan" });
      return;
    }

    // Server is set up: make Mailcow match the new plan exactly (delete, then create the new set).
    // The recreate shows its own progress and result toasts, so drop the plan's loading toast.
    toast.dismiss("replan");
    try {
      await recreateMailboxesMutation.mutateAsync();
    } catch {
      // onError already replaced the loading toast with the error.
    }
  };

  const handleWipeAndReprovision = () => {
    if (
      confirm(
        "Wipe & re-provision EVERYTHING on this server?\n\nThis tears down Docker/Mailcow on the server, reinstalls from scratch, then re-runs provision → mailbox creation → DKIM. It takes 20-40 minutes and all current mailbox passwords will be regenerated.\n\nContinue?",
      )
    ) {
      startRunMutation.mutate({ fromStep: "server", serverChoice: "reinstall" });
    }
  };

  const syncDkimMutation = useMutation({
    mutationFn: () => {
      toast.loading(`Syncing DKIM keys to Cloudflare...`, { id: "dkim" });
      return fetchDkimAndSync({ data: { domainId: id } });
    },
    onSuccess: (res: any) => {
      if (res?.error) {
        toast.error(res.error, { id: "dkim" });
      } else {
        toast.success("DKIM keys synced to Cloudflare", { id: "dkim" });
        qc.invalidateQueries({ queryKey: ["domain", id] });
      }
    },
    onError: (err: any) => {
      toast.error(err.message, { id: "dkim" });
    }
  });

  // This domain's setup run (the same row as the job board). Polled every 3 s while a run is queued, running
  // or waiting for the user, and every 2 s while a manual mailbox run from this page is going, for its progress.
  const manualMailboxRunPending = setupMailcowMutation.isPending || recreateMailboxesMutation.isPending;
  const setupQuery = useQuery({
    queryKey: ["domain-setup", id],
    queryFn: () => getDomainSetup({ data: { domainId: id } }),
    refetchInterval: (query) => {
      if (manualMailboxRunPending) return 2000;
      const row = query.state.data as { setupState?: unknown } | null | undefined;
      return isActive(row?.setupState as SetupState | null) ? 3000 : false;
    },
  });
  const setupRow = setupQuery.data ? toSetupRowData(setupQuery.data) : null;
  const setupState = setupRow?.setupState ?? null;
  const runActive = isActive(setupState);
  // Queued or running: the run holds the domain, so the server refuses manual mailbox runs meanwhile.
  const runInFlight = setupState?.status === "queued" || setupState?.status === "running";

  // When the run moves on (a step starts or ends, the run ends, the domain's status changes), the rest of the
  // page changes with it: the status, the terminal log, the mailboxes and their passwords. Refetch the details.
  const setupSignature = setupRow
    ? `${setupRow.status}:${setupState?.runId}:${setupState?.status}:${setupState?.step}`
    : null;
  const lastSetupSignature = useRef<string | null>(null);
  useEffect(() => {
    if (setupSignature === null) return;
    if (lastSetupSignature.current !== null && lastSetupSignature.current !== setupSignature) {
      qc.invalidateQueries({ queryKey: ["domain", id] });
    }
    lastSetupSignature.current = setupSignature;
  }, [setupSignature, id, qc]);

  // Progress of the manual mailbox run this page started: only once that run has saved some.
  const manualRunStartedMs = setupMailcowMutation.isPending
    ? setupMailcowMutation.submittedAt
    : recreateMailboxesMutation.isPending
      ? recreateMailboxesMutation.submittedAt
      : null;
  const manualProgress =
    manualRunStartedMs !== null ? manualRunProgress(setupRow?.mailboxProgress ?? null, manualRunStartedMs) : null;

  const exportCsv = (formatId: string) => {
    // Mail server clients connect to (mailcow host), e.g. mail.example.com
    const mailServer = domain.mailcowHostname || `mail.${domain.name}`;
    // Only export mailboxes that were actually created (active, with a saved password) — these are the
    // usable sending accounts. Keeps "downloadable only when mailboxes are ready" true.
    const usable = inboxes.filter((ib: any) => ib.status === "active" && ib.password);
    if (!usable.length) {
      toast.error("No created mailboxes to export yet. Create the mailboxes first.");
      return;
    }
    const rows = usable.map((ib: any) => ({
      name: ib.fullName || [ib.firstName, ib.lastName].filter(Boolean).join(" ") || ib.localPart || "",
      firstName: ib.firstName || "",
      lastName: ib.lastName || "",
      email: ib.email,
      password: ib.password || "",
      mailServer,
    }));
    downloadCsv(`${domain.name}_${formatId}.csv`, buildExportCsv(formatId, rows));
    toast.success(`Exported ${rows.length} mailbox${rows.length === 1 ? "" : "es"}`);
  };

  const canExportCsv = inboxes.some((ib: any) => ib.status === "active" && ib.password);

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!domain) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <AlertCircle className="h-12 w-12 text-red-500 mb-4" />
        <h2 className="text-xl font-bold">Domain not found</h2>
        <Link to="/domains" className="text-primary hover:underline mt-2">
          Back to Domains
        </Link>
      </div>
    );
  }

  const isAnyPending =
    pushDnsMutation.isPending ||
    provisionMutation.isPending ||
    setupMailcowMutation.isPending ||
    recreateMailboxesMutation.isPending ||
    syncDkimMutation.isPending ||
    startRunMutation.isPending;

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <Link to="/domains" className="shrink-0" aria-label="Back to Domains">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-card shadow-sm ring-1 ring-border hover:bg-muted transition-colors">
              <ArrowLeft className="h-5 w-5 text-muted-foreground" />
            </div>
          </Link>
          <div className="min-w-0">
            <h1 className="font-display text-xl font-semibold tracking-tight text-foreground break-all sm:text-2xl">
              <span className="ident">{domain.name}</span>
            </h1>
            <div className="mt-1.5">
              <StatusPill status={domain.status} />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <TroubleshootButton
            domainId={id}
            className="h-10 gap-2 px-4 border-primary/40 text-primary hover:bg-primary/10"
          />
          <Button
            onClick={() => startRunMutation.mutate({})}
            disabled={isAnyPending || runActive}
            className="h-10 gap-2 px-5 font-semibold"
          >
            {startRunMutation.isPending || runInFlight ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Zap className="h-4 w-4 fill-current" />
            )}
            Run Full Automation
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-10 w-10"
                title="More actions"
                aria-label="More actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>Run a step</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => pushDnsMutation.mutate()} disabled={pushDnsMutation.isPending}>
                <Send className="h-4 w-4" /> Push DNS to Cloudflare
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => provisionMutation.mutate()}
                disabled={provisionMutation.isPending || runActive}
              >
                <Zap className="h-4 w-4" /> Provision server
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setupMailcowMutation.mutate()}
                disabled={setupMailcowMutation.isPending || runInFlight}
              >
                <Mail className="h-4 w-4" /> Set up mailboxes
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => syncDkimMutation.mutate()} disabled={syncDkimMutation.isPending}>
                <ShieldCheck className="h-4 w-4" /> Sync DKIM
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Repair</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => repairDnsMutation.mutate()} disabled={repairDnsMutation.isPending}>
                <Network className="h-4 w-4" /> Fix DNS (un-proxy)
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleRecreateMailboxes}
                disabled={recreateMailboxesMutation.isPending || runInFlight}
              >
                <RefreshCw className="h-4 w-4" /> Recreate mailboxes
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleRegeneratePlan}
                disabled={regeneratePlanMutation.isPending || recreateMailboxesMutation.isPending || runInFlight}
              >
                <ListPlus className="h-4 w-4" /> Change mailbox count…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleWipeAndReprovision}
                disabled={isAnyPending || runActive}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="h-4 w-4" /> Wipe &amp; re-provision
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {setupRow && (
        <section
          aria-labelledby="domain-setup-title"
          className="overflow-hidden rounded-xl border border-border bg-card"
        >
          <h2
            id="domain-setup-title"
            className="border-b border-border px-4 py-3 font-display text-base font-semibold text-foreground sm:px-5"
          >
            Setup
          </h2>
          <SetupRow row={setupRow} onChanged={refreshSetup} />
        </section>
      )}

      <HealthCard
        domainId={id}
        serverIp={domain.ipAddress ?? null}
        initialHealth={(domain.health as any) ?? null}
        initialServerHealth={((data as any)?.serverHealth?.health as any) ?? null}
        initialCheckedAt={domain.healthCheckedAt ?? null}
      />

      {/* Phones: three compact tiles in one row (value aligned to the bottom, helper text hidden). */}
      <div className="grid grid-cols-3 gap-2 sm:gap-6">
        <div className="rounded-xl bg-card p-3 shadow-sm ring-1 ring-border flex flex-col justify-between gap-1 sm:justify-start sm:gap-2 sm:p-6">
          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider sm:text-xs">
            Total Inboxes
          </div>
          <div className="text-2xl font-black text-primary sm:text-3xl">{plan?.totalInboxes || 0}</div>
          <div className="hidden text-[10px] text-muted-foreground sm:block">Planned across all subdomains</div>
        </div>
        <div className="rounded-xl bg-card p-3 shadow-sm ring-1 ring-border flex flex-col justify-between gap-1 sm:justify-start sm:gap-2 sm:p-6">
          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider sm:text-xs">Subdomains</div>
          <div className="text-2xl font-black text-primary sm:text-3xl">{plan?.subdomainCount || 0}</div>
          <div className="hidden text-[10px] text-muted-foreground sm:block">Unique routing prefixes</div>
        </div>
        <div className="rounded-xl bg-card p-3 shadow-sm ring-1 ring-border flex flex-col justify-between gap-1 sm:justify-start sm:gap-2 sm:p-6">
          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider sm:text-xs">
            Avg Per Subdomain
          </div>
          <div className="text-2xl font-black text-primary sm:text-3xl">
            {plan?.subdomainCount ? (plan.totalInboxes / plan.subdomainCount).toFixed(1) : 0}
          </div>
          <div className="hidden text-[10px] text-muted-foreground sm:block">Balanced distribution</div>
        </div>
      </div>

      {domain.mailcowHostname && (
        <div className="rounded-xl bg-card p-6 shadow-sm ring-1 ring-border flex flex-col gap-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Key className="h-5 w-5 text-muted-foreground" /> Mailcow Access
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <MailcowAdminReset
              domainId={id}
              mailcowHostname={domain.mailcowHostname}
              currentPassword={domain.mailcowAdminPassword ?? null}
            />
            <div className="rounded-lg border border-border p-4 flex flex-col gap-1">
              <div className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                Webmail (per mailbox)
              </div>
              <a
                href={`https://${domain.mailcowHostname}/SOGo/`}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-primary hover:underline break-all"
              >
                https://{domain.mailcowHostname}/SOGo/
              </a>
              <div className="mt-2 text-sm text-muted-foreground">
                Log in with the full email address + its password (from Export CSV).
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl bg-card p-6 shadow-sm ring-1 ring-border flex flex-col gap-4 relative">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Server className="h-5 w-5 text-muted-foreground" /> Deployment Target
            </h2>
            {!isEditingServer && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsEditingServer(true)}
                className="h-8 text-xs rounded-xl text-primary hover:text-primary hover:bg-primary/10"
              >
                Edit
              </Button>
            )}
          </div>

          {isEditingServer ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold text-muted-foreground uppercase">IP Address</label>
                  <Input
                    value={ipAddress}
                    onChange={(e) => setIpAddress(e.target.value)}
                    placeholder="e.g. 192.168.1.1"
                    className="h-9 text-xs rounded-xl"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold text-muted-foreground uppercase">SSH User</label>
                  <Input
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    placeholder="e.g. root"
                    className="h-9 text-xs rounded-xl"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-bold text-muted-foreground uppercase">SSH Password</label>
                <Input
                  type="password"
                  value={sshPassword}
                  onChange={(e) => setSshPassword(e.target.value)}
                  placeholder="Leave blank to keep current"
                  className="h-9 text-xs rounded-xl"
                />
              </div>
              <div className="flex justify-end gap-2 mt-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setIsEditingServer(false);
                    setIpAddress(domain.ipAddress || "");
                    setSshUser(domain.sshUser || "root");
                    setSshPassword(domain.sshPassword || "");
                  }}
                  className="h-8 text-xs rounded-xl"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    updateDomainMutation.mutate({
                      id: domain.id,
                      ipAddress,
                      sshUser,
                      sshPassword,
                    });
                  }}
                  disabled={updateDomainMutation.isPending}
                  className="h-8 text-xs rounded-xl bg-primary hover:bg-primary/90 text-white"
                >
                  {updateDomainMutation.isPending ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    "Save"
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Server className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <div className="font-medium break-all">{domain.name}</div>
                <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5">
                  <span className="flex min-w-0 items-center gap-1 break-all">
                    <Network className="h-3 w-3 shrink-0" />
                    {domain.ipAddress || "No IP configured"}
                  </span>
                  <span className="flex items-center gap-1">
                    <Key className="h-3 w-3" />
                    {domain.sshUser || "root"}
                  </span>
                </div>
              </div>
            </div>
          )}

          {domain.ipAddress && (
            <div className="mt-2 rounded-lg bg-warning/10 border border-warning/30 px-4 py-3 text-sm">
              <div className="font-semibold text-warning flex items-center gap-1.5">
                <Network className="h-4 w-4 shrink-0" /> Set Reverse DNS (PTR) — required for deliverability
              </div>
              <div className="mt-1 text-warning">
                In your VPS provider's control panel, set the PTR record for{" "}
                <span className="font-mono font-bold break-all">{domain.ipAddress}</span> →{" "}
                <span className="font-mono font-bold break-all">
                  {domain.mailcowHostname || `mail.${domain.name}`}
                </span>
                . This can't be set via API and must match the mail hostname, or major
                providers (Gmail/Outlook) will reject or spam-folder your mail.
              </div>
            </div>
          )}
        </div>

        <div className="rounded-xl bg-card p-6 shadow-sm ring-1 ring-border flex flex-col gap-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Network className="h-5 w-5 text-muted-foreground" /> Subdomain Breakdown
          </h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(subdomainBreakdown as Record<string, number>).map(([prefix, count]) => {
              const maxCount = Math.max(
                ...Object.values(subdomainBreakdown as Record<string, number>),
              );
              const percentage = maxCount > 0 ? (count / maxCount) * 100 : 0;
              return (
                <div
                  key={prefix}
                  className="flex items-center gap-2 bg-muted px-3 py-1.5 rounded-xl border border-border"
                >
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-mono font-bold text-foreground">{prefix}</span>
                    <div className="w-16 h-1.5 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                    <span className="text-xs font-bold text-primary">{count} inboxes</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <button
          type="button"
          onClick={() => setDnsOpen((v) => !v)}
          className="flex w-full items-center gap-3 px-6 py-4 text-left transition-colors hover:bg-muted/40"
          aria-expanded={dnsOpen}
        >
          <Globe className="h-5 w-5 text-muted-foreground" />
          <span className="font-display text-base font-semibold text-foreground">DNS Blueprint</span>
          <span className="ident rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {records.length}
          </span>
          <ChevronDown
            className={`ml-auto h-4 w-4 text-muted-foreground transition-transform ${dnsOpen ? "rotate-180" : ""}`}
          />
        </button>
        {dnsOpen &&
          (records.length > 0 ? (
            <div className="grid grid-cols-1 gap-2 border-t border-border p-4 sm:grid-cols-2 lg:grid-cols-3">
              {records.map((record: any) => (
                <div
                  key={record.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2 sm:flex-nowrap sm:gap-y-0"
                >
                  <span className="ident w-12 shrink-0 rounded bg-secondary px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase text-muted-foreground">
                    {record.type}
                  </span>
                  <span className="ident min-w-0 flex-1 break-all text-[11px] text-foreground sm:truncate">
                    {record.name === "@" ? domain.name : `${record.name}.${domain.name}`}
                  </span>
                  {/* Phones: the full value wraps onto its own line (no hover tooltip on touch). */}
                  <span
                    className="ident basis-full break-all text-[10px] text-muted-foreground sm:max-w-[90px] sm:basis-auto sm:truncate"
                    title={record.content}
                  >
                    {record.content}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="border-t border-border p-6 text-sm italic text-muted-foreground">
              No DNS records generated yet.
            </div>
          ))}
      </div>

      {(domain.status === "configuring" || domain.status === "provisioning" || domain.status === "failed" || domain.status === "error" || logs.length > 0) && (
        <div className="rounded-xl bg-black overflow-hidden shadow-xl border border-gray-800 flex flex-col">
          <div className="bg-gray-900 px-4 py-3 sm:px-6 sm:py-4 flex flex-wrap justify-between items-center gap-2 border-b border-gray-800">
            <div className="flex items-center gap-3">
              <Terminal className="w-5 h-5 shrink-0 text-muted-foreground" />
              <span className="text-gray-200 font-mono text-sm font-semibold">VPS Setup Terminal Logs</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs font-mono">{terminalStatus || domain.status.toUpperCase()}</span>
              <div
                className={`w-2.5 h-2.5 rounded-full ${
                  domain.status === "ready" 
                    ? "bg-green-500" 
                    : domain.status === "failed" || domain.status === "error" 
                    ? "bg-red-500" 
                    : "bg-primary animate-pulse"
                }`}
              />
            </div>
          </div>
          <div
            ref={logPaneRef}
            className="p-3 sm:p-6 h-[60dvh] sm:h-96 overflow-y-auto font-mono text-xs text-green-400 leading-relaxed custom-scrollbar bg-black/95"
          >
            {logs.length > 0 ? (
              <pre className="whitespace-pre-wrap font-inherit break-all">{logs.join("")}</pre>
            ) : (
              <div className="text-muted-foreground italic">Waiting for setup logs stream...</div>
            )}
          </div>
        </div>
      )}

      <div className="rounded-xl bg-card p-4 sm:p-6 shadow-sm ring-1 ring-border flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Mail className="h-5 w-5 shrink-0 text-muted-foreground" /> Planned Inboxes by Subdomain
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setSubOpen(true)}
              disabled={subRows.length === 0}
              title={subRows.length === 0 ? "Available once inboxes are planned" : undefined}
              className="rounded-xl h-9 gap-2 border-border"
            >
              <Globe className="h-4 w-4" /> Subdomains
            </Button>
            <ExportButton
              onExport={exportCsv}
              disabled={!canExportCsv}
              title={canExportCsv ? undefined : "Available once mailboxes are created"}
              className="rounded-xl h-9 gap-2 border-border"
            />
          </div>
        </div>

        <ExportSubdomainsDialog
          open={subOpen}
          onOpenChange={setSubOpen}
          rows={subRows}
          filenameBase={domain?.name ?? "domain"}
        />

        {manualProgress && (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3 sm:p-4">
            <p className="break-words text-sm text-foreground">{mailboxProgressText(manualProgress)}</p>
            <SetupProgress value={progressPercent(manualProgress)} label="Mailbox creation progress" />
          </div>
        )}

        {unfinishedInboxes.length > 0 && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 flex flex-col gap-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <AlertCircle className="h-4 w-4 shrink-0 text-warning" />
                  {unfinishedInboxes.length} of {inboxes.length} mailboxes aren't ready
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Retry creates the missing ones and gives any mailbox without a saved password a new one.
                  Each is retried 3 times before it's listed as failed.
                </p>
              </div>
              <Button
                onClick={() => setupMailcowMutation.mutate()}
                disabled={isAnyPending || regeneratePlanMutation.isPending || runInFlight}
                className="h-9 w-full shrink-0 gap-2 rounded-xl sm:w-auto"
              >
                {setupMailcowMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Retry {unfinishedInboxes.length} mailbox{unfinishedInboxes.length === 1 ? "" : "es"}
              </Button>
            </div>
            <ul className="max-h-56 divide-y divide-border/60 overflow-y-auto text-xs">
              {unfinishedInboxes.map((ib: any) => {
                const reason = mailboxErrors[String(ib.email).toLowerCase()];
                return (
                  <li
                    key={ib.id}
                    className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                  >
                    <span className="break-all font-mono text-foreground">{ib.email}</span>
                    <span
                      className={cn(
                        "shrink-0",
                        ib.status === "failed" ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {reason ??
                        (ib.status === "failed"
                          ? "Failed"
                          : ib.status === "active"
                            ? "No saved password"
                            : "Not created yet")}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {inboxes.length > 0 ? (
          <div className="flex flex-col gap-2">
            {Object.entries(subdomainBreakdown as Record<string, number>).map(([prefix, count]) => {
              const subdomainInboxes = inboxes.filter((ib: any) => ib.subdomainPrefix === prefix);
              return (
                <SubdomainInboxSection
                  key={prefix}
                  prefix={prefix}
                  domain={domain.name}
                  inboxes={subdomainInboxes}
                />
              );
            })}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground italic py-8 text-center bg-muted rounded-lg border border-dashed border-border">
            No inboxes planned for this domain.
          </div>
        )}
      </div>
    </div>
  );
}

function SubdomainInboxSection({
  prefix,
  domain,
  inboxes,
}: {
  prefix: string;
  domain: string;
  inboxes: any[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});

  const togglePassword = (id: string) => {
    setShowPasswords((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Password + show/hide toggle. The toggle's p-2 tap area is cancelled out by negative margins
  // so the row keeps its original size and spacing.
  const renderPassword = (ib: any) =>
    ib.password ? (
      <div className="flex items-center">
        <span>{showPasswords[ib.id] ? ib.password : "••••••••••••"}</span>
        <button
          type="button"
          onClick={() => togglePassword(ib.id)}
          aria-label={showPasswords[ib.id] ? "Hide password" : "Show password"}
          className="-my-2 shrink-0 p-2 text-muted-foreground hover:text-muted-foreground focus:outline-none"
        >
          {showPasswords[ib.id] ? (
            <EyeOff className="h-3.5 w-3.5" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    ) : ib.status === "failed" ? (
      <span className="text-destructive">Failed</span>
    ) : (
      <span className="text-muted-foreground italic">Not created yet</span>
    );

  return (
    <div className="rounded-xl border border-border overflow-hidden bg-card">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between gap-3 p-4 hover:bg-muted transition-colors text-left"
      >
        <div className="flex min-w-0 items-center gap-3">
          {expanded ? (
            <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
          )}
          <Network className="h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0">
            <div className="font-semibold text-foreground break-all">
              {prefix}.{domain}
            </div>
            <div className="text-xs text-muted-foreground">{inboxes.length} mailboxes</div>
          </div>
        </div>
        <div className="hidden shrink-0 -space-x-2 sm:flex">
          {inboxes.slice(0, 4).map((ib: any, i: number) => (
            <div
              key={ib.id}
              className="w-8 h-8 rounded-full bg-primary/15 border-2 border-white flex items-center justify-center text-[10px] font-bold text-primary"
              style={{ zIndex: 4 - i }}
              title={ib.email}
            >
              {ib.fullName?.charAt(0) || "?"}
            </div>
          ))}
          {inboxes.length > 4 && (
            <div className="w-8 h-8 rounded-full bg-muted border-2 border-white flex items-center justify-center text-[9px] font-bold text-muted-foreground">
              +{inboxes.length - 4}
            </div>
          )}
        </div>
      </button>

      {expanded && (
        <div className="overflow-x-auto border-t border-border bg-muted/30">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-muted-foreground uppercase text-[10px] font-bold tracking-wider">
              <tr>
                <th className="px-4 py-2">Email Address</th>
                <th className="hidden px-4 py-2 sm:table-cell">Display Name</th>
                <th className="hidden px-4 py-2 sm:table-cell">Format</th>
                <th className="hidden px-4 py-2 sm:table-cell">Password</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {inboxes.map((ib: any) => (
                <tr key={ib.id} className="hover:bg-muted/50 transition-colors">
                  <td className="px-4 py-3 font-medium text-foreground">
                    <div className="break-all sm:break-normal">{ib.email}</div>
                    {/* Phones: the password stacks under the address (its column is hidden below sm). */}
                    <div className="mt-1 break-all font-mono text-xs font-normal sm:hidden">
                      {renderPassword(ib)}
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">{ib.fullName}</td>
                  <td className="hidden px-4 py-3 sm:table-cell">
                    <span className="bg-primary/10 text-primary px-2 py-0.5 rounded-md text-[10px] font-bold uppercase">
                      {ib.format}
                    </span>
                  </td>
                  <td className="hidden px-4 py-3 font-mono text-xs sm:table-cell">{renderPassword(ib)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
