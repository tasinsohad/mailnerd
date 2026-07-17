# Smart Auto-Heal (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Domains health card and Jobs pipeline a condition-aware "Auto-heal" that diagnoses server/domain problems, builds an ordered remediation plan, shows it for approval, then executes it with verify + retry — driven by one deterministic planner shared with the Troubleshoot page.

**Architecture:** A pure `remediation-planner.ts` turns a health snapshot (domain + server indicators) into an ordered `RemediationPlan` of steps (each maps to an existing fix) plus `manual` items it deliberately won't auto-run. A server-side executor runs a plan's steps in dependency order, re-checks, and streams to the live console. The Domains card, Jobs pipeline, and Troubleshoot page all call the same planner.

**Tech Stack:** TanStack Start server functions, React 19, Drizzle, Vitest, the existing `server-fixes.ts` (SSH fixes), `health-checks.ts` (diagnostics), `console-bus.ts` (SSE), `health-guidance.ts` (why-copy).

## Global Constraints

- Scope is Phase 1 only (deterministic auto-heal). Phase 2 (LLM escalation) is a separate plan.
- Deterministic planner: same input health → same plan. No LLM, no randomness.
- Never auto-flush the queue for a provider port-25 block or a reputation/5xx problem — surface as `manual`.
- Dependency order is canonical: **restart (foundation) → createApiKey → un-proxy → firewall → auth (pushDns/syncDkim) → forcePostfixIPv4 → flushQueue (last)**. If the box is down (`containers`/`listeners` fail), the plan is ONLY `restartMailcow`; everything else waits for the post-restart re-check.
- `target: "server"` steps SSH to the box (deduped by IP in a job). `target: "domain"` steps hit a per-domain DNS zone / Mailcow API (never deduped).
- Reuse existing fixes; do not reimplement SSH or DNS logic. New work is the planner, the executor, the panel, and three thin `*ForDomain` server fns.
- All new/changed TS must pass `npx tsc --noEmit`. Run `npx vitest run` before every commit.

---

### Task 1: New HealthActions + domain-scoped SSH fixes + fix registry wiring

**Files:**
- Modify: `src/server/health-types.ts` (add 3 actions to `HealthAction`)
- Modify: `src/server/server-fixes.ts` (add 3 `*ForDomain` server fns, mirroring `restartMailcowForDomain`)
- Modify: `src/lib/health-fixes.ts` (`ACTION_LABEL`, `ACTION_ORDER`, `DESTRUCTIVE_ACTIONS`, `runHealthFix`)
- Test: `src/lib/__tests__/health-fixes.test.ts` (new)

**Interfaces:**
- Produces: `HealthAction` now includes `"forcePostfixIPv4" | "flushQueue" | "createApiKey"`.
- Produces: `flushQueueForDomain`, `forcePostfixIPv4ForDomain`, `createApiKeyForDomain` (server fns, input `{ domainId: string }`, return `{ error } | { success: true, detail }`).
- Produces: `runHealthFix(action, domainId)` handles all three new actions.

- [ ] **Step 1: Add the three actions to `HealthAction`**

In `src/server/health-types.ts`, change the union:

```ts
export type HealthAction =
  | "pushDns"
  | "syncDkim"
  | "fixDns"
  | "openFirewall"
  | "restartMailcow"
  | "forcePostfixIPv4"
  | "flushQueue"
  | "createApiKey"
  | "recreate"
  | "provision";
```

- [ ] **Step 2: Add three domain-scoped server fns to `server-fixes.ts`**

After the existing `openFirewallForDomain` in `src/server/server-fixes.ts`, add (they reuse `targetForDomain` and the existing `fix*` helpers):

```ts
export const flushQueueForDomain = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(domainInput)
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    const { target, error } = await targetForDomain(db, userId, data.domainId);
    if (error || !target) return { error };
    const r = await fixFlushQueue(target);
    return r.status === "failed" ? { error: r.detail } : { success: true, detail: r.detail };
  });

export const forcePostfixIPv4ForDomain = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(domainInput)
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    const { target, error } = await targetForDomain(db, userId, data.domainId);
    if (error || !target) return { error };
    const r = await fixPostfixIpv4Only(target);
    return r.status === "failed" ? { error: r.detail } : { success: true, detail: r.detail };
  });

export const createApiKeyForDomain = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(domainInput)
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    const { target, error } = await targetForDomain(db, userId, data.domainId);
    if (error || !target) return { error };
    const r = await fixCreateApiKey(target);
    return r.status === "failed" ? { error: r.detail } : { success: true, detail: r.detail };
  });
```

- [ ] **Step 3: Wire the actions into the fix registry**

In `src/lib/health-fixes.ts`, update the import and the four maps:

```ts
import {
  restartMailcowForDomain,
  openFirewallForDomain,
  flushQueueForDomain,
  forcePostfixIPv4ForDomain,
  createApiKeyForDomain,
} from "@/server/server-fixes";
```

`ACTION_LABEL` — add: `forcePostfixIPv4: "Force IPv4"`, `flushQueue: "Flush queue"`, `createApiKey: "Create API key"`.

`ACTION_ORDER` — insert after `openFirewall`, before `recreate`: `"createApiKey", "forcePostfixIPv4", "flushQueue"`.

`DESTRUCTIVE_ACTIONS` — add `"restartMailcow"` (already present), `"createApiKey"`, `"forcePostfixIPv4"` (all briefly interrupt mail).

`runHealthFix` switch — add three cases:

```ts
    case "flushQueue":
      return flushQueueForDomain({ data: { domainId } });
    case "forcePostfixIPv4":
      return forcePostfixIPv4ForDomain({ data: { domainId } });
    case "createApiKey":
      return createApiKeyForDomain({ data: { domainId } });
```

- [ ] **Step 4: Write the failing test for the registry maps**

