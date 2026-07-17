# Smart auto-heal for the Jobs pipeline and Domains health card

Date: 2026-07-18
Status: Approved (design) — ready for implementation plan

## Problem

The Domains health card and Jobs pipeline can only fix issues that carry a `HealthAction`
(DNS, containers, firewall). The **Mail queue** and **Mail log** indicators carry no action, so
a stuck queue (e.g. "4 messages queued, oldest 66h") shows red with no way to act. The one fix
path that exists — `runHealthFix` in `src/lib/health-fixes.ts` — is a flat `action → one server
function` switch: no ordering, no verification, no retry, and no reasoning about the server's
actual condition.

Meanwhile the Troubleshoot page already has a *smart* engine (`quickFixServer` in
`src/server/troubleshoot.ts`): it orders fixes by dependency (IPv6 before flush, un-proxy before
submission), verifies, and retries until fixed. That intelligence is trapped on one page.

**Goal:** bring that smart engine to the Domains card and Jobs pipeline, make its decisions
condition-aware, and keep one decision brain instead of two that drift. The end goal is higher
deliverability by unblocking and authenticating the send path.

## Decisions (settled during brainstorming)

1. **Autonomy: propose-a-plan, then approve.** The engine diagnoses, builds an ordered plan with
   reasoning, and shows it. Nothing touches live mail until the user approves. The plan *is* the
   visible decision.
2. **Scope: runtime + DNS-auth.** Server runtime (queue, mail log, IPv6 stall, containers,
   listeners, host firewall, submission ports, API key) plus the domain DNS-auth fixes that already
   exist (push SPF/DKIM/DMARC/MX, un-proxy mail host, complete FCrDNS). The provisioning-level
   deliverability-foundation fixes (set PTR via Contabo API, remove hardcoded TLSA, fix proxied
   `192.0.2.1` sending subdomains, per-domain DMARC) are **deferred to their own spec**.
3. **Decision core: deterministic runbook rules.** A pure decision tree over the health snapshot.
   Same input always yields the same plan — auditable, unit-testable, cannot hallucinate a
   destructive action on live mail.
4. **Flush gating (confirmed):** a queue flush is gated behind cause-fixes and is **not** proposed
   for a provider port-25 block or a reputation/5xx problem — those surface as "manual, here's why".
5. **PTR + blacklist stay "manual, here's why"** in this build.
6. **LLM escalation (opt-in, Phase 2):** when the deterministic engine can't solve a problem (items
   left `manual`, or a plan that ran but didn't clear the issue), the user can trigger an AI provider
   (OpenAI / Anthropic / Gemini / custom OpenAI-compatible). The AI runs in **advise mode**: it reads
   the diagnostics + logs (redacted), proposes specific commands with reasoning, and **the user
   approves each command (or batch) before it runs** — the AI never executes on its own. This is the
   3-strike-then-escalate pattern, not a replacement for the deterministic core.

## Phased delivery

- **Phase 1 — deterministic auto-heal** (this is the safe default and most of the value): the planner,
  executor, plan-approval UI, on Domains + Jobs + Troubleshoot.
- **Phase 2 — LLM escalation** (opt-in): bolts onto the same plan panel, executor, and console. Ships
  after Phase 1 lands, because it adds a provider abstraction, Settings config, an agentic loop, and a
  bigger security surface.

## Non-goals

