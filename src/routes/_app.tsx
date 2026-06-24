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
    <div className="flex min-h-screen items-center justify-center bg-[#E5E7EB] p-4 sm:p-8 font-sans">
      <div className="flex w-full max-w-[1400px] h-[90vh] min-h-[700px] bg-[#F4F5F8] rounded-[2.5rem] overflow-hidden shadow-2xl ring-1 ring-black/5 relative">
        <aside className="flex w-64 flex-col bg-[#23242A] text-[#8B8D98] rounded-r-[2.5rem] z-10 shadow-2xl">
          <div className="flex h-24 items-center gap-3 px-8">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#4DB584] text-white shadow-lg">
              <Mail className="h-4 w-4" />
            </div>
            <span className="text-xl font-bold text-white tracking-wide">logotype</span>
          </div>
          <nav className="flex flex-1 flex-col gap-2 px-6 py-4">
            {nav.map((item) => {
              const active = item.exact ? path === item.to : path.startsWith(item.to);
              const Icon = item.icon;
              return (
                <Link
                  key={item.to}
                  to={item.to as "/"}
                  className={cn(
                    "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition-all duration-200",
                    active
                      ? "bg-[#4DB584] text-white shadow-md shadow-[#4DB584]/20 transform scale-[1.02]"
                      : "hover:bg-white/5 hover:text-white",
                  )}
                >
                  <Icon className="h-5 w-5" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="p-6">
            <div className="flex items-center gap-3 rounded-2xl bg-white/5 p-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white">
                <span className="text-sm font-semibold">A</span>
              </div>
              <div className="flex-1 overflow-hidden">
                <div className="truncate text-sm font-medium text-white">Admin</div>
                <div className="truncate text-xs text-[#8B8D98]">admin@smtpforge.local</div>
              </div>
            </div>
          </div>
        </aside>
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
