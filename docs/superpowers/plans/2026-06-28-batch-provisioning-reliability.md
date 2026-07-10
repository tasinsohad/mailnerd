# Batch Provisioning Reliability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make batch domain provisioning + mailbox creation durable, concurrent (3 at a time), and self-healing via a shared idempotent pipeline driven by a BullMQ/Upstash queue.

**Architecture:** Extract every provisioning step into one idempotent `pipeline.ts` module shared by the worker and the manual buttons. A BullMQ worker (concurrency 3) on Upstash Redis runs one pipeline job per domain with 3 retries; per-domain progress is persisted to `domains.setupSteps` and polled by the batch UI, while a single domain still streams live logs over SSE.

**Tech Stack:** TanStack Start (server functions), BullMQ + ioredis (Upstash Redis), Drizzle + Supabase Postgres, ssh2, vitest (new, for unit tests).

## Global Constraints

- Queue backend: BullMQ on Upstash Redis via `REDIS_URL` (TLS, `rediss://`). Batch enqueue MUST fail loudly if `REDIS_URL` is unset — no silent in-memory fallback.
- Concurrency: `PROVISION_CONCURRENCY` env, default `3`.
- Retries: `attempts: 3`, exponential backoff (30s base).
- Mailcow API calls go through `mailcowRequest()` (self-signed-cert tolerant). Mailcow returns HTTP 200 on failure — success is judged by body `type` AND verified via `get/*/all`.
- Mailcow add/domain fields: `mailboxes`, `quota` (domain total MB), `maxquota` (≤ quota), `defquota`. add/mailbox requires `password` AND `password2`.
- TXT records pushed to Cloudflare must be wrapped via `cfTxtContent()`.
- No new DB tables. Per-domain progress lives in `domains.setupSteps` (jsonb).
- Each domain is its own VPS; concurrency protects the app/worker, not the targets.

---

## File Structure

- Create `src/server/mailcow-helpers.ts` — pure, unit-testable helpers moved out of mailcow.ts: `parseMailcowResult`, `generateMailboxPassword`, `cfTxtContent`, `mailcowRequest`, quota constants.
- Create `src/server/pipeline.ts` — idempotent step functions + `runPipeline()`.
- Create `vitest.config.ts` and `src/server/__tests__/mailcow-helpers.test.ts`.
- Modify `src/server/mailcow.ts` — import from helpers + pipeline; server fns become thin wrappers.
- Modify `src/server/domains.ts` — `pushDns` core moves to pipeline; `cfTxtContent` re-exported from helpers; batch enqueue action.
- Modify `src/server/provisioning.ts` — `provisionServer` enqueues a pipeline job.
- Modify `src/server/queue.ts` — BullMQ "domain-pipeline" job runs `runPipeline`; concurrency/retries; fail-loud helper `requireQueue()`.
- Modify `src/routes/_app.jobs.$id.tsx` — replace browser loops with enqueue + status polling; per-domain Retry.
- Modify `src/routes/_app.domains.$id.tsx` — buttons enqueue; show step progress (live logs unchanged).
- Modify `package.json` — add `"test": "vitest run"`, devDeps `vitest`.

---

## Task 1: Test harness (vitest)

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (scripts + devDependencies)
- Test: `src/server/__tests__/smoke.test.ts`

- [ ] **Step 1: Install vitest**

Run: `npm i -D vitest`

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 3: Add script to package.json**

Add to `"scripts"`: `"test": "vitest run"`.

- [ ] **Step 4: Smoke test**

```ts
import { describe, it, expect } from "vitest";
describe("smoke", () => { it("runs", () => { expect(1 + 1).toBe(2); }); });
```

