import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "@/components/AuthShell";
import { getSession, signup } from "@/server/session";

export const Route = createFileRoute("/signup")({
  beforeLoad: async () => {
    const session = await getSession();
    if (session.authenticated) throw redirect({ to: "/" });
    return { setupError: session.setupError };
  },
  component: SignUpPage,
});

type Form = { name: string; email: string; password: string; confirmPassword: string };

function SignUpPage() {
  const { setupError } = Route.useRouteContext();
  const [form, setForm] = useState<Form>({ name: "", email: "", password: "", confirmPassword: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const disabled = setupError !== null || pending;
  const bind = (key: keyof Form) => ({
    value: form[key],
    onChange: (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
    disabled,
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await signup({ data: form });
      if (!result.ok) {
        setError(result.error ?? "Sign-up failed.");
        setPending(false);
        return;
      }
      window.location.assign("/account");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-up failed.");
      setPending(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="font-display text-lg font-semibold tracking-tight">Create an account</h1>
      <p className="mt-1 text-sm text-muted-foreground">The admin activates new accounts before they can be used.</p>

      {setupError && (
        <div role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-medium">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>{setupError}</span>
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-5 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" autoComplete="name" autoFocus required maxLength={80} {...bind("name")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" required {...bind("email")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="new-password" required minLength={10} {...bind("password")} />
          <p className="text-xs text-muted-foreground">At least 10 characters.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirmPassword">Confirm password</Label>
          <Input id="confirmPassword" type="password" autoComplete="new-password" required {...bind("confirmPassword")} />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={disabled}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {pending ? "Creating account…" : "Create account"}
        </Button>
      </form>

      <p className="mt-5 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link to="/auth" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
