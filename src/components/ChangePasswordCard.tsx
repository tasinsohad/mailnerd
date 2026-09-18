import { useState, type FormEvent } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePassword } from "@/server/session";

const EMPTY = { currentPassword: "", newPassword: "", confirmPassword: "" };

export function ChangePasswordCard() {
  const [form, setForm] = useState(EMPTY);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await changePassword({ data: form });
      if (!result.ok) {
        setError(result.error ?? "Couldn't change the password.");
        return;
      }
      setForm(EMPTY);
      toast.success("Password changed. You're signed out on your other devices.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the password.");
    } finally {
      setPending(false);
    }
  }

  const field = (key: keyof typeof EMPTY, label: string, autoComplete: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={key}>{label}</Label>
      <Input id={key} type="password" autoComplete={autoComplete} required value={form[key]} disabled={pending}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
    </div>
  );

  return (
    <div className="rounded-xl bg-card p-4 sm:p-8 shadow-sm ring-1 ring-border flex flex-col gap-6">
      <div className="flex items-center gap-3 border-b border-border pb-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <KeyRound className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-foreground">Password</h2>
          <p className="text-xs text-muted-foreground">Changing it signs you out on your other devices</p>
        </div>
      </div>
      <form onSubmit={onSubmit} className="grid gap-4 sm:max-w-sm">
        {field("currentPassword", "Current password", "current-password")}
        {field("newPassword", "New password (at least 10 characters)", "new-password")}
        {field("confirmPassword", "Confirm new password", "new-password")}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending} className="sm:w-fit">
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          Change password
        </Button>
      </form>
    </div>
  );
}
