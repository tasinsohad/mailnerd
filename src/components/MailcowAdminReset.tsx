import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Eye, EyeOff, Copy, RefreshCw, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { resetMailcowAdminPassword } from "@/server/provisioning";

// Generate a readable strong password for the dialog default (client-side; the server
// generates its own if the field is left as-is and re-submitted).
function genPassword(): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*-_"];
  const all = sets.join("");
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
  const chars = sets.map(pick);
  for (let i = chars.length; i < 18; i++) chars.push(pick(all));
  return chars.sort(() => Math.random() - 0.5).join("");
}

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
  const [value, setValue] = useState("");

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  const reset = useMutation({
    mutationFn: (newPassword: string) => {
      toast.loading("Resetting admin password…", { id: "adminpw" });
      return resetMailcowAdminPassword({ data: { domainId, newPassword } });
    },
    onSuccess: (res: any) => {
      if (res?.error) {
        toast.error(res.error, { id: "adminpw" });
        return;
      }
      toast.success("Admin password updated", { id: "adminpw" });
      qc.invalidateQueries({ queryKey: ["domain", domainId] });
      setOpen(false);
    },
    onError: (e: any) => toast.error(e?.message ?? "Reset failed", { id: "adminpw" }),
  });

  const displayPassword = currentPassword ?? "moohoo";

  return (
    <div className="rounded-lg border border-border p-4 flex flex-col gap-1">
      <div className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Admin Panel</div>
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
        <button onClick={() => setShow((s) => !s)} className="text-muted-foreground hover:text-foreground" title={show ? "Hide" : "Show"}>
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
        <button onClick={() => copy(displayPassword)} className="text-muted-foreground hover:text-foreground" title="Copy">
          <Copy className="h-3.5 w-3.5" />
        </button>
        {!currentPassword && <span className="text-warning text-xs">(default)</span>}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="mt-2 h-8 w-fit gap-1.5"
        onClick={() => {
          setValue(genPassword());
          setOpen(true);
        }}
      >
        <KeyRound className="h-3.5 w-3.5" />
        Reset password
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Mailcow admin password</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Sets a new password for the <span className="font-mono">admin</span> account on{" "}
              <span className="font-mono">{mailcowHostname}/admin</span>. Save it somewhere safe — it's shown here after reset.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="adminpw-input">New password</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="adminpw-input"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button variant="outline" size="icon" className="shrink-0" title="Generate" onClick={() => setValue(genPassword())}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" className="shrink-0" title="Copy" onClick={() => copy(value)}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">At least 8 characters.</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={reset.isPending}>
              Cancel
            </Button>
            <Button onClick={() => reset.mutate(value)} disabled={reset.isPending || value.length < 8}>
              {reset.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Set password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
