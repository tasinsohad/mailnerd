# User Accounts, Admin Approval and Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People can sign up. An account works only after the admin activates it with a plan (a length of time). Each account has a private workspace, and the admin can open any workspace. The existing Nextus data becomes the admin's account and is left untouched.

**Architecture:**
- Accounts live in the app's own `users` table: new columns, a scrypt password hash, and a signed session cookie that names the account.
- Pure logic (passwords, tokens, access decisions, plan dates) lives in leaf modules with unit tests. One database-side resolver (`resolveSession`) feeds `requireAuth`, `getSession` and the live-log stream.
- `requireAuth` puts the **workspace** id into `context.userId`, which every existing query already scopes by. Admin "view as" is just a different workspace id.

**Tech Stack:** TanStack Start 1.168 (server functions + middleware), React 19, TanStack Query/Router (route tree maintained by hand in `src/routeTree.gen.ts`), Drizzle ORM on Supabase Postgres (postgres-js, pooler port 6543, `prepare: false`), node:crypto scrypt, vitest, shadcn/ui + Tailwind v4, Docker Compose on a VPS.

**Spec:** `docs/superpowers/specs/2026-09-18-user-accounts-design.md`

## Global Constraints

- **Server-function modules** (`src/server/*.ts` files that call `createServerFn`) export only `createServerFn` values, plus types. A plain runtime export makes a "mixed module" that pulls server code into the browser bundle.
- **Middleware:**
  - `getSession`, `login`, `signup` and `logout` are the only public server functions.
  - Admin-only functions use `requireAdmin`.
  - Every other function uses `requireAuth`.
- **Server-only modules** (`auth-core.ts`, `accounts-core.ts`, `accounts-db.ts`, `src/lib/db`) may be imported only from:
  - server-function modules,
  - `sse-node.ts` and `queue.ts`,
  - dynamically inside the server callback of a middleware in `src/lib/auth.ts`.

  Browser code imports only `src/lib/plans.ts` and types.
- **The admin row keeps id `aa64be25-9b8c-40d0-9671-4e8ffa345622`.** No task changes the `user_id` of any existing row.
- **Passwords:**
  - Account passwords: at least 10 characters, at most 200.
  - scrypt parameters: N=16384, r=8, p=1, 32-byte key, 16-byte random salt. Stored as `scrypt$N$r$p$<salt b64>$<hash b64>`.
  - Temporary passwords: 16 characters.
- **Sign-up limit:** 5 per hour per client (IPv6 by /64), and 50 per hour in total.
- **Plan presets:** `7-day trial` (7 days), `1 month`, `3 months`, `6 months`, `1 year` (12 months).
- **Error prefixes the browser reacts to** (`src/lib/providers.tsx`):
  - `UNAUTHENTICATED` goes to `/auth`.
  - `ACCOUNT_LOCKED` goes to `/account`.
  - `FORBIDDEN` is only shown.
- **User-facing messages, verbatim:**
  - Sign-in failure: "Wrong email or password."
  - Email in use: "An account with this email already exists."
- **Commits:** commit after each task on branch `feat/batch-provisioning-reliability`. Don't push.
- **Verification gate before any deploy:**
  - `npx tsc --noEmit` exits 0.
  - `npx vitest run` all pass.
  - `npm run build` exits 0.
  - `grep -rlE "ssh2|bullmq|ioredis|node-ssh|SSHManager|account-session-v2" .output/public | wc -l` prints `0`.

---

### Task 1: Back up the database

**Files:**
- Create: `scripts/backup-db.ts`

**Interfaces:**
- Produces: a backup directory `<out>/mailnerd-<timestamp>/` holding `<table>.json` for every public table, and `counts.json` (`Record<string, number>`). Task 2's `--compare` reads `counts.json`.

- [ ] **Step 1: Write the backup script**

```ts
// Full backup of every table in the public schema: one JSON file per table plus counts.json.
// Run before any schema change:  npx tsx scripts/backup-db.ts <output-dir>
// The files hold plain-text credentials (SSH passwords, API keys), so the output must be outside the repo.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const repo = fileURLToPath(new URL("..", import.meta.url));
process.loadEnvFile(join(repo, ".env"));

const outArg = process.argv[2];
if (!outArg) {
  console.error("Usage: npx tsx scripts/backup-db.ts <output-dir>");
  process.exit(1);
}
const outDir = resolve(outArg);
if (outDir.toLowerCase().startsWith(resolve(repo).toLowerCase())) {
  console.error("Write the backup outside the repository: it contains credentials.");
  process.exit(1);
}

let url = process.env.DATABASE_URL ?? "";
if (url.includes("#") && !url.includes("%23")) url = url.replace(/#/, "%23"); // same fix as src/lib/db
const sql = postgres(url, { prepare: false, max: 1, ssl: "require" });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(outDir, `mailnerd-${stamp}`);
mkdirSync(dir, { recursive: true });

const tables = await sql<{ tablename: string }[]>`
  select tablename from pg_tables where schemaname = 'public' order by tablename`;
const counts: Record<string, number> = {};
for (const { tablename } of tables) {
  const rows = await sql.unsafe(`select * from public."${tablename}"`);
  const file = join(dir, `${tablename}.json`);
  writeFileSync(file, JSON.stringify(rows));
  const readBack = JSON.parse(readFileSync(file, "utf8")) as unknown[];
  if (readBack.length !== rows.length) {
    throw new Error(`${tablename}: wrote ${rows.length} rows but read back ${readBack.length}`);
  }
  counts[tablename] = rows.length;
}
writeFileSync(join(dir, "counts.json"), JSON.stringify(counts, null, 2));
console.log(`Backed up ${tables.length} tables to ${dir}`);
for (const [table, n] of Object.entries(counts)) console.log(`  ${table}: ${n}`);
await sql.end();
```

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/backup-db.ts "C:/Users/tasin/mailnerd-backups"`

Expected: `Backed up 13 tables to C:\Users\tasin\mailnerd-backups\mailnerd-<timestamp>`, with these counts (taken 2026-09-18; a small difference is fine if you changed data since, but `users` must be 1):

```
cloudflare_zones: 77  dns_records: 940  domain_batches: 6  domain_plans: 29  domains: 29
health_history: 306  job_templates: 1  planned_inboxes: 645  rate_limits: 0  server_health: 28
servers: 0  user_secrets: 1  users: 1
```

- [ ] **Step 3: Commit** (the script only, never the backup)

```bash
git add scripts/backup-db.ts
git commit -m "chore(db): script to back up every public table before schema changes"
```

---

### Task 2: Accounts migration (additive) and schema

**Files:**
- Create: `supabase/migrations/20260918100000_user_accounts.sql`
- Create: `scripts/migrate-user-accounts.ts`
- Modify: `src/lib/db/schema.ts:5-11` (the `users` table)

**Interfaces:**
- Consumes: the `counts.json` from Task 1.
- Produces: `users` columns `name`, `password_hash`, `role`, `status`, `plan_name`, `plan_ends_at`, `activated_at`, `last_sign_in_at`, `session_version`. Drizzle fields: `name`, `passwordHash`, `role`, `status`, `planName`, `planEndsAt`, `activatedAt`, `lastSignInAt`, `sessionVersion`. Every later task uses these names.

- [ ] **Step 1: Write the SQL (idempotent)**

`supabase/migrations/20260918100000_user_accounts.sql`:

```sql
-- User accounts: sign-up, admin approval and plans (docs/superpowers/specs/2026-09-18-user-accounts-design.md).
-- Additive and idempotent. The release before accounts ignores these columns, so this runs before deploying.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS plan_name text,
  ADD COLUMN IF NOT EXISTS plan_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'user'));
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE public.users ADD CONSTRAINT users_status_check CHECK (status IN ('pending', 'active', 'suspended'));

-- Exactly one admin, and emails unique regardless of case.
CREATE UNIQUE INDEX IF NOT EXISTS users_single_admin ON public.users (role) WHERE role = 'admin';
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON public.users (lower(email));

-- The internal record that owns all existing data becomes the Nextus admin account. Same id, so no row moves.
UPDATE public.users
SET role = 'admin', status = 'active', name = COALESCE(name, 'Nextus'), activated_at = COALESCE(activated_at, now())
WHERE email = 'admin@smtpforge.local';

-- Nobody holding Supabase's public anon key may read or change these tables (password hashes, SSH passwords).
-- The app connects as the table owner with BYPASSRLS, so it is unaffected. Undo per table:
--   ALTER TABLE public.<name> DISABLE ROW LEVEL SECURITY;
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
```

- [ ] **Step 2: Write the apply script**

`scripts/migrate-user-accounts.ts`:

```ts
// Applies supabase/migrations/20260918100000_user_accounts.sql in one transaction (safe to re-run), then
// checks every table still has the rows the backup recorded.
//
//   npx tsx scripts/migrate-user-accounts.ts --compare <backup-dir>/counts.json
//   npx tsx scripts/migrate-user-accounts.ts --set-admin-email you@example.com     (after deploying)
//
// --set-admin-email renames the admin row to the live ADMIN_EMAIL. Run it only AFTER the accounts release is
// deployed: the release before it finds its data by the old internal email, and would create an empty
// account if that email disappeared.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const repo = fileURLToPath(new URL("..", import.meta.url));
process.loadEnvFile(join(repo, ".env"));

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