Create `src/lib/__tests__/health-fixes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ACTION_LABEL, ACTION_ORDER, DESTRUCTIVE_ACTIONS } from "../health-fixes";

describe("health-fixes registry covers the new actions", () => {
  const NEW = ["forcePostfixIPv4", "flushQueue", "createApiKey"] as const;

  it("labels every new action", () => {
    for (const a of NEW) expect(ACTION_LABEL[a]).toBeTruthy();
  });

  it("orders every new action", () => {
    for (const a of NEW) expect(ACTION_ORDER).toContain(a);
  });

  it("marks the disruptive ones destructive (they interrupt mail)", () => {
    expect(DESTRUCTIVE_ACTIONS.has("forcePostfixIPv4")).toBe(true);
    expect(DESTRUCTIVE_ACTIONS.has("createApiKey")).toBe(true);
    // a plain flush is not destructive
    expect(DESTRUCTIVE_ACTIONS.has("flushQueue")).toBe(false);
  });
});
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/lib/__tests__/health-fixes.test.ts && npx tsc --noEmit`
Expected: 3 tests PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/health-types.ts src/server/server-fixes.ts src/lib/health-fixes.ts src/lib/__tests__/health-fixes.test.ts
git commit -m "feat(heal): add flushQueue/forcePostfixIPv4/createApiKey actions + domain-scoped fixes"
```

---

### Task 2: The deterministic remediation planner (pure core)

**Files:**
- Create: `src/server/remediation-planner.ts`
- Test: `src/server/__tests__/remediation-planner.test.ts`

**Interfaces:**
- Consumes: `DomainHealth`, `HealthAction` from `./health-types`.
- Produces:
  ```ts
  type RemediationTarget = "server" | "domain";
  interface RemediationStep { id: string; action: HealthAction; target: RemediationTarget; label: string; why: string; disruptive: boolean; }
  interface ManualItem { id: string; label: string; why: string; }
  interface RemediationPlan { steps: RemediationStep[]; manual: ManualItem[]; summary: string; }
  interface PlannerContext { hasCloudflareToken?: boolean; }
  function buildRemediationPlan(domainHealth: DomainHealth | null, serverHealth: DomainHealth | null, ctx?: PlannerContext): RemediationPlan;
  ```

- [ ] **Step 1: Write the failing tests (all fixture cases)**

Create `src/server/__tests__/remediation-planner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildRemediationPlan } from "../remediation-planner";
import type { DomainHealth, HealthStatus } from "../health-types";

// Build a health snapshot from { indicatorId: status }.
function mk(inds: Record<string, HealthStatus>): DomainHealth {
  return {
    status: "critical",
    score: 0,
    checkedAt: "2026-07-18T00:00:00Z",
    indicators: Object.entries(inds).map(([id, status]) => ({ id, label: id, status, detail: "" })),
  };
}
const ids = (p: { steps: { id: string }[] }) => p.steps.map((s) => s.id);
const manualIds = (p: { manual: { id: string }[] }) => p.manual.map((m) => m.id);

