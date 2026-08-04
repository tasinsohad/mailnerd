import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, KeyRound, Copy, Check, Download, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { downloadCsv } from "@/lib/csv";
import {
  resetDomainMailboxPasswords,
  resetJobMailboxPasswords,
} from "@/server/mailbox-passwords";

type ResetRow = { email: string; ok: boolean; error?: string };
type ResetResult = { password: string; results: ResetRow[] } | null;

// Reset every mailbox password for a domain or a whole job to ONE shared password (blank = auto).
// Shows the new password + a downloadable email/password CSV, since those creds are needed to
// re-connect the inboxes (e.g. re-upload to a sending platform).
export function ResetPasswordsDialog({
  open,
  onOpenChange,
  scope,
  id,
  label,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  scope: "domain" | "job";
  id: string;
  label: string;
  onDone?: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResetResult>(null);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setPassword("");
    setResult(null);
    setBusy(false);
  };

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res: any =
        scope === "domain"
          ? await resetDomainMailboxPasswords({ data: { domainId: id, password: password || undefined } })
          : await resetJobMailboxPasswords({ data: { batchId: id, password: password || undefined } });
      if (res?.error) {
        toast.error(res.error);
        return;
      }
      setResult({ password: res.password, results: res.results ?? [] });
      const ok = (res.results ?? []).filter((r: ResetRow) => r.ok).length;
      toast.success(`Reset ${ok} mailbox password${ok === 1 ? "" : "s"}.`);
      onDone?.();
    } catch (e: any) {
      toast.error(e?.message ?? "Password reset failed");
    } finally {
      setBusy(false);
    }
  };

  const okRows = result?.results.filter((r) => r.ok) ?? [];
  const failRows = result?.results.filter((r) => !r.ok) ?? [];

  const copyPassword = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy");
    }
  };

  const downloadList = () => {
    if (!result) return;
    const rows = [["email", "password"], ...okRows.map((r) => [r.email, result.password])];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    downloadCsv(`${label}_passwords.csv`, csv);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Reset mailbox passwords — {label}
          </DialogTitle>
        </DialogHeader>

        {!result ? (
          <div className="flex flex-col gap-3">
            <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                This resets the password for <strong>every mailbox</strong>{" "}
                {scope === "job" ? "in this job" : `on ${label}`} to one shared password. Existing
                logins stop working until updated with the new password.
              </span>
            </div>
            <label className="text-sm font-medium text-foreground">
              New password
              <input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank to auto-generate a strong password"
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="text-sm text-muted-foreground">
              Reset <span className="font-medium text-success">{okRows.length}</span>
              {failRows.length > 0 && (
                <>
                  {" "}
                  · <span className="font-medium text-destructive">{failRows.length} failed</span>
                </>
              )}
              . Save these credentials now.
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <span className="text-xs text-muted-foreground">Password</span>
              <code className="flex-1 truncate font-mono text-sm text-foreground">{result.password}</code>
              <button
                onClick={copyPassword}
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                Copy
              </button>
            </div>
            {failRows.length > 0 && (
              <div className="max-h-32 overflow-auto rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                {failRows.map((r) => (
                  <div key={r.email} className="truncate" title={r.error}>
                    {r.email}: {r.error}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {!result ? (
            <Button onClick={run} disabled={busy} className="gap-1.5">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Reset all passwords
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={downloadList} className="gap-1.5">
                <Download className="h-4 w-4" /> Download CSV
              </Button>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