let url = process.env.DATABASE_URL ?? "";
if (url.includes("#") && !url.includes("%23")) url = url.replace(/#/, "%23");
const sql = postgres(url, { prepare: false, max: 1, ssl: "require" });

const adminEmail = flag("--set-admin-email");
if (adminEmail) {
  const email = adminEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Not an email address: ${adminEmail}`);
  const clash = await sql`select id from public.users where lower(email) = ${email} and role <> 'admin'`;
  if (clash.length) throw new Error(`Another account already uses ${email}; not renaming the admin.`);
  const updated = await sql`update public.users set email = ${email} where role = 'admin' returning id`;
  console.log(updated.length === 1 ? `Admin account now uses ${email}.` : "No admin row found: run the migration first.");
} else {
  const migration = readFileSync(join(repo, "supabase/migrations/20260918100000_user_accounts.sql"), "utf8");
  await sql.begin(async (tx) => {
    await tx.unsafe(migration);
  });
  console.log("Migration applied.");
}

const [admin] = await sql`select id, email, name, role, status from public.users where role = 'admin'`;
console.log(`Admin row: ${admin ? `${admin.id} (${admin.name}, ${admin.status})` : "MISSING"}`);

const comparePath = flag("--compare");
if (comparePath) {
  const expected = JSON.parse(readFileSync(comparePath, "utf8")) as Record<string, number>;
  let mismatches = 0;
  for (const [table, n] of Object.entries(expected)) {
    const [{ count }] = await sql.unsafe(`select count(*)::int as count from public."${table}"`);
    const ok = count === n;
    if (!ok) mismatches++;
    console.log(`${ok ? "ok  " : "DIFF"} ${table}: backup ${n}, now ${count}`);
  }
  if (mismatches) {
    await sql.end();
    throw new Error(`${mismatches} table(s) differ from the backup.`);
  }
}
const rls = await sql`select count(*)::int as off from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`;
console.log(`Tables without row level security: ${rls[0].off}`);
await sql.end();
```

- [ ] **Step 3: Apply it and compare with the backup**

Run: `npx tsx scripts/migrate-user-accounts.ts --compare "C:/Users/tasin/mailnerd-backups/<backup-dir>/counts.json"`

Expected:
- `Migration applied.`
- `Admin row: aa64be25-9b8c-40d0-9671-4e8ffa345622 (Nextus, active)`
- every line starts with `ok`
- `Tables without row level security: 0`

Run it a second time and expect the same output (it's idempotent).

- [ ] **Step 4: Update the Drizzle schema**

In `src/lib/db/schema.ts`, replace the `users` table (lines 5-11) with:

```ts
export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  // Accounts (supabase/migrations/20260918100000_user_accounts.sql). The admin signs in with ADMIN_EMAIL /
  // ADMIN_PASSWORD from the environment, so its password_hash stays null.
  name: text("name"),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"), // 'admin' | 'user'
  status: text("status").notNull().default("pending"), // 'pending' | 'active' | 'suspended'
  planName: text("plan_name"),
  planEndsAt: timestamp("plan_ends_at", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
  // Bumped on password reset/change and suspension: every session issued before it stops working.
  sessionVersion: integer("session_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Run: `npx tsc --noEmit`. Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260918100000_user_accounts.sql scripts/migrate-user-accounts.ts src/lib/db/schema.ts
git commit -m "feat(accounts): additive users migration, Nextus admin row, row level security"
```

---

### Task 3: Plan arithmetic

**Files:**
- Create: `src/lib/plans.ts`
- Test: `src/lib/__tests__/plans.test.ts`

**Interfaces:**
- Produces:
  - `PLAN_PRESETS: readonly { id: "trial-7d"|"1m"|"3m"|"6m"|"12m"; label: string; days?: number; months?: number }[]`
  - `type PlanPresetId`
  - `type PlanChoice = { preset: PlanPresetId } | { days: number } | { months: number } | { until: string }` (`until` is an ISO timestamp)
  - `planFor(choice: PlanChoice, currentEnd: Date | string | null | undefined, nowMs?: number): { endsAt: Date; label: string }`. It throws an `Error` whose message is shown to the admin.
  - `daysLeft(planEndsAt: Date | string | null | undefined, nowMs?: number): number`
  - `addMonths(date: Date, months: number): Date`
  - `DAY_MS`, `MAX_PLAN_DAYS = 3660`, `MAX_PLAN_MONTHS = 120`
  - The module is browser-safe (no imports).

- [ ] **Step 1: Write the failing tests**

`src/lib/__tests__/plans.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { addMonths, daysLeft, planFor, DAY_MS, PLAN_PRESETS } from "../plans";

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

describe("addMonths", () => {
  it("keeps the day of the month", () => {
    expect(addMonths(new Date(Date.UTC(2026, 0, 15)), 1).toISOString()).toBe("2026-02-15T00:00:00.000Z");
  });
  it("uses the last day of a shorter month", () => {
    expect(addMonths(new Date(Date.UTC(2026, 0, 31)), 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(addMonths(new Date(Date.UTC(2028, 0, 31)), 1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
  it("crosses into the next year", () => {
    expect(addMonths(new Date(Date.UTC(2026, 10, 30)), 3).toISOString()).toBe("2027-02-28T00:00:00.000Z");
  });
});

describe("planFor", () => {
  it("starts a new account's plan now", () => {
    expect(planFor({ preset: "trial-7d" }, null, NOW)).toEqual({
      endsAt: new Date(NOW + 7 * DAY_MS),
      label: "7-day trial",
    });
  });

  it("adds time to the end of a plan that is still running", () => {
    const current = new Date(NOW + 10 * DAY_MS);
    expect(planFor({ days: 5 }, current, NOW)).toEqual({ endsAt: new Date(NOW + 15 * DAY_MS), label: "Custom: 5 days" });
  });

  it("restarts an ended plan from now", () => {
    const ended = new Date(NOW - 3 * DAY_MS).toISOString();
    expect(planFor({ preset: "1m" }, ended, NOW)).toEqual({ endsAt: addMonths(new Date(NOW), 1), label: "1 month" });
  });

  it("adds calendar months for a custom length", () => {
    expect(planFor({ months: 2 }, null, NOW)).toEqual({ endsAt: addMonths(new Date(NOW), 2), label: "Custom: 2 months" });
    expect(planFor({ days: 1 }, null, NOW).label).toBe("Custom: 1 day");
    expect(planFor({ months: 1 }, null, NOW).label).toBe("Custom: 1 month");
  });

  it("sets an exact end date, which must be in the future", () => {
    const until = new Date(Date.UTC(2026, 11, 31, 23, 59, 59)).toISOString();
    expect(planFor({ until }, null, NOW)).toEqual({ endsAt: new Date(until), label: "Until 2026-12-31" });
    expect(() => planFor({ until: new Date(NOW - 1000).toISOString() }, null, NOW)).toThrow(/future/);
    expect(() => planFor({ until: "not a date" }, null, NOW)).toThrow(/valid end date/);
  });

  it("refuses lengths that aren't whole numbers in range", () => {
    expect(() => planFor({ days: 0 }, null, NOW)).toThrow(/Days/);
    expect(() => planFor({ days: 1.5 }, null, NOW)).toThrow(/Days/);
    expect(() => planFor({ days: 3661 }, null, NOW)).toThrow(/Days/);
    expect(() => planFor({ months: 121 }, null, NOW)).toThrow(/Months/);
  });

  it("gives every preset a later end date than now", () => {
    for (const preset of PLAN_PRESETS) {
      expect(planFor({ preset: preset.id }, null, NOW).endsAt.getTime()).toBeGreaterThan(NOW);
    }
  });
});

describe("daysLeft", () => {
  it("rounds partial days up and is 0 once ended", () => {
    expect(daysLeft(null, NOW)).toBe(0);
    expect(daysLeft(new Date(NOW - 1), NOW)).toBe(0);
    expect(daysLeft(new Date(NOW + 1.2 * DAY_MS), NOW)).toBe(2);
    expect(daysLeft(new Date(NOW + 3 * DAY_MS).toISOString(), NOW)).toBe(3);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npx vitest run src/lib/__tests__/plans.test.ts`. Expected: FAIL, `Failed to resolve import "../plans"`.

- [ ] **Step 3: Implement**

`src/lib/plans.ts`:

```ts
// Plans: how long an account may use the app. Pure and browser-safe: the admin panel previews the end date
// with the same function the server (src/server/admin-users.ts) uses to store it.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_PLAN_DAYS = 3660;
export const MAX_PLAN_MONTHS = 120;

export const PLAN_PRESETS = [
  { id: "trial-7d", label: "7-day trial", days: 7 },
  { id: "1m", label: "1 month", months: 1 },
  { id: "3m", label: "3 months", months: 3 },
  { id: "6m", label: "6 months", months: 6 },
  { id: "12m", label: "1 year", months: 12 },
] as const;

export type PlanPresetId = (typeof PLAN_PRESETS)[number]["id"];
export type PlanChoice = { preset: PlanPresetId } | { days: number } | { months: number } | { until: string };

/** `months` calendar months after `date` (UTC): the same day, or the month's last day when it's shorter. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * When a plan choice ends, and the name to show for it. A length is added to the current end while that plan
 * is still running (extending never loses paid-for time), otherwise it starts now. An exact date is used as
 * given. Throws an Error with a message fit to show the admin.
 */
export function planFor(
  choice: PlanChoice,
  currentEnd: Date | string | null | undefined,
  nowMs: number = Date.now(),
): { endsAt: Date; label: string } {
  if ("until" in choice) {
    const endsAt = new Date(choice.until);
    if (!Number.isFinite(endsAt.getTime())) throw new Error("Pick a valid end date.");
    if (endsAt.getTime() <= nowMs) throw new Error("The end date must be in the future.");
    return { endsAt, label: `Until ${endsAt.toISOString().slice(0, 10)}` };
  }

  const current = currentEnd ? new Date(currentEnd).getTime() : NaN;
  const base = new Date(Number.isFinite(current) && current > nowMs ? current : nowMs);

  if ("preset" in choice) {
    const preset = PLAN_PRESETS.find((p) => p.id === choice.preset);
    if (!preset) throw new Error("Unknown plan.");
    const endsAt = "days" in preset ? new Date(base.getTime() + preset.days * DAY_MS) : addMonths(base, preset.months);
    return { endsAt, label: preset.label };
  }
  if ("days" in choice) {
    const { days } = choice;
    if (!Number.isInteger(days) || days < 1 || days > MAX_PLAN_DAYS) {
      throw new Error(`Days must be a whole number from 1 to ${MAX_PLAN_DAYS}.`);
    }
    return { endsAt: new Date(base.getTime() + days * DAY_MS), label: `Custom: ${plural(days, "day")}` };
  }
  const { months } = choice;
  if (!Number.isInteger(months) || months < 1 || months > MAX_PLAN_MONTHS) {
    throw new Error(`Months must be a whole number from 1 to ${MAX_PLAN_MONTHS}.`);
  }
  return { endsAt: addMonths(base, months), label: `Custom: ${plural(months, "month")}` };
}

/** Whole days left on a plan, rounded up; 0 once it has ended (or if there is none). */
export function daysLeft(planEndsAt: Date | string | null | undefined, nowMs: number = Date.now()): number {
  if (!planEndsAt) return 0;
  const ms = new Date(planEndsAt).getTime() - nowMs;
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / DAY_MS) : 0;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/__tests__/plans.test.ts`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/plans.ts src/lib/__tests__/plans.test.ts
git commit -m "feat(accounts): plan presets and end-date arithmetic"
```

---

### Task 4: Accounts core (passwords, tokens, access, sign-up rules)

**Files:**
- Create: `src/server/accounts-core.ts`
- Test: `src/server/__tests__/accounts-core.test.ts`

**Interfaces:**
- Consumes: `createLoginThrottle`, `SESSION_TTL_SECONDS` and `type AuthConfig` from `src/server/auth-core.ts`, which are unchanged.
- Produces:
  - Passwords: `hashPassword(password: string): Promise<string>`, `verifyPassword(password: string, stored: string | null | undefined): Promise<boolean>`, `burnPasswordCheck(password: string): Promise<void>`
  - Tokens: `type AccountClaims = { accountId: string; version: number; admin: boolean }`, `createAccountToken(claims: AccountClaims, config: AuthConfig, nowMs?: number): string`, `verifyAccountToken(token: string | null | undefined, config: AuthConfig, nowMs?: number): AccountClaims | null`
  - Account state: `type AccountState = "admin" | "pending" | "active" | "expired" | "suspended"`, `accountState(a: { role: string; status: string; planEndsAt: Date | string | null }, nowMs?: number): AccountState`
  - Access: `type AccessDenial = "pending" | "suspended" | "expired" | "missing"`, `type AccessResult = { ok: true } | { ok: false; reason: AccessDenial }`, `accessDecision(account: { role: string; status: string; planEndsAt: Date | string | null; sessionVersion: number } | null | undefined, claims: AccountClaims, nowMs?: number): AccessResult`
  - Workspace: `workspaceFor(account: { id: string; role: string }, requested: string | undefined, requestedExists: boolean): string`
  - Sign-up: `validateSignup(input: { name: string; email: string; password: string; confirmPassword: string }, adminEmail: string): { ok: true; value: { name: string; email: string; password: string } } | { ok: false; error: string }`, `validateNewPassword(password: string, confirmPassword: string): string | null`, `EMAIL_TAKEN`, `MIN_ACCOUNT_PASSWORD_LENGTH = 10`, `createSignupThrottle()` (same shape as `createLoginThrottle()`)
  - Other: `generateTempPassword(length?: number): string`, `sessionCookieOptions(secure: boolean): { httpOnly: true; sameSite: "lax"; secure: boolean; path: "/"; maxAge: number }`

- [ ] **Step 1: Write the failing tests**

`src/server/__tests__/accounts-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  accessDecision,
  accountState,
  burnPasswordCheck,
  createAccountToken,
  createSignupThrottle,
  EMAIL_TAKEN,
  generateTempPassword,
  hashPassword,
  sessionCookieOptions,
  validateNewPassword,
  validateSignup,
  verifyAccountToken,
  verifyPassword,
  workspaceFor,
} from "../accounts-core";
import { createSessionToken, SESSION_TTL_SECONDS } from "../auth-core";

const config = { email: "owner@example.com", password: "admin-password-123", secret: "s".repeat(40) };
const NOW = Date.UTC(2026, 8, 18, 12);
const DAY = 24 * 60 * 60 * 1000;

describe("password hashing", () => {
  it("verifies the right password and refuses a wrong one", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password")).not.toBe(await hashPassword("same password"));
  });

  it("refuses missing or malformed hashes instead of throwing", async () => {
    for (const bad of [null, undefined, "", "scrypt$x", "bcrypt$1$2$3$4$5", "scrypt$99999999$8$1$AAAA$AAAA"]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });

  it("burns time on a check for an unknown account without throwing", async () => {
    await expect(burnPasswordCheck("whatever")).resolves.toBeUndefined();
  });
});

describe("account tokens", () => {
  const user = { accountId: "user-1", version: 3, admin: false };
  const admin = { accountId: "admin-1", version: 1, admin: true };

  it("round-trips user and admin claims", () => {
    expect(verifyAccountToken(createAccountToken(user, config, NOW), config, NOW)).toEqual(user);
    expect(verifyAccountToken(createAccountToken(admin, config, NOW), config, NOW)).toEqual(admin);
  });

  it("expires after the session lifetime", () => {
    const token = createAccountToken(user, config, NOW);
    expect(verifyAccountToken(token, config, NOW + SESSION_TTL_SECONDS * 1000 + 1)).toBeNull();
  });

  it("rejects tampering, other secrets and the old admin-only token format", () => {
    const token = createAccountToken(user, config, NOW);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "admin-1", v: 1, x: 9e9, a: "x" })).toString("base64url");
    expect(verifyAccountToken(`${forged}.${sig}`, config, NOW)).toBeNull();
    expect(verifyAccountToken(`${payload}.${sig}x`, config, NOW)).toBeNull();
    expect(verifyAccountToken(token, { ...config, secret: "t".repeat(40) }, NOW)).toBeNull();
    expect(verifyAccountToken(createSessionToken(config, NOW), config, NOW)).toBeNull();
    expect(verifyAccountToken(null, config, NOW)).toBeNull();
  });

  it("signs the admin out when ADMIN_PASSWORD changes, but not users", () => {
    const changed = { ...config, password: "a-new-admin-password" };
    expect(verifyAccountToken(createAccountToken(admin, config, NOW), changed, NOW)).toBeNull();
    expect(verifyAccountToken(createAccountToken(user, config, NOW), changed, NOW)).toEqual(user);
  });
});