describe("buildRemediationPlan", () => {
  it("all healthy → empty plan", () => {
    const p = buildRemediationPlan(mk({ mx: "ok", spf: "ok", dkim: "ok", dmarc: "ok" }), mk({ queue: "ok", port25: "ok" }), {});
    expect(p.steps).toEqual([]);
    expect(p.manual).toEqual([]);
    expect(p.summary).toContain("0 fix");
  });

  it("box down (containers fail) → ONLY restartMailcow, defer the rest", () => {
    const p = buildRemediationPlan(mk({ mx: "fail" }), mk({ containers: "fail", queue: "fail", firewall: "fail" }), {});
    expect(ids(p)).toEqual(["restartMailcow"]);
    expect(p.steps[0].disruptive).toBe(true);
  });

  it("listeners missing → restartMailcow first, nothing else", () => {
    const p = buildRemediationPlan(null, mk({ listeners: "fail", queue: "fail" }), {});
    expect(ids(p)).toEqual(["restartMailcow"]);
  });

  it("queue stuck + IPv6 stall → forcePostfixIPv4, NO separate flush", () => {
    const p = buildRemediationPlan(null, mk({ ipv6: "fail", queue: "fail", port25: "ok" }), {});
    expect(ids(p)).toContain("forcePostfixIPv4");
    expect(ids(p)).not.toContain("flushQueue");
  });

  it("queue stuck + port 25 blocked → manual relayhost, NO flush", () => {
    const p = buildRemediationPlan(null, mk({ queue: "fail", port25: "fail" }), {});
    expect(ids(p)).not.toContain("flushQueue");
    expect(manualIds(p)).toContain("queue-port25");
  });

  it("queue stuck + blacklisted → manual reputation, NO flush", () => {
    const p = buildRemediationPlan(null, mk({ queue: "fail", port25: "ok", blacklist: "fail" }), {});
    expect(ids(p)).not.toContain("flushQueue");
    expect(manualIds(p)).toContain("queue-reputation");
  });

  it("queue stuck + everything else fine → flushQueue", () => {
    const p = buildRemediationPlan(mk({ dkim: "ok", spf: "ok", dmarc: "ok" }), mk({ queue: "fail", port25: "ok" }), {});
    expect(ids(p)).toContain("flushQueue");
  });

  it("mail host proxied + Cloudflare token → fixDns step", () => {
    const p = buildRemediationPlan(null, mk({ mailhost: "fail" }), { hasCloudflareToken: true });
    expect(ids(p)).toContain("fixDns");
    expect(p.steps.find((s) => s.id === "fixDns")!.target).toBe("domain");
  });

  it("mail host proxied + NO token → manual fixDns", () => {
    const p = buildRemediationPlan(null, mk({ mailhost: "fail" }), { hasCloudflareToken: false });
    expect(ids(p)).not.toContain("fixDns");
    expect(manualIds(p)).toContain("fixDns");
  });

  it("domain auth broken → pushDns + syncDkim, target domain", () => {
    const p = buildRemediationPlan(mk({ mx: "fail", spf: "warn", dkim: "fail", dmarc: "ok" }), mk({ queue: "ok" }), {});
    expect(ids(p)).toContain("pushDns");
    expect(ids(p)).toContain("syncDkim");
    for (const id of ["pushDns", "syncDkim"]) expect(p.steps.find((s) => s.id === id)!.target).toBe("domain");
  });

  it("ordering invariant: auth before forcePostfixIPv4 before flushQueue; flush is last", () => {
    const p = buildRemediationPlan(mk({ mx: "fail", dkim: "fail" }), mk({ firewall: "fail", ipv6: "fail", queue: "fail", port25: "ok" }), { hasCloudflareToken: true });
    const order = ids(p);
    // no flushQueue here (ipv6 present), but forcePostfixIPv4 comes after pushDns/syncDkim/openFirewall
    expect(order.indexOf("pushDns")).toBeLessThan(order.indexOf("forcePostfixIPv4"));
    expect(order.indexOf("openFirewall")).toBeLessThan(order.indexOf("forcePostfixIPv4"));
  });

  it("blacklist alone → manual, no step", () => {
    const p = buildRemediationPlan(null, mk({ blacklist: "fail", queue: "ok" }), {});
    expect(p.steps).toEqual([]);
    expect(manualIds(p)).toContain("blacklist");
  });

  it("missing PTR (fcrdns fail) → manual ptr", () => {
    const p = buildRemediationPlan(null, mk({ fcrdns: "fail" }), {});
    expect(manualIds(p)).toContain("ptr");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server/__tests__/remediation-planner.test.ts`
Expected: FAIL — "Cannot find module '../remediation-planner'".

- [ ] **Step 3: Implement the planner**

Create `src/server/remediation-planner.ts`:

```ts
// Deterministic remediation planner. Pure — no I/O, like health-checks.ts. Given a domain + server
// health snapshot, produce an ordered plan of fixes plus the items it deliberately won't auto-run.
// Canonical order (cause before symptom): restart → createApiKey → un-proxy → firewall →
// auth (pushDns/syncDkim) → forcePostfixIPv4 → flushQueue (last). If the box is down, the plan is
// ONLY restartMailcow and everything else waits for the post-restart re-check.

import type { DomainHealth, HealthAction, HealthStatus } from "./health-types";

export type RemediationTarget = "server" | "domain";

export interface RemediationStep {
  id: string;
  action: HealthAction;
  target: RemediationTarget;
  label: string;
  why: string;
  disruptive: boolean;
}
export interface ManualItem {
  id: string;
  label: string;
  why: string;
}
export interface RemediationPlan {
  steps: RemediationStep[];
  manual: ManualItem[];
  summary: string;
}
export interface PlannerContext {
  hasCloudflareToken?: boolean;
}

function statusOf(health: DomainHealth | null, id: string): HealthStatus | "absent" {
  const ind = health?.indicators.find((i) => i.id === id);
  return ind ? ind.status : "absent";
}
const bad = (s: HealthStatus | "absent") => s === "fail" || s === "warn";

export function buildRemediationPlan(
  domainHealth: DomainHealth | null,
  serverHealth: DomainHealth | null,
  ctx: PlannerContext = {},
): RemediationPlan {
  const steps: RemediationStep[] = [];
  const manual: ManualItem[] = [];
  const sv = (id: string) => statusOf(serverHealth, id);
  const dm = (id: string) => statusOf(domainHealth, id);

  const boxDown = sv("containers") === "fail" || sv("listeners") === "fail";

  if (boxDown) {
    steps.push({
      id: "restartMailcow",
      action: "restartMailcow",
      target: "server",
      label: "Restart Mailcow",
      why: "Core mail containers are down or not listening — bring the stack up before anything else, then re-check.",
      disruptive: true,
    });
  } else {
    // Foundation
    if (sv("mailcow") === "warn") {
      steps.push({
        id: "createApiKey",
        action: "createApiKey",
        target: "server",
        label: "Create Mailcow API key",
        why: "The Mailcow API isn't usable; create a key scoped to this app so container and DKIM checks can run.",
        disruptive: true,
      });
    }
    // Reachability
    if (sv("mailhost") === "fail" || sv("fcrdns") === "warn") {
      if (ctx.hasCloudflareToken) {
        steps.push({
          id: "fixDns",
          action: "fixDns",
          target: "domain",
          label: "Un-proxy mail host",
          why: "The mail host is behind Cloudflare's proxy; SMTP, IMAP and the API need it DNS-only.",
          disruptive: false,
        });
      } else {
        manual.push({
          id: "fixDns",
          label: "Un-proxy mail host",
          why: "The mail host is Cloudflare-proxied but no Cloudflare token is configured. Set it DNS-only manually.",
        });
      }
    }
    if (sv("firewall") === "fail") {
      steps.push({
        id: "openFirewall",
        action: "openFirewall",
        target: "server",
        label: "Open mail ports",
        why: "The host firewall is blocking mail ports; allow 25/465/587/993/995/80/443.",
        disruptive: false,
      });
    }
    // Authentication (before any flush — retried mail must pass auth)
    if (bad(dm("mx")) || bad(dm("spf")) || bad(dm("dmarc"))) {
      steps.push({
        id: "pushDns",
        action: "pushDns",
        target: "domain",
        label: "Push DNS records",
        why: "MX / SPF / DMARC are missing or incomplete; publish them to Cloudflare.",
        disruptive: false,
      });
    }
    if (bad(dm("dkim"))) {
      steps.push({
        id: "syncDkim",
        action: "syncDkim",
        target: "domain",
        label: "Sync DKIM",
        why: "The DKIM key is missing or doesn't match Mailcow; publish the current key.",
        disruptive: false,
      });
    }
    // Delivery connectivity
    const ipv6Stall = sv("ipv6") === "fail";
    if (ipv6Stall) {
      steps.push({
        id: "forcePostfixIPv4",
        action: "forcePostfixIPv4",
        target: "server",
        label: "Force Postfix to IPv4",
        why: "Mail is stalling on broken IPv6 while IPv4 works; switch Postfix to IPv4 and retry the queue.",
        disruptive: true,
      });
    }
    // Queue (last) — smart branch
    if (bad(sv("queue"))) {
      if (ipv6Stall) {
        // forcePostfixIPv4 already retries the queue — no separate flush.
      } else if (sv("port25") === "fail") {
        manual.push({
          id: "queue-port25",
          label: "Mail queue (port 25 blocked)",
          why: "The queue is stuck on outbound-25 blocks. A flush won't help — unblock port 25 with the provider or set a relayhost.",
        });
      } else if (sv("blacklist") === "fail" || bad(dm("dkim")) || bad(dm("spf")) || bad(dm("dmarc"))) {
        manual.push({
          id: "queue-reputation",
          label: "Mail queue (rejections)",
          why: "The queue is stuck on remote rejections. A flush won't help — fix IP reputation and SPF/DKIM/DMARC first.",
        });
      } else {
        steps.push({
          id: "flushQueue",
          action: "flushQueue",
          target: "server",
          label: "Flush mail queue",
          why: "Retry the deferred mail now that the blockers are cleared.",
          disruptive: false,
        });
      }
    }
  }

  // Always-manual items (independent of box state), de-duped against the queue-reputation note.
  if (sv("blacklist") === "fail" && !manual.some((m) => m.id === "queue-reputation")) {
    manual.push({
      id: "blacklist",
      label: "IP blacklisted",
      why: "The IP is on a blacklist. Request delisting at the provider — this can't be auto-fixed.",
    });
  }
  if (sv("fcrdns") === "fail") {
    manual.push({
      id: "ptr",
      label: "Reverse DNS (PTR)",
      why: "PTR is missing or wrong. Set it in your VPS panel (deferred to the deliverability-foundation work).",
    });
  }

  const summary =
    `${steps.length} fix${steps.length === 1 ? "" : "es"}` +
    (manual.length ? `, ${manual.length} manual` : "");
  return { steps, manual, summary };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/remediation-planner.test.ts && npx tsc --noEmit`
Expected: all PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/remediation-planner.ts src/server/__tests__/remediation-planner.test.ts
git commit -m "feat(heal): deterministic remediation planner (pure core)"
```

---

### Task 3: Executor server fn `runRemediationPlan` (single domain)

**Files:**
- Create: `src/server/remediation.ts`
- Test: `src/server/__tests__/remediation-dedup.test.ts` (created in Task 4; nothing pure to unit-test here — verified by typecheck + a live run in Task 6)

**Interfaces:**
- Consumes: `buildRemediationPlan`, `PlannerContext` (Task 2); `targetForDomain`-style creds; `fix*` helpers from `server-fixes.ts`; `unproxyDns` (from `pipeline.ts`); `checkDomainHealth`/`checkServerHealth` via a re-check; `ConsoleLog` from `console-bus.ts`.
- Produces: `runRemediationPlan` (server fn, input `{ domainId: string; stepIds?: string[]; runId?: string }`) → `{ error } | { ranSteps: {id,status,detail}[]; remaining: string[]; plan: RemediationPlan; transcript: ConsoleLine[] }`.
- Produces (exported helper for the executor's dispatch, so Task 8 can reuse it): `executeStep(step, execCtx, log)`.

- [ ] **Step 1: Implement the step dispatch + executor**

Create `src/server/remediation.ts`:

```ts
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { domains, userSecrets } from "@/lib/db/schema";
import {
  fixRestartMailcow,
  fixOpenFirewall,
  fixFlushQueue,
  fixPostfixIpv4Only,
  fixCreateApiKey,
  type SshTarget,
} from "./server-fixes";
import { unproxyDns } from "./pipeline";
import { buildRemediationPlan, type RemediationStep, type PlannerContext } from "./remediation-planner";
import { ConsoleLog } from "./console-bus";
import { runDomainHealthCore } from "./health-actions"; // added in Step 2

export interface StepResult {
  id: string;
  status: "fixed" | "noop" | "failed";
  detail: string;
}

// Run one step. Server-target steps SSH via the box creds; domain-target steps hit the DNS/API.
export async function executeStep(
  step: RemediationStep,
  ctx: { db: any; userId: string; domain: any; target: SshTarget | null },
  log: ConsoleLog,
): Promise<StepResult> {
  const asResult = (r: { status: "fixed" | "noop" | "failed"; detail: string }): StepResult => ({
    id: step.id,
    status: r.status,
    detail: r.detail,
  });
  try {
    if (step.target === "server") {
      if (!ctx.target) return { id: step.id, status: "failed", detail: "No SSH credentials for this server." };
      switch (step.action) {
        case "restartMailcow":
          return asResult(await fixRestartMailcow(ctx.target, log));
        case "openFirewall":
          return asResult(await fixOpenFirewall(ctx.target, log));
        case "forcePostfixIPv4":
          return asResult(await fixPostfixIpv4Only(ctx.target, log));
        case "flushQueue":
          return asResult(await fixFlushQueue(ctx.target, log));
        case "createApiKey":
          return asResult(await fixCreateApiKey(ctx.target, log));
        default:
          return { id: step.id, status: "failed", detail: `Unhandled server action ${step.action}` };
      }
    }
    // domain-target
    switch (step.action) {
      case "fixDns": {
        log.info(`Un-proxying the mail host for ${ctx.domain.name}…`);
        const r = await unproxyDns(ctx.db, ctx.domain, ctx.userId);
        return { id: step.id, status: "fixed", detail: `Un-proxied (${r.unproxied} records, ${r.removed} removed).` };
      }
      case "pushDns": {
        const { pushDnsForDomain } = await import("./domains-heal"); // thin helper, Step 3
        const r = await pushDnsForDomain(ctx.db, ctx.domain, ctx.userId, log);
        return { id: step.id, status: r.ok ? "fixed" : "failed", detail: r.detail };
      }
      case "syncDkim": {
        const { syncDkimForDomain } = await import("./domains-heal");
        const r = await syncDkimForDomain(ctx.db, ctx.domain, ctx.userId, log);
        return { id: step.id, status: r.ok ? "fixed" : "failed", detail: r.detail };
      }
      default:
        return { id: step.id, status: "failed", detail: `Unhandled domain action ${step.action}` };
    }
  } catch (e) {
    return { id: step.id, status: "failed", detail: e instanceof Error ? e.message : String(e) };
  }
}

const planInput = (d: unknown) =>
  z.object({ domainId: z.string(), stepIds: z.array(z.string()).optional(), runId: z.string().trim().optional() }).parse(d);

export const runRemediationPlan = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(planInput)
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    if (!db) return { error: "Database not connected" };
    const domain = await db.query.domains.findFirst({ where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)) });
    if (!domain) return { error: "Domain not found" };

    const log = new ConsoleLog(data.runId);
    const target: SshTarget | null =
      domain.ipAddress && domain.sshPassword
        ? { ipAddress: domain.ipAddress, sshUser: domain.sshUser || "root", sshPassword: domain.sshPassword }
        : null;
    const secrets = await db.query.userSecrets.findFirst({ where: eq(userSecrets.userId, userId) });
    const pctx: PlannerContext = { hasCloudflareToken: !!secrets?.cfApiToken };

    // Fresh diagnose → plan.
    const { health, serverHealth } = await runDomainHealthCore(db, userId, domain);
    let plan = buildRemediationPlan(health, serverHealth, pctx);
    let steps = plan.steps;
    if (data.stepIds?.length) steps = steps.filter((s) => data.stepIds!.includes(s.id));

    log.info(`Auto-heal for ${domain.name}: ${steps.length} step(s).`);
    const ranSteps: StepResult[] = [];
    for (const step of steps) {
      log.cmd(step.label);
      const r = await executeStep(step, { db, userId, domain, target }, log);
      ranSteps.push(r);
    }

    // Re-check and report what remains among the steps we targeted.
    const after = await runDomainHealthCore(db, userId, domain);
    const rechecked = buildRemediationPlan(after.health, after.serverHealth, pctx);
    const targetedIds = new Set(steps.map((s) => s.id));
    const remaining = rechecked.steps.filter((s) => targetedIds.has(s.id)).map((s) => s.id);
    log.info(`Done. ${ranSteps.filter((r) => r.status === "fixed").length} applied, ${remaining.length} still failing.`);

    return { ranSteps, remaining, plan, transcript: log.transcript() };
  });
```

- [ ] **Step 2: Extract a reusable `runDomainHealthCore` from `health-actions.ts`**

The executor needs the domain+server health as plain data (not the server-fn wrapper). In `src/server/health-actions.ts`, the existing `runDomainOne` + `runServerOne` already produce these. Add an exported helper that returns both without going through the `createServerFn`:

```ts
// Diagnose one domain (domain-auth + its server) and return both healths. Used by the remediation
// executor to re-plan between rounds.
export async function runDomainHealthCore(
  db: any,
  userId: string,
  domain: any,
): Promise<{ health: DomainHealth | null; serverHealth: DomainHealth | null }> {
  const [health, serverHealth] = await Promise.all([
    runDomainOne(db, domain).catch(() => null),
    runServerOne(db, userId, domain).catch(() => null),
  ]);
  return { health, serverHealth };
}
```

- [ ] **Step 3: Add the two thin domain DNS heal helpers**

`pushDns`/`syncDkim` logic lives inside the existing `pushDnsToCloudflare` / `fetchDkimAndSync` server-fn handlers, which can't be called server-to-server with a `ConsoleLog`. Create `src/server/domains-heal.ts` exporting the shared internals. Extract the body of `pushDnsToCloudflare`'s handler into `pushDnsForDomain(db, domain, userId, log)` and `fetchDkimAndSync`'s into `syncDkimForDomain(db, domain, userId, log)`, then have the existing server fns call these helpers (so there is ONE implementation).

```ts
// src/server/domains-heal.ts
import type { ConsoleLog } from "./console-bus";
// Move the record-push loop currently inside pushDnsToCloudflare (src/server/domains.ts) here,
// parameterised on (db, domain, userId, log?). Return { ok: boolean; detail: string }.
export async function pushDnsForDomain(db: any, domain: any, userId: string, log?: ConsoleLog): Promise<{ ok: boolean; detail: string }> {
  // ... the exact body of pushDnsToCloudflare's handler, with `log?.info(...)` breadcrumbs and
  //     returning { ok, detail } instead of the server-fn response shape.
}
export async function syncDkimForDomain(db: any, domain: any, userId: string, log?: ConsoleLog): Promise<{ ok: boolean; detail: string }> {
  // ... the exact body of fetchDkimAndSync's handler, same treatment.
}
```

Then in `src/server/domains.ts` and `src/server/mailcow.ts`, replace the handler bodies with a call to these helpers so behaviour is unchanged and there is no duplication.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. (No new unit test here — the executor is I/O orchestration; its pure inputs/outputs are the planner, tested in Task 2, and the dedup helper, tested in Task 4. Live verification happens in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add src/server/remediation.ts src/server/domains-heal.ts src/server/health-actions.ts src/server/domains.ts src/server/mailcow.ts
git commit -m "feat(heal): runRemediationPlan executor + shared DNS heal helpers"
```

---

### Task 4: Batch executor `runJobRemediation` + pure dedup helper

**Files:**
- Modify: `src/server/remediation.ts` (add `dedupePlanByServer` pure helper + `runJobRemediation` server fn)
- Test: `src/server/__tests__/remediation-dedup.test.ts`

**Interfaces:**
- Consumes: `RemediationPlan`, `RemediationStep` (Task 2); `representativesByIp`-style grouping.
- Produces: `dedupePlanByServer(perDomain: { domainId: string; ipAddress: string | null; plan: RemediationPlan }[])` → `{ serverSteps: { ipAddress: string; step: RemediationStep; domainId: string }[]; domainSteps: { domainId: string; step: RemediationStep }[] }`.
- Produces: `runJobRemediation` (server fn, input `{ batchId: string; runId?: string }`).

- [ ] **Step 1: Write the failing dedup test**

Create `src/server/__tests__/remediation-dedup.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { dedupePlanByServer } from "../remediation";
import type { RemediationStep } from "../remediation-planner";

const server = (id: string): RemediationStep => ({ id, action: "restartMailcow", target: "server", label: id, why: "", disruptive: true });
const domain = (id: string): RemediationStep => ({ id, action: "pushDns", target: "domain", label: id, why: "", disruptive: false });

describe("dedupePlanByServer", () => {
  it("collapses identical server steps that share an IP to one", () => {
    const out = dedupePlanByServer([
      { domainId: "d1", ipAddress: "1.1.1.1", plan: { steps: [server("restartMailcow")], manual: [], summary: "" } },
      { domainId: "d2", ipAddress: "1.1.1.1", plan: { steps: [server("restartMailcow")], manual: [], summary: "" } },
    ]);
    expect(out.serverSteps.filter((s) => s.step.id === "restartMailcow")).toHaveLength(1);
    expect(out.serverSteps[0].ipAddress).toBe("1.1.1.1");
  });

  it("keeps server steps separate across different IPs", () => {
    const out = dedupePlanByServer([
      { domainId: "d1", ipAddress: "1.1.1.1", plan: { steps: [server("flushQueue")], manual: [], summary: "" } },
      { domainId: "d2", ipAddress: "2.2.2.2", plan: { steps: [server("flushQueue")], manual: [], summary: "" } },
    ]);
    expect(out.serverSteps).toHaveLength(2);
  });

  it("never dedups domain steps — one per domain", () => {
    const out = dedupePlanByServer([
      { domainId: "d1", ipAddress: "1.1.1.1", plan: { steps: [domain("pushDns")], manual: [], summary: "" } },
      { domainId: "d2", ipAddress: "1.1.1.1", plan: { steps: [domain("pushDns")], manual: [], summary: "" } },
    ]);
    expect(out.domainSteps).toHaveLength(2);
    expect(out.domainSteps.map((d) => d.domainId).sort()).toEqual(["d1", "d2"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server/__tests__/remediation-dedup.test.ts`
Expected: FAIL — `dedupePlanByServer` is not exported.

- [ ] **Step 3: Implement the dedup helper + batch executor**

Add to `src/server/remediation.ts`:

```ts
import type { RemediationStep } from "./remediation-planner";

export function dedupePlanByServer(
  perDomain: { domainId: string; ipAddress: string | null; plan: { steps: RemediationStep[] } }[],
): {
  serverSteps: { ipAddress: string; step: RemediationStep; domainId: string }[];
  domainSteps: { domainId: string; step: RemediationStep }[];
} {
  const serverSteps: { ipAddress: string; step: RemediationStep; domainId: string }[] = [];
  const seen = new Set<string>(); // `${ip}:${stepId}`
  const domainSteps: { domainId: string; step: RemediationStep }[] = [];
  for (const d of perDomain) {
    for (const step of d.plan.steps) {
      if (step.target === "server") {
        if (!d.ipAddress) continue;
        const key = `${d.ipAddress}:${step.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        serverSteps.push({ ipAddress: d.ipAddress, step, domainId: d.domainId });
      } else {
        domainSteps.push({ domainId: d.domainId, step });
      }
    }
  }
  return { serverSteps, domainSteps };
}
```

Then add `runJobRemediation` (loads the batch's domains, plans each via `buildRemediationPlan` on fresh health, dedups, executes server steps once per IP + domain steps per domain, streams to console, re-checks, returns a per-target summary). It reuses `executeStep` and `runDomainHealthCore`.

```ts
export const runJobRemediation = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ batchId: z.string(), runId: z.string().trim().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    if (!db) return { error: "Database not connected" };
    const rows = await db.select().from(domains).where(and(eq(domains.userId, userId), eq(domains.batchId, data.batchId)));
    const log = new ConsoleLog(data.runId);
    const secrets = await db.query.userSecrets.findFirst({ where: eq(userSecrets.userId, userId) });
    const pctx: PlannerContext = { hasCloudflareToken: !!secrets?.cfApiToken };

    const perDomain = [];
    for (const domain of rows) {
      const { health, serverHealth } = await runDomainHealthCore(db, userId, domain);
      perDomain.push({ domainId: domain.id, ipAddress: domain.ipAddress ?? null, plan: buildRemediationPlan(health, serverHealth, pctx), domain });
    }
    const { serverSteps, domainSteps } = dedupePlanByServer(perDomain);
    const byId = new Map(rows.map((d: any) => [d.id, d]));
    const results: StepResult[] = [];

    for (const { step, domainId } of serverSteps) {
      const domain = byId.get(domainId);
      const target: SshTarget | null =
        domain.ipAddress && domain.sshPassword
          ? { ipAddress: domain.ipAddress, sshUser: domain.sshUser || "root", sshPassword: domain.sshPassword }
          : null;
      log.cmd(`${step.label} (server ${domain.ipAddress})`);
      results.push(await executeStep(step, { db, userId, domain, target }, log));
    }
    for (const { step, domainId } of domainSteps) {
      const domain = byId.get(domainId);
      log.cmd(`${step.label} (${domain.name})`);
      results.push(await executeStep(step, { db, userId, domain, target: null }, log));
    }

    log.info(`Job auto-heal done: ${results.filter((r) => r.status === "fixed").length} applied.`);
    return { results, transcript: log.transcript() };
  });
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/server/__tests__/remediation-dedup.test.ts && npx tsc --noEmit`
Expected: 3 PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/remediation.ts src/server/__tests__/remediation-dedup.test.ts
git commit -m "feat(heal): batch auto-heal with dedup-by-IP"
```

---

### Task 5: Plan-approval panel component

**Files:**
- Create: `src/components/RemediationPlanPanel.tsx`

**Interfaces:**
- Consumes: `RemediationPlan`, `RemediationStep`, `ManualItem` (Task 2); the `LiveConsole` + `ConsoleLine` pattern from `_app.troubleshoot.tsx` (extract `LiveConsole` to `src/components/LiveConsole.tsx` first so both pages share it).
- Produces: `<RemediationPlanPanel plan onApprove onClose running consoleLines />` — renders ordered steps (label, why, disruptive badge), the manual list, an **Approve & run** button, and the live console during/after the run.

- [ ] **Step 1: Extract `LiveConsole` into a shared component**

Move the `LiveConsole`, `ConsoleLine`, `consoleText`, `downloadText`, `openConsole`, and `LINE_TONE` definitions from `src/routes/_app.troubleshoot.tsx` into `src/components/LiveConsole.tsx` and export them. Update `_app.troubleshoot.tsx` to import from there. Verify the Troubleshoot page still renders (screenshot).

- [ ] **Step 2: Build the panel**

Create `src/components/RemediationPlanPanel.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import { Loader2, Wrench, TriangleAlert } from "lucide-react";
import { LiveConsole, type ConsoleLine } from "@/components/LiveConsole";
import type { RemediationPlan } from "@/server/remediation-planner";

export function RemediationPlanPanel({
  plan,
  running,
  consoleLines,
  onApprove,
  onClose,
}: {
  plan: RemediationPlan;
  running: boolean;
  consoleLines: ConsoleLine[];
  onApprove: () => void;
  onClose: () => void;
}) {
  const hasSteps = plan.steps.length > 0;
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <Wrench className="h-4 w-4 text-primary" />
        <h3 className="font-display text-sm font-semibold text-foreground">Auto-heal plan</h3>
        <span className="ml-auto text-xs text-muted-foreground">{plan.summary}</span>
      </div>

      {hasSteps ? (
        <ol className="flex flex-col gap-2">
          {plan.steps.map((s, i) => (
            <li key={s.id} className="flex gap-3 rounded-lg border border-border bg-background/60 p-3">
              <span className="ident text-xs text-muted-foreground">{i + 1}</span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {s.label}
                  {s.disruptive && (
                    <span className="rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                      brief mail interruption
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground text-pretty">{s.why}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing to auto-fix.</p>
      )}

      {plan.manual.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold text-foreground">Manual — can’t auto-fix</h4>
          {plan.manual.map((m) => (
            <div key={m.id} className="flex gap-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span>
                <span className="font-medium text-foreground">{m.label}. </span>
                {m.why}
              </span>
            </div>
          ))}
        </div>
      )}

      {(running || consoleLines.length > 0) && (
        <LiveConsole lines={consoleLines} running={running} filenameBase="auto-heal" />
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={running}>
          Close
        </Button>
        {hasSteps && (
          <Button onClick={onApprove} disabled={running} className="gap-1.5">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
            Approve &amp; run
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + live render check**

Run: `npx tsc --noEmit`, then start the dev server and screenshot the Troubleshoot page to confirm the extracted `LiveConsole` still renders. Expected: tsc clean, console renders.

- [ ] **Step 4: Commit**

```bash
git add src/components/LiveConsole.tsx src/components/RemediationPlanPanel.tsx src/routes/_app.troubleshoot.tsx
git commit -m "feat(heal): shared LiveConsole + remediation plan-approval panel"
```

---

### Task 6: Wire Auto-heal into the Domains health card

**Files:**
- Modify: `src/components/HealthCard.tsx`

**Interfaces:**
- Consumes: `runRemediationPlan` (Task 3), `RemediationPlanPanel` (Task 5), `openConsole` (Task 5's `LiveConsole.tsx`), `buildRemediationPlan` (Task 2, to preview the plan before approval).

- [ ] **Step 1: Add plan state + an Auto-heal button to the card header**

In `src/components/HealthCard.tsx`: add state `const [plan, setPlan] = useState<RemediationPlan | null>(null)`, `consoleLines`, `running`. Add an **Auto-heal** button next to Re-check that calls `openPlan()` (below). Build the preview plan client-side from the current `health` + `serverHealth` via `buildRemediationPlan(health, serverHealth, { hasCloudflareToken })` — pass a `hasCloudflareToken` prop from the route (or default true and let the server re-plan authoritatively).

- [ ] **Step 2: Implement openPlan + approve (subscribe to console, run, re-check)**

```tsx
const openPlan = (stepIds?: string[]) => {
  const p = buildRemediationPlan(health, serverHealth, { hasCloudflareToken });
  const filtered = stepIds ? { ...p, steps: p.steps.filter((s) => stepIds.includes(s.id)) } : p;
  setConsoleLines([]);
  setPlan(filtered);
};

const approve = async () => {
  if (!plan) return;
  setRunning(true);
  setConsoleLines([]);
  const { runId, close } = openConsole(setConsoleLines);
  try {
    const res: any = await runRemediationPlan({
      data: { domainId, stepIds: plan.steps.map((s) => s.id), runId },
    });
    if (Array.isArray(res?.transcript) && res.transcript.length) {
      setConsoleLines((prev) => (prev.length ? prev : res.transcript));
    }
    if (res?.error) toast.error(res.error);
    else {
      const applied = (res.ranSteps ?? []).filter((r: any) => r.status === "fixed").length;
      toast.success(`Applied ${applied} fix${applied === 1 ? "" : "es"} — re-checking…`);
    }
    await recheck();
  } catch (e: any) {
    toast.error(e?.message ?? "Auto-heal failed");
  } finally {
    close();
    setRunning(false);
  }
};
```

- [ ] **Step 3: Route the per-indicator Fix button through the planner**

Change `IndicatorRows`'s `onFix` so a row's Fix opens a single-step plan: `onFix={() => openPlan(plannedStepIdsFor(ind.id))}` where `plannedStepIdsFor` maps an indicator id to the step ids the planner would emit for it (e.g. `queue → the queue step or its manual note`). Render the button for any `fail`/`warn` indicator whose id the planner can act on (mirror the Troubleshoot `FIXABLE_IDS` set). Render `<RemediationPlanPanel>` below the indicator lists when `plan` is set.

- [ ] **Step 4: Typecheck + live check**

Run: `npx tsc --noEmit`; start dev, open a domain, click Auto-heal, confirm the plan panel shows the ordered steps + manual list and the console streams on approve. Screenshot.

- [ ] **Step 5: Commit**

```bash
git add src/components/HealthCard.tsx
git commit -m "feat(heal): Auto-heal + planner-routed per-issue fixes on the Domains card"
```

---

### Task 7: Wire Auto-heal into the Jobs pipeline

**Files:**
- Modify: `src/components/JobIssuesPanel.tsx`

- [ ] **Step 1: Add an "Auto-heal job" button + plan panel**

Add a header button that calls `runJobRemediation({ data: { batchId, runId } })` with a subscribed console, streams to a `RemediationPlanPanel`-style view (or a compact job variant showing per-server/per-domain grouped steps), then re-checks the job (`runJobHealth`). Keep the existing per-action buckets as a fallback, but the primary CTA is Auto-heal.

- [ ] **Step 2: Typecheck + live check**

Run: `npx tsc --noEmit`; start dev, open a job with issues, click Auto-heal job, confirm server steps run once per IP and the console streams. Screenshot.

- [ ] **Step 3: Commit**

```bash
git add src/components/JobIssuesPanel.tsx
git commit -m "feat(heal): Auto-heal job (dedup-by-IP) on the Jobs pipeline"
```

---

### Task 8: Refactor `quickFixServer` onto the shared planner

**Files:**
- Modify: `src/server/troubleshoot.ts`

**Interfaces:**
- Consumes: `buildRemediationPlan`, `executeStep` (exported from `remediation.ts` in Task 3).

- [ ] **Step 1: Replace the ad-hoc quick-fix ordering with the planner**

In `quickFixServer`, after the existing health check, call `buildRemediationPlan(domainHealth, serverHealth, { hasCloudflareToken })`, filter to the issues the caller passed, and execute steps via `executeStep` (target derived from the troubleshoot form creds, not a domain row — pass a `SshTarget` built from the request). Keep the Cloudflare un-proxy special-case for the external flow (no domain row → use the existing `cloudflareUnproxyMailHost`). The IPv6/queue ordering now comes from the planner, deleting the hand-rolled `MAILCOW_RESTART_IDS`/order logic.

- [ ] **Step 2: Run the full suite + typecheck + live check**

Run: `npx vitest run && npx tsc --noEmit`; start dev, run a Troubleshoot Quick fix, confirm behaviour is unchanged (IPv6 before flush, retry). Screenshot.

- [ ] **Step 3: Commit**

```bash
git add src/server/troubleshoot.ts
git commit -m "refactor(heal): Troubleshoot quick-fix uses the shared remediation planner"
```

---

## Phase 2 (separate plan, after Phase 1 lands)

LLM escalation ("AI Assist"): `llm-provider.ts` (OpenAI/Anthropic/Gemini/custom), `llm-escalation.ts`
(build redacted context → propose commands → human approves each → execute via `sshRun` → feed back),
Settings config + `userSecrets` fields, and the escalation panel bolted onto `RemediationPlanPanel`.
Written as its own plan once Task 1–8 are in, because its interfaces depend on the panel/executor
shipping first. See the spec's "Phase 2" section.

## Self-review notes

- **Spec coverage:** planner (Task 2) ✓, executor + re-check/retry (Task 3) ✓, dedup-by-IP (Task 4) ✓,
  propose-then-approve UI (Task 5–7) ✓, new actions (Task 1) ✓, one-brain refactor (Task 8) ✓,
  manual/never-auto items (Task 2, tested) ✓. Phase 2 explicitly deferred.
- **Retry loop:** Task 3's executor runs once then re-checks and reports `remaining`. A bounded
  fix→re-check→fix loop (≤3 rounds, stop-on-no-change) can wrap `runRemediationPlan` in the UI
  approve handler (loop while `remaining` shrinks) — same pattern as Troubleshoot's `repairUntilFixed`.
  Note added here so the executor stays a single, testable unit and the loop lives in the caller.
- **Type consistency:** `RemediationStep`/`ManualItem`/`RemediationPlan` defined once in Task 2 and
  imported everywhere; `executeStep`/`dedupePlanByServer`/`runDomainHealthCore` signatures match across
  Tasks 3–8.