- The deliverability-foundation provisioning fixes (separate spec).
- Fully autonomous background healing (rejected — too risky for mail infra).
- LLM-driven decisions (rejected — non-deterministic on infra you can't easily undo).

## Architecture — one brain, three surfaces

### The planner (new pure module)

`src/server/remediation-planner.ts` — no I/O, mirrors `health-checks.ts`. The testable core.

- **Input:** `domainHealth: DomainHealth`, `serverHealth: DomainHealth` (both already produced by
  `runDomainHealth`), plus a small context `{ ipAddress, mailHost, hasCloudflareToken }`.
- **Output:** `RemediationPlan`.

```ts
type RemediationTarget = "server" | "domain";

interface RemediationStep {
  id: string;                 // stable, e.g. "restartMailcow", "flushQueue"
  action: HealthAction;       // maps to an existing fix (see executor)
  target: RemediationTarget;  // dedup key: server steps run once per IP
  label: string;              // "Restart Mailcow", "Force Postfix to IPv4"
  why: string;                // from the guidance system — the reasoning shown at approval
  disruptive: boolean;        // e.g. restartMailcow briefly interrupts mail → needs the warning
}

interface ManualItem {
  id: string;                 // "blacklist", "ptr", "port25-block"
  label: string;
  why: string;                // why we can't auto-fix it + what the operator should do
}

interface RemediationPlan {
  steps: RemediationStep[];   // ordered; execute top to bottom
  manual: ManualItem[];       // surfaced separately, not executed
  summary: string;            // one line: "3 fixes, 1 manual"
}
```

`buildRemediationPlan(domainHealth, serverHealth, ctx): RemediationPlan` — pure.

### Three surfaces, same planner

1. **Domains card** (`src/components/HealthCard.tsx`): an **Auto-heal** button builds a plan for this
   domain + its server. The existing per-indicator Fix buttons route *through* the planner too, so a
   single-issue fix still gets the smart sequence (Fix on "queue" → `[forcePostfixIPv4?, flushQueue]`).
2. **Jobs pipeline** (`src/components/JobIssuesPanel.tsx`): an **Auto-heal job** button plans across
   every domain in the batch, **deduped by server IP** for server-level steps.
3. **Troubleshoot** (`src/server/troubleshoot.ts`): `quickFixServer` is refactored to call the same
   planner. One brain.

## Decision rules (the runbook, deterministic)

Built in dependency order — cause before symptom. `restart → un-proxy → firewall → IPv4 → auth → flush`.

**Step `target` = where the fix runs, and it drives the Jobs dedup:**
- `target: "server"` — the fix SSHes to the box (`restartMailcow`, `openFirewall`, `forcePostfixIPv4`,
  `flushQueue`, `createApiKey`). Deduped by IP in a job.
- `target: "domain"` — the fix hits a per-domain DNS zone or Mailcow API (`fixDns` un-proxy,
  `pushDns`, `syncDkim`). Runs once per domain, never deduped.

This matters because some **server-health indicators trigger a domain-target fix**: the "mail host
Cloudflare-proxied" indicator lives in server health, but un-proxying is per-domain (each domain has
its own `mail.<domain>` host in its own Cloudflare zone, fixed by `repairDomainDns`).

**Order (cause before symptom):**

| # | Condition (from indicators) | Step | target | Notes |
|---|---|---|---|---|
| 1 | containers down/unhealthy OR listeners missing | `restartMailcow` | server | First — nothing works if Mailcow is down |
| 2 | mail host Cloudflare-proxied (mailhost/fcrdns = proxied) | `fixDns` (un-proxy) | domain | API, submission, FCrDNS all depend on it. Only if a Cloudflare token exists; else → manual |
| 3 | host firewall (ufw) blocking mail ports | `openFirewall` | server | |
| 4 | IPv6 delivery stall (v6 times out while v4 works) | `forcePostfixIPv4` | server | Also flushes on its way out |
| 5 | mail queue stuck | conditional (below) | server | The smart branch |
| 6 | mail log errors | (no step) | — | A lens on causes already routed above |
| 7 | API key missing/rejected | `createApiKey` | server | Only when API checks are the concern |

Ordering is by dependency, not by target: a domain-target `fixDns` at step 2 still executes before
the server-target steps below it.

**Step 5 — queue branch:**

- If step 4 (IPv6) is in the plan → queue is already retried by it; **no separate flush**.
- Else classify by dominant deferral reason (`dominantDeferral`) + port-25 verdict:
  - `timeout` + port 25 **blocked** → **manual**: "provider blocks outbound 25 → set a relayhost."
  - `timeout` + port 25 **open** → `flushQueue`; on re-check, if it didn't drain, surface the log.
  - `rejected` (5xx / reputation) → **manual**: "check IP reputation + SPF/DKIM/DMARC."
  - else (small / young / unknown) → `flushQueue`.

**Domain plan (per domain, appended after server steps):**

| Condition | Step |
|---|---|
| MX / SPF / DMARC missing or partial | `pushDns` |
| DKIM missing or key mismatch | `syncDkim` |

