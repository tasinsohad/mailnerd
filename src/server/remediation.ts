// Executor for a remediation plan: diagnose -> run each step in order -> re-check -> report,
// streaming to the live console as it goes.
//
// CLIENT-BUNDLE SAFETY. This module exports both a plain helper (`executeStep`, so Task 8's
// server-driven quick-fix flow can reuse the same dispatch) AND a createServerFn
// (`runRemediationPlan`). That makes it a *mixed* module: TanStack Start can only stub a
// createServerFn's own handler body out of the client bundle, not the rest of the file — so a
// plain top-level import here would ride along into any client bundle that ever imports anything
// from this file (see server-fixes.ts's `sshRun` for the full story of that failure mode: a
// static `import { SSHManager } from "@/lib/ssh"` in a similarly-mixed module crashed the
// Domains/Jobs pages with "The requested module '/node_modules/ssh2/…' does not provide an
// export named …", because ssh2 is a native module that can't be evaluated in a browser).
//
// So: this file's top-level imports are limited to what's provably client-safe (createServerFn,
// requireAuth, zod, drizzle eq/and, the schema tables, ConsoleLog, the pure planner + its types,
// and the server-fixes `fix*` functions, which already dynamic-import `@/lib/ssh` internally).
// Anything that transitively touches SSH or the health engine — `./pipeline` (unproxyDns),
// `./diagnose` (diagnoseDomain), `./domains-heal` (pushDnsForDomain/syncDkimForDomain) — is loaded
// with `await import(...)` INSIDE executeStep / the handler, never at this top level.

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
import { buildRemediationPlan, type RemediationStep, type PlannerContext } from "./remediation-planner";
import { ConsoleLog } from "./console-bus";

export interface StepResult {
  id: string;
  status: "fixed" | "noop" | "failed";
  detail: string;
}

// Context executeStep needs to run one step. `target` is null when the domain has no SSH
// credentials on file — server-target steps fail fast with a clear message rather than throwing.
export interface ExecCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  userId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  domain: any;
  target: SshTarget | null;
}

// Run one step. Server-target steps SSH via the box creds; domain-target steps hit the DNS/API.
// Exported (not just used by runRemediationPlan below) so Task 8's quick-fix flow can dispatch a
// single step the same way the full plan does.
export async function executeStep(
  step: RemediationStep,
  ctx: ExecCtx,
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
        // Dynamic import: pipeline.ts must not sit at this module's top level (see file header).
        const { unproxyDns } = await import("./pipeline");
        const r = await unproxyDns(ctx.db, ctx.domain, ctx.userId);
        return { id: step.id, status: "fixed", detail: `Un-proxied (${r.unproxied} records, ${r.removed} removed).` };
      }
      case "pushDns": {
        const { pushDnsForDomain } = await import("./domains-heal");
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
  z
    .object({ domainId: z.string(), stepIds: z.array(z.string()).optional(), runId: z.string().trim().optional() })
    .parse(d);

// Diagnose -> plan -> (optionally filter to `stepIds`) -> run each step in order -> re-check ->
// report. `runId` is an unguessable id the CLIENT generates so it can subscribe to the console
// stream (see console-bus.ts) before kicking the run off; the full transcript also comes back in
// the response, so nothing is lost if the stream never connects.
export const runRemediationPlan = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(planInput)
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    if (!db) return { error: "Database not connected" };
    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
    });
    if (!domain) return { error: "Domain not found" };

    const log = new ConsoleLog(data.runId);
    const target: SshTarget | null =
      domain.ipAddress && domain.sshPassword
        ? { ipAddress: domain.ipAddress, sshUser: domain.sshUser || "root", sshPassword: domain.sshPassword }
        : null;
    const secrets = await db.query.userSecrets.findFirst({ where: eq(userSecrets.userId, userId) });
    const pctx: PlannerContext = { hasCloudflareToken: !!secrets?.cfApiToken };

    // Fresh diagnose -> plan. Dynamic import: diagnose.ts statically imports the health engine
    // (health-server.ts -> @/lib/ssh -> ssh2), which must never sit at this module's top level.
    const { diagnoseDomain } = await import("./diagnose");
    const { health, serverHealth } = await diagnoseDomain(db, userId, domain);
    const plan = buildRemediationPlan(health, serverHealth, pctx);
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
    const after = await diagnoseDomain(db, userId, domain);
    const rechecked = buildRemediationPlan(after.health, after.serverHealth, pctx);
    const targetedIds = new Set(steps.map((s) => s.id));
    const remaining = rechecked.steps.filter((s) => targetedIds.has(s.id)).map((s) => s.id);
    log.info(`Done. ${ranSteps.filter((r) => r.status === "fixed").length} applied, ${remaining.length} still failing.`);

    return { ranSteps, remaining, plan, transcript: log.transcript() };
  });
