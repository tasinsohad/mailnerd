import { createServerFn } from "@tanstack/react-start";
import {
  deleteCookie,
  getCookie,
  getRequest,
  getRequestHeader,
  getRequestIP,
  getRequestUrl,
  setCookie,
} from "@tanstack/react-start/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { requireAuth } from "@/lib/auth";
import { users } from "@/lib/db/schema";
import {
  createLoginThrottle,
  credentialsMatch,
  CROSS_SITE_ERROR,
  crossSiteServerFnReason,
  isHttpsRequest,
  readAuthConfig,
  SESSION_COOKIE,
} from "./auth-core";
import {
  burnPasswordCheck,
  createAccountToken,
  createSignupThrottle,
  EMAIL_TAKEN,
  hashPassword,
  sessionCookieOptions,
  validateNewPassword,
  validateSignup,
  verifyPassword,
} from "./accounts-core";
import {
  countPendingSignups,
  ensureAdminAccount,
  publicAccount,
  resolveSession,
  WORKSPACE_COOKIE,
  type Account,
  type PublicAccount,
} from "./accounts-db";

// Sign-in, sign-up and the session cookie for everyone:
// - The admin signs in with ADMIN_EMAIL / ADMIN_PASSWORD from the environment. Their account row is the Nextus
//   workspace that owned all data before accounts existed.
// - People create accounts on /signup; the admin activates them with a plan (src/server/admin-users.ts).
// requireAuth (src/lib/auth.ts) checks the cookie before every other server function; sse-node.ts too.
//
// Only createServerFn exports here (and types). One plain runtime export would make this a "mixed" module
// that TanStack Start can't strip out of the browser bundle.

// Failed sign-ins per client (an IPv6 /64 counts as one), plus a cap on failures from everyone together.
// In memory: a restart clears it, which is fine for slowing guessing.
const loginThrottle = createLoginThrottle();
// Sign-ups (not failures) per client and in total.
const signupThrottle = createSignupThrottle();

const NOT_CONFIGURED = "Sign-in isn't configured on the server yet. Check the server logs.";
const DB_DOWN = "Can't reach the database right now. Try again in a moment.";
let reportedSetupProblems = false;

function reportSetupProblems(problems: string[]) {
  if (reportedSetupProblems) return; // process.env doesn't change without a restart
  reportedSetupProblems = true;
  console.error(`Sign-in is not configured: ${problems.join("; ")}. Fix .env and restart the app.`);
}

// Signing in, up and out change the session cookie, so another site mustn't be able to trigger them.
function refuseCrossSiteCall() {
  const reason = crossSiteServerFnReason(getRequest());
  if (reason) {
    console.warn(`Refused a server function call from another site: ${reason}`);
    throw new Error(CROSS_SITE_ERROR);
  }
}

// Secure only over HTTPS: browsers drop a Secure cookie sent over plain http://, and sign-in would silently
// loop back to the sign-in page.
function setSessionCookie(token: string) {
  const secure = isHttpsRequest(getRequestUrl().href, getRequestHeader("x-forwarded-proto"));
  setCookie(SESSION_COOKIE, token, sessionCookieOptions(secure));
}

// Caddy sets X-Forwarded-For. The app's port isn't published (docker-compose.yml), so nobody outside can
// forge it to dodge the limits.
function clientAddress(): string {
  return getRequestIP({ xForwardedFor: true }) ?? "unknown";
}

