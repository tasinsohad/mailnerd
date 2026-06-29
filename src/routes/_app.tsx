import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Globe, Server, Settings, Mail, FolderGit2 } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

const nav: ReadonlyArray<{ to: string; label: string; icon: any; exact?: boolean }> = [
  { to: "/", label: "Overview", icon: Mail, exact: true },
  { to: "/jobs", label: "Jobs", icon: FolderGit2 },
  { to: "/domains", label: "Domains", icon: Globe },
  { to: "/servers", label: "Servers", icon: Server },
  { to: "/settings", label: "Settings", icon: Settings },
];

function AppLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="flex min-h-screen bg-background font-sans text-foreground">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex h-16 items-center gap-3 px-6">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
            <Mail className="h-[18px] w-[18px]" />
          </div>
          <div className="leading-tight">
            <div className="font-display text-[15px] font-semibold tracking-tight text-foreground">
              SMTP Forge
            </div>
            <div className="ident text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              control console
            </div>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
          {nav.map((item) => {
            const active = item.exact ? path === item.to : path.startsWith(item.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to as "/"}
                className={cn(
                  "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary/12 text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
                )}
                <Icon
                  className={cn("h-[18px] w-[18px]", active ? "text-primary" : "text-muted-foreground group-hover:text-foreground")}
                />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border p-3">
          <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-semibold text-foreground">
              A
            </div>
            <div className="flex-1 overflow-hidden">
              <div className="truncate text-sm font-medium text-foreground">Admin</div>
              <div className="ident truncate text-xs text-muted-foreground">team@nextus.ai</div>
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
