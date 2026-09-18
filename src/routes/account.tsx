import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { Clock, Ban, CalendarX, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthShell } from "@/components/AuthShell";
import { getSession, logout } from "@/server/session";

// Where a signed-in account lands while it can't use the app: waiting for approval, suspended, or out of plan.
export const Route = createFileRoute("/account")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session.authenticated || !session.account) throw redirect({ to: "/auth" });
    if (session.access === "ok") throw redirect({ to: "/" });
    return { access: session.access, account: session.account };
  },
  component: AccountStatusPage,
});

const MESSAGES = {
  pending: {
    icon: Clock,
    title: "Waiting for approval",
    body: "Your account has been created. The admin needs to activate it before you can use Mail Nerd. Check back later.",
  },
  suspended: {
    icon: Ban,
    title: "Account suspended",
    body: "Your account is suspended. Contact the admin to get access again.",
  },
  expired: {
    icon: CalendarX,
    title: "Your plan has ended",
    body: "Contact the admin to extend your plan. Your domains and jobs are kept and come back as soon as it's extended.",
  },
} as const;

function AccountStatusPage() {
  const { access, account } = Route.useRouteContext();
  const [leaving, setLeaving] = useState(false);
  const message = MESSAGES[(access ?? "suspended") as keyof typeof MESSAGES] ?? MESSAGES.suspended;
  const Icon = message.icon;
  const endedOn = access === "expired" && account.planEndsAt ? new Date(account.planEndsAt).toLocaleString() : null;

  const signOut = async () => {
    setLeaving(true);
    await logout();
    window.location.assign("/auth");
  };

  return (
    <AuthShell>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
        <h1 className="font-display text-lg font-semibold tracking-tight">{message.title}</h1>
      </div>
      {endedOn && <p className="mt-4 text-sm font-medium">Your plan ended on {endedOn}.</p>}
      <p className="mt-3 text-sm text-muted-foreground">{message.body}</p>
      <p className="ident mt-4 truncate text-xs text-muted-foreground">Signed in as {account.email}</p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Button className="flex-1" variant="outline" onClick={() => window.location.assign("/")}>
          Check again
        </Button>
        <Button className="flex-1" variant="ghost" onClick={signOut} disabled={leaving}>
          {leaving && <Loader2 className="h-4 w-4 animate-spin" />}
          Sign out
        </Button>
      </div>
    </AuthShell>
  );
}