- [ ] **Step 5: Run** — `npm test` → Expected: 1 passed.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "test: add vitest harness"`

---

## Task 2: Extract pure Mailcow helpers + unit tests

**Files:**
- Create: `src/server/mailcow-helpers.ts`
- Test: `src/server/__tests__/mailcow-helpers.test.ts`
- Modify: `src/server/mailcow.ts` (import from helpers), `src/server/domains.ts` (re-export `cfTxtContent` from helpers)

**Interfaces — Produces:**
- `parseMailcowResult(resOk: boolean, json: unknown): { success: boolean; error?: string }`
- `generateMailboxPassword(): string`
- `cfTxtContent(type: string, content: string): string`
- `mailcowRequest(host: string, apiKey: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: unknown }>`
- `QUOTA = { DOMAIN_MAX_MAILBOXES: 50, DOMAIN_QUOTA_MB: 51200, MAILBOX_MAX_QUOTA_MB: 10240, MAILBOX_QUOTA_MB: 1024 }`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { parseMailcowResult, generateMailboxPassword, cfTxtContent } from "../mailcow-helpers";

describe("parseMailcowResult", () => {
  it("fails on !ok", () => expect(parseMailcowResult(false, []).success).toBe(false));
  it("fails on danger body even with HTTP ok", () => {
    expect(parseMailcowResult(true, [{ type: "danger", msg: "mailbox_quota_exceeds_domain_quota" }]).success).toBe(false);
  });
  it("succeeds only with a success entry and no errors", () => {
    expect(parseMailcowResult(true, [{ type: "success" }]).success).toBe(true);
  });
  it("fails when no success and no error (empty)", () => expect(parseMailcowResult(true, {}).success).toBe(false));
});

describe("generateMailboxPassword", () => {
  it("is 20 chars with all classes", () => {
    const p = generateMailboxPassword();
    expect(p.length).toBe(20);
    expect(/[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p)).toBe(true);
  });
});

describe("cfTxtContent", () => {
  it("wraps TXT in quotes", () => expect(cfTxtContent("TXT", "v=DMARC1")).toBe('"v=DMARC1"'));
  it("leaves already-quoted TXT", () => expect(cfTxtContent("TXT", '"x"')).toBe('"x"'));
  it("leaves non-TXT untouched", () => expect(cfTxtContent("A", "1.2.3.4")).toBe("1.2.3.4"));
});
```

- [ ] **Step 2: Run** — `npm test` → Expected: FAIL (module not found).

- [ ] **Step 3: Create `mailcow-helpers.ts`** — move the existing `parseMailcowResult`, `generateMailboxPassword`, `cfTxtContent`, `mailcowRequest`, and quota constants verbatim out of `mailcow.ts`/`domains.ts` into this file and `export` each. Keep `import https from "node:https"` and `import crypto from "node:crypto"` here.

- [ ] **Step 4: Re-point imports** — in `mailcow.ts` replace the local definitions with `import { parseMailcowResult, generateMailboxPassword, cfTxtContent, mailcowRequest, QUOTA } from "./mailcow-helpers";` and use `QUOTA.*` for the inline quota consts. In `domains.ts`, replace the local `cfTxtContent` with `export { cfTxtContent } from "./mailcow-helpers";`.

- [ ] **Step 5: Run** — `npm test` (pass) and `npx tsc --noEmit` (0 errors).

- [ ] **Step 6: Commit** — `git commit -am "refactor: extract testable mailcow helpers"`

---

## Task 3: Pipeline skeleton — types, context, progress

**Files:**
- Create: `src/server/pipeline.ts`
- Test: `src/server/__tests__/pipeline-progress.test.ts`

**Interfaces — Produces:**
- `type StepName = "pushDns" | "provision" | "ensureMailDomains" | "createMailboxes" | "syncDkim" | "verify"`
- `type StepState = "pending" | "running" | "ok" | "failed"`
- `type PipelineProgress = { currentStep: StepName | null; steps: Partial<Record<StepName, StepState>>; error: string | null; updatedAt: string }`
- `function mergeProgress(prev: PipelineProgress | null, patch: Partial<PipelineProgress>): PipelineProgress`
- `const ALL_STEPS: StepName[]`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { mergeProgress } from "../pipeline";

