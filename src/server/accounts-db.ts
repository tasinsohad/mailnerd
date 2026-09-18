import { eq, sql } from "drizzle-orm";
import { users } from "../lib/db/schema"; // relative: vite.config.ts loads sse-node.ts (and so this) before path aliases exist
import { accessDecision, accountState, verifyAccountToken, workspaceFor, type AccountState } from "./accounts-core";
import type { AuthConfig } from "./auth-core";

// The database side of accounts: finding the admin row and turning a session cookie into "who is this and
// whose workspace are they in". Server only. src/lib/auth.ts imports it dynamically (inside the middleware's
// server callback); server-function modules and sse-node.ts import it directly.

/** The internal record that owned all data before accounts; the admin row keeps its id. */
export const LEGACY_ADMIN_EMAIL = "admin@smtpforge.local";
/** The workspace the admin picked with the switcher (an account id). Ignored for everyone else. */
export const WORKSPACE_COOKIE = "mn_workspace";

export type Account = typeof users.$inferSelect;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export async function findAdminAccount(db: Db): Promise<Account | null> {
  const byRole = await db.query.users.findFirst({ where: eq(users.role, "admin") });
  if (byRole) return byRole;
  return (await db.query.users.findFirst({ where: eq(users.email, LEGACY_ADMIN_EMAIL) })) ?? null;
}

/** The admin row, created on a fresh install that has none yet. */
export async function ensureAdminAccount(db: Db, adminEmail: string): Promise<Account> {
  const found = await findAdminAccount(db);
  if (found) return found;
  const [created] = await db
    .insert(users)
    .values({ email: adminEmail.trim().toLowerCase(), name: "Admin", role: "admin", status: "active", activatedAt: new Date() })
    .returning();
  return created;
}

export type PublicAccount = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
  status: string;
  state: AccountState;
  planName: string | null;
  planEndsAt: string | null;
  createdAt: string;
  lastSignInAt: string | null;
};

/** What the browser may see of an account: never the password hash or session version. */
export function publicAccount(a: Account, nowMs = Date.now()): PublicAccount {
  const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
  return {
    id: a.id,
    name: a.name || a.email,
    email: a.email,
    role: a.role === "admin" ? "admin" : "user",
    status: a.status,
    state: accountState(a, nowMs),
    planName: a.planName,
    planEndsAt: iso(a.planEndsAt),
    createdAt: iso(a.createdAt) ?? "",
    lastSignInAt: iso(a.lastSignInAt),
  };
}

export async function countPendingSignups(db: Db): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.status, "pending"));
  return row?.n ?? 0;
}

export type SessionResult =
  | { state: "signed-out" }
  | { state: "locked"; reason: "pending" | "suspended" | "expired"; account: Account }
  | { state: "ok"; account: Account; isAdmin: boolean; workspaceId: string };

/** Who a session cookie belongs to, whether they may use the app, and whose workspace they're in. */
export async function resolveSession(
  db: Db,
  token: string | undefined,
  workspaceCookie: string | undefined,
  config: AuthConfig,
  nowMs = Date.now(),
): Promise<SessionResult> {
  const claims = verifyAccountToken(token, config, nowMs);
  if (!claims) return { state: "signed-out" };
  const account: Account | undefined = await db.query.users.findFirst({ where: eq(users.id, claims.accountId) });
  const access = accessDecision(account, claims, nowMs);
  if (!access.ok) {
    return access.reason === "missing" || !account
      ? { state: "signed-out" }
      : { state: "locked", reason: access.reason, account };
  }
  const acct = account as Account;
  const isAdmin = acct.role === "admin";
  let requestedExists = false;
  if (isAdmin && workspaceCookie && workspaceCookie !== acct.id) {
    requestedExists = Boolean(
      await db.query.users.findFirst({ where: eq(users.id, workspaceCookie), columns: { id: true } }),
    );
  }
  return { state: "ok", account: acct, isAdmin, workspaceId: workspaceFor(acct, workspaceCookie, requestedExists) };
}