function tryAgainIn(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  return `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

async function database() {
  const { getDb } = await import("@/lib/db");
  return getDb();
}

export type SessionInfo = {
  authenticated: boolean;
  access: "ok" | "pending" | "suspended" | "expired" | null;
  account: PublicAccount | null;
  workspace: PublicAccount | null;
  pendingSignups: number;
  setupError: string | null;
};

function signedOut(setupError: string | null): SessionInfo {
  return { authenticated: false, access: null, account: null, workspace: null, pendingSignups: 0, setupError };
}

export const getSession = createServerFn({ method: "GET" }).handler(async (): Promise<SessionInfo> => {
  const auth = readAuthConfig(process.env);
  if (!auth.ok) {
    reportSetupProblems(auth.problems);
    return signedOut(NOT_CONFIGURED);
  }
  try {
    const db = await database();
    const session = await resolveSession(db, getCookie(SESSION_COOKIE), getCookie(WORKSPACE_COOKIE), auth.config);
    if (session.state === "signed-out") return signedOut(null);
    if (session.state === "locked") {
      return {
        authenticated: true,
        access: session.reason,
        account: publicAccount(session.account),
        workspace: null,
        pendingSignups: 0,
        setupError: null,
      };
    }
    let workspace: PublicAccount | null = null;
    if (session.workspaceId !== session.account.id) {
      const row: Account | undefined = await db.query.users.findFirst({ where: eq(users.id, session.workspaceId) });
      workspace = row ? publicAccount(row) : null;
    }
    return {
      authenticated: true,
      access: "ok",
      account: publicAccount(session.account),
      workspace,
      pendingSignups: session.isAdmin ? await countPendingSignups(db) : 0,
      setupError: null,
    };
  } catch (err) {
    console.error("getSession: couldn't check the session:", err instanceof Error ? err.message : err);
    return signedOut(DB_DOWN);
  }
});

export const login = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ email: z.string().max(320), password: z.string().max(1024) }).parse(d))
  .handler(async ({ data }) => {
    refuseCrossSiteCall();

    const auth = readAuthConfig(process.env);
    if (!auth.ok) {
      reportSetupProblems(auth.problems);
      return { ok: false, error: NOT_CONFIGURED as string | null };
    }

    const client = clientAddress();
    const waitMs = loginThrottle.retryAfterMs(client);
    if (waitMs > 0) return { ok: false, error: `Too many failed attempts. ${tryAgainIn(waitMs)}` };

    const db = await database();
    let account: Account | null = null;
    let admin = false;
    if (credentialsMatch(data.email, data.password, auth.config)) {
      account = await ensureAdminAccount(db, auth.config.email);
      admin = true;
    } else {
      const email = data.email.trim().toLowerCase();
      const found: Account | undefined = await db.query.users.findFirst({ where: eq(users.email, email) });
      if (found && found.role === "user") {
        if (await verifyPassword(data.password, found.passwordHash)) account = found;
      } else {
        await burnPasswordCheck(data.password);
      }
    }

    if (!account) {
      loginThrottle.recordFailure(client);
      return { ok: false, error: "Wrong email or password." };
    }
    loginThrottle.reset(client);
    await db.update(users).set({ lastSignInAt: new Date() }).where(eq(users.id, account.id));
    setSessionCookie(createAccountToken({ accountId: account.id, version: account.sessionVersion, admin }, auth.config));
    // A pending, suspended or expired account is signed in too: the app sends it to /account.
    return { ok: true, error: null as string | null };
  });

export const signup = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        name: z.string().max(200),
        email: z.string().max(320),
        password: z.string().max(1024),
        confirmPassword: z.string().max(1024),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    refuseCrossSiteCall();

    const auth = readAuthConfig(process.env);
    if (!auth.ok) {
      reportSetupProblems(auth.problems);
      return { ok: false, error: NOT_CONFIGURED as string | null };
    }

    const checked = validateSignup(data, auth.config.email);
    if (!checked.ok) return { ok: false, error: checked.error };

    const client = clientAddress();
    const waitMs = signupThrottle.retryAfterMs(client);
    if (waitMs > 0) return { ok: false, error: `Too many new accounts from here. ${tryAgainIn(waitMs)}` };

    signupThrottle.recordFailure(client); // counts every attempt, taken emails included, so the limit also slows probing for which emails have accounts
    const db = await database();
    const existing = await db.query.users.findFirst({ where: eq(users.email, checked.value.email), columns: { id: true } });
    if (existing) return { ok: false, error: EMAIL_TAKEN };

    const passwordHash = await hashPassword(checked.value.password);
    let created: Account;
    try {
      [created] = await db
        .insert(users)
        .values({ name: checked.value.name, email: checked.value.email, passwordHash, role: "user", status: "pending" })
        .returning();
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (code === "23505") return { ok: false, error: EMAIL_TAKEN }; // the same email, a moment earlier
      throw err;
    }
    // Signed in straight away; the app shows "waiting for approval" until the admin activates the account.
    setSessionCookie(createAccountToken({ accountId: created.id, version: created.sessionVersion, admin: false }, auth.config));
    return { ok: true, error: null as string | null };
  });

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  refuseCrossSiteCall();
  deleteCookie(SESSION_COOKIE, { path: "/" });
  deleteCookie(WORKSPACE_COOKIE, { path: "/" });
  return { ok: true };
});

export const changePassword = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        currentPassword: z.string().max(1024),
        newPassword: z.string().max(1024),
        confirmPassword: z.string().max(1024),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, user, isAdmin } = context as any as { db: any; user: Account; isAdmin: boolean };
    if (isAdmin) {
      return { ok: false, error: "The admin password is set on the server (ADMIN_PASSWORD in .env)." as string | null };
    }
    if (!(await verifyPassword(data.currentPassword, user.passwordHash))) {
      return { ok: false, error: "Your current password is wrong." };
    }
    const problem = validateNewPassword(data.newPassword, data.confirmPassword);
    if (problem) return { ok: false, error: problem };

    const auth = readAuthConfig(process.env);
    if (!auth.ok) return { ok: false, error: NOT_CONFIGURED };
    const passwordHash = await hashPassword(data.newPassword);
    // A new session version signs out every other device; this one gets a fresh cookie.
    const [updated]: Account[] = await db
      .update(users)
      .set({ passwordHash, sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, user.id))
      .returning();
    setSessionCookie(createAccountToken({ accountId: updated.id, version: updated.sessionVersion, admin: false }, auth.config));
    return { ok: true, error: null as string | null };
  });
