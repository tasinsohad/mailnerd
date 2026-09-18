import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

function MatrixAnimation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);
    let columns = Math.floor(width / 20);
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$+-*/=%&_#";
    const charArray = characters.split("");
    const drops: number[] = [];

    for (let i = 0; i < columns; i++) {
      drops[i] = 1;
    }

    let frameCount = 0;
    const draw = () => {
      ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = "#4DB584";
      ctx.font = "15px monospace";

      for (let i = 0; i < drops.length; i++) {
        const text = charArray[Math.floor(Math.random() * charArray.length)];
        ctx.fillText(text, i * 20, drops[i] * 20);

        if (drops[i] * 20 > height && Math.random() > 0.975) {
          drops[i] = 0;
        }
        drops[i]++;
      }
      frameCount++;
    };

    const interval = setInterval(draw, 33);

    const handleResize = () => {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
      columns = Math.floor(width / 20);
      for (let i = 0; i < columns; i++) {
        if (drops[i] === undefined) drops[i] = 1;
      }
    };

    window.addEventListener("resize", handleResize);

    return () => {
      clearInterval(interval);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-[100] opacity-40"
      style={{ mixBlendMode: "screen" }}
    />
  );
}
import {
  addDomainsWizardAction,
  listDomainBatches,
  validateDomainsAgainstZones,
  listDomains,
} from "@/server/domains";
import { listServers } from "@/server/servers";
import { listJobTemplates, saveJobTemplate, deleteJobTemplate } from "@/server/jobs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Trash2, Wand2, Save, FolderOpen, Upload, Download } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import {
  parseList,
  planDomain,
  randInt,
  allocateInboxes,
  inboxCountSettingsError,
  type InboxCountMode,
  type InboxCountSettings,
  DomainPlan,
  generateDnsRecords,
} from "@/lib/planning";

interface DomainRow {
  domain: string;
  ipAddress: string;
  sshUser: string;
  sshPassword?: string;
  plannedSubdomainCount?: number;
  plannedInboxCount?: number;
  // The previewed split per mail domain ("@" = main domain); the server creates exactly this.
  plannedDistribution?: { prefix: string; count: number }[];
  // "Set per domain" mode: the count typed for this domain (or imported from the CSV).
  manualInboxCount?: number;
}

interface AddDomainWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const INBOX_MODES: { value: InboxCountMode; label: string; hint: string }[] = [
  { value: "even", label: "Even split", hint: "A total, split evenly across the domains" },
  { value: "random", label: "Random split", hint: "A total, split at random; still adds up exactly" },
  { value: "fixed", label: "Same per domain", hint: "The same number for every domain" },
  { value: "range", label: "Random range", hint: "Each domain gets a random number in a range" },
  { value: "manual", label: "Set per domain", hint: "Type a number for each domain" },
];

// Mailcow's standard mailbox limit per mail domain. Bigger plans are fine: the app raises the limit.
const MAILCOW_DEFAULT_MAILBOX_LIMIT = 50;

function describeFailures(failed: { domain: string; error: string }[] | undefined): string {
  if (!failed?.length) return "";
  const shown = failed
    .slice(0, 3)
    .map((f) => `${f.domain}: ${f.error}`)
    .join("; ");
  return `Not added: ${shown}${failed.length > 3 ? ` and ${failed.length - 3} more` : ""}.`;
}

type CsvRow = {
  domain: string;
  ipAddress?: string;
  sshUser?: string;
  sshPassword?: string;
  inboxes?: number; // optional mailbox count column
};

// Parse a CSV of domains + optional server credentials.
// Accepts comma / semicolon / tab delimiters. If a header row is present
// (contains "domain"), columns are matched by name, including an optional
// mailbox count column ("inboxes", "mailboxes", ...). Otherwise columns are
// assumed to be: domain, ipAddress, sshUser, sshPassword. A headerless CSV
// never yields a mailbox count, so an extra 5th column (e.g. an SSH port)
// isn't mistaken for one.
function parseDomainCsv(text: string): CsvRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const splitLine = (line: string) =>
    line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));

  const normalize = (h: string) => h.toLowerCase().replace(/[\s_-]/g, "");
  const first = splitLine(lines[0]).map(normalize);
  const hasHeader = first.some((h) => h.includes("domain"));

  // inboxes: -1 = not read. Only a named header column supplies mailbox counts.
  let idx = { domain: 0, ipAddress: 1, sshUser: 2, sshPassword: 3, inboxes: -1 };
  if (hasHeader) {
    const find = (aliases: string[]) =>
      first.findIndex((h) => aliases.some((a) => h === a || h.includes(a)));
    idx = {
      domain: find(["domain", "domainname", "host"]),
      ipAddress: find(["ipaddress", "ip"]),
      sshUser: find(["sshuser", "user", "username"]),
      sshPassword: find(["sshpassword", "password", "pass"]),
      // Exact names only: "count" alone would also match a header like "account".
      inboxes: first.findIndex((h) =>
        ["inboxes", "mailboxes", "inboxcount", "mailboxcount", "emails", "count"].includes(h),
      ),
    };
  }

  const parseCount = (value: string | undefined) => {
    const n = value ? Number(value) : NaN;
    return Number.isFinite(n) ? n : undefined;
  };

  const rows: CsvRow[] = [];
  const dataLines = hasHeader ? lines.slice(1) : lines;
  for (const line of dataLines) {
    const cols = splitLine(line);
    const domain = idx.domain >= 0 ? cols[idx.domain] : cols[0];
    if (!domain) continue;
    rows.push({
      domain,
      ipAddress: idx.ipAddress >= 0 ? cols[idx.ipAddress] || undefined : undefined,
      sshUser: idx.sshUser >= 0 ? cols[idx.sshUser] || undefined : undefined,
      sshPassword: idx.sshPassword >= 0 ? cols[idx.sshPassword] || undefined : undefined,
      inboxes: idx.inboxes >= 0 ? parseCount(cols[idx.inboxes]) : undefined,
    });
  }
  return rows;
}