describe("accountState and accessDecision", () => {
  const future = new Date(NOW + DAY);
  const past = new Date(NOW - DAY);
  const row = (over: Partial<{ role: string; status: string; planEndsAt: Date | null; sessionVersion: number }>) => ({
    role: "user",
    status: "active",
    planEndsAt: future as Date | null,
    sessionVersion: 1,
    ...over,
  });
  const userClaims = { accountId: "u", version: 1, admin: false };

  it("names each state", () => {
    expect(accountState(row({ role: "admin", status: "active", planEndsAt: null }), NOW)).toBe("admin");
    expect(accountState(row({ status: "pending" }), NOW)).toBe("pending");
    expect(accountState(row({ status: "suspended" }), NOW)).toBe("suspended");
    expect(accountState(row({ status: "something-else" }), NOW)).toBe("suspended");
    expect(accountState(row({ planEndsAt: past }), NOW)).toBe("expired");
    expect(accountState(row({ planEndsAt: null }), NOW)).toBe("expired");
    expect(accountState(row({}), NOW)).toBe("active");
  });

  it("lets active users and the admin in", () => {
    expect(accessDecision(row({}), userClaims, NOW)).toEqual({ ok: true });
    expect(
      accessDecision(row({ role: "admin", planEndsAt: null }), { accountId: "a", version: 1, admin: true }, NOW),
    ).toEqual({ ok: true });
  });

  it("says why everyone else is refused", () => {
    expect(accessDecision(row({ status: "pending" }), userClaims, NOW)).toEqual({ ok: false, reason: "pending" });
    expect(accessDecision(row({ status: "suspended" }), userClaims, NOW)).toEqual({ ok: false, reason: "suspended" });
    expect(accessDecision(row({ planEndsAt: past }), userClaims, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("treats a missing account, an old session version or a role mismatch as signed out", () => {
    expect(accessDecision(null, userClaims, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(accessDecision(row({ sessionVersion: 2 }), userClaims, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(accessDecision(row({}), { ...userClaims, admin: true }, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(accessDecision(row({ role: "admin" }), userClaims, NOW)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("workspaceFor", () => {
  it("keeps a user in their own workspace whatever they ask for", () => {
    expect(workspaceFor({ id: "u1", role: "user" }, "u2", true)).toBe("u1");
  });
  it("opens the workspace the admin picked, if it exists", () => {
    expect(workspaceFor({ id: "a", role: "admin" }, "u2", true)).toBe("u2");
    expect(workspaceFor({ id: "a", role: "admin" }, "gone", false)).toBe("a");
    expect(workspaceFor({ id: "a", role: "admin" }, undefined, false)).toBe("a");
  });
});

describe("validateSignup", () => {
  const good = { name: "  Alice   Smith ", email: " Alice@Example.COM ", password: "long-enough-1", confirmPassword: "long-enough-1" };

  it("tidies the name and lower-cases the email", () => {
    expect(validateSignup(good, config.email)).toEqual({
      ok: true,
      value: { name: "Alice Smith", email: "alice@example.com", password: "long-enough-1" },
    });
  });

  it("explains what's wrong", () => {
    expect(validateSignup({ ...good, name: "  " }, config.email)).toMatchObject({ ok: false, error: /name/ });
    expect(validateSignup({ ...good, email: "not-an-email" }, config.email)).toMatchObject({ ok: false, error: /valid email/ });
    expect(validateSignup({ ...good, password: "short", confirmPassword: "short" }, config.email)).toMatchObject({
      ok: false,
      error: /at least 10/,
    });
    expect(validateSignup({ ...good, confirmPassword: "different-1" }, config.email)).toMatchObject({
      ok: false,
      error: /don't match/,
    });
  });

  it("refuses the admin's email as if it were taken", () => {
    expect(validateSignup({ ...good, email: "OWNER@example.com" }, config.email)).toEqual({ ok: false, error: EMAIL_TAKEN });
  });

  it("checks a new password on its own", () => {
    expect(validateNewPassword("long-enough-1", "long-enough-1")).toBeNull();
    expect(validateNewPassword("short", "short")).toMatch(/at least 10/);
    expect(validateNewPassword("long-enough-1", "long-enough-2")).toMatch(/don't match/);
  });
});

describe("generateTempPassword", () => {
  it("makes 16 unambiguous characters, different each time", () => {
    const a = generateTempPassword();
    expect(a).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);
    expect(generateTempPassword()).not.toBe(a);
  });
});

describe("createSignupThrottle", () => {
  it("allows 5 sign-ups per client per hour", () => {
    const throttle = createSignupThrottle();
    for (let i = 0; i < 5; i++) throttle.recordFailure("203.0.113.9", NOW);
    expect(throttle.retryAfterMs("203.0.113.9", NOW)).toBeGreaterThan(0);
    expect(throttle.retryAfterMs("203.0.113.10", NOW)).toBe(0);
    expect(throttle.retryAfterMs("203.0.113.9", NOW + 60 * 60_000)).toBe(0);
  });

  it("allows 50 sign-ups per hour from everyone together", () => {
    const throttle = createSignupThrottle();
    for (let i = 0; i < 50; i++) throttle.recordFailure(`198.51.100.${i}`, NOW);
    expect(throttle.retryAfterMs("192.0.2.1", NOW)).toBeGreaterThan(0);
  });
});

describe("sessionCookieOptions", () => {
  it("is httpOnly, lax, site-wide, and Secure only over HTTPS", () => {
    expect(sessionCookieOptions(true)).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: SESSION_TTL_SECONDS });
    expect(sessionCookieOptions(false).secure).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npx vitest run src/server/__tests__/accounts-core.test.ts`. Expected: FAIL, `Failed to resolve import "../accounts-core"`.

- [ ] **Step 3: Implement**

`src/server/accounts-core.ts`:

```ts
import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { createLoginThrottle, SESSION_TTL_SECONDS, type AuthConfig } from "./auth-core";

// Accounts: password hashing, the session token that names an account, who may use the app right now, and
// the sign-up rules. Leaf module (node:crypto + auth-core) so tests load it without the framework. Server only.

// ---------- passwords ----------

export const MIN_ACCOUNT_PASSWORD_LENGTH = 10;
const MAX_ACCOUNT_PASSWORD_LENGTH = 200;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

function scryptAsync(password: string, salt: Buffer, keylen: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `scrypt$N$r$p$<salt>$<hash>`, with a fresh 16-byte salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT.N, SCRYPT.r, SCRYPT.p);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

/** Whether `password` matches a stored hash. False for a missing or malformed hash; never throws. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 1 << 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await scryptAsync(password, salt, expected.length, N, r, p);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// A sign-in for an email nobody has still does one scrypt, so response times don't reveal which emails exist.
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("not a real account password");
  await verifyPassword(password, await dummyHash);
}

const TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
/** A temporary password the admin hands out after a reset: no look-alike characters (0/O, 1/l/I). */
export function generateTempPassword(length = 16): string {
  return Array.from({ length }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join("");
}

// ---------- session token ----------

export type AccountClaims = { accountId: string; version: number; admin: boolean };

function signingKey(config: AuthConfig): Buffer {
  return createHmac("sha256", config.secret).update("account-session-v2").digest();
}
// An admin token carries this, so changing ADMIN_PASSWORD still signs the admin out (users are signed out by
// bumping their session_version instead).
function adminFingerprint(config: AuthConfig): string {
  return createHmac("sha256", config.secret).update(`admin-password:${config.password}`).digest("base64url").slice(0, 22);
}
function sign(payload: string, config: AuthConfig): string {
  return createHmac("sha256", signingKey(config)).update(payload).digest("base64url");
}

export function createAccountToken(claims: AccountClaims, config: AuthConfig, nowMs = Date.now()): string {
  const body: Record<string, unknown> = {
    u: claims.accountId,
    v: claims.version,
    x: Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS,
  };
  if (claims.admin) body.a = adminFingerprint(config);
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${sign(payload, config)}`;
}

/** The claims of a valid token, or null for a missing, forged, expired or old-format one. Never throws. */
export function verifyAccountToken(
  token: string | null | undefined,
  config: AuthConfig,
  nowMs = Date.now(),
): AccountClaims | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(payload, config), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { u, v, x, a } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof u !== "string" || !u || !Number.isInteger(v) || typeof x !== "number") return null;
    if (x * 1000 <= nowMs) return null;
    if (a !== undefined && a !== adminFingerprint(config)) return null;
    return { accountId: u, version: v, admin: a !== undefined };
  } catch {
    return null;
  }
}

export function sessionCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: SESSION_TTL_SECONDS } as const;
}

// ---------- who may use the app ----------

export type AccountState = "admin" | "pending" | "active" | "expired" | "suspended";
export type AccessDenial = "pending" | "suspended" | "expired" | "missing";
export type AccessResult = { ok: true } | { ok: false; reason: AccessDenial };

type StateFields = { role: string; status: string; planEndsAt: Date | string | null };

export function accountState(account: StateFields, nowMs = Date.now()): AccountState {
  if (account.role === "admin") return "admin";
  if (account.status === "pending") return "pending";
  if (account.status !== "active") return "suspended";
  const ends = account.planEndsAt ? new Date(account.planEndsAt).getTime() : NaN;
  return Number.isFinite(ends) && ends > nowMs ? "active" : "expired";
}

/**
 * Whether a session may use the app. "missing" means treat it as signed out: the account is gone, its session
 * version moved on (password reset, suspension), or an admin token is used for a user row or the other way
 * round. The admin is never locked out.
 */
export function accessDecision(
  account: (StateFields & { sessionVersion: number }) | null | undefined,
  claims: AccountClaims,
  nowMs = Date.now(),
): AccessResult {
  if (!account || account.sessionVersion !== claims.version) return { ok: false, reason: "missing" };
  if (claims.admin !== (account.role === "admin")) return { ok: false, reason: "missing" };
  const state = accountState(account, nowMs);
  return state === "admin" || state === "active" ? { ok: true } : { ok: false, reason: state };
}

/** Whose data a request works on: a user always their own; the admin the workspace they picked, if it exists. */
export function workspaceFor(account: { id: string; role: string }, requested: string | undefined, requestedExists: boolean): string {
  return account.role === "admin" && requested && requestedExists ? requested : account.id;
}

// ---------- sign-up ----------

export const EMAIL_TAKEN = "An account with this email already exists.";

export function validateNewPassword(password: string, confirmPassword: string): string | null {
  if (password.length < MIN_ACCOUNT_PASSWORD_LENGTH) {
    return `Use a password of at least ${MIN_ACCOUNT_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_ACCOUNT_PASSWORD_LENGTH) {
    return `Use a password of at most ${MAX_ACCOUNT_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirmPassword) return "The passwords don't match.";
  return null;
}

export function validateSignup(
  input: { name: string; email: string; password: string; confirmPassword: string },
  adminEmail: string,
): { ok: true; value: { name: string; email: string; password: string } } | { ok: false; error: string } {
  const name = input.name.trim().replace(/\s+/g, " ");
  const email = input.email.trim().toLowerCase();
  if (!name || name.length > 80) return { ok: false, error: "Enter your name (up to 80 characters)." };
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  const passwordError = validateNewPassword(input.password, input.confirmPassword);
  if (passwordError) return { ok: false, error: passwordError };
  if (email === adminEmail.trim().toLowerCase()) return { ok: false, error: EMAIL_TAKEN };
  return { ok: true, value: { name, email, password: input.password } };
}

/** Counts sign-ups (call recordFailure for each one): 5 per client and 50 in total per hour. */
export function createSignupThrottle() {
  return createLoginThrottle({ maxFailures: 5, maxGlobalFailures: 50, windowMs: 60 * 60_000 });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/server/__tests__/accounts-core.test.ts`. Expected: all pass (the scrypt tests take about a second).

- [ ] **Step 5: Commit**

```bash
git add src/server/accounts-core.ts src/server/__tests__/accounts-core.test.ts
git commit -m "feat(accounts): scrypt passwords, account session tokens, access decision, sign-up rules"
```

---

### Task 5: Session resolution, middleware and the live-log stream

**Files:**
- Create: `src/server/accounts-db.ts`
- Modify: `src/lib/auth.ts` (whole file)
- Modify: `src/server/sse-node.ts:1-111` (session and domain check)
- Modify: `src/lib/providers.tsx:5-12`
- Modify: `src/lib/db/index.ts` (`max: 1` in the `postgres(...)` options)

**Interfaces:**
- Consumes: Task 4 (`verifyAccountToken`, `accessDecision`, `accountState`, `workspaceFor`, `AccountState`) and Task 2 (the schema fields).
- Produces:
  - `type Account = typeof users.$inferSelect`
  - `WORKSPACE_COOKIE = "mn_workspace"`, `LEGACY_ADMIN_EMAIL`
  - `findAdminAccount(db): Promise<Account | null>`, `ensureAdminAccount(db, adminEmail: string): Promise<Account>`
  - `type PublicAccount = { id: string; name: string; email: string; role: "admin" | "user"; status: string; state: AccountState; planName: string | null; planEndsAt: string | null; createdAt: string; lastSignInAt: string | null }`, `publicAccount(a: Account, nowMs?: number): PublicAccount`
  - `countPendingSignups(db): Promise<number>`
  - `type SessionResult = { state: "signed-out" } | { state: "locked"; reason: "pending" | "suspended" | "expired"; account: Account } | { state: "ok"; account: Account; isAdmin: boolean; workspaceId: string }`, `resolveSession(db, token: string | undefined, workspaceCookie: string | undefined, config: AuthConfig, nowMs?: number): Promise<SessionResult>`
  - `requireAuth` context: `{ db, userId /* workspace id */, user: Account, accountId: string, isAdmin: boolean }`
  - `requireAdmin`: middleware that refuses non-admins with `FORBIDDEN: only the admin can do this.`

- [ ] **Step 1: Write `src/server/accounts-db.ts`**

```ts
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
```

- [ ] **Step 2: Rewrite `src/lib/auth.ts`**

```ts
import { createMiddleware } from "@tanstack/react-start";

// Runs before every server function except sign-in/sign-up (src/server/session.ts).
// - A call another site made is refused with FORBIDDEN (see crossSiteServerFnReason in src/server/auth-core.ts).
// - Without a valid session the error says UNAUTHENTICATED, and the browser (src/lib/providers.tsx) goes to
//   sign-in. A pending, suspended or expired account gets ACCOUNT_LOCKED and goes to /account.
// - context.userId is the WORKSPACE every query scopes by: a user's own id, or for the admin the workspace
//   picked with the switcher (the Nextus workspace by default). context.accountId is who is signed in.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const requireAuth = createMiddleware().server(async ({ next }: any) => {
  // Imported inside the server-only callback so none of it can end up in the browser bundle.
  const [
    { getCookie, getRequest },
    { readAuthConfig, SESSION_COOKIE, crossSiteServerFnReason, CROSS_SITE_ERROR },
    { resolveSession, WORKSPACE_COOKIE },
    { getDb },
  ] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("../server/auth-core"),
    import("../server/accounts-db"),
    import("./db"),
  ]);

  // For a page render this is the page's request, which is never refused; for an HTTP call it's the
  // server-function request itself.
  const crossSite = crossSiteServerFnReason(getRequest());
  if (crossSite) {
    console.warn(`Refused a server function call from another site: ${crossSite}`);
    throw new Error(CROSS_SITE_ERROR);
  }

  const auth = readAuthConfig(process.env);
  if (!auth.ok) throw new Error("UNAUTHENTICATED: sign in to continue.");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let session: Awaited<ReturnType<typeof resolveSession>>;
  try {
    db = getDb();
    session = await resolveSession(db, getCookie(SESSION_COOKIE), getCookie(WORKSPACE_COOKIE), auth.config);
  } catch (error) {
    console.error("requireAuth: couldn't check the session:", error instanceof Error ? error.message : error);
    throw new Error("The database isn't answering, so your session couldn't be checked. Try again in a moment.");
  }

  if (session.state === "signed-out") throw new Error("UNAUTHENTICATED: sign in to continue.");
  if (session.state === "locked") throw new Error(`ACCOUNT_LOCKED: ${session.reason}`);

  return next({
    context: {
      db,
      userId: session.workspaceId,
      user: session.account,
      accountId: session.account.id,
      isAdmin: session.isAdmin,
    },
  });
});

// For the admin panel's server functions: requireAuth, then only the admin may continue.
export const requireAdmin = createMiddleware()
  .middleware([requireAuth])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .server(async ({ next, context }: any) => {
    if (!context.isAdmin) throw new Error("FORBIDDEN: only the admin can do this.");
    return next();
  });
```

- [ ] **Step 3: Update `src/server/sse-node.ts`**

Replace the imports on lines 1-7 with:

```ts
import { domains } from "../lib/db/schema";
import { eq } from "drizzle-orm";
import { getDb } from "../lib/db";
import { jobEvents, inProcessProvisions } from "./events";
import { createRedis, waitForRedis } from "./redis";
import { consoleChannel } from "./console-bus";
import { readAuthConfig, readCookie, SESSION_COOKIE } from "./auth-core";
import { resolveSession, WORKSPACE_COOKIE } from "./accounts-db";
```

Delete the `DEFAULT_USER_EMAIL` constant and its comment (lines 46-47). Replace everything in `sseHandler` from `const url = ...` down to the end of the `catch (dbErr) { ... }` block (current lines 52-111) with:

```ts
  const url = new URL(req.url || "", "http://localhost");

  // The same session check every server function makes (requireAuth): these streams carry server output and
  // setup logs. EventSource sends the session cookie by itself on same-site requests.
  const auth = readAuthConfig(process.env);
  let workspaceId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  try {
    db = getDb();
    const session = auth.ok
      ? await resolveSession(
          db,
          readCookie(req.headers.cookie, SESSION_COOKIE),
          readCookie(req.headers.cookie, WORKSPACE_COOKIE),
          auth.config,
        )
      : ({ state: "signed-out" } as const);
    if (session.state !== "ok") {
      res.statusCode = session.state === "locked" ? 403 : 401;
      res.end(session.state === "locked" ? "Account locked" : "Sign in required");
      return;
    }
    workspaceId = session.workspaceId;
  } catch (dbErr) {
    console.error("Session check failed in SSE handler:", dbErr);
    if (!res.headersSent && !res.destroyed) {
      res.statusCode = 503;
      res.end("Database unavailable");
    }
    return;
  }

  // Troubleshoot console stream — no domain involved (the runId is an unguessable UUID the client made).
  const runId = url.searchParams.get("runId");
  if (runId) {
    streamConsole(runId, req, res);
    return;
  }

  const domainId = url.searchParams.get("domainId");
  if (!domainId) {
    res.statusCode = 400;
    res.end("Missing domainId or runId");
    return;
  }

  let domain;
  try {
    domain = await db.query.domains.findFirst({ where: eq(domains.id, domainId) });
  } catch (dbErr) {
    console.error("Domain lookup failed in SSE handler:", dbErr);
    if (!res.headersSent && !res.destroyed) {
      res.statusCode = 503;
      res.end("Database unavailable");
    }
    return;
  }
  // Only the workspace this session is in: a user's own domains, or the workspace the admin opened.
  if (!domain || domain.userId !== workspaceId) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
```

Leave the rest of the handler (from the `useRedis` comment onward) unchanged.

- [ ] **Step 4: Send locked accounts to `/account`**

In `src/lib/providers.tsx`, replace the `sendToSignInIfSignedOut` function (lines 5-12) with:

```ts
// Server functions refuse with UNAUTHENTICATED once the session is gone (it expired, you signed out in another
// tab, your password was reset) and ACCOUNT_LOCKED when the account is pending, suspended or out of plan. Go to
// sign-in or the account status page instead of a page of errors.
function sendToSignInIfSignedOut(error: unknown) {
  if (typeof window === "undefined") return;
  const message = String((error as { message?: unknown })?.message ?? "");
  if (message.includes("ACCOUNT_LOCKED")) {
    if (window.location.pathname !== "/account") window.location.assign("/account");
    return;
  }
  if (!message.includes("UNAUTHENTICATED")) return;
  if (window.location.pathname === "/auth") return;
  const back = window.location.pathname + window.location.search;
  window.location.assign(`/auth?redirect=${encodeURIComponent(back)}`);
}
```

- [ ] **Step 5: Let more than one request use the database at once**

In `src/lib/db/index.ts`, replace the line `      max: 1,` and the comment above it with:

```ts
      // Several people use the app at once now. It's one long-running server behind Supabase's
      // transaction pooler, so a small pool is safe (DB_POOL_MAX overrides it).
      max: Math.min(20, Math.max(1, Number(process.env.DB_POOL_MAX) || 5)),
```

- [ ] **Step 6: Typecheck and run all tests**

Run: `npx tsc --noEmit && npx vitest run`. Expected: tsc exits 0 and all tests pass. Sign-in itself breaks until Task 6: `login` still issues old tokens, which `requireAuth` now rejects. That's expected mid-plan.

- [ ] **Step 7: Commit**

```bash
git add src/server/accounts-db.ts src/lib/auth.ts src/server/sse-node.ts src/lib/providers.tsx src/lib/db/index.ts
git commit -m "feat(accounts): resolve sessions to an account and workspace; requireAdmin; scoped live logs"
```

---

### Task 6: Sign-in, sign-up, sign-out and password change

**Files:**
- Modify: `src/server/session.ts` (whole file)

**Interfaces:**
- Consumes: Tasks 4 and 5.
- Produces (browser-callable):
  - `getSession(): Promise<SessionInfo>`, where `SessionInfo = { authenticated: boolean; access: "ok" | "pending" | "suspended" | "expired" | null; account: PublicAccount | null; workspace: PublicAccount | null; pendingSignups: number; setupError: string | null }`. `workspace` is non-null only while the admin views another account's workspace.
  - `login({ data: { email, password } }): Promise<{ ok: boolean; error: string | null }>`
  - `signup({ data: { name, email, password, confirmPassword } }): Promise<{ ok: boolean; error: string | null }>`
  - `logout(): Promise<{ ok: true }>`
  - `changePassword({ data: { currentPassword, newPassword, confirmPassword } }): Promise<{ ok: boolean; error: string | null }>`

- [ ] **Step 1: Replace `src/server/session.ts`**

```ts
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

    const db = await database();
    const existing = await db.query.users.findFirst({ where: eq(users.email, checked.value.email), columns: { id: true } });
    if (existing) return { ok: false, error: EMAIL_TAKEN };

    signupThrottle.recordFailure(client); // counts this sign-up
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`. Expected: exit 0. If `src/routes/_app.tsx` or `src/routes/auth.tsx` fail on `session.email` or `userEmail`, leave them: Tasks 9 and 10 rewrite both. To keep this commit compiling, make `_app.tsx` `beforeLoad` return `{ userEmail: session.account?.email ?? "" }` for now.

- [ ] **Step 3: Run the tests**

Run: `npx vitest run`. Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/server/session.ts src/routes/_app.tsx
git commit -m "feat(accounts): sign-in for accounts and the admin, sign-up, password change"
```

---

### Task 7: Admin server functions

**Files:**
- Create: `src/server/admin-users.ts`

**Interfaces:**
- Consumes: `requireAdmin` (Task 5), `planFor`/`PLAN_PRESETS`/`PlanChoice` (Task 3), `generateTempPassword`/`hashPassword`/`sessionCookieOptions` (Task 4), `publicAccount`/`WORKSPACE_COOKIE`/`Account` (Task 5).
- Produces (browser-callable, admin only):
  - `listUsers(): Promise<(PublicAccount & { domains: number; jobs: number })[]>`: every account, the admin included, newest first
  - `applyPlan({ data: { userId: string; choice: PlanChoice } }): Promise<{ ok: boolean; error: string | null }>`: sets the plan, and activates a pending account
  - `setSuspended({ data: { userId: string; suspended: boolean } }): Promise<{ ok: boolean; error: string | null }>`
  - `resetUserPassword({ data: { userId: string } }): Promise<{ ok: boolean; error: string | null; password: string | null }>`
  - `rejectSignup({ data: { userId: string } }): Promise<{ ok: boolean; error: string | null }>`
  - `listWorkspaces(): Promise<{ id: string; name: string; email: string; role: "admin" | "user"; state: AccountState }[]>`
  - `setWorkspace({ data: { userId: string | null } }): Promise<{ ok: boolean; error: string | null }>`: null goes back to the admin's own workspace

- [ ] **Step 1: Write `src/server/admin-users.ts`**

```ts
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
```

- [ ] **Step 2: Typecheck and test**

Run: `npx tsc --noEmit && npx vitest run`. Expected: exit 0, all pass.

- [ ] **Step 3: Commit**

```bash
git add src/server/admin-users.ts
git commit -m "feat(accounts): admin functions to activate, extend, suspend, reset, reject and open workspaces"
```

---

### Task 8: Scope every server function to its workspace

The 2026-09-18 audit checked all 64 server functions:
- **Already correct: 59.** They load the parent record with `userId` before touching its children.
- **Fixed by Tasks 5-6:** `requireAuth` and `sse-node.ts` ignored who was signed in, and `session.ts` had no users table.
- **Four gaps left, fixed here:**
  - `createDnsRecord` could attach records to someone else's domain. The owner's Cloudflare token would later push them.
  - `deleteDomain` deleted another workspace's DNS records, mailboxes and plan before checking ownership.
  - `createDomainBatch` and `addDomainsWizardAction` link any template id.
- **Accepted as is:**
  - **Troubleshoot console stream (`/api/sse?runId=`):** it's keyed by a random UUID the browser generates, so it stays unguessable.
  - **`domains.name`:** stays unique across the whole app (spec §6).
  - **Queue worker:** acts for the domain's owner by design.

**Files:**
- Modify: `src/server/dns.ts:1-44`
- Modify: `src/server/domains.ts` (the imports; `deleteDomain`; the batch insert in `addDomainsWizardAction`)
- Modify: `src/server/jobs.ts:12-33`

**Interfaces:**
- Consumes: `context.userId` (the workspace id) from `requireAuth` (Task 5).
- Produces: no new names. Task 12's isolation check exercises every one of these.

- [ ] **Step 1: `createDnsRecord` only on the caller's own domain**

In `src/server/dns.ts` change the schema import to `import { dnsRecords, domains } from "@/lib/db/schema";`, and replace the body of `createDnsRecord`'s handler with:

```ts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    // Only on a domain in this workspace: records get pushed to the domain owner's Cloudflare zone.
    const owned = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
      columns: { id: true },
    });
    if (!owned) throw new Error("Domain not found");
    const [res] = await db
      .insert(dnsRecords)
      .values({
        userId,
        ...data,
        status: "pending",
      })
      .returning();
    return res;
```

- [ ] **Step 2: `deleteDomain` checks ownership before deleting anything**

In `src/server/domains.ts`, inside `deleteDomain`'s `try {`, insert before the first `await db.delete(dnsRecords)` line:

```ts
      // The child tables are keyed by domain id alone, so check the domain is in this workspace first.
      const owned = await db.query.domains.findFirst({
        where: and(eq(domains.id, data.id), eq(domains.userId, userId)),
        columns: { id: true },
      });
      if (!owned) return { ok: false, error: "Domain not found" };
```

- [ ] **Step 3: templates only from the caller's own workspace**

In `src/server/domains.ts`, add `jobTemplates,` to the `@/lib/db/schema` import list. In `addDomainsWizardAction`, directly before `const [batch] = await db`, add:

```ts
      // A template from another workspace is ignored rather than linked.
      const templateId = data.templateId
        ? ((
            await db.query.jobTemplates.findFirst({
              where: and(eq(jobTemplates.id, data.templateId), eq(jobTemplates.userId, userId)),
              columns: { id: true },
            })
          )?.id ?? null)
        : null;
```

Then change `templateId: data.templateId ?? null,` in that insert to `templateId,`.

In `src/server/jobs.ts`, inside `createDomainBatch`'s `try {`, before `const [res] = await db`, add:

```ts
      if (data.templateId) {
        const template = await db.query.jobTemplates.findFirst({
          where: and(eq(jobTemplates.id, data.templateId), eq(jobTemplates.userId, userId)),
          columns: { id: true },
        });
        if (!template) return { error: "Template not found" };
      }
```

- [ ] **Step 4: Typecheck and test**

Run: `npx tsc --noEmit && npx vitest run`. Expected: exit 0, all pass. These paths are verified end to end by Task 12.

- [ ] **Step 5: Commit**

```bash
git add src/server/dns.ts src/server/domains.ts src/server/jobs.ts
git commit -m "fix(accounts): DNS records, domain deletion and templates stay inside the caller's workspace"
```

---

### Task 9: Sign-in, sign-up and account status pages

**Files:**
- Create: `src/components/AuthShell.tsx`
- Create: `src/routes/signup.tsx`
- Create: `src/routes/account.tsx`
- Modify: `src/routes/auth.tsx` (whole file)
- Modify: `src/routeTree.gen.ts` (register `/signup` and `/account`)

**Interfaces:**
- Consumes: `getSession`, `login`, `signup` and `logout` from `@/server/session` (Task 6).
- Produces: routes `/signup` and `/account`, and `AuthShell({ children })`.

- [ ] **Step 1: Write `src/components/AuthShell.tsx`**

```tsx
import type { ReactNode } from "react";
import { Mail } from "lucide-react";

// The centred brand + card layout shared by sign-in, sign-up and the account status page.
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 font-sans text-foreground">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
            <Mail className="h-5 w-5" />
          </div>
          <div className="leading-tight">
            <div className="font-display text-base font-semibold tracking-tight">Mail Nerd</div>
            <div className="ident text-[10px] uppercase tracking-[0.18em] text-muted-foreground">control console</div>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">{children}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Replace `src/routes/auth.tsx`**

```tsx
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "@/components/AuthShell";
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
      // Full page load, so every page starts fresh with the new session. A pending or expired account is
      // sent on to /account by the app.
      window.location.assign(safeRedirectPath(redirectTo));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setPending(false);
    }
  }

  return (
    <AuthShell>
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
          <Input id="email" type="email" autoComplete="username" autoFocus required value={email}
            onChange={(e) => setEmail(e.target.value)} disabled={notSetUp || pending} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" required value={password}
            onChange={(e) => setPassword(e.target.value)} disabled={notSetUp || pending} />
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

      <p className="mt-5 text-center text-sm text-muted-foreground">
        New here?{" "}
        <Link to="/signup" className="font-medium text-primary hover:underline">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
```

- [ ] **Step 3: Write `src/routes/signup.tsx`**

```tsx
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
```

- [ ] **Step 4: Write `src/routes/account.tsx`**

```tsx
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
```

- [ ] **Step 5: Register the routes in `src/routeTree.gen.ts`**

Make these edits. The file is maintained by hand: the router plugin is disabled in `vite.config.ts`.

1. After `import { Route as AuthRouteImport } from './routes/auth'` add:
```ts
import { Route as SignupRouteImport } from './routes/signup'
import { Route as AccountRouteImport } from './routes/account'
```
2. After the `const AuthRoute = ... as any)` block add:
```ts
const SignupRoute = SignupRouteImport.update({
  id: '/signup',
  path: '/signup',
  getParentRoute: () => rootRouteImport,
} as any)
const AccountRoute = AccountRouteImport.update({
  id: '/account',
  path: '/account',
  getParentRoute: () => rootRouteImport,
} as any)
```
3. In `FileRoutesByFullPath`, `FileRoutesByTo` and `FileRoutesById` add, after each `'/auth': typeof AuthRoute` line:
```ts
  '/signup': typeof SignupRoute
  '/account': typeof AccountRoute
```
4. In `FileRouteTypes`, add `| '/signup'` and `| '/account'` after `| '/auth'` in each of `fullPaths`, `to` and `id`.
5. In `interface RootRouteChildren` add:
```ts
  SignupRoute: typeof SignupRoute
  AccountRoute: typeof AccountRoute
```
6. In `declare module '@tanstack/react-router'` → `interface FileRoutesByPath`, after the `'/auth': {...}` entry add:
```ts
    '/signup': {
      id: '/signup'
      path: '/signup'
      fullPath: '/signup'
      preLoaderRoute: typeof SignupRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/account': {
      id: '/account'
      path: '/account'
      fullPath: '/account'
      preLoaderRoute: typeof AccountRouteImport
      parentRoute: typeof rootRouteImport
    }
```
7. In `const rootRouteChildren` add `SignupRoute: SignupRoute,` and `AccountRoute: AccountRoute,`.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`. Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/components/AuthShell.tsx src/routes/auth.tsx src/routes/signup.tsx src/routes/account.tsx src/routeTree.gen.ts
git commit -m "feat(accounts): sign-up page, account status page, sign-in links to sign-up"
```

---

### Task 10: App shell (plan badge, admin nav, workspace switcher) and password change

**Files:**
- Create: `src/components/PlanBadge.tsx`
- Create: `src/components/WorkspaceSwitcher.tsx`
- Create: `src/components/ChangePasswordCard.tsx`
- Modify: `src/routes/_app.tsx` (whole file)
- Modify: `src/routes/_app.settings.tsx` (add the card below the page header)

**Interfaces:**
- Consumes:
  - `getSession`, `logout` and `changePassword` (Task 6)
  - `listWorkspaces` and `setWorkspace` (Task 7)
  - `daysLeft` (Task 3)
- Produces: route context for every `/_app/*` page: `{ account: PublicAccount; workspace: PublicAccount | null; pendingSignups: number }`. Task 11 relies on it: `/_app/admin` reads `context.account.role`.

- [ ] **Step 1: Write `src/components/PlanBadge.tsx`**

```tsx
import { daysLeft } from "@/lib/plans";
import { cn } from "@/lib/utils";

// "Plan ends in N days" for a user's own plan; amber in the last week.
export function PlanBadge({ planEndsAt, className }: { planEndsAt: string | null; className?: string }) {
  const days = daysLeft(planEndsAt);
  const text = days <= 1 ? "Plan ends within a day" : `Plan ends in ${days} days`;
  return (
    <span
      title={planEndsAt ? `Plan ends ${new Date(planEndsAt).toLocaleString()}` : undefined}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
        days <= 7 ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground",
        className,
      )}
    >
      {text}
    </span>
  );
}
```

- [ ] **Step 2: Write `src/components/WorkspaceSwitcher.tsx`**

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listWorkspaces, setWorkspace } from "@/server/admin-users";

// Admin only: pick whose workspace the app shows. Switching reloads the app so no cached data from the
// previous workspace survives.
export function WorkspaceSwitcher({ currentId }: { currentId: string }) {
  const { data: workspaces = [] } = useQuery({ queryKey: ["workspaces"], queryFn: () => listWorkspaces() });
  const [switching, setSwitching] = useState(false);

  const change = async (id: string) => {
    if (id === currentId) return;
    setSwitching(true);
    await setWorkspace({ data: { userId: id } });
    window.location.assign("/");
  };

  return (
    <div className="px-3 pb-2">
      <div className="ident mb-1 px-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Workspace</div>
      <Select value={currentId} onValueChange={change} disabled={switching}>
        <SelectTrigger className="h-10 w-full">
          <SelectValue placeholder="Workspace" />
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((w) => (
            <SelectItem key={w.id} value={w.id}>
              {w.name}
              {w.role === "admin" ? " (you)" : w.state !== "active" ? ` (${w.state})` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
```

- [ ] **Step 3: Write `src/components/ChangePasswordCard.tsx`**

```tsx
import { useState, type FormEvent } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePassword } from "@/server/session";

const EMPTY = { currentPassword: "", newPassword: "", confirmPassword: "" };

export function ChangePasswordCard() {
  const [form, setForm] = useState(EMPTY);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await changePassword({ data: form });
      if (!result.ok) {
        setError(result.error ?? "Couldn't change the password.");
        return;
      }
      setForm(EMPTY);
      toast.success("Password changed. You're signed out on your other devices.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the password.");
    } finally {
      setPending(false);
    }
  }

  const field = (key: keyof typeof EMPTY, label: string, autoComplete: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={key}>{label}</Label>
      <Input id={key} type="password" autoComplete={autoComplete} required value={form[key]} disabled={pending}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
    </div>
  );

  return (
    <div className="rounded-xl bg-card p-4 sm:p-8 shadow-sm ring-1 ring-border flex flex-col gap-6">
      <div className="flex items-center gap-3 border-b border-border pb-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <KeyRound className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-foreground">Password</h2>
          <p className="text-xs text-muted-foreground">Changing it signs you out on your other devices</p>
        </div>
      </div>
      <form onSubmit={onSubmit} className="grid gap-4 sm:max-w-sm">
        {field("currentPassword", "Current password", "current-password")}
        {field("newPassword", "New password (at least 10 characters)", "new-password")}
        {field("confirmPassword", "Confirm new password", "new-password")}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending} className="sm:w-fit">
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          Change password
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Replace `src/routes/_app.tsx`**

```tsx
import { useState } from "react";
import { createFileRoute, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { Globe, Server, Settings, Mail, FolderGit2, Stethoscope, LogOut, Menu, Users } from "lucide-react";
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
    await setWorkspace({ data: { userId: null } });
    window.location.assign("/");
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
```

- [ ] **Step 5: Add the card to Settings**

In `src/routes/_app.settings.tsx`:
- Add the import `import { ChangePasswordCard } from "@/components/ChangePasswordCard";`
- At the top of `function SettingsPage() {` add `const { account } = Route.useRouteContext();`
- Directly after the header block

```tsx
      <div>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Configure your API integrations</p>
      </div>
```

insert:

```tsx
      {account.role !== "admin" && <ChangePasswordCard />}
```

- [ ] **Step 6: Typecheck and test**

Run: `npx tsc --noEmit && npx vitest run`. Expected: exit 0, all pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/PlanBadge.tsx src/components/WorkspaceSwitcher.tsx src/components/ChangePasswordCard.tsx src/routes/_app.tsx src/routes/_app.settings.tsx
git commit -m "feat(accounts): plan badge, admin Users nav with pending count, workspace switcher, password change"
```

---

### Task 11: Admin Users page

**Files:**
- Create: `src/components/admin/PlanDialog.tsx`
- Create: `src/components/admin/TempPasswordDialog.tsx`
- Create: `src/routes/_app.admin.tsx`
- Modify: `src/routeTree.gen.ts` (register `/_app/admin`)

**Interfaces:**
- Consumes: `listUsers`, `applyPlan`, `setSuspended`, `resetUserPassword`, `rejectSignup` and `setWorkspace` (Task 7); `planFor`, `PLAN_PRESETS`, `daysLeft`, `PlanChoice` and `PlanPresetId` (Task 3); route context `account` (Task 10).
- Produces: route `/admin`.

- [ ] **Step 1: Write `src/components/admin/PlanDialog.tsx`**

```tsx
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { PLAN_PRESETS, planFor, type PlanChoice, type PlanPresetId } from "@/lib/plans";
import { applyPlan } from "@/server/admin-users";

export type PlanTarget = { id: string; name: string; email: string; state: string; planEndsAt: string | null };

// Activate a sign-up or change a plan: a preset, a custom number of days or months, or an exact end date.
// The preview uses the same planFor the server stores with.
export function PlanDialog({ user, onClose, onDone }: { user: PlanTarget; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<"preset" | "custom" | "until">("preset");
  const [preset, setPreset] = useState<PlanPresetId>(user.state === "pending" ? "trial-7d" : "1m");
  const [amount, setAmount] = useState("30");
  const [unit, setUnit] = useState<"days" | "months">("days");
  const [until, setUntil] = useState("");
  const [saving, setSaving] = useState(false);

  const choice: PlanChoice | null =
    kind === "preset"
      ? { preset }
      : kind === "custom"
        ? unit === "days"
          ? { days: Number(amount) }
          : { months: Number(amount) }
        : until
          ? { until: new Date(`${until}T23:59:59`).toISOString() } // the end of that day, in your timezone
          : null;

  let preview = "Pick an end date.";
  let valid = false;
  if (choice) {
    try {
      preview = `Access until ${planFor(choice, user.planEndsAt).endsAt.toLocaleString()}`;
      valid = true;
    } catch (err) {
      preview = err instanceof Error ? err.message : "That plan isn't valid.";
    }
  }

  const activating = user.state === "pending";
  const save = async () => {
    if (!choice) return;
    setSaving(true);
    try {
      const result = await applyPlan({ data: { userId: user.id, choice } });
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't save the plan.");
        return;
      }
      toast.success(activating ? `${user.name} is activated.` : `${user.name}'s plan is updated.`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the plan.");
    } finally {
      setSaving(false);
    }
  };

  const tab = (id: typeof kind, label: string) => (
    <button
      type="button"
      onClick={() => setKind(id)}
      className={cn(
        "flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        kind === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{activating ? `Activate ${user.name}` : `Change plan for ${user.name}`}</DialogTitle>
          <DialogDescription>
            {user.email}. A length is added to the current end date while the plan is still running, otherwise it
            starts today.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {tab("preset", "Plan")}
          {tab("custom", "Custom")}
          {tab("until", "End date")}
        </div>

        {kind === "preset" && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PLAN_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPreset(p.id)}
                className={cn(
                  "rounded-lg border px-3 py-3 text-sm font-medium transition-colors",
                  preset === p.id ? "border-primary bg-primary/10 text-foreground" : "border-border hover:bg-muted",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        {kind === "custom" && (
          <div className="flex gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="plan-amount">Length</Label>
              <Input id="plan-amount" type="number" inputMode="numeric" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="w-36 space-y-1.5">
              <Label>Unit</Label>
              <Select value={unit} onValueChange={(v) => setUnit(v as "days" | "months")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="days">Days</SelectItem>
                  <SelectItem value="months">Months</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {kind === "until" && (
          <div className="space-y-1.5">
            <Label htmlFor="plan-until">Last day of access</Label>
            <Input id="plan-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </div>
        )}

        <p className={cn("text-sm", valid ? "text-muted-foreground" : "text-destructive")}>{preview}</p>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!valid || saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {activating ? "Activate" : "Save plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Write `src/components/admin/TempPasswordDialog.tsx`**

```tsx
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// A reset password is shown once: it isn't stored anywhere readable.
export function TempPasswordDialog({ email, password, onClose }: { email: string; password: string; onClose: () => void }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      toast.success("Copied.");
    } catch {
      toast.error("Couldn't copy. Select the password and copy it by hand.");
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New temporary password</DialogTitle>
          <DialogDescription>
            For {email}. It's shown only this once. Send it to them privately; they can change it in Settings.
            They've been signed out everywhere.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted p-3">
          <code className="ident flex-1 select-all break-all text-base">{password}</code>
          <Button size="sm" variant="outline" onClick={copy}>
            <Copy className="h-4 w-4" /> Copy
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Write `src/routes/_app.admin.tsx`**

```tsx
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
    await setWorkspace({ data: { userId: u.id } });
    window.location.assign("/");
  };

  const resetPassword = async (u: UserRow) => {
    if (!confirm(`Reset ${u.name}'s password? They'll be signed out everywhere and need the new password you get.`)) return;
    setBusyId(u.id);
    try {
      const result = await resetUserPassword({ data: { userId: u.id } });
      if (!result.ok || !result.password) toast.error(result.error ?? "Couldn't reset the password.");
      else setTempPassword({ email: u.email, password: result.password });
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
```

- [ ] **Step 4: Register `/_app/admin` in `src/routeTree.gen.ts`**

1. After `import { Route as AppIndexRouteImport } from './routes/_app.index'` add `import { Route as AppAdminRouteImport } from './routes/_app.admin'`.
2. After the `const AppIndexRoute = ... as any)` block add:
```ts
const AppAdminRoute = AppAdminRouteImport.update({
  id: '/admin',
  path: '/admin',
  getParentRoute: () => AppRoute,
} as any)
```
3. Add the route to the type maps:
   - `FileRoutesByFullPath`: `'/admin': typeof AppAdminRoute`
   - `FileRoutesByTo`: `'/admin': typeof AppAdminRoute`
   - `FileRoutesById`: `'/_app/admin': typeof AppAdminRoute`
   - `FileRouteTypes`: `| '/admin'` in `fullPaths` and `to`, and `| '/_app/admin'` in `id`
4. In `FileRoutesByPath` add:
```ts
    '/_app/admin': {
      id: '/_app/admin'
      path: '/admin'
      fullPath: '/admin'
      preLoaderRoute: typeof AppAdminRouteImport
      parentRoute: typeof AppRoute
    }
```
5. Add `AppAdminRoute: typeof AppAdminRoute` to `interface AppRouteChildren`, and `AppAdminRoute: AppAdminRoute,` to `const AppRouteChildren`.

- [ ] **Step 5: Typecheck, test, build**

Run: `npx tsc --noEmit && npx vitest run && npm run build`. Expected: all succeed. Then run `grep -rlE "ssh2|bullmq|ioredis|node-ssh|SSHManager|account-session-v2" .output/public | wc -l` and expect `0`.

- [ ] **Step 6: Commit**

```bash
git add src/components/admin/PlanDialog.tsx src/components/admin/TempPasswordDialog.tsx src/routes/_app.admin.tsx src/routeTree.gen.ts
git commit -m "feat(accounts): admin Users page with plans, suspension, password reset and workspace access"
```

---

### Task 12: Isolation check and local end-to-end run

**Files:**
- Create: `scripts/accounts-e2e.ts`

**Interfaces:**
- Consumes: every earlier task. It needs a production build in `.output/`, because it reads the server-function ids from `.output/server`, and the local server from Step 3.
- Produces: `npx tsx scripts/accounts-e2e.ts <base-url> [--flow-only]`, which exits 0 when every check passes. Task 13 runs it against the live site with `--flow-only`.

The local server uses the **production database**: there is only one. The script creates only throwaway accounts (`*@example.invalid`, `*.invalid` domains) and deletes them in a `finally`, even when a check fails. Nextus data is only ever read.

- [ ] **Step 1: Write `scripts/accounts-e2e.ts`**

```ts
// End-to-end check of accounts against a running production build (plan Task 12):
//  1. Isolation (needs the server's SESSION_SECRET, so local only): throwaway account B calls every server
//     function that takes an id, with throwaway account A's ids. Nothing of A's may come back and none of A's
//     rows may change. Positive controls prove A, B and the admin still see what they should.
//  2. Account flow (local or live): sign up, wait for approval, activate, empty workspace, suspend, reset password,
//     change password, plan expiry. Signs in through the real login function.
// Everything it creates is deleted at the end, even when a check fails.
//
//   Local: SESSION_SECRET=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx scripts/accounts-e2e.ts http://127.0.0.1:3101
//   Live:  ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx scripts/accounts-e2e.ts https://mail.nxtcloudsystems.com --flow-only
// Server-function ids are read from .output/server, so build the same code the target runs first.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray } from "drizzle-orm";
import { toJSONAsync } from "seroval";
import * as schema from "../src/lib/db/schema";
import { createAccountToken } from "../src/server/accounts-core";

const repo = fileURLToPath(new URL("..", import.meta.url));
process.loadEnvFile(join(repo, ".env"));

const base = (process.argv[2] ?? "").replace(/\/$/, "");
const flowOnly = process.argv.includes("--flow-only");
const { SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (!base || !ADMIN_EMAIL || !ADMIN_PASSWORD || (!flowOnly && !SESSION_SECRET)) {
  console.error(
    "Usage: SESSION_SECRET=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx scripts/accounts-e2e.ts <base-url> [--flow-only]",
  );
  process.exit(1);
}

let dbUrl = process.env.DATABASE_URL ?? "";
if (dbUrl.includes("#") && !dbUrl.includes("%23")) dbUrl = dbUrl.replace(/#/, "%23");
const client = postgres(dbUrl, { prepare: false, max: 1, ssl: "require" });
const db = drizzle({ client, schema });
const tag = randomBytes(4).toString("hex");
const failures: string[] = [];

function check(ok: boolean, label: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
}

// ---------- server functions over HTTP, the way the browser calls them ----------

function serverFnIds(): Map<string, string> {
  const ids = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".mjs")) {
        const text = readFileSync(path, "utf8");
        for (const m of text.matchAll(/createServerRpc\(\{\s*id:\s*"([0-9a-f]{64})",\s*name:\s*"(\w+)"/g)) {
          ids.set(m[2], m[1]);
        }
      }
    }
  };
  walk(join(repo, ".output/server"));
  return ids;
}
const fnIds = serverFnIds();

async function call(
  name: string,
  method: "GET" | "POST",
  data: unknown,
  cookie = "",
): Promise<{ status: number; text: string; setCookie: string[] }> {
  const id = fnIds.get(name);
  if (!id) throw new Error(`No server function named ${name} in .output/server. Rebuild first.`);
  const payload = JSON.stringify(await toJSONAsync({ data }));
  const headers: Record<string, string> = {
    "x-tsr-serverFn": "true",
    "sec-fetch-site": "same-origin",
    accept: "application/json",
  };
  if (cookie) headers.cookie = cookie;
  let target = `${base}/_serverFn/${id}`;
  let body: string | undefined;
  if (method === "GET") target += `?payload=${encodeURIComponent(payload)}`;
  else {
    body = payload;
    headers["content-type"] = "application/json";
  }
  const res = await fetch(target, { method, headers, body });
  return { status: res.status, text: await res.text(), setCookie: res.headers.getSetCookie() };
}

function sessionCookie(setCookie: string[]): string {
  const found = setCookie.find((c) => c.startsWith("mn_session="));
  if (!found) throw new Error("The server didn't set a session cookie");
  return found.split(";")[0];
}
const isSignedOut = (text: string) => !/"(ok|pending|expired|suspended)"/.test(text);

// ---------- cleanup ----------

const OWNED = [
  schema.plannedInboxes,
  schema.dnsRecords,
  schema.domainPlans,
  schema.healthHistory,
  schema.serverHealth,
  schema.rateLimits,
  schema.domains,
  schema.domainBatches,
  schema.jobTemplates,
  schema.servers,
  schema.cloudflareZones,
  schema.userSecrets,
];
async function deleteAccounts(ids: string[]) {
  if (!ids.length) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const table of OWNED) await db.delete(table).where(inArray((table as any).userId, ids));
  await db.delete(schema.users).where(inArray(schema.users.id, ids));
}

async function adminRow() {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.role, "admin"));
  if (!row) throw new Error("No admin row: run the accounts migration first.");
  return row;
}

// ---------- 1. isolation ----------

async function isolation(created: string[]) {
  const active = { role: "user", status: "active", planName: "e2e", planEndsAt: new Date(Date.now() + 86_400_000) };
  const [a] = await db.insert(schema.users).values({ email: `iso-a-${tag}@example.invalid`, name: `Iso A ${tag}`, ...active }).returning();
  created.push(a.id);
  const [b] = await db.insert(schema.users).values({ email: `iso-b-${tag}@example.invalid`, name: `Iso B ${tag}`, ...active }).returning();
  created.push(b.id);

  const domainName = `iso-a-${tag}.invalid`;
  const [template] = await db.insert(schema.jobTemplates).values({ userId: a.id, name: `iso-template-${tag}` }).returning();
  const [batch] = await db.insert(schema.domainBatches).values({ userId: a.id, name: `iso-batch-${tag}`, templateId: template.id }).returning();
  const [domA] = await db
    .insert(schema.domains)
    .values({ userId: a.id, batchId: batch.id, name: domainName, ipAddress: "192.0.2.10", sshUser: "root", sshPassword: `iso-ssh-secret-${tag}` })
    .returning();
  await db.insert(schema.domains).values({ userId: b.id, name: `iso-b-${tag}.invalid` });
  const [planA] = await db.insert(schema.domainPlans).values({ userId: a.id, domainId: domA.id, totalInboxes: 1, subdomainCount: 1 }).returning();
  await db.insert(schema.plannedInboxes).values({
    userId: a.id,
    domainId: domA.id,
    planId: planA.id,
    subdomainPrefix: "web",
    subdomainFqdn: `web.${domainName}`,
    localPart: "iso",
    email: `iso@web.${domainName}`,
    password: `iso-mailbox-secret-${tag}`,
    status: "active",
  });
  await db.insert(schema.dnsRecords).values({ userId: a.id, domainId: domA.id, type: "TXT", name: "iso", content: `iso-record-${tag}` });
  await db.insert(schema.userSecrets).values({ userId: a.id, cfApiToken: `iso-cf-token-${tag}-0123456789` });
  const [serverA] = await db
    .insert(schema.servers)
    .values({ userId: a.id, label: `iso-server-${tag}`, hostname: `srv.${domainName}`, ipAddress: "192.0.2.11", sshPassword: `iso-server-secret-${tag}` })
    .returning();
  await db.insert(schema.cloudflareZones).values({ userId: a.id, zoneId: `iso-zone-${tag}`, name: domainName });

  const markers = [
    domainName,
    `iso-record-${tag}`,
    `iso-mailbox-secret-${tag}`,
    `iso-cf-token-${tag}`,
    `iso-server-${tag}`,
    `iso-template-${tag}`,
    `iso-zone-${tag}`,
    `iso-batch-${tag}`,
    `iso-ssh-secret-${tag}`,
  ];
  const leaked = (text: string) => markers.filter((m) => text.includes(m));

  const config = { email: ADMIN_EMAIL!, password: ADMIN_PASSWORD!, secret: SESSION_SECRET! };
  const cookieA = `mn_session=${createAccountToken({ accountId: a.id, version: 1, admin: false }, config)}`;
  const cookieB = `mn_session=${createAccountToken({ accountId: b.id, version: 1, admin: false }, config)}`;
  const admin = await adminRow();
  const cookieAdmin = `mn_session=${createAccountToken({ accountId: admin.id, version: admin.sessionVersion, admin: true }, config)}`;

  // Positive controls: owners see their own data, so a clean result below means something.
  check((await call("listDomains", "GET", {}, cookieA)).text.includes(domainName), "A sees A's domain");
  check((await call("listDomains", "GET", {}, cookieB)).text.includes(`iso-b-${tag}.invalid`), "B sees B's domain");

  const reads: [string, "GET" | "POST", unknown][] = [
    ["listDomains", "GET", {}],
    ["getDomain", "GET", { id: domA.id }],
    ["getDomainDetails", "GET", { id: domA.id }],
    ["getBatchDetails", "GET", { id: batch.id }],
    ["listDomainBatches", "GET", {}],
    ["listDomainPlans", "GET", {}],
    ["getDomainPlan", "GET", { domainId: domA.id }],
    ["listPlannedInboxes", "GET", { domainId: domA.id }],
    ["getInboxExport", "GET", { domainId: domA.id }],
    ["getInboxExport", "GET", {}],
    ["getSubdomainExport", "GET", { domainId: domA.id }],
    ["getSubdomainExport", "GET", { batchId: batch.id }],
    ["listDnsRecords", "GET", { domainId: domA.id }],
    ["getSecrets", "GET", {}],
    ["getCfZones", "GET", {}],
    ["listServers", "GET", {}],
    ["listJobTemplates", "GET", {}],
    ["getOverviewStats", "GET", {}],
    ["getHealthOverview", "GET", {}],
    ["getBatchServerHealth", "GET", { batchId: batch.id }],
  ];
  for (const [name, method, data] of reads) {
    const found = leaked((await call(name, method, data, cookieB)).text);
    check(found.length === 0, `B ${name} ${JSON.stringify(data)} shows nothing of A's${found.length ? `: ${found.join(", ")}` : ""}`);
  }

  const spoof = await call("listDomains", "GET", {}, `${cookieB}; mn_workspace=${a.id}`);
  check(leaked(spoof.text).length === 0, "B can't open A's workspace with a forged mn_workspace cookie");

  const writes: [string, unknown][] = [
    ["updateDomain", { id: domA.id, ipAddress: "192.0.2.99" }],
    ["createDnsRecord", { domainId: domA.id, type: "TXT", name: "hijack", content: "x" }],
    ["regeneratePlan", { domainId: domA.id, totalInboxes: 1, prefixes: ["web"], names: ["Hi Jack"] }],
    ["saveJobTemplate", { id: template.id, name: "hijack", subdomainPrefixes: ["web"], personNames: ["Hi Jack"] }],
    ["createDomainBatch", { name: `iso-b-batch-${tag}`, templateId: template.id }],
    ["resetDomainMailboxPasswords", { domainId: domA.id }],
    ["setupMailcowDomain", { domainId: domA.id }],
    ["provisionServer", { domainId: domA.id }],
    ["testSshConnection", { domainId: domA.id }],
    ["resetMailcowAdminPassword", { domainId: domA.id }],
    ["pushDnsToCloudflare", { domainId: domA.id }],
    ["batchPushDnsToCloudflare", { domainId: domA.id }],
    ["repairDomainDns", { domainId: domA.id }],
    ["fetchDkimAndSync", { domainId: domA.id }],
    ["runDomainHealth", { domainId: domA.id }],
    ["runJobHealth", { batchId: batch.id }],
    ["runJobRemediation", { batchId: batch.id }],
    ["restartMailcowForDomain", { domainId: domA.id }],
    ["createApiKeyForDomain", { domainId: domA.id }],
    ["deleteJobTemplate", { id: template.id }],
    ["deleteServer", { id: serverA.id }],
    ["deleteDomainBatch", { id: batch.id }],
    ["deleteDomain", { id: domA.id }],
  ];
  for (const [name, data] of writes) {
    const found = leaked((await call(name, "POST", data, cookieB)).text);
    check(found.length === 0, `B ${name} on A's ids reveals nothing${found.length ? `: ${found.join(", ")}` : ""}`);
  }

  // None of A's rows changed.
  const domAfter = await db.query.domains.findFirst({ where: eq(schema.domains.id, domA.id) });
  check(domAfter?.ipAddress === "192.0.2.10" && domAfter?.name === domainName, "A's domain is unchanged");
  const records = await db.select().from(schema.dnsRecords).where(eq(schema.dnsRecords.domainId, domA.id));
  check(records.length === 1 && records[0].name === "iso", "A's DNS records are unchanged (nothing added by B)");
  const inboxes = await db.select().from(schema.plannedInboxes).where(eq(schema.plannedInboxes.domainId, domA.id));
  check(inboxes.length === 1 && inboxes[0].password === `iso-mailbox-secret-${tag}`, "A's mailbox and its password are unchanged");
  const planAfter = await db.query.domainPlans.findFirst({ where: eq(schema.domainPlans.id, planA.id) });
  check(planAfter?.totalInboxes === 1, "A's plan is unchanged");
  const templateAfter = await db.query.jobTemplates.findFirst({ where: eq(schema.jobTemplates.id, template.id) });
  check(templateAfter?.name === `iso-template-${tag}`, "A's template is unchanged");
  check(Boolean(await db.query.servers.findFirst({ where: eq(schema.servers.id, serverA.id) })), "A's server still exists");
  check(Boolean(await db.query.domainBatches.findFirst({ where: eq(schema.domainBatches.id, batch.id) })), "A's job still exists");
  const bBatches = await db.select().from(schema.domainBatches).where(eq(schema.domainBatches.userId, b.id));
  check(bBatches.every((x) => x.templateId !== template.id), "B couldn't link A's template to a job");

  // Live setup logs.
  const sseB = await fetch(`${base}/api/sse?domainId=${domA.id}`, { headers: { cookie: cookieB } });
  check(sseB.status === 403, `B can't stream A's setup log (HTTP ${sseB.status})`);
  await sseB.body?.cancel();
  const sseA = await fetch(`${base}/api/sse?domainId=${domA.id}`, { headers: { cookie: cookieA } });
  check(sseA.status === 200, `A can stream A's setup log (HTTP ${sseA.status})`);
  await sseA.body?.cancel();

  // Admin-only functions refuse a user.
  const adminOnly: [string, "GET" | "POST", unknown][] = [
    ["listUsers", "GET", {}],
    ["listWorkspaces", "GET", {}],
    ["applyPlan", "POST", { userId: b.id, choice: { preset: "12m" } }],
    ["setWorkspace", "POST", { userId: a.id }],
  ];
  for (const [name, method, data] of adminOnly) {
    check((await call(name, method, data, cookieB)).text.includes("FORBIDDEN"), `B is refused ${name}`);
  }

  // The admin: Nextus doesn't show A's data; A's workspace does; Nextus lists every one of its domains.
  const adminOwn = await call("listDomains", "GET", {}, cookieAdmin);
  check(leaked(adminOwn.text).length === 0, "the admin's own (Nextus) workspace doesn't show A's data");
  check((await call("listDomains", "GET", {}, `${cookieAdmin}; mn_workspace=${a.id}`)).text.includes(domainName), "the admin sees A's data in A's workspace");
  const nextus = await db.select({ id: schema.domains.id }).from(schema.domains).where(eq(schema.domains.userId, admin.id));
  // One "batchName" key per domain row in the serialized list. If this ever misfires, print adminOwn.text.slice(0, 600).
  check((adminOwn.text.match(/"batchName"/g) ?? []).length === nextus.length, `the Nextus workspace lists all ${nextus.length} of its domains`);
}

// ---------- 2. account flow ----------

async function flow(created: string[]) {
  const email = `e2e-${tag}@example.invalid`;
  const password = `e2e-password-${tag}`;
  const admin = await adminRow();

  const signup = await call("signup", "POST", { name: `E2E ${tag}`, email, password, confirmPassword: password });
  const [row] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (row) created.push(row.id);
  check(row?.status === "pending", "sign-up creates a pending account");
  let cookieC = sessionCookie(signup.setCookie);
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"pending"'), "a new account sees 'waiting for approval'");
  check((await call("listDomains", "GET", {}, cookieC)).text.includes("ACCOUNT_LOCKED"), "a pending account can't use the app");
  const dup = await call("signup", "POST", { name: "Dup", email: email.toUpperCase(), password, confirmPassword: password });
  check(dup.text.includes("An account with this email already exists."), "the same email can't sign up twice");

  const cookieAdmin = sessionCookie((await call("login", "POST", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).setCookie);
  check((await call("listUsers", "GET", {}, cookieAdmin)).text.includes(email), "the admin sees the sign-up");
  await call("applyPlan", "POST", { userId: row.id, choice: { preset: "trial-7d" } }, cookieAdmin);
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"ok"'), "activation lets the account in");
  const [nextusDomain] = await db.select({ name: schema.domains.name }).from(schema.domains).where(eq(schema.domains.userId, admin.id)).limit(1);
  const own = await call("listDomains", "GET", {}, cookieC);
  check(!own.text.includes("ACCOUNT_LOCKED") && (!nextusDomain || !own.text.includes(nextusDomain.name)), "an activated account starts with an empty workspace");

  await call("setSuspended", "POST", { userId: row.id, suspended: true }, cookieAdmin);
  check(isSignedOut((await call("getSession", "GET", {}, cookieC)).text), "suspending signs the account out everywhere");
  cookieC = sessionCookie((await call("login", "POST", { email, password })).setCookie);
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"suspended"'), "a suspended account sees 'suspended'");
  await call("setSuspended", "POST", { userId: row.id, suspended: false }, cookieAdmin);

  const reset = await call("resetUserPassword", "POST", { userId: row.id }, cookieAdmin);
  const temp = reset.text.match(/[A-HJ-NP-Za-km-z2-9]{16}/)?.[0] ?? "";
  check(temp.length === 16 && isSignedOut((await call("getSession", "GET", {}, cookieC)).text), "a password reset signs the account out");
  cookieC = sessionCookie((await call("login", "POST", { email, password: temp })).setCookie);
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"ok"'), "the temporary password works");
  check((await call("login", "POST", { email, password })).text.includes("Wrong email or password."), "the old password stops working");

  const changed = await call("changePassword", "POST", { currentPassword: temp, newPassword: password, confirmPassword: password }, cookieC);
  cookieC = sessionCookie(changed.setCookie);
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"ok"'), "changing the password keeps this session signed in");

  await db.update(schema.users).set({ planEndsAt: new Date(Date.now() - 60_000) }).where(eq(schema.users.id, row.id));
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"expired"'), "an ended plan locks the account");
  check((await call("listDomains", "GET", {}, cookieC)).text.includes("ACCOUNT_LOCKED"), "an expired account can't use the app");
  await call("applyPlan", "POST", { userId: row.id, choice: { days: 3 } }, cookieAdmin);
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"ok"'), "extending the plan brings the account back");
}

// ---------- run ----------

const created: string[] = [];
try {
  if (!flowOnly) {
    console.log("== Isolation");
    await isolation(created);
  }
  console.log("== Account flow");
  await flow(created);
} catch (err) {
  failures.push(`crashed: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  await deleteAccounts(created);
  const left = created.length ? await db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, created)) : [];
  console.log(`Cleaned up ${created.length} test account(s); ${left.length} left.`);
  await client.end();
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
```

- [ ] **Step 2: Build**

Run: `npm run build`. Expected: exit 0.

- [ ] **Step 3: Start a local copy with a throwaway admin login**

Keep the throwaway values in the session scratchpad, never in the repo:

```bash
SP="<scratchpad dir>"
node -e "process.stdout.write(require('crypto').randomBytes(18).toString('base64url'))" > "$SP/e2e-admin-pw.txt"
node -e "process.stdout.write(require('crypto').randomBytes(36).toString('base64url'))" > "$SP/e2e-secret.txt"
NODE_ENV=production PORT=3101 HOST=127.0.0.1 REDIS_URL= ADMIN_EMAIL=local-admin@example.invalid \
  ADMIN_PASSWORD="$(cat "$SP/e2e-admin-pw.txt")" SESSION_SECRET="$(cat "$SP/e2e-secret.txt")" \
  node --env-file=.env .output/server/index.mjs
```

Run it in the background, and wait for `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3101/auth` to print `200`. `REDIS_URL=` keeps the queue worker off, so no setup job can start.

- [ ] **Step 4: Run the check**

```bash
ADMIN_EMAIL=local-admin@example.invalid ADMIN_PASSWORD="$(cat "$SP/e2e-admin-pw.txt")" SESSION_SECRET="$(cat "$SP/e2e-secret.txt")" \
  npx tsx scripts/accounts-e2e.ts http://127.0.0.1:3101
```

Expected: every line starts with `ok`, then `Cleaned up 3 test account(s); 0 left.` and `All checks passed.`

If a check fails:
- Fix the task that owns that behaviour (for a leak, add the missing `userId` condition in the named server function), not the script.
- Rebuild, restart the server, and rerun.
- A crash before cleanup still deletes the accounts it created.

- [ ] **Step 5: Stop the local server and delete the throwaway files**

Stop the node process listening on port 3101 (only that one), then `rm "$SP/e2e-admin-pw.txt" "$SP/e2e-secret.txt"`.

- [ ] **Step 6: Commit**

```bash
git add scripts/accounts-e2e.ts
git commit -m "test(accounts): end-to-end isolation and account-flow check against a running build"
```

---

### Task 13: Roll out

**Files:**
- Modify: `DEPLOY.md` (add an "Accounts" section)

**Interfaces:**
- Consumes: everything above.
- Produces: the live site at https://mail.nxtcloudsystems.com running accounts.

The server's IP and the admin login are in `C:\Users\tasin\mailnerd-deploy.env`, which is outside the repo. Never print its values. SSH uses the key `C:/Users/tasin/.ssh/mailnerd_vps` as root. The app lives in `/opt/mailnerd` and keeps its own `.env`.

- [ ] **Step 1: Document accounts in `DEPLOY.md`**

Add this section after the sign-in/environment section:

```markdown
## Accounts

- **The admin** signs in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`. The admin's workspace holds everything
  created before accounts existed (the Nextus data). Changing `ADMIN_PASSWORD` signs the admin out; changing
  `SESSION_SECRET` signs everyone out.
- **Everyone else** signs up at `/signup`. A new account waits until the admin activates it on the **Users** page
  with a plan (7-day trial, 1/3/6 months, 1 year, a custom length, or an end date). When the plan ends the account
  is locked; its data stays and comes back when the plan is extended.
- **Forgotten password:** the admin uses **Reset password** on the Users page and passes on the temporary password.
- **Workspaces are private.** The admin can open any account's workspace from the switcher in the sidebar.
- Before any schema change, back up the database: `npx tsx scripts/backup-db.ts <folder outside the repo>`.
- `DB_POOL_MAX` (default 5) sets how many database connections the app uses.
```

Commit it:

```bash
git add DEPLOY.md
git commit -m "docs(deploy): accounts, sign-up approval and plans"
```

- [ ] **Step 2: Verification gate**

Run:
```bash
npx tsc --noEmit && npx vitest run && npm run build && \
  echo "leaks: $(grep -rlE 'ssh2|bullmq|ioredis|node-ssh|SSHManager|account-session-v2' .output/public | wc -l)"
```
Expected: all succeed, and `leaks: 0`.

- [ ] **Step 3: Fresh backup, then re-check the migration**

```bash
npx tsx scripts/backup-db.ts "C:/Users/tasin/mailnerd-backups"
npx tsx scripts/migrate-user-accounts.ts --compare "C:/Users/tasin/mailnerd-backups/<new backup dir>/counts.json"
```
Expected: every line `ok`, `Admin row: aa64be25-… (Nextus, active)`, and `Tables without row level security: 0`.

- [ ] **Step 4: Make sure no server setup is running**

```bash
HOST=$(grep '^VPS_HOST=' "C:/Users/tasin/mailnerd-deploy.env" | cut -d= -f2 | tr -d '\r\n ')
ssh -i "C:/Users/tasin/.ssh/mailnerd_vps" -o BatchMode=yes root@"$HOST" '
cd /opt/mailnerd; R="docker compose exec -T redis redis-cli"
for k in wait active paused; do echo "$k: $($R LLEN bull:server-setup:$k)"; done
for k in delayed prioritized; do echo "$k: $($R ZCARD bull:server-setup:$k)"; done'
```
Expected: all five are `0`. If not, wait and check again: a restart would re-run a setup from scratch.

- [ ] **Step 5: Upload and rebuild on the server**

```bash
SP="<scratchpad dir>"
git ls-files --cached --others --exclude-standard --deduplicate | grep -vxE '\.env' \
  | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done > "$SP/deploy-files.txt"
grep -iE '(^|/)\.env($|\.local|\.prod)|script[0-9]*\.ts$|cookie|deploy\.env|\.pem$|id_rsa' "$SP/deploy-files.txt"   # must print nothing
tar --force-local -czf "$SP/mailnerd-deploy.tgz" -T "$SP/deploy-files.txt"
scp -i "C:/Users/tasin/.ssh/mailnerd_vps" -o BatchMode=yes -q "$SP/mailnerd-deploy.tgz" root@"$HOST":/tmp/mailnerd-deploy.tgz
rm -f "$SP/mailnerd-deploy.tgz"
ssh -i "C:/Users/tasin/.ssh/mailnerd_vps" -o BatchMode=yes -o ServerAliveInterval=30 root@"$HOST" '
set -e; cd /opt/mailnerd; test -f .env
tar -xzf /tmp/mailnerd-deploy.tgz -C /opt/mailnerd && rm -f /tmp/mailnerd-deploy.tgz
setsid nohup docker compose up -d --build > /root/mailnerd-deploy.log 2>&1 < /dev/null &
sleep 3; for i in $(seq 1 96); do pgrep -f "docker compose up -d --build" >/dev/null || break; sleep 5; done
grep -E "Built|Recreated|Started|ERROR" /root/mailnerd-deploy.log | tail -6
docker compose ps --format "{{.Service}} {{.State}} {{.Status}}"
docker compose logs app --no-color 2>&1 | grep -iE "error|fail" | tail -5'
```
Expected: `Image mailnerd-app Built`, then app/caddy/redis `running`, and no app errors.

- [ ] **Step 6: Name the admin row after the live `ADMIN_EMAIL`**

Only now, because the new release finds the admin by role. First check that the server's `ADMIN_EMAIL` matches the local deploy file, without printing either value:

```bash
LOCAL=$(grep '^ADMIN_EMAIL=' "C:/Users/tasin/mailnerd-deploy.env" | cut -d= -f2 | tr -d '\r\n ' | tr 'A-Z' 'a-z' | sha256sum | cut -c1-16)
REMOTE=$(ssh -i "C:/Users/tasin/.ssh/mailnerd_vps" -o BatchMode=yes root@"$HOST" \
  "grep '^ADMIN_EMAIL=' /opt/mailnerd/.env | cut -d= -f2 | tr -d '\r\n ' | tr 'A-Z' 'a-z' | sha256sum | cut -c1-16")
[ "$LOCAL" = "$REMOTE" ] && echo "same ADMIN_EMAIL" || echo "DIFFERENT: stop and ask"
npx tsx scripts/migrate-user-accounts.ts --set-admin-email "$(grep '^ADMIN_EMAIL=' C:/Users/tasin/mailnerd-deploy.env | cut -d= -f2 | tr -d '\r\n ')"
```
Expected: `same ADMIN_EMAIL`, then `Admin account now uses …` and `Admin row: aa64be25-… (Nextus, active)`.

- [ ] **Step 7: Check the live site**

```bash
U=https://mail.nxtcloudsystems.com
for p in /auth /signup /account /domains /admin; do echo "$p $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$U$p")"; done
```
Expected:
- `/auth 200`
- `/signup 200`
- `/account 307 …/auth`
- `/domains 307 …/auth?redirect=…`
- `/admin 307 …/auth?redirect=…`

Then run the account flow against the live site. This builds from the same commit that was deployed. The script creates a throwaway `e2e-…@example.invalid` account and deletes it afterwards:

```bash
ADMIN_EMAIL="$(grep '^ADMIN_EMAIL=' C:/Users/tasin/mailnerd-deploy.env | cut -d= -f2 | tr -d '\r\n ')" \
ADMIN_PASSWORD="$(grep '^ADMIN_PASSWORD=' C:/Users/tasin/mailnerd-deploy.env | cut -d= -f2- | tr -d '\r\n')" \
  npx tsx scripts/accounts-e2e.ts https://mail.nxtcloudsystems.com --flow-only
```
Expected: `All checks passed.` and `Cleaned up 1 test account(s); 0 left.`

- [ ] **Step 8: Confirm the Nextus data is intact**

Run the `--compare` from Step 3 again against the Step 3 backup.

Expected: every line `ok`, except `users`, which may be higher if real people signed up since. The flow-only run's account is already deleted.

Then tell the user:
- They need to sign in once more, because the cookie format changed.
- `/signup` is the page to share.
- New sign-ups appear under **Users** with a badge.
