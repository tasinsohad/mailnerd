import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ChevronDown, Send, Zap, Mail, ShieldCheck, Network, RefreshCw, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { pushDnsToCloudflare, repairDomainDns } from "@/server/domains";
import { provisionServer } from "@/server/provisioning";
import { setupMailcowDomain, fetchDkimAndSync } from "@/server/mailcow";

// Run any per-domain action across EVERY domain in a job. Same control set as a single
// domain, applied to the whole batch sequentially with a running progress toast.
export function JobActionsMenu({ domainIds, onChanged }: { domainIds: string[]; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const n = domainIds.length;

  const runAll = async (
    label: string,
    fn: (domainId: string) => Promise<any>,
    confirmMsg?: string,
  ) => {
    if (!n) return;
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(true);
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < n; i++) {
      toast.loading(`${label} — ${i + 1}/${n}…`, { id: "jobactions" });
      try {
        const res: any = await fn(domainIds[i]);
        if (res?.error || (res?.summary && res.summary.failed > 0)) fail++;
        else ok++;
      } catch {
        fail++;
      }
    }
    setBusy(false);
    onChanged?.();
    toast[fail ? "error" : "success"](
      `${label}: ${ok} ok${fail ? `, ${fail} failed` : ""} across ${n} domain${n !== 1 ? "s" : ""}.`,
      { id: "jobactions", duration: 8000 },
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={busy || !n} className="h-10 gap-2">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
          Run for all domains
          <ChevronDown className="h-4 w-4 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Apply to all {n} domains</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => runAll("Pushing DNS", (id) => pushDnsToCloudflare({ data: { domainId: id } }))}>
          <Send className="h-4 w-4" /> Push DNS
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => runAll("Provisioning", (id) => provisionServer({ data: { domainId: id } }))}>
          <Zap className="h-4 w-4" /> Provision servers
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => runAll("Setting up mailboxes", (id) => setupMailcowDomain({ data: { domainId: id } }))}>
          <Mail className="h-4 w-4" /> Set up mailboxes
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => runAll("Syncing DKIM", (id) => fetchDkimAndSync({ data: { domainId: id } }))}>
          <ShieldCheck className="h-4 w-4" /> Sync DKIM
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Repair</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => runAll("Fixing DNS", (id) => repairDomainDns({ data: { domainId: id } }))}>
          <Network className="h-4 w-4" /> Fix DNS (un-proxy)
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            runAll(
              "Recreating mailboxes",
              (id) => setupMailcowDomain({ data: { domainId: id, recreate: true } }),
              `Recreate mailboxes for ALL ${n} domains? This deletes & recreates every mailbox with new passwords.`,
            )
          }
        >
          <RefreshCw className="h-4 w-4" /> Recreate mailboxes
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() =>
            runAll(
              "Wiping & re-provisioning",
              (id) => provisionServer({ data: { domainId: id } }),
              `Wipe & re-provision ALL ${n} servers from scratch? Each takes 20–40 min.`,
            )
          }
        >
          <Trash2 className="h-4 w-4" /> Wipe &amp; re-provision
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