**Never auto-planned → `manual`:** IP on a blacklist (delisting is off-platform), missing PTR
(foundation spec), port-25 provider block (ticket/relayhost).

The `why` string for each step and manual item comes from the existing guidance system
(`src/server/health-guidance.ts`), so reasoning stays in one place.

## Executor

`runRemediationPlan` (server fn) maps each step's `action` to an existing fix and runs the plan:

| action | fix (`src/server/server-fixes.ts`) |
|---|---|
| `restartMailcow` | `fixRestartMailcow` |
| `openFirewall` | `fixOpenFirewall` |
| `forcePostfixIPv4` (new HealthAction) | `fixPostfixIpv4Only` |
| `flushQueue` (new HealthAction) | `fixFlushQueue` |
| `createApiKey` (new HealthAction) | `fixCreateApiKey` |
| `fixDns` | `repairDomainDns` (existing) |
| `pushDns` | `pushDnsToCloudflare` (existing) |
| `syncDkim` | `fetchDkimAndSync` (existing) |

Reuses the Troubleshoot retry loop pattern:

1. Run the plan steps in order.
2. Re-check health (`runDomainHealth`).
3. Verify each targeted indicator cleared.
4. **Stop early if a step changed nothing** (a step whose fix reports `noop`/no effect is not
   retried — no pointless loops against a provider block).
5. Bounded to ≤ 3 rounds.
6. Stream every command + output to the live SSE console (`console-bus.ts`, the `runId` stream).

SSH credentials come from the domain row for the Domains/Jobs flows (as
`restartMailcowForDomain`/`openFirewallForDomain` already do via `targetForDomain`).

## Jobs execution

`runJobRemediation({ batchId })`:

1. Load the batch's domains; run `buildRemediationPlan` per domain.
2. **Dedup server steps by IP** — a `restartMailcow`/`forcePostfixIPv4`/`openFirewall`/`flushQueue`
   for a shared box appears once, not per domain.
3. Domain steps (`pushDns`/`syncDkim`) stay per domain.
4. Present one combined plan grouped by server → domain; execute after approval; stream to console.

## UI — propose-then-approve

A **plan-approval panel** (shared component, used by all three surfaces):

