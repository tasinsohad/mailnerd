import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MoreHorizontal, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PlanDialog, type PlanTarget } from "@/components/admin/PlanDialog";
import { TempPasswordDialog } from "@/components/admin/TempPasswordDialog";
import { daysLeft } from "@/lib/plans";
import { cn } from "@/lib/utils";
import { listUsers, rejectSignup, resetUserPassword, setSuspended, setWorkspace } from "@/server/admin-users";

export const Route = createFileRoute("/_app/admin")({
  beforeLoad: ({ context }) => {
    if (context.account?.role !== "admin") throw redirect({ to: "/" });
  },
  component: AdminUsersPage,
});

type UserRow = Awaited<ReturnType<typeof listUsers>>[number];
const FILTERS = [
  { id: "pending", label: "Pending" },
  { id: "active", label: "Active" },
  { id: "expired", label: "Expired" },
  { id: "suspended", label: "Suspended" },
  { id: "all", label: "All" },
] as const;
type Filter = (typeof FILTERS)[number]["id"];

const STATE_STYLE: Record<string, string> = {
  pending: "bg-primary/15 text-primary",
  active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  expired: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  suspended: "bg-destructive/15 text-destructive",
};

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

function planText(u: UserRow): string {
  if (!u.planEndsAt) return "No plan yet";
  const days = daysLeft(u.planEndsAt);
  return days > 0
    ? `${u.planName ?? "Plan"} · ends ${date(u.planEndsAt)} (${days} day${days === 1 ? "" : "s"} left)`
    : `${u.planName ?? "Plan"} · ended ${date(u.planEndsAt)}`;
}

function AdminUsersPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["admin-users"], queryFn: () => listUsers() });
  const people = rows.filter((r) => r.role !== "admin");
  const count = (f: Filter) => (f === "all" ? people.length : people.filter((u) => u.state === f).length);
  const [filter, setFilter] = useState<Filter | null>(null);
  const shownFilter: Filter = filter ?? (count("pending") > 0 ? "pending" : "all");
  const shown = shownFilter === "all" ? people : people.filter((u) => u.state === shownFilter);

  const [planTarget, setPlanTarget] = useState<PlanTarget | null>(null);
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // The sidebar's pending count comes from the route context, so re-run the route's beforeLoad too.
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["admin-users"] });
    await qc.invalidateQueries({ queryKey: ["workspaces"] });
    await router.invalidate();
  };

  const act = async (u: UserRow, run: () => Promise<{ ok: boolean; error: string | null }>, done: string) => {
    setBusyId(u.id);
    try {
      const result = await run();
      if (!result.ok) toast.error(result.error ?? "That didn't work.");
      else toast.success(done);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusyId(null);
    }
  };

  const openWorkspace = async (u: UserRow) => {
    try {
      const result = await setWorkspace({ data: { userId: u.id } });
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't open that workspace.");
        return;
      }
      window.location.assign("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open that workspace.");
    }
  };

  const resetPassword = async (u: UserRow) => {
    if (!confirm(`Reset ${u.name}'s password? They'll be signed out everywhere and need the new password you get.`)) return;
    setBusyId(u.id);
    try {
      const result = await resetUserPassword({ data: { userId: u.id } });
      if (!result.ok || !result.password) toast.error(result.error ?? "Couldn't reset the password.");
      else setTempPassword({ email: u.email, password: result.password });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't reset the password.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex max-w-5xl flex-col gap-6 p-4 sm:p-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <Users className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Users</h1>
          <p className="text-sm text-muted-foreground">Activate sign-ups, manage plans and open any workspace</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
              shownFilter === f.id ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            {f.label} <span className="text-muted-foreground">{count(f.id)}</span>
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          {people.length === 0 ? "Nobody has signed up yet. Share the sign-up page: /signup" : "No accounts in this list."}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((u) => (
            <div key={u.id} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{u.name}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize", STATE_STYLE[u.state])}>
                    {u.state}
                  </span>
                </div>
                <div className="ident truncate text-xs text-muted-foreground">{u.email}</div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>Signed up {date(u.createdAt)}</span>
                  <span>{planText(u)}</span>
                  <span>Last sign-in {u.lastSignInAt ? date(u.lastSignInAt) : "never"}</span>
                  <span>
                    {u.domains} domain{u.domains === 1 ? "" : "s"} · {u.jobs} job{u.jobs === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {busyId === u.id && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                <Button size="sm" variant={u.state === "pending" ? "default" : "outline"} onClick={() => setPlanTarget(u)}>
                  {u.state === "pending" ? "Activate" : "Change plan"}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" aria-label={`More actions for ${u.name}`}>
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {u.state !== "pending" && <DropdownMenuItem onClick={() => openWorkspace(u)}>Open workspace</DropdownMenuItem>}
                    <DropdownMenuItem onClick={() => resetPassword(u)}>Reset password</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {u.state === "suspended" ? (
                      <DropdownMenuItem
                        onClick={() => act(u, () => setSuspended({ data: { userId: u.id, suspended: false } }), `${u.name} is reactivated.`)}
                      >
                        Reactivate
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() =>
                          confirm(`Suspend ${u.name}? They're signed out at once and can't use the app until you reactivate them.`) &&
                          act(u, () => setSuspended({ data: { userId: u.id, suspended: true } }), `${u.name} is suspended.`)
                        }
                      >
                        Suspend
                      </DropdownMenuItem>
                    )}
                    {u.state === "pending" && (
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() =>
                          confirm(`Reject and delete ${u.name}'s sign-up (${u.email})?`) &&
                          act(u, () => rejectSignup({ data: { userId: u.id } }), "Sign-up rejected.")
                        }
                      >
                        Reject sign-up
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </div>
      )}

      {planTarget && (
        <PlanDialog
          key={planTarget.id}
          user={planTarget}
          onClose={() => setPlanTarget(null)}
          onDone={async () => {
            setPlanTarget(null);
            await refresh();
          }}
        />
      )}
      {tempPassword && (
        <TempPasswordDialog email={tempPassword.email} password={tempPassword.password} onClose={() => setTempPassword(null)} />
      )}
    </div>
  );
}
