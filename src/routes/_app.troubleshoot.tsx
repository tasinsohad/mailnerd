import { createFileRoute } from "@tanstack/react-router";
import { useState, useRef, useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Stethoscope,
  Loader2,
  Play,
  ChevronDown,
  Server,
  ShieldCheck,
  Wrench,
  Copy,
  Check,
  Square,
  Terminal,
  Download,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  LiveConsole,
  openConsole,
  downloadText,
  type ConsoleLine,
} from "@/components/LiveConsole";
import { troubleshootServer, quickFixServer, getServerLog } from "@/server/troubleshoot";
import { bulkSetupDns, type BulkDnsResult } from "@/server/bulk-dns";
import { resetExternalMailboxPasswords } from "@/server/mailbox-passwords";
import {
  EXPORT_FORMATS,
  buildExportCsv,
  getExportFormat,
  type ExportInbox,
} from "@/lib/export-formats";
import { sortByPriority } from "@/server/health-checks";
import type {
  DomainHealth,
  HealthStatus,
  Indicator,
  FixGuidance,
  FixSeverity,
} from "@/server/health";

// Indicator ids Quick fix knows how to remediate: the Cloudflare un-proxy cascade (mailhost,
// fcrdns, submission), a Mailcow restart (containers, listeners, mailcow), the host firewall,
// and a queue flush.
const FIXABLE_IDS = new Set([
  "mailhost",
  "fcrdns",
  "submission",
  "containers",
  "listeners",
  "mailcow",
  "firewall",
  "queue",
  "maillog",
  "ipv6",
]);

export const Route = createFileRoute("/_app/troubleshoot")({
  component: TroubleshootPage,
});

const DOT: Record<HealthStatus, string> = {
  ok: "text-success",
  warn: "text-warning",
  fail: "text-destructive",
  skip: "text-muted-foreground",
};

const SEVERITY: Record<FixSeverity, { label: string; cls: string }> = {
  info: { label: "Info", cls: "border-border text-muted-foreground" },
  warning: { label: "Warning", cls: "border-warning/40 bg-warning/10 text-warning" },
  high: { label: "High", cls: "border-destructive/40 bg-destructive/10 text-destructive" },
  critical: { label: "Critical", cls: "border-destructive/60 bg-destructive/15 text-destructive" },
};

const OVERALL: Record<string, { color: string; label: string }> = {
  healthy: { color: "text-success", label: "Healthy" },
  warning: { color: "text-warning", label: "Needs attention" },
  critical: { color: "text-destructive", label: "Critical" },
  unknown: { color: "text-muted-foreground", label: "Inconclusive" },
};

// A labelled group inside the guidance panel. Sentence-case, on the type scale — deliberately not
// a tracked-uppercase kicker: one of those above every group is scaffolding, not wayfinding.
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-xs font-semibold text-foreground">{title}</h4>
      {children}
    </div>
  );
}

// Literal machine text — commands, DNS records, log lines — rendered on the console material.
// One material for anything the machine says or you'd paste into a shell; light surfaces stay for
// UI chrome. Reuses the design system's .console instrument rather than inventing a code style.
function CodeBlock({ title, lines }: { title: string; lines: string[] }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  };
  return (
    <div className="console overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5">
        <span className="font-sans text-xs font-medium text-white/55">{title}</span>
        <button
          onClick={copy}
          className="-m-2 rounded p-3 sm:-m-1 sm:p-1 text-white/55 transition-colors duration-150 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          title="Copy to clipboard"
          aria-label={`Copy ${title}`}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 text-white/85">{lines.join("\n")}</pre>
    </div>
  );
}