describe("mergeProgress", () => {
  it("merges step state without losing others", () => {
    const a = mergeProgress(null, { steps: { pushDns: "ok" } });
    const b = mergeProgress(a, { currentStep: "provision", steps: { provision: "running" } });
    expect(b.steps.pushDns).toBe("ok");
    expect(b.steps.provision).toBe("running");
    expect(b.currentStep).toBe("provision");
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement skeleton**

```ts
export type StepName = "pushDns" | "provision" | "ensureMailDomains" | "createMailboxes" | "syncDkim" | "verify";
export type StepState = "pending" | "running" | "ok" | "failed";
export interface PipelineProgress { currentStep: StepName | null; steps: Partial<Record<StepName, StepState>>; error: string | null; updatedAt: string; }
export const ALL_STEPS: StepName[] = ["pushDns","provision","ensureMailDomains","createMailboxes","syncDkim","verify"];
export function mergeProgress(prev: PipelineProgress | null, patch: Partial<PipelineProgress>): PipelineProgress {
  return {
    currentStep: patch.currentStep ?? prev?.currentStep ?? null,
    steps: { ...(prev?.steps ?? {}), ...(patch.steps ?? {}) },
    error: patch.error !== undefined ? patch.error : (prev?.error ?? null),
    updatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run** — pass. **Step 5: Commit** — `git commit -am "feat: pipeline progress model"`

---

## Task 4: Pipeline steps — ensureMailDomains, createMailboxes, verify

**Files:**
- Modify: `src/server/pipeline.ts`, `src/server/mailcow.ts`

**Interfaces — Consumes:** `mailcowRequest`, `parseMailcowResult`, `generateMailboxPassword`, `QUOTA` (Task 2). **Produces:**
- `ensureMailDomains(db, domain): Promise<{ existingDomains: Set<string>; errors: Record<string,string> }>`
- `createMailboxes(db, domain, existingDomains: Set<string>): Promise<{ created: number; failed: number; results: any[] }>`
- `verifyMailboxes(db, domain): Promise<{ total: number; active: number }>`

- [ ] **Step 1:** Move the domain-ensure, mailbox-create, and verify logic from `setupMailcowDomain` (mailcow.ts) into these three functions in `pipeline.ts`, preserving current behavior verbatim (correct field names, `password2`, GET-as-source-of-truth, password stored only when created this run).
- [ ] **Step 2:** Rewrite `setupMailcowDomain` handler to call `ensureMailDomains` → `createMailboxes` → `verifyMailboxes` and return `{ results, summary }` as before (thin wrapper). Add `recreate` handling (delete mailboxes) inside `createMailboxes` via an option.
- [ ] **Step 3:** `npx tsc --noEmit` → 0 errors.
- [ ] **Step 4: Manual integration** — `npx tsx verify-mailcow.ts atechperu.com` still shows domains+mailboxes; re-running setup is a no-op (idempotent).
- [ ] **Step 5: Commit** — `git commit -am "refactor: mailbox steps into pipeline"`

---

## Task 5: Pipeline steps — pushDns and syncDkim

**Files:** Modify `src/server/pipeline.ts`, `src/server/domains.ts`, `src/server/mailcow.ts`

**Interfaces — Produces:**
- `pushDns(db, domain): Promise<{ pushed: number; failed: number }>`
- `syncDkim(db, domain, userId): Promise<{ results: any[] }>`

- [ ] **Step 1:** Extract the Cloudflare push loop (zone resolve, per-record POST with `cfTxtContent`, skip `active`, store `cfRecordId`) from `pushDnsToCloudflare` into `pushDns(db, domain)` in pipeline.ts.
- [ ] **Step 2:** `pushDnsToCloudflare` server fn becomes a wrapper calling `pushDns`.
- [ ] **Step 3:** Extract the DKIM fetch + Cloudflare TXT upsert logic (using `mailcowRequest` for `get/dkim`, `cfTxtContent` for content, PUT/POST by `cfRecordId`) from `fetchDkimAndSync` (mailcow.ts) into `syncDkim(db, domain, userId)` in pipeline.ts; `fetchDkimAndSync` becomes a thin wrapper. (Requires the Cloudflare token from `userSecrets` — load it inside `syncDkim`.)
- [ ] **Step 4:** `npx tsc --noEmit` → 0 errors. **Step 5: Commit** — `git commit -am "refactor: pushDns + syncDkim into pipeline"`

---

## Task 6: Pipeline step — provision (idempotent)

**Files:** Modify `src/server/pipeline.ts`, `src/server/queue.ts`

**Interfaces — Produces:** `provision(domain, log): Promise<{ mailcowApiKey: string }>`

- [ ] **Step 1:** Move the SSH provisioning body of `executeProvisionJob` (connect, deploy script, API key capture/redaction, ACME preserve, SOGo restart, health check) into `provision(domain, log)` in pipeline.ts. Keep the deploy-script string as-is.
- [ ] **Step 2: Idempotency guard** — before running the heavy install, probe the API once:

```ts
const probe = await mailcowRequest(`mail.${domain.name}`, existingKey, "get/status/containers").catch(() => null);
if (probe && (probe.json as string)?.toString().includes("php-fpm-mailcow")) { log("Mailcow already healthy; skipping reinstall.\n","Configuring"); return { mailcowApiKey: existingKey }; }
```
(Use the domain's stored `mailcowApiKey` if present; only skip when healthy.)

- [ ] **Step 3:** `npx tsc --noEmit` → 0 errors. **Step 4: Commit** — `git commit -am "refactor: provision step + idempotency guard"`

---

## Task 7: runPipeline orchestrator

**Files:** Modify `src/server/pipeline.ts`
**Interfaces — Produces:** `runPipeline(domainId: string, steps: StepName[], log): Promise<void>` — runs steps in order, writes `mergeProgress` to `domains.setupSteps` before/after each, throws on first failing step (so BullMQ retries), persists `mailcowHostname`/`mailcowApiKey` after provision.

- [ ] **Step 1:** Implement `runPipeline`: load domain; for each step set `currentStep`+`running`, run it, set `ok`; on throw set `failed`+error and rethrow. After `provision`, persist host+key immediately (the early-save behavior).
- [ ] **Step 2:** `npx tsc --noEmit` → 0 errors. **Step 3: Commit** — `git commit -am "feat: runPipeline orchestrator"`

---

## Task 8: BullMQ pipeline job + fail-loud queue

**Files:** Modify `src/server/queue.ts`
**Interfaces — Produces:** `enqueueDomainPipeline(domainId: string, steps?: StepName[]): Promise<{ jobId: string }>`, `requireQueue(): Queue`

- [ ] **Step 1:** Replace the `server-setup` worker with a `domain-pipeline` worker whose handler calls `runPipeline(job.data.domainId, job.data.steps ?? ALL_STEPS, log)`; `log` publishes to `server-log:<domainId>` (existing SSE) with throttled DB flush.
- [ ] **Step 2:** Queue options: `defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 30000 }, removeOnComplete: 100, removeOnFail: false }`; worker `{ concurrency: Number(process.env.PROVISION_CONCURRENCY ?? 3) }`.
- [ ] **Step 3:** Worker `failed` event (attempts exhausted) → set `domains.status="failed"` + store `error` in `setupSteps`.
- [ ] **Step 4:** `requireQueue()` throws `"REDIS_URL is required for batch provisioning"` if the queue is null. `enqueueDomainPipeline` uses it (no in-memory fallback).
- [ ] **Step 5:** `npx tsc --noEmit` → 0. **Step 6: Integration** — with dev `REDIS_URL` set, enqueue one domain; confirm it runs to `ready`; restart the dev server mid-run and confirm the job resumes. **Step 7: Commit** — `git commit -am "feat: durable domain-pipeline queue"`

---

## Task 9: Enqueue paths + remove browser loops

**Files:** Modify `src/server/provisioning.ts`, `src/server/domains.ts`, `src/routes/_app.jobs.$id.tsx`, `src/routes/_app.domains.$id.tsx`

**Interfaces — Produces:** server fn `enqueuePipeline({ domainId, steps? })`; server fn `enqueueBatch({ batchId })`.

- [ ] **Step 1:** `provisionServer` and the domain-page buttons call `enqueueDomainPipeline` (full or subset of steps) instead of the old in-memory path; set status `queued`.
- [ ] **Step 2:** `enqueueBatch` enqueues a pipeline job for every domain in the batch.
- [ ] **Step 3:** In `_app.jobs.$id.tsx`, replace `handleBatchRecreateMailboxes`/`handleBatchWipeReprovision` browser `for await` loops with single `enqueueBatch` calls (recreate = enqueue with `steps:["ensureMailDomains","createMailboxes","verify"]` + recreate flag; wipe = full pipeline).
- [ ] **Step 4:** Per-domain **Retry** button (failed domains) calls `enqueuePipeline`.
- [ ] **Step 5:** `npx tsc --noEmit` → 0. **Step 6: Commit** — `git commit -am "feat: enqueue pipeline; remove browser loops"`

---

## Task 10: Batch status polling UI (minimal)

**Files:** Modify `src/routes/_app.jobs.$id.tsx`

- [ ] **Step 1:** Add a react-query poll (`refetchInterval: 3000`) on `getBatchDetails` while any domain is `queued`/`provisioning`/`configuring`.
- [ ] **Step 2:** Render a per-domain status row from `domains.status` + `setupSteps.currentStep` (e.g. "Step 3/6 · provision") with a Retry button on `failed` showing `setupSteps.error`.
- [ ] **Step 3:** `npx tsc --noEmit` → 0. **Step 4: Manual:** enqueue a 4-domain batch with `PROVISION_CONCURRENCY=3`; confirm 3 run + 1 queued; break one and confirm `failed`+error+retry works. **Step 5: Commit** — `git commit -am "feat: batch status polling UI"`

---

## Task 11: End-to-end verification

- [ ] **Step 1:** `npm test` (all unit tests pass) + `npx tsc --noEmit` (0 errors).
- [ ] **Step 2:** Enqueue a real batch (2–3 domains) against dev Upstash; confirm concurrency 3, retries on induced failure, durability across restart, and `verify-mailcow.ts` shows all mailboxes active.
- [ ] **Step 3:** Final commit — `git commit -am "chore: batch provisioning reliability complete"`
