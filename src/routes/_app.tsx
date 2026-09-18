import { useState } from "react";
import { createFileRoute, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { Globe, Server, Settings, Mail, FolderGit2, Stethoscope, LogOut, Menu, Users } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { getSession, logout } from "@/server/session";
import { setWorkspace } from "@/server/admin-users";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { PlanBadge } from "@/components/PlanBadge";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import type { PublicAccount } from "@/server/accounts-db";

export const Route = createFileRoute("/_app")({
  // Every page's data comes from server functions, which refuse without a usable account anyway; checking
  // here sends you to sign-in or the account status page up front.
  beforeLoad: async ({ location }) => {
    const session = await getSession();
    if (!session.authenticated || !session.account) {
      throw redirect({ to: "/auth", search: { redirect: location.href } });
    }
    if (session.access !== "ok") throw redirect({ to: "/account" });
    return { account: session.account, workspace: session.workspace, pendingSignups: session.pendingSignups };
  },
  component: AppLayout,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nav: ReadonlyArray<{ to: string; label: string; icon: any; exact?: boolean; adminOnly?: boolean }> = [
  { to: "/", label: "Overview", icon: Mail, exact: true },
  { to: "/jobs", label: "Jobs", icon: FolderGit2 },
  { to: "/domains", label: "Domains", icon: Globe },
  { to: "/servers", label: "Servers", icon: Server },
  { to: "/troubleshoot", label: "Troubleshoot", icon: Stethoscope },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/admin", label: "Users", icon: Users, adminOnly: true },
];

// Logo mark + product name. Shared by the desktop sidebar, the phone top bar and the phone drawer.
function Brand() {
  return (
    <>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
        <Mail className="h-[18px] w-[18px]" />
      </div>
      <div className="leading-tight">
        <div className="font-display text-[15px] font-semibold tracking-tight text-foreground">Mail Nerd</div>
        <div className="ident text-[10px] uppercase tracking-[0.18em] text-muted-foreground">control console</div>
      </div>
    </>
  );
}

// The nav list, rendered in both the desktop sidebar and the phone drawer so the two can't drift.
function NavLinks({
  path,
  isAdmin,
  pendingSignups,
  onNavigate,
}: {
  path: string;
  isAdmin: boolean;
  pendingSignups: number;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
      {nav
        .filter((item) => isAdmin || !item.adminOnly)
        .map((item) => {
          const active = item.exact ? path === item.to : path.startsWith(item.to);
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to as "/"}
              onClick={onNavigate}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                active ? "bg-primary/12 text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {active && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />}
              <Icon className={cn("h-[18px] w-[18px]", active ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
              {item.label}
              {item.adminOnly && pendingSignups > 0 && (
                <span
                  className="ml-auto rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground"
                  aria-label={`${pendingSignups} waiting for approval`}
                >
                  {pendingSignups}
                </span>
              )}
            </Link>
          );
        })}
    </nav>
  );
}

// Signed-in account + sign-out, shared by the desktop sidebar and the phone drawer.
function UserBlock({ account, onSignOut }: { account: PublicAccount; onSignOut: () => void }) {
  return (
    <div className="border-t border-border p-3">
      <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold uppercase text-foreground">
          {account.name.charAt(0) || "A"}
        </div>
        <div className="flex-1 overflow-hidden">
          <div className="truncate text-sm font-medium text-foreground">{account.name}</div>
          <div className="ident truncate text-xs text-muted-foreground">{account.email}</div>
          <div className="mt-1">
            {account.role === "admin" ? (
              <span className="text-[11px] font-medium text-muted-foreground">Admin</span>
            ) : (
              <PlanBadge planEndsAt={account.planEndsAt} />
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          title="Sign out"
          aria-label="Sign out"
          className="rounded-md p-3 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:p-2"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function AppLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { account, workspace, pendingSignups } = Route.useRouteContext();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const isAdmin = account.role === "admin";

  const signOut = async () => {
    await logout();
    window.location.assign("/auth");
  };
  const backToOwnWorkspace = async () => {
    try {
      const result = await setWorkspace({ data: { userId: null } });
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't switch back.");
        return;
      }
      window.location.assign("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't switch back.");
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-background font-sans text-foreground md:flex-row">
      {/* Phones/tablets: the sidebar would eat most of the screen, so it becomes a top bar + drawer. */}
      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-card px-2 md:hidden">
        <button
          type="button"
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open menu"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Brand />
        {!isAdmin && <PlanBadge planEndsAt={account.planEndsAt} className="ml-auto mr-1" />}
      </header>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" aria-describedby={undefined} className="flex w-72 max-w-[85vw] flex-col gap-0 overflow-y-auto bg-card p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex h-16 shrink-0 items-center gap-3 px-6">
            <Brand />
          </div>
          {isAdmin && <WorkspaceSwitcher currentId={workspace?.id ?? account.id} />}
          <NavLinks path={path} isAdmin={isAdmin} pendingSignups={pendingSignups} onNavigate={() => setMobileNavOpen(false)} />
          <UserBlock account={account} onSignOut={signOut} />
        </SheetContent>
      </Sheet>

      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card md:flex">
        <div className="flex h-16 items-center gap-3 px-6">
          <Brand />
        </div>
        {isAdmin && <WorkspaceSwitcher currentId={workspace?.id ?? account.id} />}
        <NavLinks path={path} isAdmin={isAdmin} pendingSignups={pendingSignups} />
        <UserBlock account={account} onSignOut={signOut} />
      </aside>

      <main className="min-w-0 flex-auto overflow-auto md:flex-1">
        {workspace && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm">
            <span className="min-w-0">
              Viewing <strong>{workspace.name}</strong>’s workspace{" "}
              <span className="ident break-all text-xs text-muted-foreground">({workspace.email})</span>
            </span>
            <Button size="sm" variant="outline" onClick={backToOwnWorkspace}>
              Back to {account.name}
            </Button>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