// The expanded detail for a row: severity, explanation, causes, steps, commands, DNS, verification.
// A recessed well, not a card — this already lives inside the results card, and a bordered box here
// (holding further bordered code blocks) would be cards three deep. The inset surface + hairline
// says "revealed detail" without adding another frame.
function GuidancePanel({ guidance, fallback }: { guidance?: FixGuidance; fallback?: string }) {
  if (!guidance) {
    return fallback ? (
      <div className="reveal mt-3 border-t border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground sm:px-6">
        <span className="font-medium text-foreground">How to fix: </span>
        {fallback}
      </div>
    ) : null;
  }
  return (
    <div className="reveal mt-3 flex flex-col gap-4 border-t border-border bg-muted/50 px-4 py-4 sm:px-6">
      {/* Body copy capped for readability; code blocks below run full width on purpose. */}
      <p className="max-w-[70ch] text-sm leading-relaxed text-muted-foreground text-pretty">
        {guidance.explanation}
      </p>

      {guidance.causes?.length ? (
        <Section title="Likely causes">
          <ul className="max-w-[70ch] list-disc space-y-1 pl-4 text-sm text-muted-foreground marker:text-muted-foreground/50">
            {guidance.causes.map((c, i) => (
              <li key={i} className="pl-0.5">
                {c}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {guidance.steps?.length ? (
        <Section title="How to fix">
          <ol className="max-w-[70ch] list-decimal space-y-1.5 pl-4 text-sm text-muted-foreground marker:font-medium marker:text-muted-foreground/70">
            {guidance.steps.map((s, i) => (
              <li key={i} className="pl-0.5">
                {s}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {guidance.logs?.length ? (
        <CodeBlock title="Recent log lines from your server" lines={guidance.logs} />
      ) : null}

      {guidance.commands?.length ? (
        <CodeBlock title="Commands to run" lines={guidance.commands} />
      ) : null}

      {guidance.dns?.length ? <CodeBlock title="DNS configuration" lines={guidance.dns} /> : null}

      {guidance.verification?.length ? (
        // A to-do list, NOT results. Empty boxes in a muted colour on purpose: green ticks here
        // would read as "these already passed", which is exactly backwards while the check fails.
        <Section title="Confirm after fixing">
          <ul className="max-w-[70ch] space-y-1.5 text-sm text-muted-foreground">
            {guidance.verification.map((v, i) => (
              <li key={i} className="flex items-start gap-2">
                <Square className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground/55" />
                <span>{v}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {guidance.nextStep ? (
        <p className="max-w-[70ch] text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">Next step. </span>
          {guidance.nextStep}
        </p>
      ) : null}
    </div>
  );
}

// Read-only indicator list — no one-click fixes here, since we don't own this server. Each row
// expands to a full "How to Fix" guidance panel (severity, causes, steps, commands, verification).
function IndicatorRows({
  indicators,
  onFix,
  busy,
}: {
  indicators: Indicator[];
  onFix?: (id: string) => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <ul className="divide-y divide-border">
      {sortByPriority(indicators).map((ind) => {
        const isOpen = !!open[ind.id];
        const expandable = !!(ind.guidance || ind.fix);
        const sev = ind.guidance ? SEVERITY[ind.guidance.severity] : null;
        // We can actually run this one's fix on the server, so offer it right on the row.
        const canFix =
          !!onFix && (ind.status === "fail" || ind.status === "warn") && FIXABLE_IDS.has(ind.id);
        const toggle = () => expandable && setOpen((o) => ({ ...o, [ind.id]: !o[ind.id] }));
        return (
          <li key={ind.id} className={cn(isOpen && "bg-muted/25")}>
            {/* The whole row is the hit target — a 16px chevron is a needlessly small one. */}
            <div
              role={expandable ? "button" : undefined}
              tabIndex={expandable ? 0 : undefined}
              aria-expanded={expandable ? isOpen : undefined}
              onClick={toggle}
              onKeyDown={(e) => {
                if (!expandable) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle();
                }
              }}
              className={cn(
                "flex items-center gap-3 px-4 py-3 transition-colors duration-150 sm:px-6",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                expandable && "cursor-pointer hover:bg-muted/40",
              )}
            >
              <span
                className={cn(
                  "status-dot shrink-0",
                  DOT[ind.status],
                  ind.status === "fail" && "status-dot--pulse",
                )}
              />
              {/* Label + detail share the elastic space and stack when the column gets narrow;
                  min-w-0 lets them actually shrink instead of forcing the actions to wrap away. */}
              <div className="flex min-w-0 flex-1 flex-col gap-x-3 gap-y-0.5 sm:flex-row sm:items-baseline">
                <span className="shrink-0 text-sm font-medium text-foreground sm:w-40">
                  {ind.label}
                </span>
                <span className="min-w-0 flex-1 text-sm text-muted-foreground">{ind.detail}</span>
              </div>
              {/* Actions stay pinned to the row at every width — a Fix button that wraps onto its
                  own line reads as belonging to the next check. */}
              <div className="flex shrink-0 items-center gap-2">
                {/* Compact pill on phones, full size from sm up. */}
                {sev && ind.status !== "ok" && (
                  <span
                    className={cn(
                      "rounded-full border px-1.5 py-0 text-[10px] font-medium sm:px-2 sm:py-0.5 sm:text-xs",
                      sev.cls,
                    )}
                  >
                    {sev.label}
                  </span>
                )}
                {canFix && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 gap-1.5 px-2.5 text-xs sm:h-7"
                    disabled={busy}
                    // Stop the click bubbling to the row toggle underneath.
                    onClick={(e) => {
                      e.stopPropagation();
                      onFix!(ind.id);
                    }}
                    title="Run this fix on the server now"
                  >
                    <Wrench aria-hidden className="h-3 w-3" />
                    Fix
                  </Button>
                )}
                {expandable && (
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      "h-4 w-4 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
                      isOpen && "rotate-180",
                    )}
                  />
                )}
              </div>
            </div>
            {isOpen && <GuidancePanel guidance={ind.guidance} fallback={ind.fix} />}
          </li>
        );
      })}
    </ul>
  );
}

function TroubleshootPage() {
  const [form, setForm] = useState({
    ipAddress: "",
    sshUser: "root",
    sshPassword: "",
    mailcowHostname: "",
    mailcowApiKey: "",
    sendingDomain: "",
  });
  // Read the Mailcow API key off the server over SSH when the user hasn't supplied one.
  const [fetchApiKey, setFetchApiKey] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [logBusy, setLogBusy] = useState(false);
  // Bulk DNS setup (reuses the server connection above).
  const [bulkNames, setBulkNames] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkConsole, setBulkConsole] = useState<ConsoleLine[]>([]);
  const [bulkResults, setBulkResults] = useState<BulkDnsResult[] | null>(null);
  // Reset all mailbox passwords on an external server.
  const [resetPw, setResetPw] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetConsole, setResetConsole] = useState<ConsoleLine[]>([]);
  const [resetResult, setResetResult] = useState<{
    password: string;
    host?: string;
    results: { email: string; ok: boolean; error?: string; host?: string }[];
  } | null>(null);
  const [resetFormat, setResetFormat] = useState("generic"); // platform CSV format
  const [result, setResult] = useState<{
    health: DomainHealth;
    mailcowHostname: string | null;
    hostnameAutodetected: boolean;
    sendingDomain: string | null;
    apiKeyAutodetected: boolean;
    apiKeySource: "mailcow.conf" | "database" | "provided" | null;
    apiKeyRestricted: boolean;
    apiAllowFrom: string | null;
    apiKeyWanted: boolean;
  } | null>(null);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const run = async (opts?: { silent?: boolean }) => {
    if (!form.ipAddress.trim() || !form.sshPassword) {
      toast.error("Enter the server IP and SSH password.");
      return;
    }
    setBusy(true);
    setResult(null);
    setConsoleLines([]);
    const { runId, close } = openConsole(setConsoleLines);
    try {
      const res: any = await troubleshootServer({
        data: {
          ipAddress: form.ipAddress.trim(),
          sshUser: form.sshUser.trim() || "root",
          sshPassword: form.sshPassword,
          mailcowHostname: form.mailcowHostname.trim() || undefined,
          mailcowApiKey: form.mailcowApiKey.trim() || undefined,
          sendingDomain: form.sendingDomain.trim() || undefined,
          fetchApiKey,
          runId,
        },
      });
      // Fall back to the transcript if the live stream never connected.
      if (Array.isArray(res?.transcript) && res.transcript.length) {
        setConsoleLines((prev) => (prev.length > 1 ? prev : res.transcript));
      }
      if (res?.error) {
        toast.error(res.error);
        return null;
      }
      setResult(res);
      if (!opts?.silent) toast.success("Diagnostics complete");
      return res;
    } catch (e: any) {
      toast.error(e?.message ?? "Diagnostics failed");
      return null;
    } finally {
      close();
      setBusy(false);
    }
  };

  // Indicators Quick fix can act on right now.
  const fixableIndicators =
    result?.health.indicators.filter(
      (i) => (i.status === "fail" || i.status === "warn") && FIXABLE_IDS.has(i.id),
    ) ?? [];
  // A missing API key isn't an indicator failure (we simply couldn't check), but Quick fix can
  // create one — so it counts as fixable work.
  const canCreateApiKey = !!result?.apiKeyWanted && !result?.apiKeyAutodetected;
  const allFixableIds = [
    ...fixableIndicators.map((i) => i.id),
    ...(canCreateApiKey ? ["apikey"] : []),
  ];
  const fixableCount = allFixableIds.length;

  // Spell out exactly what will change before touching anything — these run commands on the
  // server, change live DNS, restart mail services and can add API access. Asked once, up front;
  // the repair loop may then run several rounds without re-prompting.
  const confirmPlan = (fixableIds: string[]): boolean => {
    const ids = new Set(fixableIds);
    const planned: string[] = [];
    if (["mailhost", "fcrdns", "submission"].some((i) => ids.has(i)))
      planned.push(
        `un-proxy the mail host${result?.mailcowHostname ? ` (${result.mailcowHostname})` : ""} in Cloudflare`,
      );
    if (["containers", "listeners", "mailcow"].some((i) => ids.has(i)))
      planned.push("restart the Mailcow stack (brief mail interruption)");
    if (ids.has("firewall")) planned.push("open the mail ports on the server firewall (ufw)");
    if (ids.has("ipv6"))
      planned.push(
        "set Postfix to IPv4-only so it stops stalling on IPv6, restart it, and retry the queue",
      );
    else if (ids.has("queue") || ids.has("maillog"))
      planned.push("flush the mail queue (retry now)");
    if (ids.has("apikey"))
      planned.push(
        "create a Mailcow API key on the server (API access limited to this app's IP; applying it recreates Mailcow's containers)",
      );
    if (!planned.length) return true;
    return confirm(
      `This will run commands on the server, re-checking and retrying until the checks pass:\n\n• ${planned.join("\n• ")}\n\nContinue?`,
    );
  };

  const quickFix = async (fixableIds: string[], indicators: Indicator[]) => {
    if (!result || fixableIds.length === 0) return null;
    setFixing(true);
    setConsoleLines([]);
    toast.loading("Applying fixes…", { id: "quickfix" });
    const { runId, close } = openConsole(setConsoleLines);

    try {
      const res: any = await quickFixServer({
        data: {
          ipAddress: form.ipAddress.trim(),
          sshUser: form.sshUser.trim() || "root",
          sshPassword: form.sshPassword,
          mailcowHostname: result.mailcowHostname || form.mailcowHostname.trim() || undefined,
          issues: fixableIds,
          indicators: indicators.map((i) => ({ id: i.id, status: i.status })),
          runId,
        },
      });
      // If the live stream never connected, fall back to the full transcript so the console
      // still shows exactly what ran.
      if (Array.isArray(res?.transcript) && res.transcript.length) {
        setConsoleLines((prev) => (prev.length ? prev : res.transcript));
      }
      const fixes = (res?.results ?? []) as { label: string; status: string; detail: string }[];
      const applied = fixes.filter((f) => f.status === "fixed").length;
      if (fixes.length === 0) {
        toast.info("Nothing to auto-fix.", { id: "quickfix" });
      } else if (applied > 0) {
        toast.success(`Applied ${applied} fix${applied === 1 ? "" : "es"} — re-checking…`, {
          id: "quickfix",
        });
      } else if (fixes.every((f) => f.status === "noop")) {
        // Everything was already in the desired state — nothing needed changing.
        toast.info(fixes[0].detail, { id: "quickfix", duration: 7000 });
      } else {
        // Couldn't apply — surface the most actionable reason (skipped/failed over noop).
        const reason =
          fixes.find((f) => f.status === "skipped" || f.status === "failed") ?? fixes[0];
        toast.warning(reason.detail, { id: "quickfix", duration: 9000 });
      }
      return { applied, fixes };
    } catch (e: any) {
      toast.error(e?.message ?? "Quick fix failed", { id: "quickfix" });
    } finally {
      close();
      setFixing(false);
    }
  };

  // Pull a raw log off the server into the console, where it can be read, copied or downloaded.
  // This is the fastest way to see WHY mail is deferring without SSHing in by hand.
  const getLog = async (source: "postfix" | "mailcow" | "queue" | "journal") => {
    if (!form.ipAddress.trim() || !form.sshPassword) {
      toast.error("Enter the server IP and SSH password.");
      return;
    }
    setLogBusy(true);
    toast.loading(`Fetching ${source} log…`, { id: "getlog" });
    try {
      const res: any = await getServerLog({
        data: {
          ipAddress: form.ipAddress.trim(),
          sshUser: form.sshUser.trim() || "root",
          sshPassword: form.sshPassword,
          source,
          lines: 500,
        },
      });
      if (res?.error) {
        toast.error(res.error, { id: "getlog" });
        return;
      }
      const text = String(res?.text ?? "");
      if (!text.trim()) {
        toast.info(`The ${source} log came back empty.`, { id: "getlog" });
        return;
      }
      // Replace the console with the log so Copy/Download hand over exactly these lines.
      setConsoleLines([
        { kind: "info", text: `--- ${source} log (${res.lines} lines) from ${form.ipAddress} ---` },
        ...text.split("\n").map((t) => ({ kind: "out" as const, text: t })),
      ]);
      toast.success(`Fetched ${res.lines} lines — use Copy or Download below.`, {
        id: "getlog",
        duration: 6000,
      });
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't fetch the log", { id: "getlog" });
    } finally {
      setLogBusy(false);
    }
  };

  // Parse the pasted domains/subdomains (newline / comma / space separated).
  const parseBulkNames = (raw: string): string[] =>
    [...new Set(raw.split(/[\s,]+/).map((s) => s.trim().replace(/\.$/, "").toLowerCase()))].filter(
      Boolean,
    );

  // Bulk DNS setup: for each pasted name, create the missing MX/SPF/DKIM/DMARC on Cloudflare, using
  // the server connected above (mail host + DKIM keys come from it).
  const runBulk = async () => {
    const names = parseBulkNames(bulkNames);
    if (!form.ipAddress.trim() || !form.sshPassword) {
      toast.error("Enter the server IP and SSH password in the form above first.");
      return;
    }
    if (names.length === 0) {
      toast.error("Paste at least one domain or subdomain.");
      return;
    }
    setBulkBusy(true);
    setBulkResults(null);
    setBulkConsole([]);
    const { runId, close } = openConsole(setBulkConsole);
    try {
      const res: any = await bulkSetupDns({
        data: {
          ipAddress: form.ipAddress.trim(),
          sshUser: form.sshUser.trim() || "root",
          sshPassword: form.sshPassword,
          mailcowHostname: form.mailcowHostname.trim() || undefined,
          mailcowApiKey: form.mailcowApiKey.trim() || undefined,
          fetchApiKey,
          names,
          runId,
        },
      });
      if (Array.isArray(res?.transcript) && res.transcript.length)
        setBulkConsole((prev) => (prev.length ? prev : res.transcript));
      if (res?.error) {
        toast.error(res.error);
        return;
      }
      setBulkResults(res.results ?? []);
      const created = (res.results ?? []).reduce(
        (n: number, r: BulkDnsResult) => n + r.created.length,
        0,
      );
      toast.success(`Done — ${created} record${created === 1 ? "" : "s"} created.`, {
        duration: 7000,
      });
    } catch (e: any) {
      toast.error(e?.message ?? "Bulk DNS setup failed");
    } finally {
      close();
      setBulkBusy(false);
    }
  };

  // Reset EVERY mailbox password on this external server to one shared password (blank = auto).
  const runReset = async () => {
    if (!form.ipAddress.trim() || !form.sshPassword) {
      toast.error("Enter the server IP and SSH password in the form above first.");
      return;
    }
    if (!confirm("Reset the password for EVERY mailbox on this server? Existing logins will stop working until updated.")) return;
    setResetBusy(true);
    setResetResult(null);
    setResetConsole([]);
    const { runId, close } = openConsole(setResetConsole);
    try {
      const res: any = await resetExternalMailboxPasswords({
        data: {
          ipAddress: form.ipAddress.trim(),
          sshUser: form.sshUser.trim() || "root",
          sshPassword: form.sshPassword,
          mailcowHostname: form.mailcowHostname.trim() || undefined,
          mailcowApiKey: form.mailcowApiKey.trim() || undefined,
          fetchApiKey,
          password: resetPw || undefined,
          runId,
        },
      });
      if (Array.isArray(res?.transcript) && res.transcript.length)
        setResetConsole((prev) => (prev.length ? prev : res.transcript));
      if (res?.error) {
        toast.error(res.error);
        return;
      }
      setResetResult({ password: res.password, host: res.host, results: res.results ?? [] });
      const ok = (res.results ?? []).filter((r: any) => r.ok).length;
      toast.success(`Reset ${ok} mailbox password${ok === 1 ? "" : "s"}.`, { duration: 8000 });
    } catch (e: any) {
      toast.error(e?.message ?? "Password reset failed");
    } finally {
      close();
      setResetBusy(false);
    }
  };

  const downloadResetCsv = () => {
    if (!resetResult) return;
    const rows: ExportInbox[] = resetResult.results
      .filter((r) => r.ok)
      .map((r) => ({
        email: r.email,
        password: resetResult.password,
        mailServer: r.host || resetResult.host || `mail.${r.email.split("@")[1] ?? ""}`,
      }));
    downloadText(`mailbox-passwords-${resetFormat}.csv`, buildExportCsv(resetFormat, rows));
  };

  const copyResetPassword = async () => {
    if (!resetResult) return;
    try {
      await navigator.clipboard.writeText(resetResult.password);
      toast.success("Password copied");
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  };

  // Which of the targeted ids are STILL unhealthy in a fresh result.
  const stillBroken = (fresh: any, targeted: string[]): string[] => {
    const set = new Set(targeted);
    const bad = (fresh?.health?.indicators ?? [])
      .filter((i: Indicator) => (i.status === "fail" || i.status === "warn") && set.has(i.id))
      .map((i: Indicator) => i.id);
    // The API key isn't an indicator — it's only "still broken" if we wanted one and still lack it.
    if (set.has("apikey") && fresh?.apiKeyWanted && !fresh?.apiKeyAutodetected) bad.push("apikey");
    return bad;
  };

  // Fix → re-check → fix again, until the targeted checks actually pass. Bounded, and it stops the
  // moment a round changes nothing: retrying a fix that isn't landing (a provider port-25 block,
  // say) would just spin forever and hammer the server.
  const MAX_ROUNDS = 3;
  const repairUntilFixed = async (only?: string[]) => {
    if (!result) return;
    let target = only ?? allFixableIds;
    if (target.length === 0) return;
    if (!confirmPlan(target)) return;

    // Pass the health snapshot fresh each round: the planner needs real statuses (box-down →
    // restart first, then the rest next round), and React state (`result`) is stale inside this
    // loop, so thread the re-check's indicators through explicitly.
    let indicators = result.health.indicators;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const outcome = await quickFix(target, indicators);
      if (!outcome) return;
      const fresh = await run({ silent: true });
      if (!fresh) return;
      indicators = fresh.health.indicators;

      const remaining = stillBroken(fresh, target);
      if (remaining.length === 0) {
        toast.success(
          `Fixed — the targeted checks are healthy${round > 1 ? ` after ${round} rounds` : ""}.`,
          {
            id: "quickfix",
            duration: 7000,
          },
        );
        return;
      }
      if (outcome.applied === 0) {
        toast.warning(
          `Still failing: ${remaining.join(", ")}. Nothing changed this round, so retrying won't help — open the row for the manual steps.`,
          { id: "quickfix", duration: 11000 },
        );
        return;
      }
      if (round === MAX_ROUNDS) {
        toast.warning(
          `Still failing after ${MAX_ROUNDS} rounds: ${remaining.join(", ")}. Open the row for the manual steps.`,
          { id: "quickfix", duration: 11000 },
        );
        return;
      }
      toast.loading(`Round ${round + 1}: still fixing ${remaining.join(", ")}…`, {
        id: "quickfix",
      });
      target = remaining;
    }
  };

  const overall = result ? OVERALL[result.health.status] : null;

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-8">
      <header className="flex items-start gap-3">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Stethoscope aria-hidden className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground text-balance">
            Troubleshoot a server
          </h1>
          <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground text-pretty">
            Check any mail VPS — even one whose mailboxes weren&apos;t created here. Enter its IP
            and SSH login to probe DNS, outbound port 25, the mail queue, IP reputation and more.
          </p>
        </div>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        {/* Connection form */}
        <div className="rounded-xl border border-border bg-card p-4 sm:p-6 h-fit">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <div className="grid gap-2">
              <Label>Server IP</Label>
              <Input
                placeholder="1.2.3.4"
                value={form.ipAddress}
                onChange={(e) => set("ipAddress", e.target.value)}
                className="rounded-xl font-mono"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label>SSH user</Label>
              <Input
                placeholder="root"
                value={form.sshUser}
                onChange={(e) => set("sshUser", e.target.value)}
                className="rounded-xl"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label>SSH password</Label>
              <Input
                type="password"
                placeholder="••••••••"
                value={form.sshPassword}
                onChange={(e) => set("sshPassword", e.target.value)}
                className="rounded-xl"
                autoComplete="new-password"
              />
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={showAdvanced}
                onCheckedChange={(v) => setShowAdvanced(v === true)}
              />
              Advanced (mail host, sending domain &amp; API key)
            </label>

            {showAdvanced && (
              <div className="flex flex-col gap-4 rounded-lg bg-muted/30 p-4">
                <div className="grid gap-2">
                  <Label>Mailcow hostname</Label>
                  <Input
                    placeholder="auto-detected from the server"
                    value={form.mailcowHostname}
                    onChange={(e) => set("mailcowHostname", e.target.value)}
                    className="rounded-xl"
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave blank to auto-detect. Enables mail-host DNS, submission ports and TLS
                    checks.
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label>Sending domain</Label>
                  <Input
                    placeholder="auto-detected from the mail host"
                    value={form.sendingDomain}
                    onChange={(e) => set("sendingDomain", e.target.value)}
                    className="rounded-xl"
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    The domain you send from. Checks its MX, SPF, DKIM and DMARC records.
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label>Mailcow API key</Label>
                  <Input
                    placeholder={fetchApiKey ? "read from the server automatically" : "optional"}
                    value={form.mailcowApiKey}
                    onChange={(e) => set("mailcowApiKey", e.target.value)}
                    className="rounded-xl font-mono"
                    autoComplete="off"
                  />
                  <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={fetchApiKey}
                      onCheckedChange={(v) => setFetchApiKey(v === true)}
                      className="mt-0.5"
                    />
                    <span>
                      If no key is given, read it from the server over SSH (mailcow.conf, then
                      Mailcow&apos;s database). Enables container health and DKIM key-match checks.
                      The key is used for this check only — it&apos;s never stored or shown.
                    </span>
                  </label>
                </div>
              </div>
            )}

            <Button type="submit" disabled={busy} className="rounded-xl mt-1 gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {busy ? "Running diagnostics…" : "Run diagnostics"}
            </Button>

            {/* Pull raw logs straight off the server — the fastest way to see why mail defers. */}
            <div className="mt-2 flex flex-col gap-2.5 border-t border-border pt-4">
              <div className="flex items-center gap-2">
                <FileText aria-hidden className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium text-foreground">Copy a log from the server</h3>
                {logBusy && (
                  <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["postfix", "Postfix (mail)"],
                    ["queue", "Mail queue"],
                    ["mailcow", "All Mailcow"],
                    ["journal", "Host journal"],
                  ] as const
                ).map(([src, label]) => (
                  <Button
                    key={src}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-9 px-2.5 text-xs sm:h-7"
                    disabled={logBusy || busy || fixing}
                    onClick={() => getLog(src)}
                    title={`Fetch the ${label} log from the server`}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground text-pretty">
                Loads the last 500 lines into the console, where you can copy or download them.
                Secrets are redacted.
              </p>
            </div>

            <p className="text-xs text-muted-foreground text-pretty">
              Credentials are used only for this check and are never stored.
            </p>
          </form>
        </div>

        {/* Results */}
        <div className="min-h-[19rem] rounded-xl border border-border bg-card">
          {!result ? (
            busy ? (
              // Skeleton, not a spinner in the middle of nothing: the shape it settles into is
              // the shape it's loading, so the panel doesn't jump when results land.
              <div aria-busy="true" aria-live="polite">
                <div className="flex items-center gap-3 border-b border-border px-4 py-4 sm:px-6">
                  <Server aria-hidden className="h-5 w-5 text-muted-foreground" />
                  <div className="flex flex-col gap-1.5">
                    <span className="ident text-base font-semibold text-foreground">
                      {form.ipAddress || "the server"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Connecting over SSH and running checks…
                    </span>
                  </div>
                </div>
                <ul className="divide-y divide-border">
                  {Array.from({ length: 7 }).map((_, i) => (
                    <li key={i} className="flex items-center gap-3 px-4 py-3 sm:px-6">
                      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-muted-foreground/25" />
                      <span className="h-3.5 w-44 shrink-0 animate-pulse rounded bg-muted-foreground/15" />
                      <span
                        className="h-3.5 flex-1 animate-pulse rounded bg-muted-foreground/10"
                        style={{ maxWidth: `${52 + ((i * 13) % 34)}%` }}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              // Teach the interface: name what it will check and what it needs, rather than
              // announcing emptiness.
              <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center sm:p-12">
                <ShieldCheck aria-hidden className="h-10 w-10 text-muted-foreground/70" />
                <p className="text-sm font-medium text-foreground">No diagnostics yet</p>
                <p className="max-w-sm text-sm text-muted-foreground text-pretty">
                  Enter the server IP and SSH password, then run diagnostics. You&apos;ll get every
                  check below with a severity, the reason, and a one-click fix where we can apply
                  one.
                </p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  Checks DNS &amp; reverse DNS · outbound port 25 · submission ports · Mailcow
                  containers · the mail queue · IP reputation · SPF, DKIM &amp; DMARC
                </p>
              </div>
            )
          ) : (
            <>
              {/* Identity + verdict + action on one line; the meta gets its own row beneath so a
                  long hostname can't crowd the score badge or the primary action. */}
              <div className="border-b border-border px-4 py-4 sm:px-6">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Server aria-hidden className="h-5 w-5 shrink-0 text-muted-foreground" />
                  {/* An IP is technical data — the system says identifiers are always mono. */}
                  <h2 className="ident mr-auto text-base font-semibold text-foreground">
                    {form.ipAddress}
                  </h2>
                  {overall && (
                    <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground">
                      <span className={cn("status-dot", overall.color)} />
                      {overall.label}
                      <span className="ident tabular-nums text-muted-foreground">
                        {result.health.score}%
                      </span>
                    </span>
                  )}
                  {fixableCount > 0 && (
                    <Button
                      size="sm"
                      className="h-9 gap-1.5"
                      onClick={() => repairUntilFixed()}
                      disabled={fixing || busy}
                      title={`Fix ${fixableCount} issue${fixableCount === 1 ? "" : "s"} automatically`}
                    >
                      {fixing ? (
                        <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                      ) : (
                        <Wrench aria-hidden className="h-4 w-4" />
                      )}
                      Quick fix
                      <span className="ident tabular-nums opacity-80">{fixableCount}</span>
                    </Button>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground text-pretty">
                  {result.mailcowHostname
                    ? `Mail host ${result.mailcowHostname}${result.hostnameAutodetected ? " (auto-detected)" : ""}`
                    : "Mail host unknown"}
                  {result.sendingDomain ? ` · sending domain ${result.sendingDomain}` : ""}
                  {result.apiKeyAutodetected
                    ? ` · API key read from ${result.apiKeySource === "database" ? "Mailcow's database" : "mailcow.conf"}`
                    : ""}
                  {` · checked ${new Date(result.health.checkedAt).toLocaleTimeString()}`}
                </p>
              </div>
              <IndicatorRows
                indicators={result.health.indicators}
                onFix={(id) => repairUntilFixed([id])}
                busy={fixing || busy}
              />
              {/* The key's IP allow-list can reject us even though the key itself is valid. */}
              {result.apiKeyAutodetected && result.apiKeyRestricted && (
                <div className="border-t border-border px-4 py-3 text-xs text-warning sm:px-6">
                  The Mailcow API key on this server is restricted to specific IPs
                  {result.apiAllowFrom ? ` (API_ALLOW_FROM: ${result.apiAllowFrom})` : ""}, so API
                  checks may be rejected even though the key is valid. Add this app's IP to that
                  allow-list to enable them.
                </div>
              )}
              {/* Wanted a key, looked, found nothing — Quick fix can create one. */}
              {canCreateApiKey && result.mailcowHostname && (
                <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-6">
                  No Mailcow API key found on the server (checked mailcow.conf and Mailcow's
                  database), so the API/UI reachability and DKIM key-match checks were skipped.{" "}
                  <span className="text-foreground">Quick fix can create one for you</span> — or
                  make one in Mailcow → Configuration → API and paste it under Advanced.
                </div>
              )}
              {!form.mailcowHostname && !result.mailcowHostname && (
                <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-6">
                  Couldn't auto-detect a Mailcow hostname, so DNS / submission / TLS checks were
                  skipped. Add it under Advanced to include them.
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Live console — streams each run, and holds any fetched log so it can be copied/downloaded. */}
      {(fixing || busy || logBusy || consoleLines.length > 0) && (
        <LiveConsole
          lines={consoleLines}
          running={fixing || busy || logBusy}
          filenameBase={form.ipAddress.trim() || "server"}
        />
      )}

      {/* Bulk DNS setup — paste domains/subdomains; create the missing MX/SPF/DKIM/DMARC on
          Cloudflare, using the server connected above as the mail host + DKIM source. */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-3 border-b border-border px-4 py-4 sm:px-6">
          <Server className="h-5 w-5 text-muted-foreground" />
          <div className="flex-1">
            <h2 className="font-display text-base font-semibold text-foreground">Bulk DNS setup</h2>
            <p className="text-xs text-muted-foreground">
              Paste domains or subdomains — I'll create any missing MX / SPF / DKIM / DMARC on
              Cloudflare, using the server connected above. Existing records are kept, never
              duplicated.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-3 p-4 sm:p-6">
          <textarea
            value={bulkNames}
            onChange={(e) => setBulkNames(e.target.value)}
            rows={5}
            spellCheck={false}
            placeholder={"us1.example.com\neu1.example.com\nexample.com"}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={runBulk} disabled={bulkBusy} className="gap-1.5">
              {bulkBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Check &amp; create records
            </Button>
            <span className="text-xs text-muted-foreground">
              {parseBulkNames(bulkNames).length} name
              {parseBulkNames(bulkNames).length === 1 ? "" : "s"} · needs the Cloudflare token in
              Settings
            </span>
          </div>

          {bulkResults && bulkResults.length > 0 && (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {bulkResults.map((r) => (
                <li key={r.name} className="flex flex-col gap-1 px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-sm font-medium text-foreground">
                      {r.name}
                    </span>
                    {r.zoneMissing && (
                      <span className="rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                        zone not in Cloudflare
                      </span>
                    )}
                  </div>
                  {!r.zoneMissing && (
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      {r.created.map((c) => (
                        <span
                          key={`c-${c}`}
                          className="rounded-full bg-success/10 px-2 py-0.5 font-medium text-success"
                        >
                          + {c}
                        </span>
                      ))}
                      {r.present.map((p) => (
                        <span
                          key={`p-${p}`}
                          className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground"
                        >
                          {p} ✓
                        </span>
                      ))}
                      {r.skipped.map((s) => (
                        <span
                          key={`s-${s}`}
                          className="rounded-full bg-warning/10 px-2 py-0.5 text-warning"
                        >
                          {s}
                        </span>
                      ))}
                      {r.failed.map((f) => (
                        <span
                          key={`f-${f.record}`}
                          className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive"
                          title={f.error}
                        >
                          {f.record} failed
                        </span>
                      ))}
                      {r.created.length === 0 &&
                        r.failed.length === 0 &&
                        r.skipped.length === 0 && (
                          <span className="text-muted-foreground">all records already present</span>
                        )}
                    </div>
                  )}
                  {/* Why each record failed, as readable text on phones: a title tooltip is invisible on
                      touch. From sm up the chips' title tooltips carry it, so the list is hidden. */}
                  {!r.zoneMissing && r.failed.length > 0 && (
                    <ul className="flex flex-col gap-0.5 text-[11px] text-destructive sm:hidden">
                      {r.failed.map((f) => (
                        <li key={`fe-${f.record}`} className="break-words">
                          <span className="font-medium">{f.record}:</span> {f.error}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {(bulkBusy || bulkConsole.length > 0) && (
          <div className="border-t border-border px-4 py-4 sm:px-6">
            <LiveConsole lines={bulkConsole} running={bulkBusy} filenameBase="bulk-dns" />
          </div>
        )}
      </div>

      {/* Reset mailbox passwords — logs into the server above, reads the Mailcow API key, and resets
          EVERY mailbox to one shared password (blank = auto-generate). */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-3 border-b border-border px-4 py-4 sm:px-6">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <div className="flex-1">
            <h2 className="font-display text-base font-semibold text-foreground">
              Reset mailbox passwords
            </h2>
            <p className="text-xs text-muted-foreground">
              Logs into the server above, reads the Mailcow API key, and resets{" "}
              <strong>every</strong> mailbox to one shared password. Save the result — those
              credentials are what you re-connect the inboxes with.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-3 p-4 sm:p-6">
          <label className="text-sm font-medium text-foreground">
            New password
            <input
              type="text"
              value={resetPw}
              onChange={(e) => setResetPw(e.target.value)}
              placeholder="Leave blank to auto-generate a strong password"
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <div>
            <Button onClick={runReset} disabled={resetBusy} className="gap-1.5">
              {resetBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Reset all mailbox passwords
            </Button>
          </div>

          {resetResult && (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
              <div className="text-sm text-muted-foreground">
                Reset{" "}
                <span className="font-medium text-success">
                  {resetResult.results.filter((r) => r.ok).length}
                </span>
                {resetResult.results.some((r) => !r.ok) && (
                  <>
                    {" "}
                    ·{" "}
                    <span className="font-medium text-destructive">
                      {resetResult.results.filter((r) => !r.ok).length} failed
                    </span>
                  </>
                )}
                {resetResult.host ? ` on ${resetResult.host}` : ""}.
              </div>
              {/* Phones: the password (which must be saved) gets its own full row with a Copy
                  button; the export controls sit on a second row. From sm up it's one row again. */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="shrink-0 text-xs text-muted-foreground">Password</span>
                  <code className="min-w-0 flex-1 break-all font-mono text-sm text-foreground">
                    {resetResult.password}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0 gap-1.5 sm:h-8"
                    onClick={copyResetPassword}
                    aria-label="Copy password"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={resetFormat}
                    onChange={(e) => setResetFormat(e.target.value)}
                    className="h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
                    title="Export format"
                  >
                    {EXPORT_FORMATS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1.5 sm:h-8"
                    onClick={downloadResetCsv}
                  >
                    <Download className="h-3.5 w-3.5" /> CSV
                  </Button>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {getExportFormat(resetFormat).label} format · IMAP 993 / SMTP 587.
              </p>
            </div>
          )}
        </div>

        {(resetBusy || resetConsole.length > 0) && (
          <div className="border-t border-border px-4 py-4 sm:px-6">
            <LiveConsole lines={resetConsole} running={resetBusy} filenameBase="password-reset" />
          </div>
        )}
      </div>
    </div>
  );
}
