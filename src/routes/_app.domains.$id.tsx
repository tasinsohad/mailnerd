import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getDomainDetails, pushDnsToCloudflare } from "@/server/domains";
import { provisionServer } from "@/server/provisioning";
import { setupMailcowDomain, fetchDkimAndSync } from "@/server/mailcow";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useState } from "react";

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

  const pushDnsMutation = useMutation({
    mutationFn: () => pushDnsToCloudflare({ data: { domainId: id } }),
    onSuccess: (res: any) => {
      if (res.error) toast.error(res.error);
      else toast.success("DNS records pushed successfully");
      qc.invalidateQueries({ queryKey: ["domain", id] });
    },
  });

  const provisionMutation = useMutation({
    mutationFn: () => provisionServer({ data: { domainId: id } }),
    onSuccess: (res: any) => {
      if (res.error) toast.error(res.error);
      else toast.success("Server provisioned successfully");
      qc.invalidateQueries({ queryKey: ["domain", id] });
    },
  });

  const setupMailcowMutation = useMutation({
    mutationFn: () => setupMailcowDomain({ data: { domainId: id } }),
    onSuccess: (res: any) => {
      if (res.error) toast.error(res.error);
      else toast.success("Mailcow domain and mailboxes created");
    },
  });

  const syncDkimMutation = useMutation({
    mutationFn: () => fetchDkimAndSync({ data: { domainId: id } }),
    onSuccess: (res: any) => {
      if (res.error) toast.error(res.error);
      else toast.success("DKIM keys synced to Cloudflare");
    },
  });

  const runFullAutomation = async () => {
    try {
      toast.info("Starting full automation sequence...");

      toast.loading("Step 1: Pushing DNS...", { id: "auto" });
      await pushDnsMutation.mutateAsync();

      toast.loading("Step 2: Provisioning VPS...", { id: "auto" });
      await provisionMutation.mutateAsync();

      toast.loading("Step 3: Setting up Mailcow...", { id: "auto" });
      await setupMailcowMutation.mutateAsync();

      toast.loading("Step 4: Syncing DKIM...", { id: "auto" });
      await syncDkimMutation.mutateAsync();

      toast.success("Full automation completed successfully!", { id: "auto" });
    } catch (err) {
      toast.error("Automation failed: " + String(err), { id: "auto" });
    }
  };

  const exportCsv = () => {
    if (!inboxes.length) return;
    const headers = [
      "Domain",
      "Subdomain Prefix",
      "Subdomain FQDN",
      "Email Address",
      "Local Part",
      "Full Name",
      "First Name",
      "Last Name",
      "Format",
      "IP Address",
      "SSH User",
    ];
    const rows = inboxes.map((ib: any) => [
      domain.name,
      ib.subdomainPrefix,
      ib.subdomainFqdn,
      ib.email,
      ib.localPart,
      ib.fullName || "",
      ib.firstName || "",
      ib.lastName || "",
      ib.format,
      domain.ipAddress || "",
      domain.sshUser || "",
    ]);

    const csvContent = [headers, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `${domain.name}_planned_inboxes.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!domain) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <AlertCircle className="h-12 w-12 text-red-500 mb-4" />
        <h2 className="text-xl font-bold">Domain not found</h2>
        <Link to="/domains" className="text-blue-500 hover:underline mt-2">
          Back to Domains
        </Link>
      </div>
    );
  }

  const isAnyPending =
    pushDnsMutation.isPending ||
    provisionMutation.isPending ||
    setupMailcowMutation.isPending ||
    syncDkimMutation.isPending;

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/domains">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-black/5 hover:bg-gray-50 transition-colors">
              <ArrowLeft className="h-5 w-5 text-gray-600" />
            </div>
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{domain.name}</h1>
            <div className="flex items-center gap-2 mt-1">
              <span
                className={`px-2 py-0.5 rounded-md text-xs font-bold ${domain.status === "active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}
              >
                {domain.status.toUpperCase()}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <Button
            onClick={runFullAutomation}
            disabled={isAnyPending}
            className="rounded-2xl h-12 gap-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white shadow-xl shadow-purple-500/20 px-6 font-bold"
          >
            <Zap className="h-5 w-5 fill-current" />
            Run Full Automation
          </Button>

          <div className="h-8 w-[1px] bg-gray-200" />

          <div className="flex gap-2 bg-white p-2 rounded-[1.5rem] shadow-sm ring-1 ring-black/5">
            <Button
              onClick={() => pushDnsMutation.mutate()}
              disabled={pushDnsMutation.isPending}
              className="rounded-xl h-10 gap-2 bg-blue-500 hover:bg-blue-600 text-white"
            >
              {pushDnsMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Push DNS
            </Button>
            <Button
              onClick={() => provisionMutation.mutate()}
              disabled={provisionMutation.isPending}
              className="rounded-xl h-10 gap-2 bg-purple-500 hover:bg-purple-600 text-white"
            >
              {provisionMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Zap className="h-4 w-4" />
              )}
              Provision
            </Button>
            <Button
              onClick={() => setupMailcowMutation.mutate()}
              disabled={setupMailcowMutation.isPending}
              className="rounded-xl h-10 gap-2 bg-[#4DB584] hover:bg-[#3da070] text-white"
            >
              {setupMailcowMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Mail className="h-4 w-4" />
              )}
              Setup Mailcow
            </Button>
            <Button
              onClick={() => syncDkimMutation.mutate()}
              disabled={syncDkimMutation.isPending}
              className="rounded-xl h-10 gap-2 bg-amber-500 hover:bg-amber-600 text-white"
            >
              {syncDkimMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Sync DKIM
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-black/5 flex flex-col gap-2">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">
            Total Inboxes
          </div>
          <div className="text-3xl font-black text-[#4DB584]">{plan?.totalInboxes || 0}</div>
          <div className="text-[10px] text-gray-500">Planned across all subdomains</div>
        </div>
        <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-black/5 flex flex-col gap-2">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">Subdomains</div>
          <div className="text-3xl font-black text-blue-500">{plan?.subdomainCount || 0}</div>
          <div className="text-[10px] text-gray-500">Unique routing prefixes</div>
        </div>
        <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-black/5 flex flex-col gap-2">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">
            Avg Per Subdomain
          </div>
          <div className="text-3xl font-black text-purple-500">
            {plan?.subdomainCount ? (plan.totalInboxes / plan.subdomainCount).toFixed(1) : 0}
          </div>
          <div className="text-[10px] text-gray-500">Balanced distribution</div>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-black/5 flex flex-col gap-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Server className="h-5 w-5 text-gray-500" /> Deployment Target
          </h2>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-purple-100">
              <Server className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <div className="font-medium">{domain.name}</div>
              <div className="text-sm text-gray-500 flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <Network className="h-3 w-3" />
                  {domain.ipAddress || "No IP configured"}
                </span>
                <span className="flex items-center gap-1">
                  <Key className="h-3 w-3" />
                  {domain.sshUser || "root"}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-black/5 flex flex-col gap-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Network className="h-5 w-5 text-gray-500" /> Subdomain Breakdown
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
                  className="flex items-center gap-2 bg-gray-50 px-3 py-1.5 rounded-xl border border-gray-100"
                >
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-mono font-bold text-gray-700">{prefix}</span>
                    <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[#4DB584] rounded-full"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                    <span className="text-xs font-bold text-[#4DB584]">{count} inboxes</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-1">
        <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-black/5 flex flex-col gap-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Globe className="h-5 w-5 text-gray-500" /> DNS Blueprint
          </h2>
          {records.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {records.map((record: any) => (
                <div
                  key={record.id}
                  className="flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-2 border border-slate-100"
                >
                  <div className="text-[10px] font-bold text-slate-400 bg-slate-200 px-1.5 py-0.5 rounded uppercase w-10 text-center">
                    {record.type}
                  </div>
                  <div className="font-mono text-[10px] text-slate-700 truncate flex-1">
                    {record.name === "@" ? domain.name : `${record.name}.${domain.name}`}
                  </div>
                  <div className="text-[9px] text-slate-400 truncate max-w-[80px] font-mono">
                    {record.content}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-gray-500 italic">No DNS records generated yet.</div>
          )}
        </div>
      </div>

      <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-black/5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Mail className="h-5 w-5 text-gray-500" /> Planned Inboxes by Subdomain
          </h2>
          <Button
            variant="outline"
            onClick={exportCsv}
            disabled={!inboxes.length}
            className="rounded-xl h-9 gap-2 border-gray-200"
          >
            <Send className="h-4 w-4" /> Export CSV
          </Button>
        </div>

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
          <div className="text-sm text-gray-500 italic py-8 text-center bg-gray-50 rounded-2xl border border-dashed border-gray-200">
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

  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden bg-white">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-gray-50 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          {expanded ? (
            <ChevronDown className="h-5 w-5 text-gray-400" />
          ) : (
            <ChevronRight className="h-5 w-5 text-gray-400" />
          )}
          <Network className="h-5 w-5 text-purple-500" />
          <div>
            <div className="font-semibold text-gray-900">
              {prefix}.{domain}
            </div>
            <div className="text-xs text-gray-500">{inboxes.length} mailboxes</div>
          </div>
        </div>
        <div className="flex -space-x-2">
          {inboxes.slice(0, 4).map((ib: any, i: number) => (
            <div
              key={ib.id}
              className="w-8 h-8 rounded-full bg-blue-100 border-2 border-white flex items-center justify-center text-[10px] font-bold text-blue-600"
              style={{ zIndex: 4 - i }}
              title={ib.email}
            >
              {ib.personName?.charAt(0) || "?"}
            </div>
          ))}
          {inboxes.length > 4 && (
            <div className="w-8 h-8 rounded-full bg-gray-100 border-2 border-white flex items-center justify-center text-[9px] font-bold text-gray-500">
              +{inboxes.length - 4}
            </div>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50/30">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-gray-500 uppercase text-[10px] font-bold tracking-wider">
              <tr>
                <th className="px-4 py-2">Email Address</th>
                <th className="px-4 py-2">Display Name</th>
                <th className="px-4 py-2">Format</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {inboxes.map((ib: any) => (
                <tr key={ib.id} className="hover:bg-gray-100/50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">{ib.email}</td>
                  <td className="px-4 py-3 text-gray-600">{ib.personName}</td>
                  <td className="px-4 py-3">
                    <span className="bg-blue-50 text-blue-600 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase">
                      {ib.format}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