- Ordered steps, each: label, `why`, and a disruptive badge ("restarts Mailcow — brief mail
  interruption") where `disruptive` is true.
- A separate **"Manual — can't auto-fix"** list with each item's `why`.
- One **Approve & run** button → executes; the live console (existing `LiveConsole`) streams.
- On completion: re-check, then show **what cleared vs what remains** (with the remaining items'
  guidance).
- Empty plan (all healthy, or everything is manual) → the panel says so and offers nothing to run.

The per-indicator Fix button opens the same panel scoped to the one issue's plan.

## New / reuse / refactor

- **New (Phase 1):** `remediation-planner.ts` (pure); `runRemediationPlan` + `runJobRemediation`
  server fns; the plan-approval panel component; `forcePostfixIPv4`, `flushQueue`, `createApiKey`
  added to `HealthAction` and to the `runHealthFix` map.
- **New (Phase 2):** `llm-provider.ts` (provider abstraction); `llm-escalation.ts` (orchestration
  server fns); the escalation panel; Settings LLM config + `userSecrets` fields.
- **Reuse:** every `server-fixes.ts` function, the health diagnostics, the SSE console + `LiveConsole`,
  the guidance system, `fetchServerLog`, `redact()`, the retry-loop pattern.
- **Refactor:** point `quickFixServer` at the shared planner so Troubleshoot and Domains/Jobs share
  one decision brain.

## Boundaries (isolation)

- **Planner** — pure `health → plan`. Unit-testable with fixture snapshots. The core.
- **Executor** — `plan → server-fixes`, handles order/retry/console. Server-only, dumb.
- **UI** — renders the plan, collects approval. Dumb.

## Testing

Planner unit tests (pure, deterministic) — fixture health snapshots → assert the exact ordered plan:

- queue stuck + IPv6 stall → `[forcePostfixIPv4]`, no separate flush.
- queue stuck + port-25 blocked → no flush; a `manual` relayhost item.
- queue stuck + reputation (5xx) → no flush; a `manual` reputation item.
- queue stuck + port-25 open + no IPv6 → `[flushQueue]`.
- containers down + listeners missing + queue stuck → `[restartMailcow]` first; queue deferred to
  re-check (don't flush before the box is up).
- mail host Cloudflare-proxied (+ token) → `fixDns` before submission-dependent steps; (no token) →
  `manual`.
- all healthy → empty plan.
- ordering invariant: whenever both are present, `restartMailcow` precedes everything, `flushQueue`
  is always last.

Executor: dedup-by-IP test (one server step for N domains on one IP); stop-on-no-change test.

## Error handling

- A step that fails is recorded and does **not** abort the plan; the rest run.
- Re-check after execution; report which targeted issues cleared and which remain, with the
  remaining items' guidance.
- Credentials missing / SSH unreachable → the step reports `failed` with the reason; surfaced per
  step, plan continues.

## Phase 2 — LLM escalation ("AI Assist")

Opt-in. Bolts onto the Phase 1 plan panel. Only offered once the deterministic engine has been run
and issues remain, or from a `manual` item. Advise mode: **the AI proposes, the human approves each
command.** The AI never executes on its own.

### Provider abstraction

`src/server/llm-provider.ts` — one interface over OpenAI, Anthropic, Gemini, and a custom
OpenAI-compatible endpoint (base URL + key). Normalizes a chat + structured-proposal call. Provider,
model, base URL, and API key are configured in **Settings** and stored in `userSecrets` alongside
`cfApiToken`. Uses the Anthropic SDK / OpenAI SDK / Gemini SDK as appropriate; custom uses the
OpenAI-compatible shape.

### The loop (agentic, human-in-the-loop)

1. **Build context** (server fn `llmEscalationStart`): the failing indicators + their guidance, the
   plan already tried and its outcome, and recent server logs (postfix / queue / mailcow, via the
   existing `fetchServerLog`). **All redacted** through `redact()` before leaving the box — never send
   `mailcow.conf` API keys, `DBROOT`, or `DBPASS` to a third-party API.
2. **Ask the provider** for reasoning + a list of proposed commands, each tagged `{ why,
   mutating: boolean }`. System prompt: an SMTP/Mailcow deliverability expert; propose the next
   diagnostic or fix; read-only first; you may only PROPOSE — a human approves each.
3. **UI shows the proposal**: the AI's reasoning + proposed commands, each with an Approve control
   (mutating commands flagged). The user approves one or a batch.
4. **Execute approved commands** (server fn `llmEscalationRun`) over SSH via the existing `sshRun`,
   streaming to the live console; capture output.
5. **Feed output back** as the next turn. Loop until the AI reports resolved or the user stops.
6. **Bounded** (max N turns) and fully **audit-logged** — every proposal, approval, and output goes to
   the console and is retained for the run.

### Guardrails (even in advise mode)

- Commands are proposed, never auto-run; the human approves each. This is the primary safety gate.
- Secrets are redacted from everything sent to the provider.
- Read-only-first is nudged in the prompt; mutating commands are visually flagged at approval.
- SSH creds come from the domain row (server flow), same as the deterministic executor — the AI
  never sees the password.
- Full audit trail of proposed + approved + executed commands with output.

### Boundaries

- `llm-provider.ts` — provider-agnostic chat/proposal call. Network only; swappable per provider.
- `llm-escalation.ts` — orchestration server fns (`llmEscalationStart`, `llmEscalationRun`): build
  redacted context, call the provider, return proposals; execute approved commands and return output.
- UI — the escalation panel: AI reasoning + proposed commands + per-command approve + streamed output.
  Reuses `LiveConsole` and the plan-panel shell.

### Testing (Phase 2)

- Provider adapter: mock each provider's response shape → assert normalized `{ reasoning, commands[] }`.
- Redaction: assert `mailcow.conf` / DB creds never appear in the built context (reuse the redaction
  tests).
- The command-approval gate: a mutating command is never executed without an explicit approve.

## Deferred (separate spec)

Deliverability-foundation fixes from the earlier investigation: set reverse DNS via Contabo API,
remove the hardcoded TLSA record, fix the proxied `192.0.2.1` sending subdomains, per-domain DMARC.
