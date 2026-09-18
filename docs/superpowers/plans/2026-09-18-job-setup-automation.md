# Job Setup Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One reliable server-side setup run per domain (DNS → server → mailboxes → DKIM), started for a whole job with **Set up everything** or per domain. It has a live board with mailbox % and time left, asks before touching a server that already runs Mailcow, and adds a Supabase keep-alive.

**Architecture:**
- Pure modules hold the run's state shape, progress math, the server-choice rule and the step sequencer, all unit-tested with fakes.
- A BullMQ job named `domain-setup`, on the existing queue and worker, drives the sequencer with real step functions that reuse today's pipeline code. Run state lives in `domains.setup_state` and mailbox progress in `domains.mailbox_progress`, and the UI polls both.

**Tech Stack:** TanStack Start 1.168 server functions, React 19, TanStack Query/Router (route tree maintained by hand in `src/routeTree.gen.ts`), Drizzle on Supabase Postgres, BullMQ 5 + ioredis, Nitro plugins, vitest.

**Spec:** `docs/superpowers/specs/2026-09-18-job-setup-automation-design.md`

## Global Constraints

- **Server-function modules** export only `createServerFn` values, plus types. Every one uses `.middleware([requireAuth])`, or `requireAdmin` for admin-only.
- **Server-only modules** (anything importing `@/lib/db`, `ssh`, `bullmq`, `ioredis`, `node:crypto`) must never be imported by browser code. Browser code may import `src/lib/setup-state.ts`, `src/lib/mailbox-progress.ts` and types.
- **Workspace scoping:** every query that takes a record id also filters `userId = context.userId`, the workspace.
- **Setup steps, in order:** `dns`, `server`, `mailboxes`, `dkim`.
- **Run statuses:** `queued | running | waiting | done | failed`. **Step statuses:** `pending | running | done | failed`.
- **Server choice:** `reuse | reinstall`. A wipe only happens with `reinstall` (the user's choice, or Wipe & re-provision), or on this domain's own unfinished install when no other app domain uses the IP.
- **Retries:** 3 attempts per queued run, exponential backoff starting at 30 s, the existing `defaultJobOptions`. At most `PROVISION_CONCURRENCY` (default 3) runs at once, and one run per server IP at a time.
- **Refresh rates:** mailbox progress is written at most every 2 s. The board polls every 3 s, and the domain page every 2 s during mailbox runs.
- **Keep-alive:** at boot and then every 12 h, production only.
- **Verification gate:**
  - `npx tsc --noEmit` exits 0.
  - `npx vitest run` all pass.
  - `npm run build` exits 0.
  - `grep -rlE "ssh2|bullmq|ioredis|node-ssh|SSHManager|account-session-v2" .output/public | wc -l` prints 0.
- **Commits:** each commit ends with a separate trailer paragraph, `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Use two `-m` flags. Don't push.

---

### Task 1: Database columns

**Files:**
- Create: `supabase/migrations/20260918300000_setup_runs.sql`
- Modify: `scripts/migrate-user-accounts.ts` (add the file to `MIGRATIONS`)
- Modify: `src/lib/db/schema.ts` (the `domains` table)

- [ ] **Step 1: SQL**
```sql
-- Server-side setup runs (docs/superpowers/specs/2026-09-18-job-setup-automation-design.md). Additive, idempotent.
ALTER TABLE public.domains ADD COLUMN IF NOT EXISTS setup_state jsonb;
ALTER TABLE public.domains ADD COLUMN IF NOT EXISTS mailbox_progress jsonb;
```
- [ ] **Step 2:** in `scripts/migrate-user-accounts.ts`, append `"20260918300000_setup_runs.sql"` to the `MIGRATIONS` array.
- [ ] **Step 3:** in `schema.ts`, add these to `domains`, after `status`:
```ts
  // Server-side setup run (src/lib/setup-state.ts SetupState) and the latest mailbox run's progress
  // (src/lib/mailbox-progress.ts MailboxProgress).
  setupState: jsonb("setup_state"),
  mailboxProgress: jsonb("mailbox_progress"),
```
- [ ] **Step 4:** back up, then apply and compare:
  - `npx tsx scripts/backup-db.ts "C:/Users/tasin/mailnerd-backups"`
  - `npx tsx scripts/migrate-user-accounts.ts --compare "<new backup>/counts.json"`
  - Expected: every line `ok`, and RLS off = 0.

  Then `npx tsc --noEmit` should exit 0.
- [ ] **Step 5:** commit `feat(setup): columns for server-side setup runs and mailbox progress`.

---

### Task 2: Pure state and progress helpers

**Files:**
- Create: `src/lib/setup-state.ts`, `src/lib/mailbox-progress.ts`
- Test: `src/lib/__tests__/setup-state.test.ts`, `src/lib/__tests__/mailbox-progress.test.ts`

**Interfaces produced** (browser-safe, no imports):
- **`setup-state.ts`:**
  - `SETUP_STEPS`, `type SetupStep`, `type StepStatus`, `type SetupStatus`, `type ServerChoice`, `type SetupState`
  - `newSetupState(runId: string, nowIso: string, opts?: { fromStep?: SetupStep; serverChoice?: ServerChoice | null }): SetupState`
  - `mergeSetupState(prev: SetupState, patch: Partial<SetupState>, nowIso: string): SetupState`
  - `isActive(state: SetupState | null | undefined): boolean` (queued, running or waiting)
  - `boardSummary(states: (SetupState | null | undefined)[]): { done: number; running: number; waiting: number; failed: number; notStarted: number }`
  - `STEP_LABELS: Record<SetupStep, string>`
- **`mailbox-progress.ts`:**
  - `type MailboxProgress`
  - `newMailboxProgress(total: number, nowIso: string): MailboxProgress`
  - `recordProgress(prev: MailboxProgress, done: number, nowMs: number): MailboxProgress`
  - `finishProgress(prev: MailboxProgress, done: number, failed: number, nowIso: string): MailboxProgress`
  - `progressPercent(p: MailboxProgress): number`
  - `secondsLeft(p: MailboxProgress): number | null`
  - `formatEta(seconds: number | null): string`

- [ ] **Step 1: Write the failing tests**

`src/lib/__tests__/setup-state.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { boardSummary, isActive, mergeSetupState, newSetupState, SETUP_STEPS } from "../setup-state";

const T0 = "2026-09-18T10:00:00.000Z";
const T1 = "2026-09-18T10:05:00.000Z";

describe("newSetupState", () => {
  it("starts queued with every step pending", () => {
    const s = newSetupState("r1", T0);
    expect(s).toMatchObject({ runId: "r1", status: "queued", step: null, attempt: 0, error: null, waiting: null, serverChoice: null, startedAt: T0, updatedAt: T0, finishedAt: null });
    expect(SETUP_STEPS.map((k) => s.steps[k])).toEqual(["pending", "pending", "pending", "pending"]);
  });
  it("marks the steps before fromStep as done", () => {
    const s = newSetupState("r1", T0, { fromStep: "mailboxes" });
    expect(s.steps).toEqual({ dns: "done", server: "done", mailboxes: "pending", dkim: "pending" });
  });
  it("carries a server choice", () => {
    expect(newSetupState("r1", T0, { fromStep: "server", serverChoice: "reinstall" }).serverChoice).toBe("reinstall");
  });
});

describe("mergeSetupState", () => {
  it("merges steps instead of replacing them and stamps updatedAt", () => {
    const s = newSetupState("r1", T0);
    const m = mergeSetupState(s, { status: "running", step: "dns", steps: { ...s.steps, dns: "running" } }, T1);
    expect(m.steps.dns).toBe("running");
    expect(m.steps.server).toBe("pending");
    expect(m.updatedAt).toBe(T1);
    expect(m.startedAt).toBe(T0);
  });
});

describe("isActive and boardSummary", () => {
  it("counts each domain once", () => {
    const base = newSetupState("r", T0);
    const states = [
      null,
      { ...base, status: "queued" as const },
      { ...base, status: "running" as const },
      { ...base, status: "waiting" as const },
      { ...base, status: "failed" as const },
      { ...base, status: "done" as const },
    ];
    expect(states.map(isActive)).toEqual([false, true, true, true, false, false]);
    expect(boardSummary(states)).toEqual({ done: 1, running: 2, waiting: 1, failed: 1, notStarted: 1 });
  });
});
```

`src/lib/__tests__/mailbox-progress.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { finishProgress, formatEta, newMailboxProgress, progressPercent, recordProgress, secondsLeft } from "../mailbox-progress";

const T0 = Date.UTC(2026, 8, 18, 10, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

describe("mailbox progress", () => {
  it("starts at 0% with no estimate yet", () => {
    const p = newMailboxProgress(100, iso(T0));
    expect(progressPercent(p)).toBe(0);
    expect(secondsLeft(p)).toBeNull();
    expect(formatEta(secondsLeft(p))).toBe("estimating time left…");
  });

  it("measures seconds per mailbox and projects the rest", () => {
    let p = newMailboxProgress(100, iso(T0));
    p = recordProgress(p, 10, T0 + 20_000); // 10 mailboxes in 20 s → 2 s each
    expect(p.secondsPerMailbox).toBeCloseTo(2);
    expect(progressPercent(p)).toBe(10);
    expect(secondsLeft(p)).toBeCloseTo(180); // 90 left × 2 s
  });

  it("smooths the rate so one slow mailbox doesn't swing the estimate", () => {
    let p = newMailboxProgress(100, iso(T0));
    p = recordProgress(p, 10, T0 + 20_000); // 2 s each
    p = recordProgress(p, 11, T0 + 30_000); // one took 10 s
    expect(p.secondsPerMailbox).toBeGreaterThan(2);
    expect(p.secondsPerMailbox).toBeLessThan(10);
  });

  it("ignores an update with no new mailboxes", () => {
    const p = recordProgress(newMailboxProgress(10, iso(T0)), 0, T0 + 5_000);
    expect(p.secondsPerMailbox).toBeNull();
  });

  it("finishes at 100% with nothing left", () => {
    const p = finishProgress(newMailboxProgress(10, iso(T0)), 9, 1, iso(T0 + 60_000));
    expect(progressPercent(p)).toBe(100);
    expect(secondsLeft(p)).toBe(0);
    expect(p).toMatchObject({ done: 9, failed: 1 });
  });

  it("treats an empty run as complete", () => {
    expect(progressPercent(newMailboxProgress(0, iso(T0)))).toBe(100);
  });

  it("formats the time left", () => {
    expect(formatEta(0)).toBe("finishing…");
    expect(formatEta(40)).toBe("under a minute left");
    expect(formatEta(6 * 60 + 10)).toBe("about 6 min left");
    expect(formatEta(80 * 60)).toBe("about 1 h 20 min left");
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npx vitest run src/lib/__tests__/setup-state.test.ts src/lib/__tests__/mailbox-progress.test.ts`. Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/lib/setup-state.ts`:
```ts
// The server-side setup run of one domain: DNS → server → mailboxes → DKIM. Stored in domains.setup_state
// (src/server/domain-setup*.ts) and shown on the job board. Pure and browser-safe.

export const SETUP_STEPS = ["dns", "server", "mailboxes", "dkim"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export type StepStatus = "pending" | "running" | "done" | "failed";
export type SetupStatus = "queued" | "running" | "waiting" | "done" | "failed";
export type ServerChoice = "reuse" | "reinstall";

export interface SetupState {
  runId: string;
  status: SetupStatus;
  step: SetupStep | null;
  steps: Record<SetupStep, StepStatus>;
  attempt: number;
  error: string | null;
  /** Set while the run waits for the user to decide what to do with a server that already runs Mailcow. */
  waiting: null | { kind: "server-choice"; ip: string; hostname: string | null; otherDomains: string[] };
  serverChoice: ServerChoice | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export const STEP_LABELS: Record<SetupStep, string> = {
  dns: "DNS",
  server: "Server",
  mailboxes: "Mailboxes",
  dkim: "DKIM",
};

export function newSetupState(
  runId: string,
  nowIso: string,
  opts: { fromStep?: SetupStep; serverChoice?: ServerChoice | null } = {},
): SetupState {
  const from = opts.fromStep ? SETUP_STEPS.indexOf(opts.fromStep) : 0;
  const steps = Object.fromEntries(
    SETUP_STEPS.map((step, i) => [step, i < from ? "done" : "pending"]),
  ) as Record<SetupStep, StepStatus>;
  return {
    runId,
    status: "queued",
    step: null,
    steps,
    attempt: 0,
    error: null,
    waiting: null,
    serverChoice: opts.serverChoice ?? null,
    startedAt: nowIso,
    updatedAt: nowIso,
    finishedAt: null,
  };
}

export function mergeSetupState(prev: SetupState, patch: Partial<SetupState>, nowIso: string): SetupState {
  return { ...prev, ...patch, steps: { ...prev.steps, ...(patch.steps ?? {}) }, updatedAt: nowIso };
}

/** Queued, running or waiting for the user: a new run for this domain must not start. */
export function isActive(state: SetupState | null | undefined): boolean {
  return state?.status === "queued" || state?.status === "running" || state?.status === "waiting";
}

export function boardSummary(states: (SetupState | null | undefined)[]) {
  const summary = { done: 0, running: 0, waiting: 0, failed: 0, notStarted: 0 };
  for (const s of states) {
    if (!s) summary.notStarted++;
    else if (s.status === "done") summary.done++;
    else if (s.status === "waiting") summary.waiting++;
    else if (s.status === "failed") summary.failed++;
    else summary.running++;
  }
  return summary;
}
```

`src/lib/mailbox-progress.ts`:
```ts
// Progress of one mailbox-creation run: % and a time-left estimate from the measured rate. Stored in
// domains.mailbox_progress by the server and shown on the job board and the domain page. Pure and browser-safe.

export interface MailboxProgress {
  total: number;
  done: number;
  failed: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** Moving average of seconds per mailbox; null until the first mailbox is measured. */
  secondsPerMailbox: number | null;
}

// Weight of the newest measurement: high enough to follow a real slowdown, low enough that one slow mailbox
// doesn't swing the estimate.
const SMOOTHING = 0.3;

export function newMailboxProgress(total: number, nowIso: string): MailboxProgress {
  return { total, done: 0, failed: 0, startedAt: nowIso, updatedAt: nowIso, finishedAt: null, secondsPerMailbox: null };
}

/** `done` mailboxes are finished now; update the rate from the time since the last update. */
export function recordProgress(prev: MailboxProgress, done: number, nowMs: number): MailboxProgress {
  const delta = done - prev.done;
  if (delta <= 0) return prev;
  const elapsed = Math.max(0, (nowMs - new Date(prev.updatedAt).getTime()) / 1000);
  const sample = elapsed / delta;
  const rate = prev.secondsPerMailbox === null ? sample : SMOOTHING * sample + (1 - SMOOTHING) * prev.secondsPerMailbox;
  return { ...prev, done, updatedAt: new Date(nowMs).toISOString(), secondsPerMailbox: rate };
}

export function finishProgress(prev: MailboxProgress, done: number, failed: number, nowIso: string): MailboxProgress {
  return { ...prev, done, failed, updatedAt: nowIso, finishedAt: nowIso };
}

export function progressPercent(p: MailboxProgress): number {
  if (p.finishedAt || p.total <= 0) return 100;
  return Math.min(100, Math.floor(((p.done + p.failed) / p.total) * 100));
}

export function secondsLeft(p: MailboxProgress): number | null {
  if (p.finishedAt) return 0;
  if (p.secondsPerMailbox === null) return null;
  return Math.max(0, p.total - p.done - p.failed) * p.secondsPerMailbox;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null) return "estimating time left…";
  if (seconds <= 0) return "finishing…";
  if (seconds < 60) return "under a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  return `about ${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}
```

- [ ] **Step 4:** run the two tests and expect them to pass. Then run `npx tsc --noEmit`.
- [ ] **Step 5:** commit `feat(setup): run state and mailbox progress helpers`.

---

### Task 3: Mailbox progress reporting

**Files:**
- Modify: `src/server/mailbox-creation.ts`, with its test `src/server/__tests__/mailbox-creation.test.ts`
- Modify: `src/server/pipeline.ts` (`createMailboxes`)
- Modify: `src/server/mailcow.ts` (`setupMailcowDomain`)
- Create: `src/server/mailbox-progress-store.ts` (server-only)

**Interfaces:**
- **`MailboxCreationDeps`** gains an optional `onProgress?(done: number, total: number): void`. `runMailboxCreation` calls it:
  - once after the already-finished mailboxes are marked;
  - after every mailbox Mailcow accepts in any round;
  - once at the end.

  `done` = mailboxes finished (already done + accepted this run).
- **`createMailboxes(db, domain, existingDomains, opts?)`:** `opts` gains `onProgress?: (done: number, failed: number, total: number, finished: boolean) => void`. It's called from runMailboxCreation's callback, and once more at the end with the final counts and `finished: true`.
- **`src/server/mailbox-progress-store.ts`:** `createMailboxProgressWriter(db, domainId: string, total: number): { update(done: number): void; finish(done: number, failed: number): Promise<void> }`.
  - It writes `domains.mailbox_progress` using `newMailboxProgress` / `recordProgress` / `finishProgress`.
  - `update` persists at most every 2 s, fire-and-forget, logging DB errors.
  - `finish` always writes.

- [ ] **Step 1 (TDD):** add a test to `mailbox-creation.test.ts`, using the existing `fakeWorld` and a `progress` array fed by `onProgress: (done, total) => progress.push(\`${done}/${total}\`)`:
  - For `[inbox(1), inbox(2)]` with no existing mailboxes, expect `progress` to equal `["0/2", "1/2", "2/2", "2/2"]`: start, two accepts, end.
  - For `existing: ["user1@example.com"]` and `inbox(1, { hasPassword: true })`, expect the first entry to be `"1/1"`.

  Run the test and see it fail.
- [ ] **Step 2:** implement in `runMailboxCreation`:
  - call `deps.onProgress?.(alreadyDone.length, inboxes.length)` after the already-done `markActive`;
  - after each `accepted.add(ib.id)`, call `deps.onProgress?.(alreadyDone.length + accepted.size, inboxes.length)`;
  - before the return, call `deps.onProgress?.(inboxes.length - pending.length, inboxes.length)`.

  Run the tests until they pass.
- [ ] **Step 3:** `createMailboxes` passes `onProgress: (done, total) => opts?.onProgress?.(done, 0, total, false)` into the deps. After `runMailboxCreation` returns, it calls `opts?.onProgress?.(run.created, run.failed.length, run.total, true)`.
- [ ] **Step 4:** write `mailbox-progress-store.ts`. In `setupMailcowDomain`, build the writer from the planned inbox count (`db.select` count of `plannedInboxes` for the domain) and pass it to createMailboxes:
```ts
onProgress: (done, failed, total, finished) => (finished ? void writer.finish(done, failed) : writer.update(done))
```
- [ ] **Step 5:** run `npx tsc --noEmit` and `npx vitest run`. Commit `feat(setup): mailbox creation reports progress`.

---

### Task 4: One setup per server at a time

**Files:** modify `src/server/domain-locks.ts`; test `src/server/__tests__/domain-locks.test.ts`.

**Interfaces:**
- `claimServer(ip: string, owner: string, now?: number): { ok: true } | { ok: false; heldBy: string }`
- `releaseServer(ip: string, owner: string): void`

Both work the same way as the domain claims: the same owner may re-claim, and the claim goes stale after `STALE_CLAIM_MS`. They use a separate globalThis map `__serverClaims`, keyed by the trimmed, lower-cased IP.

- [ ] **Step 1 (TDD):** add tests:
  - two owners on one IP: the second is refused with `heldBy`;
  - the same owner can re-claim;
  - release by a non-owner is ignored;
  - a different IP is independent;
  - the claim goes stale after `STALE_CLAIM_MS`.

  Run them and see them fail.
- [ ] **Step 2:** implement next to the domain claims:
```ts
const g2 = globalThis as unknown as { __serverClaims?: Map<string, { owner: string; since: number }> };
const serverClaims = g2.__serverClaims ?? (g2.__serverClaims = new Map());
const ipKey = (ip: string) => ip.trim().toLowerCase();

/** One setup per server IP at a time: two Mailcow installs on one box would trample each other. */
export function claimServer(ip: string, owner: string, now = Date.now()): { ok: true } | { ok: false; heldBy: string } {
  const key = ipKey(ip);
  const current = serverClaims.get(key);
  if (current && now - current.since <= STALE_CLAIM_MS && current.owner !== owner) return { ok: false, heldBy: current.owner };
  serverClaims.set(key, { owner, since: now });
  return { ok: true };
}

export function releaseServer(ip: string, owner: string): void {
  const key = ipKey(ip);
  if (serverClaims.get(key)?.owner === owner) serverClaims.delete(key);
}
```
- [ ] **Step 3:** run the tests until they pass. Commit `feat(setup): one setup per server at a time`.

---

### Task 5: The step sequencer and the server-choice rule (pure)

**Files:**
- Create: `src/server/domain-setup-core.ts` (leaf: it imports only `@/lib/setup-state` types and helpers, by relative path `../lib/setup-state`)
- Test: `src/server/__tests__/domain-setup-core.test.ts`

**Interfaces:**
- `type ServerInspection = { hasMailcow: boolean; hostname: string | null; otherDomainsOnServer: string[]; ownInstallComplete: boolean; ownUnfinishedInstall: boolean }`
- `serverDecision(i: ServerInspection, choice: ServerChoice | null): "install" | "reuse" | "ask"`
- `interface SetupDeps`:
  - `load(): Promise<SetupState>`
  - `save(patch: Partial<SetupState>): Promise<SetupState>` (merge + persist; returns the merged state)
  - `log(line: string): void`
  - `dns(): Promise<void>`
  - `inspectServer(): Promise<ServerInspection & { ip: string }>`
  - `install(): Promise<void>`
  - `reuse(): Promise<void>`
  - `mailboxes(): Promise<{ created: number; failed: number; total: number }>`
  - `dkim(): Promise<void>`
- `runDomainSetup(deps: SetupDeps): Promise<"done" | "waiting">`. It throws the step's error after marking the step `failed`. The queue decides whether to retry.

- [ ] **Step 1 (TDD), tests:**
  - **`serverDecision`:**
    - no Mailcow → install;
    - `reinstall` → install;
    - `reuse` → reuse;
    - own complete install → reuse;
    - own unfinished install with no other domains → install;
    - own unfinished install with other domains → ask;
    - foreign Mailcow → ask.
  - **`runDomainSetup`:** use an in-memory fake that records calls and state:
    - fresh state: calls `dns`, `inspectServer`, `install`, `mailboxes`, `dkim` in order. All steps end `done`, status `done`, `finishedAt` set, result `"done"`.
    - state from `mailboxes` (earlier steps done): only `mailboxes` and `dkim` run.
    - Mailcow already there, no choice: returns `"waiting"`. Status is `waiting`, `waiting.kind` is `"server-choice"` with the IP and other domains, the server step is back to `pending`, and `mailboxes` is never called.
    - choice `reuse`: calls `reuse`, not `install`.
    - a step throwing `new Error("zone missing")`: rejects with it. `steps.dns` is `failed` and `error` is "zone missing".
    - `mailboxes` returning `{ failed: 2, total: 10 }`: throws "2 of 10 mailboxes couldn't be created" and marks the step failed.
    - resume: after a dns failure, a second call with the same fake (dns now succeeding) runs dns again and continues.
- [ ] **Step 2: implement**
```ts
import type { ServerChoice, SetupState, SetupStep } from "../lib/setup-state";
import { SETUP_STEPS } from "../lib/setup-state";

// The order and rules of one domain's setup run, with the real work injected (src/server/domain-setup.ts) so
// this is unit-tested with fakes. Leaf module: no database, SSH or queue imports.

export type ServerInspection = {
  hasMailcow: boolean;
  hostname: string | null;
  /** Other app domains that use the same server IP (names only). */
  otherDomainsOnServer: string[];
  /** This domain's own earlier install finished: domain is ready and its mail host is the server's. */
  ownInstallComplete: boolean;
  /** This domain's own earlier install didn't finish: domain isn't ready, but the server's mail host is mail.<domain> or the
   *  domain's saved mailcowHostname. */
  ownUnfinishedInstall: boolean;
};

/**
 * What to do with the server. Wiping an existing Mailcow deletes every mailbox on it, so that only happens when
 * the user chose it, or when the only Mailcow there is this domain's own unfinished install.
 */
export function serverDecision(i: ServerInspection, choice: ServerChoice | null): "install" | "reuse" | "ask" {
  if (!i.hasMailcow) return "install";
  if (choice === "reinstall") return "install";
  if (choice === "reuse") return "reuse";
  if (i.ownInstallComplete) return "reuse";
  if (i.ownUnfinishedInstall && i.otherDomainsOnServer.length === 0) return "install";
  return "ask";
}

export interface SetupDeps {
  load(): Promise<SetupState>;
  save(patch: Partial<SetupState>): Promise<SetupState>;
  log(line: string): void;
  dns(): Promise<void>;
  inspectServer(): Promise<ServerInspection & { ip: string }>;
  install(): Promise<void>;
  reuse(): Promise<void>;
  mailboxes(): Promise<{ created: number; failed: number; total: number }>;
  dkim(): Promise<void>;
}

export async function runDomainSetup(deps: SetupDeps): Promise<"done" | "waiting"> {
  let state = await deps.load();
  state = await deps.save({ status: "running", attempt: state.attempt + 1, error: null, waiting: null });

  for (const step of SETUP_STEPS) {
    if (state.steps[step] === "done") continue;
    state = await deps.save({ step, steps: { ...state.steps, [step]: "running" } });
    try {
      if (step === "server") {
        const inspection = await deps.inspectServer();
        const decision = serverDecision(inspection, state.serverChoice);
        if (decision === "ask") {
          deps.log(`Server ${inspection.ip} already runs Mailcow. Waiting for you to choose what to do.\n`);
          await deps.save({
            status: "waiting",
            steps: { ...state.steps, server: "pending" },
            waiting: { kind: "server-choice", ip: inspection.ip, hostname: inspection.hostname, otherDomains: inspection.otherDomainsOnServer },
          });
          return "waiting";
        }
        if (decision === "reuse") await deps.reuse();
        else await deps.install();
      } else if (step === "dns") {
        await deps.dns();
      } else if (step === "mailboxes") {
        const result = await deps.mailboxes();
        if (result.failed > 0) throw new Error(`${result.failed} of ${result.total} mailboxes couldn't be created`);
      } else {
        await deps.dkim();
      }
      state = await deps.save({ steps: { ...state.steps, [step]: "done" } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await deps.save({ steps: { ...state.steps, [step]: "failed" }, error: message });
      throw err;
    }
  }

  await deps.save({ status: "done", step: null, finishedAt: new Date().toISOString() });
  return "done";
}
```
- [ ] **Step 3:** run the tests until they pass, then run `npx tsc --noEmit`. Commit `feat(setup): step sequencer and server-choice rule`.

---

### Task 6: The real run on the queue

**Files:**
- Create: `src/server/domain-setup.ts` (server-only: real `SetupDeps`, state store, enqueue)
- Modify: `src/server/queue.ts`
- Modify: `src/server/provisioning.ts` (`provisionServer` delegates)

**Interfaces produced:**
- `saveSetupState(db, domainId: string, patch: Partial<SetupState>): Promise<SetupState>`: reads `domains.setup_state`, `mergeSetupState`, writes.
- `enqueueDomainSetup(opts: { domainId: string; userId: string; fromStep?: SetupStep; serverChoice?: ServerChoice | null }): Promise<{ runId: string }>`:
  - throws `busyMessage` if `isActive(current state)`;
  - writes `newSetupState(...)`;
  - adds a BullMQ job `"domain-setup"` with data `{ domainId, runId, lockOwner }`, using the same Redis-reachability check, duplicate check and timeouts as `startServerSetup`, or the in-process fallback.
- `executeDomainSetupJob(domainId: string, runId: string, logFn)`: builds the real deps and calls `runDomainSetup`.

**Required behaviour:**
1. **Refactor `executeProvisionJob` in `queue.ts` into reusable parts, without changing behaviour:**
   - `createDomainLogger(domainId, logFn, notice?)` returns `{ log, flush }`. It carries the throttled `terminalLogs` accumulation (2 s), the run separator, and a final flush in `finally`. The final flush fixes today's dropped last lines.
   - `installMailcowOnServer({ domainId, ipAddress, sshUser, sshPassword, domainName, log })`. It is exactly today's SSH connect → DNS un-proxy → hostname reuse → deploy script → API key capture → `status: "ready"` + `mailcowHostname` + `mailcowApiKey` sequence, and throws on failure after setting `status: "failed"`.
   - `executeProvisionJob` then becomes `installMailcowOnServer` followed by the existing mailbox + DKIM block, so `setup` jobs already in Redis still work.
2. **Real deps in `domain-setup.ts`:**
   - Each step loads the domain with `with: { server: true }`, workspace-agnostic. The run belongs to the domain's owner `domain.userId`, like today's queue.
   - **`dns`:** `resolveAndSaveCfZoneId(db, domain, domain.userId)`; if null, throw "No Cloudflare zone found for <domain>: add the domain to the Cloudflare account in Settings". Then `pushDns(db, domain, domain.userId)`; if `failed > 0`, throw with the first failing record's error. Then `unproxyDns(db, domain, domain.userId)`.
   - **`inspectServer`:**
     - SSH with the domain's credentials (the same fallback as `loadSshPassword`). Read `MAILCOW_HOSTNAME` from `/opt/mailcow-dockerized/mailcow.conf`; `hasMailcow` = the file exists.
     - Other app domains on the IP: a `domains` query with the same `ipAddress`, `id <> this`, across all users. Return names only for the same owner; count others as "another account's domain".
     - `ownInstallComplete`: `domain.status === "ready"` and `domain.mailcowHostname` equals the server hostname (case-insensitive).
     - `ownUnfinishedInstall`: the domain isn't ready, and the server hostname equals `mail.<domain>` or `domain.mailcowHostname`.
   - **`install`:**
     - claim the server IP (Task 4) with the run's lock owner. If held, throw `DelayedServerBusy`: the worker moves the job to delayed for 60 s without counting an attempt, as the domain claim does today.
     - `installMailcowOnServer(...)`;
     - release the IP in `finally`.
   - **`reuse`:** claim the IP the same way. `readMailcowConfigOverSsh(target, { wantApiKey: true })`; if there's no hostname or key, throw a clear error. Save `mailcowHostname`, `mailcowApiKey`, `status: "ready"` on the domain. Release the IP.
   - **`mailboxes`:** reload the domain, `ensureWorkingApiKey`, `ensureMailDomains`, `createMailboxes(..., { ssh, onProgress: writer })`, using the Task 3 writer. Return `{ created, failed, total }` from the summary.
   - **`dkim`:** `syncDkim(db, domain, domain.userId)`. If any result is `success: false`, throw with its error.
   - **`log`:** the domain logger from item 1. It writes to the terminal log with the current step as status.
3. **Worker:**
   - In the processor, branch on `job.name`:
     - `"domain-setup"` → claim the domain (`"server setup"`, owner = `job.data.lockOwner`), then `executeDomainSetupJob`.
     - Anything else keeps today's `runQueuedSetup`.
   - Keep the `setupPasses` de-duplication.
   - **Status on each attempt:**
     - at the start: `status: "running"` and `attempt`;
     - on an error with attempts left: leave the state `running`, with the failed step marked and `error` shown, and rethrow for BullMQ to retry;
     - on the final attempt: save `status: "failed"`, `finishedAt` and release the domain claim;
     - on `"done"` or `"waiting"`: release the domain claim.
4. **The in-process fallback (no Redis):** the same, using `inProcessSlots`, with up to 3 attempts and 30 s / 60 s waits between them.
5. **`provisionServer`:** keep its ownership lookup and SSH-credential validation, then call `enqueueDomainSetup({ domainId, userId, fromStep: "server" })` instead of `addServerSetupJob`. Keep the return shape `{ success, jobId }` using `runId`. `addServerSetupJob` stays exported for old jobs.
6. **Tests:** there's no DB in unit tests. Add a unit test for any new pure helper, for example a function deciding "final attempt" from `attemptsMade/attempts`. Everything else is covered by Task 11's local run.

- [ ] Implement the items above in small commits. After each commit run `npx tsc --noEmit && npx vitest run`, and after the worker changes also run `npm run build` and the leak grep. Commit messages: `refactor(setup): split server install out of the provisioning job`, `feat(setup): server-side domain setup runs on the queue`, `feat(setup): provisioning goes through the setup run`.

---

### Task 7: Server functions

**Files:**
- Create: `src/server/domain-setup-fns.ts` (createServerFn only)
- Modify: `src/server/domains.ts` (`addDomainsWizardAction` also returns `batchId`)

**Interfaces (all `requireAuth`, workspace-scoped):**
- `startDomainSetup({ data: { domainId, fromStep?, serverChoice? } })` → `{ ok, error, runId }`.
  - It checks that the domain is in the workspace, then calls `enqueueDomainSetup` with `userId: domain.userId`.
  - A missing domain returns "Domain not found". A busy domain returns its busy message.
- `startJobSetup({ data: { batchId } })` → `{ ok, started: number, skipped: number, errors: { domain: string; error: string }[] }`.
  - It loads the batch's domains in the workspace.
  - Skipped: those `isActive(setupState)`, or with `setupState.status === "done"`, or `status === "ready"` with no setup state.
  - It starts the rest one by one, collecting errors.
- `decideServerChoice({ data: { domainId, choice: "reuse" | "reinstall" } })` → `{ ok, error }`.
  - Only when `setupState.status === "waiting"` and `waiting.kind === "server-choice"`.
  - It sets the state to queued, with `serverChoice`, `waiting: null`, and the server step `pending`, and enqueues from `"server"` with that choice. `enqueueDomainSetup` must accept a waiting state when the caller passes the choice, not treat it as busy: add an `allowWaiting` flag.
- `getJobSetupBoard({ data: { batchId } })` → `{ domains: { id, name, ipAddress, status, setupState, mailboxProgress }[] }`, ordered by name.
- `getDomainSetup({ data: { domainId } })` → one such row, or null.

- [ ] Implement, then run tsc, tests, build and the leak grep. Commit `feat(setup): server functions for runs and the board`.

---

### Task 8: Job page board and wizard redirect

**Files:**
- Create: `src/components/SetupBoard.tsx` (plus small sub-components in the same folder if it grows past ~300 lines: `SetupRow.tsx`, `ServerChoicePanel.tsx`, `SetupLogDialog.tsx`)
- Modify: `src/routes/_app.jobs.$id.tsx`
- Modify: `src/components/AddDomainWizard.tsx`

**Required behaviour:**
- **`SetupBoard({ batchId })`:**
  - It uses `useQuery(["setup-board", batchId], getJobSetupBoard)` with `refetchInterval: 3000` while any row `isActive` (else off).
  - **Header:** **Set up everything** (calls `startJobSetup`, toasts started/skipped/errors, invalidates the board). Disable it when every row is done or active. Show the summary from `boardSummary`, e.g. "3 done · 2 running · 1 waiting for you · 1 needs attention · 4 not started".
  - **Each row:**
    - name, IP and the four step chips (✓ done, spinner running, ✕ failed, • pending);
    - a status line;
    - a progress bar (`progressPercent` during mailboxes; indeterminate while installing);
    - buttons: **Start** (no state, not ready) → `startDomainSetup`; **Retry** (failed) → `startDomainSetup({ fromStep: first failed step })`; **Open log** → dialog with the existing terminal stream (move the `TerminalWindow` log view out of the jobs page into `SetupLogDialog`; it attaches to `/api/sse?domainId=`).
  - **Status line text:**
    - queued: "Queued";
    - running on dns: "Setting up DNS…";
    - running on server: "Installing Mailcow (usually 20–40 min) · N min so far", from `updatedAt` of the step start;
    - running on mailboxes: "Mailboxes 240/500 · 48% · about 6 min left";
    - running on dkim: "Syncing DKIM…";
    - waiting: the choice panel;
    - failed: "Needs attention: <error>";
    - done: "Set up".
  - **Choice panel:**
    - "Server <ip> already runs Mailcow<hostname ? ` as ${hostname}` : ''>. Other domains using it: <list or 'none in this app'>."
    - **Add to existing Mailcow** → `decideServerChoice("reuse")`.
    - **Wipe & reinstall** → `confirm("This deletes every mailbox on <ip>, for every domain on that server. Continue?")`, then `decideServerChoice("reinstall")`.
  - It works at phone width: rows stack, buttons wrap.
- **Job page:**
  - Remove the PRE_FLIGHT / DNS_PUSH / SERVER_SETUP stepper (the step state, `PreFlightStep`, `DnsPushStep`, `ServerSetupStep`, the auto-jump effect, and the "Start Provisioning Pipeline" / "Go to Server Setup" buttons).
  - Render `<SetupBoard batchId={id} />` at the top of the VIEW content, above the health panels. Keep everything else in VIEW.
  - The `batchPushDnsToCloudflare` import may become unused; remove unused imports.
- **Wizard:** after success, if the response has a `batchId`, `navigate({ to: "/jobs/$id", params: { id: res.batchId } })` instead of the `domains[0]` navigation.

- [ ] Implement, then run tsc, tests, build and the leak grep. Commit `feat(setup): job setup board replaces the stepper; new jobs open on their job page`.

---

### Task 9: Domain page

**File:** modify `src/routes/_app.domains.$id.tsx`.

**Required behaviour:**
- **At the top:** this domain's setup row, reusing the SetupBoard row component with `getDomainSetup`, polling 3 s while active. It also has Start / Retry / Open log and the choice panel.
- **Run Full Automation:** calls `startDomainSetup({ domainId })` and toasts "Setup started — it keeps running if you close this page". Delete the client-side `runFullAutomation` loop and its 15-minute polling.
- **Wipe & re-provision:** after the existing confirm, calls `startDomainSetup({ domainId, fromStep: "server", serverChoice: "reinstall" })`.
- **Provision:** uses `provisionServer`, which now delegates; no change needed besides the toast text.
- **Manual mailbox runs** (Set up mailboxes / Retry N / Recreate / Change mailbox count): while one is pending, poll `getDomainSetup` every 2 s and show a progress bar with "Mailboxes N/M · P% · <formatEta>" under the mailbox section.

- [ ] Implement, then run tsc, tests, build and the leak grep. Commit `feat(setup): domain page uses the server-side run and shows mailbox progress`.

---

### Task 10: Supabase keep-alive

**Files:**
- Create: `src/server/keep-alive.ts` (Nitro plugin)
- Create: `src/server/keep-alive-core.ts` (leaf state + ping)
- Create: `src/server/system-status.ts` (createServerFn only)
- Modify: `vite.config.ts` (`plugins`)
- Modify: `src/routes/_app.settings.tsx`

**Required behaviour:**
- **`keep-alive-core.ts`:**
  - `KEEP_ALIVE_INTERVAL_MS = 12 * 60 * 60 * 1000`;
  - a globalThis-pinned status `{ lastOkAt: string | null; lastError: string | null; lastAttemptAt: string | null }`;
  - `pingDatabaseOnce(deps: { query(): Promise<void>; rest?: () => Promise<void> })` records ok or error and never throws;
  - `getKeepAliveState()`.

  Unit-test ok, error and the rest-optional behaviour.
- **`keep-alive.ts` plugin:** production only.
  - `query` = `getDb().execute(sql\`select 1\`)` (dynamic import of `./../lib/db` and drizzle `sql`).
  - `rest` when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set: `fetch(\`${url}/rest/v1/\`, { headers: { apikey: key, Authorization: \`Bearer ${key}\` } })`, treating non-2xx as an error.
  - Ping once 30 s after boot, then `setInterval` every 12 h (`unref()` the timer).
- **`getKeepAliveStatus`** (`requireAdmin`) returns the state.
- **Settings (admin only):** a small card, "Database keep-alive: last ping <relative time> · every 12 h", plus the last error if any.
- **Register in `vite.config.ts`:** `plugins: ["./src/server/start-queue-worker.ts", "./src/server/keep-alive.ts"]`.

- [ ] Implement with tests, then run tsc, tests, build and the leak grep. Commit `feat(ops): keep the Supabase project awake`.

---

### Task 11: Local end-to-end check (no real servers)

**File:** create `scripts/setup-e2e.ts`, in the same style as `scripts/accounts-e2e.ts` (reuse its HTTP calling approach; copy the small helpers).

**What it does:**
- Against a local build, with throwaway `SESSION_SECRET`/admin env, `REDIS_URL` empty (in-process runs):
  - create one throwaway active account with one domain `setup-<tag>.invalid` in a batch, IP `192.0.2.20`, SSH user `root`, SSH password `x`;
  - mint its session cookie;
  - `startJobSetup({ batchId })` → `started: 1`;
  - poll `getJobSetupBoard` for up to 120 s. Expect `setupState.status === "failed"`, `steps.dns === "failed"`, and an error mentioning Cloudflare. The DNS step fails because the account has no Cloudflare token or zone, and no SSH is attempted.
  - `startJobSetup` again → the failed domain is started again (a retry path) and fails the same way.
  - `startDomainSetup` while a run is active → refused with the busy message.
  - `decideServerChoice` on a non-waiting domain → refused.
  - another account's cookie → `getJobSetupBoard` returns no rows for this batch.
- Clean up every created row in `finally`.
- Then run the existing `scripts/accounts-e2e.ts` against the same local server.

- [ ] Implement and run it locally, following the local-server steps in plan `2026-09-18-user-accounts.md` Task 12 Steps 3–5. Expect all checks ok and 0 rows left. Commit `test(setup): end-to-end check of setup runs against a local build`.

---

### Task 12: Deploy

- [ ] Run the verification gate, then:
  - take a fresh backup, and run `migrate-user-accounts.ts --compare` with it (applies the new columns if not already);
  - check the queue is empty on the VPS;
  - upload and rebuild, following the steps in `docs/superpowers/plans/2026-09-18-user-accounts.md` Task 13 Steps 4–5.
- [ ] **Live checks:**
  - `/jobs/<id>` shows the board, via an admin session in the browser or an HTTP call to `getJobSetupBoard`;
  - `scripts/accounts-e2e.ts --flow-only` passes;
  - the app log shows the keep-alive ping after ~30 s ("keep-alive ok");
  - the queue worker is connected.
- [ ] **Update memory:** the setup run architecture and the "ask before wiping a shared server" rule.
