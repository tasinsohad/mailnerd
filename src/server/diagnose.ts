// Diagnose one domain's health (domain-auth + its server) as plain data, without going through
// the `runDomainHealth` createServerFn wrapper. Used by the remediation executor (remediation.ts)
// to build a plan before running fixes and to re-check afterwards.
//
// Mirrors the private `runDomainOne` / `runServerOne` helpers in health-actions.ts, but
// deliberately skips their persistence (history rows, `domains.health` / `serverHealth` table
// writes): the executor only needs a fresh snapshot to feed the planner between rounds, not to
// record it — the next manual "re-check" (or a scheduled sweep) persists a fresh snapshot anyway.
// `health-actions.ts` stays an all-createServerFn module on purpose (see below), so this lives in
// its own file rather than as an added export there.
//
// SERVER-ONLY. This module statically imports the health engine (`./health`, `./health-server`),
// and `./health-server` statically imports `@/lib/ssh`, which pulls in the native `ssh2` binding —
// fine in a server-only chunk, but it crashes the browser bundle if it ever leaks into client
// code (see `server-fixes.ts`'s `sshRun` for the full story of that failure mode). That's safe
// here ONLY because this module is never imported at the top level of anything client-reachable:
// `remediation.ts` (a *mixed* module — it exports both plain helpers and a createServerFn, so
// TanStack Start can't stub the whole thing out of the client bundle) must reach this exclusively
// via `await import("./diagnose")` inside its handler, never as a top-level import.

import { eq } from "drizzle-orm";
import { plannedInboxes } from "@/lib/db/schema";
import { checkDomainHealth, type DomainHealth } from "./health";
import { checkServerHealth } from "./health-server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Domain = any;

// Domain-level (DNS auth) health for one domain — same inputs as health-actions.ts's runDomainOne.
async function diagnoseDomainHealth(db: Db, domain: Domain): Promise<DomainHealth> {
  const inboxes = await db
    .select()
    .from(plannedInboxes)
    .where(eq(plannedInboxes.domainId, domain.id));
  const subdomains = Array.from(
    new Set(inboxes.map((i: any) => String(i.subdomainFqdn))),
  ) as string[];

  return checkDomainHealth({
    name: domain.name,
    mailcowHostname: domain.mailcowHostname,
    mailcowApiKey: domain.mailcowApiKey,
    subdomains,
    plannedInboxCount: inboxes.length,
  });
}

// Server-level (VPS/IP) health for this domain's server — same inputs as runServerOne, minus the
// serverHealth-table upsert (see module comment).
async function diagnoseServerHealth(domain: Domain): Promise<DomainHealth | null> {
  if (!domain.ipAddress) return null;
  return checkServerHealth({
    ipAddress: domain.ipAddress,
    mailcowHostname: domain.mailcowHostname,
    mailcowApiKey: domain.mailcowApiKey,
    sshUser: domain.sshUser,
    sshPassword: domain.sshPassword,
  });
}

// Diagnose one domain (domain-auth + its server) and return both healths, freshly computed and
// NOT persisted. `userId` is accepted for interface symmetry with the rest of the health/executor
// plumbing (and in case a future caller wants to persist); unused today because persistence is
// intentionally out of scope here.
export async function diagnoseDomain(
  db: Db,
  userId: string,
  domain: Domain,
): Promise<{ health: DomainHealth | null; serverHealth: DomainHealth | null }> {
  void userId;
  const [health, serverHealth] = await Promise.all([
    diagnoseDomainHealth(db, domain).catch(() => null),
    diagnoseServerHealth(domain).catch(() => null),
  ]);
  return { health, serverHealth };
}
