import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { domains, plannedInboxes } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { checkDomainHealth, type DomainHealth } from "./health";

// Run the health engine for one domain, persist the result, and return it.
async function runOne(db: any, domain: any): Promise<DomainHealth> {
  const inboxes = await db
    .select()
    .from(plannedInboxes)
    .where(eq(plannedInboxes.domainId, domain.id));
  const subdomains = Array.from(
    new Set(inboxes.map((i: any) => String(i.subdomainFqdn))),
  ) as string[];

  // The real mailbox target is the number of inboxes we actually generated (one mailbox each).
  // domainPlans.totalInboxes is the *aspirational* figure before planDomain caps it to unique
  // name×prefix combos, so it overcounts (e.g. plan 37 but only 32 unique inboxes generated).
  const plannedInboxCount = inboxes.length;

  const health = await checkDomainHealth({
    name: domain.name,
    ipAddress: domain.ipAddress,
    mailcowHostname: domain.mailcowHostname,
    mailcowApiKey: domain.mailcowApiKey,
    subdomains,
    plannedInboxCount,
  });

  await db
    .update(domains)
    .set({ health, healthCheckedAt: new Date() })
    .where(eq(domains.id, domain.id));

  return health;
}

function summarize(rows: any[]) {
  const counts = { healthy: 0, warning: 0, critical: 0, unknown: 0 };
  const issueTally: Record<string, { label: string; count: number }> = {};
  for (const r of rows) {
    const h = r.health as DomainHealth | null;
    const status = (h?.status ?? "unknown") as keyof typeof counts;
    counts[status] = (counts[status] ?? 0) + 1;
    for (const ind of h?.indicators ?? []) {
      if (ind.status === "fail" || ind.status === "warn") {
        issueTally[ind.id] = { label: ind.label, count: (issueTally[ind.id]?.count ?? 0) + 1 };
      }
    }
  }
  const topIssues = Object.values(issueTally)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return { total: rows.length, counts, topIssues };
}

export const runDomainHealth = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ domainId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = context as any;
    if (!db) return { error: "Database not connected" };
    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
    });
    if (!domain) return { error: "Domain not found" };
    try {
      const health = await runOne(db, domain);
      return { health };
    } catch (err) {
      return { error: String(err) };
    }
  });

export const runJobHealth = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ batchId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = context as any;
    if (!db) return { error: "Database not connected" };
    const rows = await db
      .select()
      .from(domains)
      .where(and(eq(domains.userId, userId), eq(domains.batchId, data.batchId)));
    for (const d of rows) {
      try {
        await runOne(db, d);
      } catch {
        /* per-domain failure already reflected as unknown; continue */
      }
    }
    const fresh = await db
      .select()
      .from(domains)
      .where(and(eq(domains.userId, userId), eq(domains.batchId, data.batchId)));
    return { summary: summarize(fresh) };
  });

export const runAllHealth = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(() => ({}))
  .handler(async ({ context }) => {
    const { db, userId } = context as any;
    if (!db) return { error: "Database not connected" };
    const rows = await db.select().from(domains).where(eq(domains.userId, userId));
    for (const d of rows) {
      try {
        await runOne(db, d);
      } catch {
        /* continue */
      }
    }
    const fresh = await db.select().from(domains).where(eq(domains.userId, userId));
    return { summary: summarize(fresh) };
  });

// Read-only rollup from persisted health (no re-scan) for the Overview panel.
export const getHealthOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { db, userId } = context as any;
    if (!db)
      return {
        total: 0,
        counts: { healthy: 0, warning: 0, critical: 0, unknown: 0 },
        topIssues: [],
        lastCheckedAt: null,
      };
    const rows = await db.select().from(domains).where(eq(domains.userId, userId));
    const lastCheckedAt =
      rows
        .map((r: any) => r.healthCheckedAt)
        .filter(Boolean)
        .sort()
        .pop() ?? null;
    return { ...summarize(rows), lastCheckedAt };
  });
