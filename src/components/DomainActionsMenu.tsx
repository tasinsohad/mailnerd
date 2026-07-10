import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  MoreHorizontal,
  Send,
  Zap,
  Mail,
  ShieldCheck,
  Network,
  RefreshCw,
  Trash2,
  Loader2,
  Download,
  Globe,
} from "lucide-react";
import { toast } from "sonner";
import { pushDnsToCloudflare, repairDomainDns, deleteDomain } from "@/server/domains";
import { provisionServer } from "@/server/provisioning";
import { setupMailcowDomain, fetchDkimAndSync } from "@/server/mailcow";
import { getInboxExport, getSubdomainExport } from "@/server/plans";
import { downloadCsv } from "@/lib/csv";
import { EXPORT_FORMATS, buildExportCsv } from "@/lib/export-formats";
import { ExportSubdomainsDialog } from "@/components/ExportSubdomainsDialog";
import type { SubdomainRow } from "@/lib/subdomains";

// Every per-domain control in one 3-dot menu. Used in the Domains list and anywhere a
// single domain needs its full action set. Stops click propagation so it can live inside
// a clickable row without triggering navigation.
export function DomainActionsMenu({
  domainId,
  domainName,
  onChanged,
  canExport = false,
}: {
  domainId: string;
  domainName?: string;
  onChanged?: () => void;
  canExport?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [subRows, setSubRows] = useState<SubdomainRow[]>([]);

  const openSubdomains = async () => {
    setBusy(true);
    try {
      const res: any = await getSubdomainExport({ data: { domainId } });
      if (!res?.rows?.length) {
        toast.error("No subdomains to export yet. Plan the domain's inboxes first.");
        return;
      }
      setSubRows(res.rows);
      setSubOpen(true);
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't load subdomains");
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async (formatId: string) => {
    setBusy(true);
    try {
      const res: any = await getInboxExport({ data: { domainId } });
      if (!res?.rows?.length) {
        toast.error("No created mailboxes to export yet.");
        return;
      }
      downloadCsv(`${domainName ?? "domain"}_${formatId}.csv`, buildExportCsv(formatId, res.rows));
      toast.success(`Exported ${res.rows.length} mailbox${res.rows.length === 1 ? "" : "es"}`);
    } catch (e: any) {
      toast.error(e?.message ?? "Export failed");
    } finally {
      setBusy(false);
    }
  };

  const run = async (label: string, fn: () => Promise<any>, success: string) => {
    setBusy(true);
    toast.loading(`${label}…`, { id: domainId });
    try {
      const res: any = await fn();
      if (res?.error) toast.error(res.error, { id: domainId });
      else if (res?.summary && res.summary.failed > 0)
        toast.error(`${res.summary.created}/${res.summary.total} mailboxes — ${res.summary.failed} failed`, {
          id: domainId,
          duration: 9000,
        });
      else toast.success(success, { id: domainId });
      onChanged?.();
    } catch (e: any) {
      toast.error(e?.message ?? "Action failed", { id: domainId });
    } finally {
      setBusy(false);
    }
  };

  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={busy}
          onClick={stop}
          title="Domain actions"
          className="h-9 w-9"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel>Run a step</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => run("Pushing DNS", () => pushDnsToCloudflare({ data: { domainId } }), "DNS pushed to Cloudflare")}>
          <Send className="h-4 w-4" /> Push DNS
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => run("Provisioning server", () => provisionServer({ data: { domainId } }), "Provisioning started")}>
          <Zap className="h-4 w-4" /> Provision server
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => run("Setting up mailboxes", () => setupMailcowDomain({ data: { domainId } }), "Mailboxes set up")}>
          <Mail className="h-4 w-4" /> Set up mailboxes
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => run("Syncing DKIM", () => fetchDkimAndSync({ data: { domainId } }), "DKIM synced")}>
          <ShieldCheck className="h-4 w-4" /> Sync DKIM
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            disabled={!canExport}
            title={canExport ? undefined : "Available once mailboxes are created"}
          >
            <Download className="h-4 w-4" /> Export CSV
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {EXPORT_FORMATS.map((f) => (
              <DropdownMenuItem key={f.id} onClick={() => exportCsv(f.id)}>
                {f.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onClick={openSubdomains}>
          <Globe className="h-4 w-4" /> Export subdomains
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Repair</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => run("Fixing DNS", () => repairDomainDns({ data: { domainId } }), "DNS fixed (un-proxied)")}>
          <Network className="h-4 w-4" /> Fix DNS (un-proxy)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => run("Recreating mailboxes", () => setupMailcowDomain({ data: { domainId, recreate: true } }), "Mailboxes recreated")}>
          <RefreshCw className="h-4 w-4" /> Recreate mailboxes
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => {
            if (confirm(`Delete ${domainName ?? "this domain"}? This removes it from SMTP Forge.`))
              run("Deleting domain", () => deleteDomain({ data: { id: domainId } }), "Domain deleted");
          }}
        >
          <Trash2 className="h-4 w-4" /> Delete domain
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <ExportSubdomainsDialog
      open={subOpen}
      onOpenChange={setSubOpen}
      rows={subRows}
      filenameBase={domainName ?? "domain"}
    />
    </>
  );
}