export function AddDomainWizard({ open, onOpenChange }: AddDomainWizardProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Form State
  const [batchName, setBatchName] = useState("");
  const [domainList, setDomainList] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [newTemplateName, setNewTemplateName] = useState("");

  // Credentials imported from CSV, keyed by domain name (lowercased)
  const [csvCreds, setCsvCreds] = useState<Record<string, CsvRow>>({});
  const csvInputRef = useRef<HTMLInputElement>(null);

  // Per-domain rows
  const [domainRows, setDomainRows] = useState<DomainRow[]>([]);
  const [validationResults, setValidationResults] = useState<
    { name: string; valid: boolean; zoneId: string | null }[]
  >([]);

  // Global settings
  const [prefixesText, setPrefixesText] = useState(
    "mail\nweb\napp\ndev\napi\nshop\nblog\nnews\ninfo\nsupport\ncloud\nportal",
  );
  const [namesText, setNamesText] = useState(
    "John\nMichael\nDavid\nChris\nJames\nRobert\nEmily\nSarah\nJessica\nEmma\nLinda\nMary",
  );

  // Global range inputs
  const [minSubdomains, setMinSubdomains] = useState(3);
  const [maxSubdomains, setMaxSubdomains] = useState(15);
  const [minInboxes, setMinInboxes] = useState(10);
  const [maxInboxes, setMaxInboxes] = useState(50);
  // Where mailboxes are created: on subdomains, the main domain, or both.
  const [placement, setPlacement] = useState<"subdomain" | "main" | "both">("subdomain");

  // Subdomains: a per-domain range or an exact count.
  const [subdomainMode, setSubdomainMode] = useState<"range" | "exact">("range");
  const [exactSubdomains, setExactSubdomains] = useState(3);
  // Mailboxes: how the batch's counts are decided (see INBOX_MODES).
  const [inboxMode, setInboxMode] = useState<InboxCountMode>("even");
  const [totalInboxes, setTotalInboxes] = useState(50);
  const [perDomainInboxes, setPerDomainInboxes] = useState(20);

  // Planned results for preview
  const [plannedResults, setPlannedResults] = useState<DomainPlan[]>([]);
  const [showDnsPreview, setShowDnsPreview] = useState(false);
  const [dnsPreviewRecords, setDnsPreviewRecords] = useState<any[]>([]);

  const { data: servers = [] } = useQuery({
    queryKey: ["servers"],
    queryFn: () => listServers(),
  });

  const { data: templates = [], isLoading: templatesLoading } = useQuery({
    queryKey: ["job-templates"],
    queryFn: async () => {
      try {
        const result = await listJobTemplates();
        const safeResult = Array.isArray(result) ? result : [];
        console.log("Templates loaded:", safeResult.length, "templates");
        return safeResult;
      } catch (err) {
        console.error("Failed to load templates:", err);
        return [];
      }
    },
  });

  const validateMutation = useMutation({
    mutationFn: (domains: string[]) => validateDomainsAgainstZones({ data: { domains } }),
    onSuccess: (res) => setValidationResults(res as any),
  });

  const saveTemplateMutation = useMutation({
    mutationFn: async (data: {
      name: string;
      subdomainPrefixes: string[];
      personNames: string[];
    }) => {
      try {
        return await saveJobTemplate({ data });
      } catch (err) {
        console.error("Save template error:", err);
        return { error: String(err) };
      }
    },
    onSuccess: (res: any) => {
      if (res?.error) {
        toast.error(res.error);
      } else if (res?.id) {
        toast.success("Template saved!");
        qc.invalidateQueries({ queryKey: ["job-templates"] });
        setSavingTemplate(false);
        setNewTemplateName("");
        setSelectedTemplateId(res.id);
      } else {
        toast.error("Failed to save template");
      }
    },
    onError: (err: any) => {
      toast.error(err?.message || "Failed to save template");
    },
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: (id: string) => deleteJobTemplate({ data: { id } }),
    onSuccess: (res: any) => {
      if (res.ok) {
        toast.success("Template deleted");
        qc.invalidateQueries({ queryKey: ["job-templates"] });
        if (selectedTemplateId) setSelectedTemplateId("");
      }
    },
  });

  const addMutation = useMutation({
    mutationFn: (data: any) => addDomainsWizardAction({ data }),
    onSuccess: (res: any) => {
      if (res.error) {
        toast.error(res.error);
      } else if (res.okCount === 0) {
        // Nothing was added: keep the wizard open so the batch can be fixed and submitted again.
        toast.error(`No domains were added. ${describeFailures(res.failed)}`, { duration: 15000 });
      } else {
        if (res.failed?.length) {
          toast.warning(
            `Added ${res.okCount} of ${res.okCount + res.failed.length} domains. ${describeFailures(res.failed)}`,
            { duration: 15000 },
          );
        } else {
          toast.success(`Successfully added ${res.okCount} domains!`);
        }
        qc.invalidateQueries({ queryKey: ["domain-batches"] });
        qc.invalidateQueries({ queryKey: ["domains"] });
        onOpenChange(false);
        resetForm();

        qc.fetchQuery({ queryKey: ["domains", "all"], queryFn: () => listDomains({ data: {} }) }).then(
          (domains: any) => {
            if (domains && domains.length > 0) {
              navigate({ to: "/domains/$id", params: { id: domains[0].id } });
            }
          },
        );
      }
    },
    onError: (err) => {
      toast.error("Failed to add domains: " + String(err));
    },
    onSettled: () => setLoading(false),
  });

  const resetForm = () => {
    setStep(0);
    setBatchName("");
    setDomainList("");
    setSelectedTemplateId("");
    setDomainRows([]);
    setCsvCreds({});
    setInboxMode("even");
    setTotalInboxes(50);
    setPerDomainInboxes(20);
    setMinInboxes(10);
    setMaxInboxes(50);
    setPlannedResults([]);
  };

  const applyTemplate = (template: any) => {
    // Handle subdomainPrefixes - could be string (JSON) or array
    if (template.subdomainPrefixes) {
      let prefixes: string[] = [];
      if (typeof template.subdomainPrefixes === "string") {
        try {
          prefixes = JSON.parse(template.subdomainPrefixes);
        } catch {
          prefixes = [];
        }
      } else if (Array.isArray(template.subdomainPrefixes)) {
        prefixes = template.subdomainPrefixes;
      }
      if (Array.isArray(prefixes)) {
        setPrefixesText(prefixes.join("\n"));
      }
    }
    // Handle personNames - could be string (JSON) or array
    if (template.personNames) {
      let names: string[] = [];
      if (typeof template.personNames === "string") {
        try {
          names = JSON.parse(template.personNames);
        } catch {
          names = [];
        }
      } else if (Array.isArray(template.personNames)) {
        names = template.personNames;
      }
      if (Array.isArray(names)) {
        setNamesText(names.join("\n"));
      }
    }
    setSelectedTemplateId(template.id);
    toast.success(`Applied template: ${template.name}`);
  };

  const handleSaveTemplate = () => {
    if (!newTemplateName.trim()) {
      toast.error("Please enter a template name");
      return;
    }
    saveTemplateMutation.mutate({
      name: newTemplateName,
      subdomainPrefixes: parseList(prefixesText),
      personNames: parseList(namesText),
    });
  };

  const inboxSettings = (): InboxCountSettings => ({
    mode: inboxMode,
    total: totalInboxes,
    perDomain: perDomainInboxes,
    min: minInboxes,
    max: maxInboxes,
    // Blank counts are left out, so a missing one reads as "enter a count for every domain".
    manual: domainRows.map((row) => row.manualInboxCount).filter((n): n is number => n !== undefined),
  });

  // Returns a human-readable error string if the active Step-2 settings are invalid, else null.
  const step2Errors = (): string | null => {
    if (subdomainMode === "range") {
      if (minSubdomains < 1) return "Min subdomains must be ≥ 1";
      if (maxSubdomains < minSubdomains) return "Max subdomains must be ≥ Min subdomains";
    } else if (exactSubdomains < 1) {
      return "Exact subdomains must be ≥ 1";
    }
    return inboxCountSettingsError(inboxSettings(), domainRows.length);
  };

  // One line under the mailbox inputs saying what the chosen mode will do.
  const inboxModeSummary = (): string => {
    const n = domainRows.length;
    switch (inboxMode) {
      case "even": {
        if (n === 0) return "";
        const low = Math.floor(totalInboxes / n);
        const high = Math.ceil(totalInboxes / n);
        return `${totalInboxes} total: ${low === high ? low : `${low}–${high}`} per domain across ${n} domains`;
      }
      case "random":
        return `${totalInboxes} total, split at random across ${n} domains (adds up exactly)`;
      case "fixed":
        return `${perDomainInboxes} per domain: ${perDomainInboxes * n} total`;
      case "range":
        return `Each of ${n} domains gets ${minInboxes}–${maxInboxes}: ${minInboxes * n}–${maxInboxes * n} total`;
      case "manual": {
        const entered = domainRows.reduce((sum, row) => sum + (row.manualInboxCount ?? 0), 0);
        return `Type a count for each domain below: ${entered} total so far`;
      }
      default:
        return "";
    }
  };
  const inboxSettingsError = step === 2 ? inboxCountSettingsError(inboxSettings(), domainRows.length) : null;

  // Plan every domain for the chosen count mode. Returns false (after telling the user why) if it can't.
  const planAllDomains = (): boolean => {
    const prefixes = parseList(prefixesText);
    const names = parseList(namesText);
    const results: DomainPlan[] = [];

    let counts: number[];
    try {
      counts = allocateInboxes(inboxSettings(), domainRows.length);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return false;
    }

    for (let d = 0; d < domainRows.length; d++) {
      const row = domainRows[d];
      let attempts = 0;
      let plan: DomainPlan | null = null;
      let lastError = "";

      while (attempts < 10 && !plan) {
        const subdomainCount =
          subdomainMode === "exact" ? exactSubdomains : randInt(minSubdomains, maxSubdomains);
        try {
          plan = planDomain(row.domain, {
            totalInboxes: counts[d],
            prefixes,
            names,
            minSubdomains: subdomainCount,
            maxSubdomains: subdomainCount,
            placement,
          });
          if (plan.inboxes.length !== counts[d]) {
            plan = null;
            attempts++;
          }
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          attempts++;
        }
      }

      if (!plan) {
        toast.error(`Couldn't plan ${row.domain}${lastError ? `: ${lastError}` : ""}`);
        return false;
      }
      results.push(plan);
    }

    setPlannedResults(results);
    setDomainRows((prev) =>
      prev.map((row, i) => ({
        ...row,
        plannedSubdomainCount: results[i]?.subdomainCount,
        plannedInboxCount: results[i]?.totalInboxes,
        plannedDistribution: results[i]
          ? Object.entries(results[i].subdomainDistribution).map(([prefix, count]) => ({ prefix, count }))
          : [],
      })),
    );
    return true;
  };

  const handleDownloadTemplate = () => {
    // "inboxes" is optional: fill it in to set each domain's mailbox count.
    const headers = ["domain", "ipAddress", "sshUser", "sshPassword", "inboxes"];
    const sampleRows = [
      ["example.com", "192.168.1.10", "root", "your-password", "20"],
      ["another.net", "192.168.1.11", "root", "your-password", "25"],
    ];
    const csv = [headers, ...sampleRows].map((row) => row.join(",")).join("\r\n") + "\r\n";

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "domain-import-template.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Revoking straight away can cancel the download before iOS Safari has started it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so the same file can be re-selected later.
    e.target.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = parseDomainCsv(String(reader.result ?? ""));
        if (rows.length === 0) {
          toast.error("No domains found in CSV");
          return;
        }

        const creds: Record<string, CsvRow> = {};
        for (const row of rows) creds[row.domain.toLowerCase()] = row;
        setCsvCreds(creds);
        // Rows already made on step 2 are kept when moving forward again (see handleNext), so apply
        // this newer CSV's values to them here, or they'd be ignored for those domains.
        setDomainRows((prev) =>
          prev.map((row) => {
            const c = creds[row.domain.trim().toLowerCase()];
            if (!c) return row;
            return {
              ...row,
              ipAddress: c.ipAddress || row.ipAddress,
              sshUser: c.sshUser || row.sshUser,
              sshPassword: c.sshPassword || row.sshPassword,
              manualInboxCount: c.inboxes ?? row.manualInboxCount,
            };
          }),
        );
        // A CSV with a mailbox count column means: use those exact counts.
        const withCounts = rows.some((r) => r.inboxes !== undefined);
        if (withCounts) setInboxMode("manual");

        // Merge with any domains already entered, de-duplicating.
        const existing = parseList(domainList);
        const merged = Array.from(
          new Set([...existing, ...rows.map((r) => r.domain)].map((d) => d.trim()).filter(Boolean)),
        );
        setDomainList(merged.join("\n"));

        const withCreds = rows.filter((r) => r.ipAddress || r.sshUser || r.sshPassword).length;
        toast.success(
          `Imported ${rows.length} domain${rows.length === 1 ? "" : "s"} from CSV` +
            (withCreds > 0 ? ` (${withCreds} with server credentials)` : "") +
            (withCounts ? ` with mailbox counts — using "Set per domain"` : ""),
        );

        validateMutation.mutate(merged);
      } catch (err) {
        toast.error("Failed to parse CSV file");
      }
    };
    reader.onerror = () => toast.error("Failed to read CSV file");
    reader.readAsText(file);
  };

  const handlePreviewDns = () => {
    if (plannedResults.length === 0) {
      toast.error("Please randomize domains first");
      return;
    }
    const allRecords: any[] = [];
    for (let i = 0; i < domainRows.length; i++) {
      const row = domainRows[i];
      const plan = plannedResults[i];
      if (plan) {
        const records = generateDnsRecords(row.domain, row.ipAddress, plan);
        allRecords.push(...records.map(r => ({ ...r, domain: row.domain })));
      }
    }
    setDnsPreviewRecords(allRecords);
    setShowDnsPreview(true);
  };

  const handleNext = () => {
    if (step === 0) {
      setStep(1);
    } else if (step === 1) {
      const domains = parseList(domainList);
      if (domains.length === 0) {
        toast.error("Please enter at least one domain");
        return;
      }
      // Keep what was typed on step 2 for domains that are still listed (going Back and forward
      // again must not wipe it); new domains start from the CSV values, then the defaults.
      const previousRows = new Map(domainRows.map((row) => [row.domain.trim().toLowerCase(), row]));
      const rows: DomainRow[] = domains.map((d) => {
        const prev = previousRows.get(d.toLowerCase());
        if (prev) {
          return {
            domain: d,
            ipAddress: prev.ipAddress,
            sshUser: prev.sshUser,
            sshPassword: prev.sshPassword,
            manualInboxCount: prev.manualInboxCount,
          };
        }
        const cred = csvCreds[d.toLowerCase()];
        return {
          domain: d,
          ipAddress: cred?.ipAddress || servers[0]?.ipAddress || "1.2.3.4",
          sshUser: cred?.sshUser || servers[0]?.sshUser || "root",
          sshPassword: cred?.sshPassword || "",
          manualInboxCount: cred?.inboxes,
        };
      });
      setDomainRows(rows);
      setStep(2);
    } else if (step === 2) {
      const err = step2Errors();
      if (err) {
        toast.error(err);
        return;
      }
      if (planAllDomains()) setStep(3);
    }
  };

  const updateRow = (index: number, field: string, value: any) => {
    setDomainRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (domainRows.some((row) => !row.plannedInboxCount)) {
      toast.error("Some domains aren't planned yet. Go back a step and press Next again.");
      return;
    }
    setLoading(true);

    const prefixes = parseList(prefixesText);
    const names = parseList(namesText);

    addMutation.mutate({
      batchName: batchName || `Batch ${new Date().toLocaleDateString()}`,
      ...(selectedTemplateId && selectedTemplateId !== "new"
        ? { templateId: selectedTemplateId }
        : {}),
      domains: domainRows.map((row) => ({
        domain: row.domain,
        ipAddress: row.ipAddress,
        sshUser: row.sshUser,
        sshPassword: row.sshPassword,
        plannedSubdomainCount: row.plannedSubdomainCount,
        plannedInboxCount: row.plannedInboxCount,
        plannedDistribution: row.plannedDistribution,
      })),
      prefixes,
      names,
      placement,
    });
  };

  return (
    <>
    {/* Outside DialogContent: its transform + overflow-y-auto would contain this full-window canvas and
        add scrollbars. Portalled to <body> so no ancestor on the page can contain it either; z-[100]
        keeps it above the dialog (z-50). */}
    {loading && typeof document !== "undefined" && createPortal(<MatrixAnimation />, document.body)}
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Full-screen on phones (rows: header, then the body fills the rest); from sm up, the
          centred scrolling card as before. The centring transform still lands a 100vw x 100dvh
          box at 0,0. */}
      <DialogContent className="h-dvh max-h-dvh w-screen max-w-none grid-rows-[auto_1fr] rounded-none p-0 border-none shadow-lg sm:h-auto sm:max-h-[calc(100dvh-1.5rem)] sm:w-[calc(100%-1.5rem)] sm:max-w-3xl sm:grid-rows-none sm:rounded-lg">
        <DialogHeader className="p-4 sm:p-8 bg-[#23242A] text-white">
          {/* pr-8 keeps the progress bars clear of the dialog's close X on phones. */}
          <div className="flex items-center justify-between gap-3 w-full pr-8 sm:pr-0">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-white">
                <Wand2 className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle className="text-lg sm:text-xl">Add Domains Wizard</DialogTitle>
                <p className="text-xs text-muted-foreground mt-1">Step {step + 1} of 4</p>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              {[0, 1, 2, 3].map((s) => (
                <div
                  key={s}
                  className={`h-1.5 w-5 sm:w-8 rounded-full transition-colors ${s <= step ? "bg-primary" : "bg-card/10"}`}
                />
              ))}
            </div>
          </div>
        </DialogHeader>

        <div className="bg-card min-h-[400px] flex flex-col">
          {step === 0 && (
            <div className="p-4 sm:p-8 flex flex-col gap-8 flex-1">
              {/* Wraps on phones: icon + text on one line, the full-width select below. */}
              <div className="flex flex-wrap items-center gap-4 p-4 bg-primary/10/50 rounded-lg border border-blue-100">
                <FolderOpen className="h-5 w-5 text-primary" />
                <div className="flex-1">
                  <h3 className="font-semibold text-sm text-foreground">Load Template (Optional)</h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Select a saved template or continue with defaults
                  </p>
                </div>
                <Select
                  value={selectedTemplateId}
                  onValueChange={(id) => {
                    setSelectedTemplateId(id);
                    if (id && id !== "new") {
                      const templateArray = Array.isArray(templates) ? templates : [];
                      const template = templateArray.find((t: any) => t.id === id);
                      if (template) applyTemplate(template);
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-48 rounded-xl">
                    <SelectValue placeholder="Select template..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">+ Create new template</SelectItem>
                    {Array.isArray(templates) &&
                      templates.map((t: any) => (
                        <SelectItem key={t?.id || Math.random()} value={t?.id || ""}>
                          {t?.name || "Unnamed Template"}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedTemplateId && selectedTemplateId !== "new" && (
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-500 hover:text-destructive hover:bg-destructive/10"
                    onClick={() => {
                      if (confirm("Delete this template?")) {
                        deleteTemplateMutation.mutate(selectedTemplateId);
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4 mr-1" /> Delete
                  </Button>
                </div>
              )}

              <div className="bg-success/10/50 border border-green-100 rounded-xl p-4 sm:p-6 flex items-start gap-4">
                <div className="h-10 w-10 rounded-lg bg-primary text-white flex items-center justify-center shrink-0">
                  <Wand2 className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground text-sm">Planning Configuration</h3>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Our AI planner generates unique, natural-looking inboxes. Save your prefixes and
                    names as a template for future use.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                      <Label className="text-foreground font-bold text-sm tracking-tight">
                        Subdomain Prefixes
                      </Label>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        Used for mail, tracking, and web subdomains
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-primary hover:text-primary"
                      onClick={() => setSavingTemplate(true)}
                    >
                      <Save className="h-3 w-3 mr-1" /> Save
                    </Button>
                  </div>
                  <Textarea
                    value={prefixesText}
                    onChange={(e) => setPrefixesText(e.target.value)}
                    className="text-xs h-36 rounded-xl border-border bg-muted/50 p-4 focus:bg-card transition-all leading-relaxed resize-none shadow-inner"
                    placeholder="mail&#10;web&#10;app&#10;dev..."
                  />
                </div>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                      <Label className="text-foreground font-bold text-sm tracking-tight">
                        Pool of Full Names
                      </Label>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        Enter full names (e.g., John Smith). They will be split into first and last
                        names
                      </p>
                    </div>
                  </div>
                  <Textarea
                    value={namesText}
                    onChange={(e) => setNamesText(e.target.value)}
                    className="text-xs h-36 rounded-xl border-border bg-muted/50 p-4 focus:bg-card transition-all leading-relaxed resize-none shadow-inner"
                    placeholder="John Smith&#10;Mary Johnson&#10;Michael Brown..."
                  />
                </div>
              </div>

              <div className="mt-5 flex flex-col gap-2">
                <Label className="text-foreground font-bold text-sm tracking-tight">
                  Mailbox placement
                </Label>
                <p className="text-[10px] text-muted-foreground -mt-1">
                  Choose where mailboxes are created for each domain.
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {(
                    [
                      { v: "subdomain", label: "Subdomains", hint: "user@web.domain.com" },
                      { v: "main", label: "Main domain", hint: "user@domain.com" },
                      { v: "both", label: "Both", hint: "main + subdomains" },
                    ] as const
                  ).map((o) => (
                    <button
                      key={o.v}
                      type="button"
                      onClick={() => setPlacement(o.v)}
                      className={`flex flex-col items-start gap-0.5 rounded-xl border p-3 text-left transition-colors ${
                        placement === o.v
                          ? "border-primary bg-primary/10"
                          : "border-border bg-muted/40 hover:border-primary/40"
                      }`}
                    >
                      <span className="text-sm font-medium text-foreground">{o.label}</span>
                      <span className="text-[10px] text-muted-foreground">{o.hint}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* A nested dialog portals to <body>, so the wizard's transform and scrolling can't
                  pin or clip it the way a `fixed` overlay inside the wizard was. Its own close X
                  replaces the old one (same handler: onOpenChange(false) → setSavingTemplate(false)). */}
              <Dialog open={savingTemplate} onOpenChange={setSavingTemplate}>
                <DialogContent className="max-w-96 shadow-lg" aria-describedby={undefined}>
                  <DialogHeader className="text-left pr-6">
                    <DialogTitle className="text-base">Save Template</DialogTitle>
                  </DialogHeader>
                  <Input
                    placeholder="Template name..."
                    value={newTemplateName}
                    onChange={(e) => setNewTemplateName(e.target.value)}
                    className="rounded-xl"
                  />
                  <div className="flex gap-2 justify-end">
                    <Button variant="ghost" onClick={() => setSavingTemplate(false)}>
                      Cancel
                    </Button>
                    <Button
                      onClick={handleSaveTemplate}
                      disabled={saveTemplateMutation.isPending}
                    >
                      {saveTemplateMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4" />
                      )}
                      Save Template
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          )}

          {step === 1 && (
            <div className="p-4 sm:p-8 flex flex-col gap-8 flex-1">
              <div className="flex flex-col gap-3">
                <Label className="text-foreground font-bold text-sm tracking-tight">Batch Name</Label>
                <Input
                  placeholder="e.g. Winter Campaign 2024"
                  value={batchName}
                  onChange={(e) => setBatchName(e.target.value)}
                  className="rounded-lg border-border bg-muted/50 focus:bg-card h-12 px-5 transition-all shadow-sm"
                />
              </div>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap justify-between items-end gap-2">
                  <div className="flex flex-col">
                    <Label className="text-foreground font-bold text-sm tracking-tight">
                      Domains List
                    </Label>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Enter one domain per line, or import a CSV
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={csvInputRef}
                      type="file"
                      accept=".csv,text/csv,text/plain"
                      className="hidden"
                      onChange={handleCsvUpload}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-9 sm:h-7 rounded-lg gap-1.5 text-[11px] text-muted-foreground"
                      onClick={handleDownloadTemplate}
                    >
                      <Download className="h-3.5 w-3.5" />
                      Template
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 sm:h-7 rounded-lg gap-1.5 text-[11px]"
                      onClick={() => csvInputRef.current?.click()}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Upload CSV
                    </Button>
                    <span className="text-[10px] font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded-lg">
                      {parseList(domainList).length} detected
                    </span>
                  </div>
                </div>
                <div className="relative group/textarea">
                  <Textarea
                    placeholder="example.com\nanother.net\nthird.io"
                    value={domainList}
                    onChange={(e) => setDomainList(e.target.value)}
                    onBlur={() => {
                      const domains = parseList(domainList);
                      if (domains.length > 0) validateMutation.mutate(domains);
                    }}
                    className="min-h-[220px] rounded-xl border-border bg-muted/50 focus:bg-card p-5 transition-all resize-none shadow-inner leading-relaxed pr-12"
                    required
                  />
                  <div className="absolute right-4 top-4">
                    {validateMutation.isPending && (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    )}
                  </div>
                </div>

                {validationResults.length > 0 && (
                  <div className="flex flex-wrap gap-2 p-4 bg-muted/50 rounded-xl border border-border/50">
                    {validationResults.map((v, i) => (
                      <div
                        key={i}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold border transition-all ${
                          v.valid
                            ? "bg-success/10 text-success border-green-100"
                            : "bg-destructive/10 text-destructive border-red-100"
                        }`}
                      >
                        {v.valid ? (
                          <div className="h-1.5 w-1.5 rounded-full bg-green-500" />
                        ) : (
                          <div className="h-1.5 w-1.5 rounded-full bg-red-500" />
                        )}
                        {v.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            // min-h-0 only from sm up: on phones the step must keep its full height, or its rows spill
            // past the body and drag the sticky Back/Next footer up into the middle of the screen.
            <div className="flex-1 flex flex-col sm:min-h-0">
              {/* Global Range Inputs */}
              <div className="p-4 pb-4 sm:p-8 sm:pb-4 flex flex-col gap-6">
                <div className="bg-success/10/50 border border-green-100 rounded-xl p-4 sm:p-6">
                  <h3 className="font-semibold text-foreground text-sm mb-1">Count Settings</h3>
                  <p className="text-[10px] text-muted-foreground mb-4">
                    Choose how many subdomains each domain uses and how many mailboxes the batch gets.
                    The preview on the next step is exactly what will be created.
                  </p>

                  <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                    {/* Subdomains */}
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-foreground font-bold text-xs">Subdomains</Label>
                        <div className="flex rounded-lg bg-muted p-0.5">
                          {(["range", "exact"] as const).map((m) => (
                            <button
                              key={m}
                              type="button"
                              onClick={() => setSubdomainMode(m)}
                              className={`px-2 py-0.5 text-[10px] rounded-md capitalize transition-colors ${
                                subdomainMode === m
                                  ? "bg-card text-foreground shadow-sm"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                      </div>
                      {subdomainMode === "range" ? (
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            value={minSubdomains}
                            onChange={(e) => setMinSubdomains(Number(e.target.value))}
                            className="h-9 rounded-xl text-xs"
                            placeholder="Min"
                            min={1}
                          />
                          <span className="text-muted-foreground">—</span>
                          <Input
                            type="number"
                            value={maxSubdomains}
                            onChange={(e) => setMaxSubdomains(Number(e.target.value))}
                            className="h-9 rounded-xl text-xs"
                            placeholder="Max"
                            min={1}
                          />
                        </div>
                      ) : (
                        <Input
                          type="number"
                          value={exactSubdomains}
                          onChange={(e) => setExactSubdomains(Number(e.target.value))}
                          className="h-9 rounded-xl text-xs"
                          placeholder="Subdomains per domain"
                          min={1}
                          max={20}
                        />
                      )}
                    </div>

                    {/* Mailboxes */}
                    <div className="flex flex-col gap-2">
                      <Label className="text-foreground font-bold text-xs">Mailboxes</Label>
                      <div
                        className="flex flex-wrap gap-1 rounded-lg bg-muted p-0.5"
                        role="radiogroup"
                        aria-label="How to count mailboxes"
                      >
                        {INBOX_MODES.map((m) => (
                          <button
                            key={m.value}
                            type="button"
                            role="radio"
                            aria-checked={inboxMode === m.value}
                            title={m.hint}
                            onClick={() => setInboxMode(m.value)}
                            className={`px-2 py-1 text-[11px] rounded-md transition-colors ${
                              inboxMode === m.value
                                ? "bg-card text-foreground shadow-sm"
                                : "text-muted-foreground"
                            }`}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                      {(inboxMode === "even" || inboxMode === "random") && (
                        <Input
                          type="number"
                          value={totalInboxes}
                          onChange={(e) => setTotalInboxes(Number(e.target.value))}
                          className="h-9 rounded-xl text-xs"
                          placeholder="Total mailboxes for the batch"
                          aria-label="Total mailboxes for the batch"
                          min={1}
                        />
                      )}
                      {inboxMode === "fixed" && (
                        <Input
                          type="number"
                          value={perDomainInboxes}
                          onChange={(e) => setPerDomainInboxes(Number(e.target.value))}
                          className="h-9 rounded-xl text-xs"
                          placeholder="Mailboxes per domain"
                          aria-label="Mailboxes per domain"
                          min={1}
                        />
                      )}
                      {inboxMode === "range" && (
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            value={minInboxes}
                            onChange={(e) => setMinInboxes(Number(e.target.value))}
                            className="h-9 rounded-xl text-xs"
                            placeholder="Min"
                            aria-label="Minimum mailboxes per domain"
                            min={1}
                          />
                          <span className="text-muted-foreground">—</span>
                          <Input
                            type="number"
                            value={maxInboxes}
                            onChange={(e) => setMaxInboxes(Number(e.target.value))}
                            className="h-9 rounded-xl text-xs"
                            placeholder="Max"
                            aria-label="Maximum mailboxes per domain"
                            min={1}
                          />
                        </div>
                      )}
                      <span className="text-[10px] text-muted-foreground">{inboxModeSummary()}</span>
                    </div>
                  </div>

                  {/* Validation */}
                  {subdomainMode === "range" && minSubdomains < 1 && (
                    <p className="text-[10px] text-red-500 mt-2">Min subdomains must be ≥ 1</p>
                  )}
                  {subdomainMode === "range" && maxSubdomains < minSubdomains && (
                    <p className="text-[10px] text-red-500 mt-2">Max subdomains must be ≥ Min</p>
                  )}
                  {subdomainMode === "exact" &&
                    exactSubdomains > parseList(prefixesText).length && (
                      <p className="text-[10px] text-amber-600 mt-2">
                        Only {parseList(prefixesText).length} prefixes available — subdomains will be
                        capped at {parseList(prefixesText).length}.
                      </p>
                    )}
                  {inboxSettingsError && (
                    <p className="text-[10px] text-red-500 mt-2" role="alert">
                      {inboxSettingsError}
                    </p>
                  )}
                </div>
              </div>

              {/* Domain list with server config (+ a count per domain in "Set per domain" mode) */}
              <div
                className={`hidden sm:grid gap-4 px-8 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.1em] mb-3 ${
                  inboxMode === "manual"
                    ? "grid-cols-[1.5fr_1.2fr_0.8fr_0.8fr_0.7fr]"
                    : "grid-cols-[1.5fr_1.2fr_0.8fr_0.8fr]"
                }`}
              >
                <div>Domain Name</div>
                <div>IP Address</div>
                <div>SSH User</div>
                <div>SSH Password</div>
                {inboxMode === "manual" && <div>Mailboxes</div>}
              </div>
              <div className="px-4 sm:px-8 flex flex-col gap-3 flex-1 sm:overflow-auto sm:max-h-[350px]">
                {domainRows.map((row, i) => (
                  <div
                    key={i}
                    className={`grid grid-cols-1 gap-2 sm:gap-4 items-center bg-card p-2 px-3 rounded-xl ring-1 ring-black/[0.03] shadow-sm hover:shadow-md hover:ring-primary/20 transition-all group ${
                      inboxMode === "manual"
                        ? "sm:grid-cols-[1.5fr_1.2fr_0.8fr_0.8fr_0.7fr]"
                        : "sm:grid-cols-[1.5fr_1.2fr_0.8fr_0.8fr]"
                    }`}
                  >
                    <Input
                      value={row.domain}
                      onChange={(e) => updateRow(i, "domain", e.target.value)}
                      className="h-9 rounded-xl border-border bg-muted/50 focus:bg-card text-xs font-semibold transition-all"
                      placeholder="Domain"
                    />
                    <Input
                      value={row.ipAddress}
                      onChange={(e) => updateRow(i, "ipAddress", e.target.value)}
                      className="h-9 rounded-xl border-border bg-muted/50 focus:bg-card text-xs font-mono transition-all"
                      placeholder="IP Address"
                    />
                    <Input
                      value={row.sshUser}
                      onChange={(e) => updateRow(i, "sshUser", e.target.value)}
                      className="h-9 rounded-xl border-border bg-muted/50 focus:bg-card text-xs transition-all"
                      placeholder="User"
                    />
                    <Input
                      type="password"
                      value={row.sshPassword || ""}
                      onChange={(e) => updateRow(i, "sshPassword", e.target.value)}
                      className="h-9 rounded-xl border-border bg-muted/50 focus:bg-card text-xs transition-all"
                      placeholder="Password"
                    />
                    {inboxMode === "manual" && (
                      <Input
                        type="number"
                        min={1}
                        value={row.manualInboxCount ?? ""}
                        onChange={(e) =>
                          updateRow(
                            i,
                            "manualInboxCount",
                            e.target.value === "" ? undefined : Number(e.target.value),
                          )
                        }
                        className="h-9 rounded-xl border-border bg-muted/50 focus:bg-card text-xs transition-all"
                        placeholder="Mailboxes"
                        aria-label={`Mailboxes for ${row.domain}`}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="p-4 sm:p-8 flex flex-col gap-6 flex-1">
              <div className="text-center">
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 mb-4">
                  <Wand2 className="h-6 w-6 text-primary" />
                </div>
                <h3 className="text-xl font-bold text-foreground">Planning Preview</h3>
                <p className="text-sm text-muted-foreground mt-2">
                  This is exactly what will be created for each domain.
                </p>
              </div>

              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  onClick={() => {
                    if (planAllDomains()) {
                      toast.success(
                        inboxMode === "random" || inboxMode === "range"
                          ? "New counts, subdomains and addresses"
                          : "New subdomains and addresses (counts unchanged)",
                      );
                    }
                  }}
                  variant="outline"
                  className="rounded-xl border-primary text-primary hover:bg-primary/10"
                >
                  <Wand2 className="h-4 w-4 mr-2" />
                  {inboxMode === "random" || inboxMode === "range" ? "Re-roll" : "Shuffle addresses"}
                </Button>
                <Button
                  onClick={handlePreviewDns}
                  variant="outline"
                  className="rounded-xl border-blue-500 text-primary hover:bg-primary/10"
                >
                  Preview DNS Records
                </Button>
              </div>

              <div className="overflow-auto max-h-[300px] scrollbar-thin scrollbar-thumb-gray-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card">
                    <tr className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.1em]">
                      <th className="text-left pb-3 pr-3">Domain</th>
                      <th className="text-center pb-3 px-3">Mailboxes</th>
                      <th className="text-left pb-3 pl-3">Where they go</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {domainRows.map((row, i) => {
                      const overLimit = (row.plannedDistribution ?? []).some(
                        (d) => d.count > MAILCOW_DEFAULT_MAILBOX_LIMIT,
                      );
                      return (
                        <tr key={i} className="hover:bg-muted/50 align-top">
                          <td className="py-3 pr-3 font-medium text-foreground break-all">{row.domain}</td>
                          <td className="py-3 px-3 text-center text-foreground tabular-nums">
                            {row.plannedInboxCount || 0}
                          </td>
                          <td className="py-3 pl-3 text-[11px] text-muted-foreground font-mono">
                            {(row.plannedDistribution ?? [])
                              .map((d) => `${d.prefix === "@" ? "main domain" : d.prefix} ${d.count}`)
                              .join(" · ") || "-"}
                            {overLimit && (
                              <div className="font-sans text-[10px] text-warning mt-1">
                                Over {MAILCOW_DEFAULT_MAILBOX_LIMIT} on one mail domain: Mailcow's limit is
                                raised automatically.
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="bg-muted rounded-lg p-4 space-y-2">
                <div className="text-xs font-bold text-muted-foreground uppercase">Summary</div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Domains</span>
                  <span className="font-medium">{domainRows.length}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Total Inboxes</span>
                  <span className="font-medium">
                    {domainRows.reduce((a, b) => a + (b.plannedInboxCount || 0), 0)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Template</span>
                  <span className="font-medium">{selectedTemplateId || "Default"}</span>
                </div>
              </div>
            </div>
          )}

          {/* Pinned to the bottom of the scrolling dialog, so Back / Next stay reachable on short screens. */}
          <DialogFooter className="sticky bottom-0 z-10 gap-2 sm:gap-0 p-4 sm:p-6 border-t border-border bg-muted">
            <Button
              type="button"
              variant="ghost"
              onClick={() => (step === 0 ? onOpenChange(false) : setStep(step - 1))}
              className="rounded-lg text-muted-foreground"
            >
              {step === 0 ? "Cancel" : "Back"}
            </Button>

            {step < 3 ? (
              <Button
                type="button"
                onClick={handleNext}
                className="bg-[#23242A] hover:bg-black text-white rounded-lg px-8 gap-2 shadow-lg"
              >
                Next Step
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleSubmit}
                disabled={loading}
                className="bg-primary hover:bg-primary/90 rounded-lg px-8 gap-2 shadow-lg shadow-primary/20"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Create Batch
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
    
    <Dialog open={showDnsPreview} onOpenChange={setShowDnsPreview}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col rounded-lg p-0">
        <DialogHeader className="p-3 sm:p-6 bg-muted border-b">
          <DialogTitle>DNS Records Preview</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">These records will be pushed to Cloudflare</p>
        </DialogHeader>
        <div className="flex-1 overflow-auto p-3 sm:p-6">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted-foreground uppercase bg-muted">
              <tr>
                <th className="px-4 py-3">Domain</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Content</th>
                <th className="px-4 py-3">Proxied</th>
              </tr>
            </thead>
            <tbody>
              {dnsPreviewRecords.map((r, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-muted">
                  <td className="px-4 py-3 font-medium text-foreground">{r.domain}</td>
                  <td className="px-4 py-3 font-mono">{r.type}</td>
                  <td className="px-4 py-3 font-mono text-muted-foreground">{r.name}</td>
                  <td className="px-4 py-3 font-mono text-xs break-all text-muted-foreground max-w-[300px]">{r.content}</td>
                  <td className="px-4 py-3 text-center">
                    {r.proxied ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-warning/15 text-warning">
                        Proxied
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-foreground">
                        DNS Only
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <DialogFooter className="p-3 sm:p-4 bg-muted border-t">
          <Button onClick={() => setShowDnsPreview(false)}>Close Preview</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
