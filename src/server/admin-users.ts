import { createServerFn } from "@tanstack/react-start";
import { deleteCookie, getRequestHeader, getRequestUrl, setCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import { asc, desc, eq, sql } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth";
import { domainBatches, domains, users, userSecrets } from "@/lib/db/schema";
import { PLAN_PRESETS, planFor, type PlanChoice } from "@/lib/plans";
import { isHttpsRequest } from "./auth-core";
import { generateTempPassword, hashPassword, sessionCookieOptions } from "./accounts-core";
import { publicAccount, WORKSPACE_COOKIE, type Account } from "./accounts-db";

// The admin panel: activate sign-ups with a plan, extend or change plans, suspend, reset passwords, reject
// spam sign-ups, and open any account's workspace. Every function is admin-only (requireAdmin).
//
// Only createServerFn exports here (and types): see the note in session.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = { db: any; accountId: string };

const presetIds = PLAN_PRESETS.map((p) => p.id) as [string, ...string[]];
const planChoiceSchema = z.union([
  z.object({ preset: z.enum(presetIds) }),
  z.object({ days: z.number().int() }),
  z.object({ months: z.number().int() }),
  z.object({ until: z.string().max(64) }),
]);
const userIdSchema = z.string().min(1).max(64);

// The account an action targets. The admin row is never changed from the panel.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function managedAccount(db: any, userId: string): Promise<{ account: Account } | { error: string }> {
  const account: Account | undefined = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!account) return { error: "That account doesn't exist any more." };
  if (account.role === "admin") return { error: "The admin account can't be changed here." };
  return { account };
}

export const listUsers = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const { db } = context as unknown as Ctx;
    const rows: Account[] = await db.select().from(users).orderBy(desc(users.createdAt));
    const countBy = async (table: typeof domains | typeof domainBatches) => {
      const counted = await db
        .select({ userId: table.userId, n: sql<number>`count(*)::int` })
        .from(table)
        .groupBy(table.userId);
      return new Map<string, number>(counted.map((r: { userId: string; n: number }) => [r.userId, r.n]));
    };
    const domainCounts = await countBy(domains);
    const jobCounts = await countBy(domainBatches);
    return rows.map((row) => ({
      ...publicAccount(row),
      domains: domainCounts.get(row.id) ?? 0,
      jobs: jobCounts.get(row.id) ?? 0,
    }));
  });

export const applyPlan = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: unknown) => z.object({ userId: userIdSchema, choice: planChoiceSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { db } = context as unknown as Ctx;
    const target = await managedAccount(db, data.userId);
    if ("error" in target) return { ok: false, error: target.error as string | null };
    let plan: { endsAt: Date; label: string };
    try {
      plan = planFor(data.choice as PlanChoice, target.account.planEndsAt);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "That plan isn't valid." };
    }
    // Giving a pending sign-up a plan is what activates it. A suspended account stays suspended.
    const activating = target.account.status === "pending";
    await db
      .update(users)
      .set({
        planName: plan.label,
        planEndsAt: plan.endsAt,
        ...(activating ? { status: "active", activatedAt: new Date() } : {}),
      })
      .where(eq(users.id, target.account.id));
    return { ok: true, error: null as string | null };
  });

export const setSuspended = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: unknown) => z.object({ userId: userIdSchema, suspended: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { db } = context as unknown as Ctx;
    const target = await managedAccount(db, data.userId);
    if ("error" in target) return { ok: false, error: target.error as string | null };
    if (data.suspended) {
      // A new session version signs them out everywhere at once.
      await db
        .update(users)
        .set({ status: "suspended", sessionVersion: sql`${users.sessionVersion} + 1` })
        .where(eq(users.id, target.account.id));
    } else {
      if (target.account.status !== "suspended") return { ok: false, error: "This account isn't suspended." };
      await db.update(users).set({ status: "active" }).where(eq(users.id, target.account.id));
    }
    return { ok: true, error: null as string | null };
  });

export const resetUserPassword = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: unknown) => z.object({ userId: userIdSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { db } = context as unknown as Ctx;
    const target = await managedAccount(db, data.userId);
    if ("error" in target) return { ok: false, error: target.error as string | null, password: null as string | null };
    const password = generateTempPassword();
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password), sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, target.account.id));
    // Shown to the admin once; it's never stored in readable form.
    return { ok: true, error: null as string | null, password: password as string | null };
  });

export const rejectSignup = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: unknown) => z.object({ userId: userIdSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { db } = context as unknown as Ctx;
    const target = await managedAccount(db, data.userId);
    if ("error" in target) return { ok: false, error: target.error as string | null };
    if (target.account.status !== "pending") {
      return { ok: false, error: "Only a pending sign-up can be rejected. Suspend this account instead." };
    }
    try {
      await db.delete(userSecrets).where(eq(userSecrets.userId, target.account.id));
      await db.delete(users).where(eq(users.id, target.account.id));
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (code === "23503") return { ok: false, error: "This account has data, so it can't be deleted. Suspend it instead." };
      throw err;
    }
    return { ok: true, error: null as string | null };
  });

export const listWorkspaces = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const { db } = context as unknown as Ctx;
    const rows: Account[] = await db.select().from(users).orderBy(desc(users.role), asc(users.name));
    return rows
      .filter((row) => row.role === "admin" || row.status !== "pending")
      .map((row) => {
        const a = publicAccount(row);
        return { id: a.id, name: a.name, email: a.email, role: a.role, state: a.state };
      });
  });

export const setWorkspace = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: unknown) => z.object({ userId: userIdSchema.nullable() }).parse(d))
  .handler(async ({ data, context }) => {
    const { db, accountId } = context as unknown as Ctx;
    if (data.userId === null || data.userId === accountId) {
      deleteCookie(WORKSPACE_COOKIE, { path: "/" });
      return { ok: true, error: null as string | null };
    }
    const exists = await db.query.users.findFirst({ where: eq(users.id, data.userId), columns: { id: true } });
    if (!exists) return { ok: false, error: "That account doesn't exist any more." };
    const secure = isHttpsRequest(getRequestUrl().href, getRequestHeader("x-forwarded-proto"));
    setCookie(WORKSPACE_COOKIE, data.userId, sessionCookieOptions(secure));
    return { ok: true, error: null as string | null };
  });
