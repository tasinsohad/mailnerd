import { useState, useEffect, useRef } from "react";
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
import { Loader2, Plus, Trash2, Wand2, Save, FolderOpen, X } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { parseList, planDomain, randInt, DomainPlan, generateDnsRecords } from "@/lib/planning";

interface DomainRow {
  domain: string;
  ipAddress: string;
  sshUser: string;
  sshPassword?: string;
  plannedSubdomainCount?: number;
  plannedInboxCount?: number;
  plannedDistribution?: number[];
}

interface AddDomainWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
    onSuccess: (res) => {
      if (res.error) {
        toast.error(res.error);
      } else {
        toast.success(`Successfully added ${res.okCount} domains!`);
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

  const planAllDomains = () => {
    const prefixes = parseList(prefixesText);
    const names = parseList(namesText);
    const results: DomainPlan[] = [];

    for (const row of domainRows) {
      let attempts = 0;
      let plan: DomainPlan | null = null;

      while (attempts < 10 && !plan) {
        const subdomainCount = randInt(minSubdomains, maxSubdomains);
        const totalInboxes = randInt(minInboxes, maxInboxes);

        try {
          plan = planDomain(row.domain, {
            totalInboxes,
            prefixes,
            names,
            minSubdomains: subdomainCount,
            maxSubdomains: subdomainCount,
          });
          if (plan.inboxes.length !== totalInboxes) {
            plan = null;
            attempts++;
          }
        } catch (e) {
          attempts++;
        }
      }

      if (!plan) {
        toast.error(`Failed to plan ${row.domain} after 10 attempts`);
        return;
      }

      results.push(plan);
    }

    setPlannedResults(results);
    setDomainRows((prev) =>
      prev.map((row, i) => ({
        ...row,
        plannedSubdomainCount: results[i]?.subdomainCount,
        plannedInboxCount: results[i]?.totalInboxes,
        plannedDistribution: results[i] ? Object.values(results[i].subdomainDistribution) : [],
      })),
    );
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
      setDomainRows(
        domains.map((d) => ({
          domain: d,
          ipAddress: servers[0]?.ipAddress || "1.2.3.4",
          sshUser: servers[0]?.sshUser || "root",
          sshPassword: "",
        })),
      );
      setStep(2);
    } else if (step === 2) {
      planAllDomains();
      setStep(3);
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
        plannedInboxCount: row.plannedInboxCount || 0,
        plannedDistribution: row.plannedDistribution,
      })),
      prefixes,
      names,
    });
  };

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl rounded-[2.5rem] p-0 overflow-hidden border-none shadow-2xl">
        {loading && <MatrixAnimation />}
        <DialogHeader className="p-8 bg-[#23242A] text-white">
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#4DB584] text-white">
                <Wand2 className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle className="text-xl">Add Domains Wizard</DialogTitle>
                <p className="text-xs text-gray-400 mt-1">Step {step + 1} of 4</p>
              </div>
            </div>
            <div className="flex gap-2">
              {[0, 1, 2, 3].map((s) => (
                <div
                  key={s}
                  className={`h-1.5 w-8 rounded-full transition-colors ${s <= step ? "bg-[#4DB584]" : "bg-white/10"}`}
                />
              ))}
            </div>
          </div>
        </DialogHeader>

        <div className="bg-white min-h-[400px] flex flex-col">
          {step === 0 && (
            <div className="p-8 flex flex-col gap-8 flex-1">
              <div className="flex items-center gap-4 p-4 bg-blue-50/50 rounded-2xl border border-blue-100">
                <FolderOpen className="h-5 w-5 text-blue-500" />
                <div className="flex-1">
                  <h3 className="font-semibold text-sm text-gray-900">Load Template (Optional)</h3>
                  <p className="text-xs text-gray-500 mt-1">
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
                  <SelectTrigger className="w-48 rounded-xl">
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
                    className="text-red-500 hover:text-red-600 hover:bg-red-50"
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

              <div className="bg-green-50/50 border border-green-100 rounded-3xl p-6 flex items-start gap-4">
                <div className="h-10 w-10 rounded-2xl bg-[#4DB584] text-white flex items-center justify-center shrink-0">
                  <Wand2 className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 text-sm">Planning Configuration</h3>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    Our AI planner generates unique, natural-looking inboxes. Save your prefixes and
                    names as a template for future use.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-8">
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                      <Label className="text-gray-900 font-bold text-sm tracking-tight">
                        Subdomain Prefixes
                      </Label>
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        Used for mail, tracking, and web subdomains
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-blue-500 hover:text-blue-600"
                      onClick={() => setSavingTemplate(true)}
                    >
                      <Save className="h-3 w-3 mr-1" /> Save
                    </Button>
                  </div>
                  <Textarea
                    value={prefixesText}
                    onChange={(e) => setPrefixesText(e.target.value)}
                    className="text-xs h-36 rounded-[1.5rem] border-gray-100 bg-gray-50/50 p-4 focus:bg-white transition-all leading-relaxed resize-none shadow-inner"
                    placeholder="mail&#10;web&#10;app&#10;dev..."
                  />
                </div>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                      <Label className="text-gray-900 font-bold text-sm tracking-tight">
                        Pool of Full Names
                      </Label>
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        Enter full names (e.g., John Smith). They will be split into first and last
                        names
                      </p>
                    </div>
                  </div>
                  <Textarea
                    value={namesText}
                    onChange={(e) => setNamesText(e.target.value)}
                    className="text-xs h-36 rounded-[1.5rem] border-gray-100 bg-gray-50/50 p-4 focus:bg-white transition-all leading-relaxed resize-none shadow-inner"
                    placeholder="John Smith&#10;Mary Johnson&#10;Michael Brown..."
                  />
                </div>
              </div>

              {savingTemplate && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                  <div className="bg-white rounded-2xl p-6 w-96 shadow-2xl">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold">Save Template</h3>
                      <Button variant="ghost" size="sm" onClick={() => setSavingTemplate(false)}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    <Input
                      placeholder="Template name..."
                      value={newTemplateName}
                      onChange={(e) => setNewTemplateName(e.target.value)}
                      className="rounded-xl mb-4"
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
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="p-8 flex flex-col gap-8 flex-1">
              <div className="flex flex-col gap-3">
                <Label className="text-gray-900 font-bold text-sm tracking-tight">Batch Name</Label>
                <Input
                  placeholder="e.g. Winter Campaign 2024"
                  value={batchName}
                  onChange={(e) => setBatchName(e.target.value)}
                  className="rounded-2xl border-gray-100 bg-gray-50/50 focus:bg-white h-12 px-5 transition-all shadow-sm"
                />
              </div>
              <div className="flex flex-col gap-3">
                <div className="flex justify-between items-end">
                  <div className="flex flex-col">
                    <Label className="text-gray-900 font-bold text-sm tracking-tight">
                      Domains List
                    </Label>
                    <p className="text-[10px] text-gray-400 mt-0.5">Enter one domain per line</p>
                  </div>
                  <span className="text-[10px] font-mono text-gray-400 bg-gray-100 px-2 py-0.5 rounded-lg">
                    {parseList(domainList).length} detected
                  </span>
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
                    className="min-h-[220px] rounded-[1.5rem] border-gray-100 bg-gray-50/50 focus:bg-white p-5 transition-all resize-none shadow-inner leading-relaxed pr-12"
                    required
                  />
                  <div className="absolute right-4 top-4">
                    {validateMutation.isPending && (
                      <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                    )}
                  </div>
                </div>

                {validationResults.length > 0 && (
                  <div className="flex flex-wrap gap-2 p-4 bg-gray-50/50 rounded-[1.5rem] border border-gray-100/50">
                    {validationResults.map((v, i) => (
                      <div
                        key={i}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold border transition-all ${
                          v.valid
                            ? "bg-green-50 text-green-600 border-green-100"
                            : "bg-red-50 text-red-600 border-red-100"
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
            <div className="flex-1 flex flex-col min-h-0">
              {/* Global Range Inputs */}
              <div className="p-8 pb-4 flex flex-col gap-6">
                <div className="bg-green-50/50 border border-green-100 rounded-3xl p-6">
                  <h3 className="font-semibold text-gray-900 text-sm mb-4">
                    Global Range Settings
                  </h3>
                  <p className="text-[10px] text-gray-500 mb-4">
                    These ranges apply to all domains in the batch. Each domain will randomly get
                    values within these ranges.
                  </p>

                  <div className="grid grid-cols-2 gap-6">
                    <div className="flex flex-col gap-2">
                      <Label className="text-gray-900 font-bold text-xs">
                        Subdomains per Domain
                      </Label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          value={minSubdomains}
                          onChange={(e) => setMinSubdomains(Number(e.target.value))}
                          className="h-9 rounded-xl text-xs"
                          placeholder="Min"
                          min={1}
                        />
                        <span className="text-gray-400">—</span>
                        <Input
                          type="number"
                          value={maxSubdomains}
                          onChange={(e) => setMaxSubdomains(Number(e.target.value))}
                          className="h-9 rounded-xl text-xs"
                          placeholder="Max"
                          min={1}
                        />
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <Label className="text-gray-900 font-bold text-xs">Inboxes per Domain</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          value={minInboxes}
                          onChange={(e) => setMinInboxes(Number(e.target.value))}
                          className="h-9 rounded-xl text-xs"
                          placeholder="Min"
                          min={1}
                        />
                        <span className="text-gray-400">—</span>
                        <Input
                          type="number"
                          value={maxInboxes}
                          onChange={(e) => setMaxInboxes(Number(e.target.value))}
                          className="h-9 rounded-xl text-xs"
                          placeholder="Max"
                          min={1}
                        />
                      </div>
                    </div>
                  </div>

                  {minSubdomains < 1 && (
                    <p className="text-[10px] text-red-500 mt-2">Min subdomains must be ≥ 1</p>
                  )}
                  {maxSubdomains < minSubdomains && (
                    <p className="text-[10px] text-red-500 mt-2">Max subdomains must be ≥ Min</p>
                  )}
                  {minInboxes < maxSubdomains && (
                    <p className="text-[10px] text-red-500 mt-2">
                      Min inboxes must be ≥ Max subdomains (to ensure at least 1 inbox per
                      subdomain)
                    </p>
                  )}
                  {maxInboxes < minInboxes && (
                    <p className="text-[10px] text-red-500 mt-2">
                      Max inboxes must be ≥ Min inboxes
                    </p>
                  )}
                </div>
              </div>

              {/* Domain List with Server Config */}
              <div className="grid grid-cols-[1.5fr,1.2fr,0.8fr,0.8fr] gap-4 px-8 text-[10px] font-bold text-gray-400 uppercase tracking-[0.1em] mb-3">
                <div>Domain Name</div>
                <div>IP Address</div>
                <div>SSH User</div>
                <div>SSH Password</div>
              </div>
              <div className="px-8 flex flex-col gap-3 flex-1 overflow-auto max-h-[350px] scrollbar-thin scrollbar-thumb-gray-200">
                {domainRows.map((row, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[1.5fr,1.2fr,0.8fr,0.8fr] gap-4 items-center bg-white p-2 px-3 rounded-xl ring-1 ring-black/[0.03] shadow-sm hover:shadow-md hover:ring-[#4DB584]/20 transition-all group"
                  >
                    <Input
                      value={row.domain}
                      onChange={(e) => updateRow(i, "domain", e.target.value)}
                      className="h-9 rounded-xl border-gray-100 bg-gray-50/50 focus:bg-white text-xs font-semibold transition-all"
                      placeholder="Domain"
                    />
                    <Input
                      value={row.ipAddress}
                      onChange={(e) => updateRow(i, "ipAddress", e.target.value)}
                      className="h-9 rounded-xl border-gray-100 bg-gray-50/50 focus:bg-white text-xs font-mono transition-all"
                      placeholder="IP Address"
                    />
                    <Input
                      value={row.sshUser}
                      onChange={(e) => updateRow(i, "sshUser", e.target.value)}
                      className="h-9 rounded-xl border-gray-100 bg-gray-50/50 focus:bg-white text-xs transition-all"
                      placeholder="User"
                    />
                    <Input
                      type="password"
                      value={row.sshPassword || ""}
                      onChange={(e) => updateRow(i, "sshPassword", e.target.value)}
                      className="h-9 rounded-xl border-gray-100 bg-gray-50/50 focus:bg-white text-xs transition-all"
                      placeholder="Password"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="p-8 flex flex-col gap-6 flex-1">
              <div className="text-center">
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[#4DB584]/10 mb-4">
                  <Wand2 className="h-6 w-6 text-[#4DB584]" />
                </div>
                <h3 className="text-xl font-bold text-gray-900">Planning Preview</h3>
                <p className="text-sm text-gray-500 mt-2">
                  Review the random values generated for each domain
                </p>
              </div>

              <div className="flex justify-center">
                <Button
                  onClick={() => {
                    planAllDomains();
                    toast.success("Re-randomized all domains!");
                  }}
                  variant="outline"
                  className="rounded-xl border-[#4DB584] text-[#4DB584] hover:bg-[#4DB584]/10"
                >
                  <Wand2 className="h-4 w-4 mr-2" />
                  Re-randomize All
                </Button>
                <Button
                  onClick={handlePreviewDns}
                  variant="outline"
                  className="rounded-xl border-blue-500 text-blue-500 hover:bg-blue-500/10 ml-4"
                >
                  Preview DNS Records
                </Button>
              </div>

              <div className="overflow-auto max-h-[300px] scrollbar-thin scrollbar-thumb-gray-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white">
                    <tr className="text-[10px] font-bold text-gray-400 uppercase tracking-[0.1em]">
                      <th className="text-left pb-3">Domain</th>
                      <th className="text-center pb-3">Subdomains</th>
                      <th className="text-center pb-3">Total Inboxes</th>
                      <th className="text-left pb-3">Distribution</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {domainRows.map((row, i) => (
                      <tr key={i} className="hover:bg-gray-50/50">
                        <td className="py-3 font-medium text-gray-700">{row.domain}</td>
                        <td className="py-3 text-center text-gray-600">
                          {row.plannedSubdomainCount || 0}
                        </td>
                        <td className="py-3 text-center text-gray-600">
                          {row.plannedInboxCount || 0}
                        </td>
                        <td className="py-3 text-[10px] text-gray-500 font-mono">
                          {row.plannedDistribution?.join(", ") || "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="bg-gray-50 rounded-2xl p-4 space-y-2">
                <div className="text-xs font-bold text-gray-400 uppercase">Summary</div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Domains</span>
                  <span className="font-medium">{domainRows.length}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Total Inboxes</span>
                  <span className="font-medium">
                    {domainRows.reduce((a, b) => a + (b.plannedInboxCount || 0), 0)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Template</span>
                  <span className="font-medium">{selectedTemplateId || "Default"}</span>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="p-8 border-t border-gray-50 bg-gray-50/50">
            <Button
              type="button"
              variant="ghost"
              onClick={() => (step === 0 ? onOpenChange(false) : setStep(step - 1))}
              className="rounded-2xl text-gray-500"
            >
              {step === 0 ? "Cancel" : "Back"}
            </Button>

            {step < 3 ? (
              <Button
                type="button"
                onClick={handleNext}
                className="bg-[#23242A] hover:bg-black text-white rounded-2xl px-8 gap-2 shadow-lg"
              >
                Next Step
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleSubmit}
                disabled={loading}
                className="bg-[#4DB584] hover:bg-[#3da070] rounded-2xl px-8 gap-2 shadow-lg shadow-[#4DB584]/20"
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
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col rounded-2xl p-0">
        <DialogHeader className="p-6 bg-gray-50 border-b">
          <DialogTitle>DNS Records Preview</DialogTitle>
          <p className="text-sm text-gray-500 mt-1">These records will be pushed to Cloudflare</p>
        </DialogHeader>
        <div className="flex-1 overflow-auto p-6">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-gray-500 uppercase bg-gray-50">
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
                <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{r.domain}</td>
                  <td className="px-4 py-3 font-mono">{r.type}</td>
                  <td className="px-4 py-3 font-mono text-gray-600">{r.name}</td>
                  <td className="px-4 py-3 font-mono text-xs break-all text-gray-500 max-w-[300px]">{r.content}</td>
                  <td className="px-4 py-3 text-center">
                    {r.proxied ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800">
                        Proxied
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800">
                        DNS Only
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <DialogFooter className="p-4 bg-gray-50 border-t">
          <Button onClick={() => setShowDnsPreview(false)}>Close Preview</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
