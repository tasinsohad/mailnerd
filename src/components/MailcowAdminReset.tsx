import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Eye, EyeOff, Copy, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { resetMailcowAdminPassword } from "@/server/provisioning";

export function MailcowAdminReset({
  domainId,
  mailcowHostname,
  currentPassword,
}: {
  domainId: string;
  mailcowHostname: string;
  currentPassword: string | null;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState(false);

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  const reset = useMutation({
    mutationFn: () => {
      toast.loading("Resetting admin password…", { id: "adminpw" });
      return resetMailcowAdminPassword({ data: { domainId } });
    },
    onSuccess: (res: any) => {
      if (res?.error) {
        toast.error(res.error, { id: "adminpw" });
        return;
      }
      toast.success("Admin password reset — new password shown in the card", { id: "adminpw" });
      setShow(true);
      qc.invalidateQueries({ queryKey: ["domain", domainId] });
      setOpen(false);
    },
    onError: (e: any) => toast.error(e?.message ?? "Reset failed", { id: "adminpw" }),
  });

  const displayPassword = currentPassword ?? "moohoo";

  return (
    <div className="rounded-lg border border-border p-4 flex flex-col gap-1">
      <div className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
        Admin Panel
      </div>
      <a
        href={`https://${mailcowHostname}/admin`}
        target="_blank"
        rel="noreferrer"
        className="text-sm text-primary hover:underline break-all"
      >
        https://{mailcowHostname}/admin
      </a>
      <div className="mt-2 text-sm">
        User: <span className="font-mono font-bold">admin</span>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span>Pass:</span>
        <span className="font-mono font-bold">{show ? displayPassword : "••••••••"}</span>
        <button
          onClick={() => setShow((s) => !s)}
          className="text-muted-foreground hover:text-foreground"
          title={show ? "Hide" : "Show"}
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={() => copy(displayPassword)}
          className="text-muted-foreground hover:text-foreground"
          title="Copy"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        {!currentPassword && <span className="text-warning text-xs">(default)</span>}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="mt-2 h-8 w-fit gap-1.5"
        onClick={() => setOpen(true)}
      >
        <KeyRound className="h-3.5 w-3.5" />
        Reset password
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Mailcow admin password</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Runs Mailcow's own reset on <span className="font-mono">{mailcowHostname}</span>: the{" "}
            <span className="font-mono">admin</span> account gets a new randomly generated password
            (and 2FA is cleared). The old password stops working immediately. The new password is
            shown here afterward — copy it somewhere safe.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={reset.isPending}>
              Cancel
            </Button>
            <Button onClick={() => reset.mutate()} disabled={reset.isPending}>
              {reset.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Reset password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
