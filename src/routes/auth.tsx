import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { AlertTriangle, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { getSession, login } from "@/server/session";

export const Route = createFileRoute("/auth")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  beforeLoad: async ({ search }) => {
    const session = await getSession();
    if (session.authenticated) throw redirect({ href: safeRedirectPath(search.redirect) });
    return { setupError: session.setupError };
  },
  component: SignInPage,
});

function SignInPage() {
  const { redirect: redirectTo } = Route.useSearch();
  const { setupError } = Route.useRouteContext();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const notSetUp = setupError !== null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await login({ data: { email, password } });
      if (!result.ok) {
        setError(result.error ?? "Sign-in failed.");
        setPending(false);
        return;
      }
      // Full page load, so every page starts fresh with the new session.
      window.location.assign(safeRedirectPath(redirectTo));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 font-sans text-foreground">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
            <Mail className="h-5 w-5" />
          </div>
          <div className="leading-tight">
            <div className="font-display text-base font-semibold tracking-tight">Mail Nerd</div>
            <div className="ident text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              control console
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <h1 className="font-display text-lg font-semibold tracking-tight">Sign in</h1>

          {notSetUp && (
            <div role="alert" className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              {/* Deliberately generic: this page is public. The details are in the server log. */}
              <div className="flex items-start gap-2 font-medium">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <span>{setupError}</span>
              </div>
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={notSetUp || pending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={notSetUp || pending}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={notSetUp || pending}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
