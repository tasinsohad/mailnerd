import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { domains, plannedInboxes, serverHealth, healthHistory } from "@/lib/db/schema";
import { eq, and, inArray, desc } from "drizzle-orm";
import { checkDomainHealth, type DomainHealth } from "./health";
import { checkServerHealth } from "./health-server";
import { diffSnapshots, toSnapshot, type IndicatorSnap } from "./health-history";

// Append a compact history row for a check run, then prune to the newest ~100 for that target.
// Tolerant of an unmigrated table (logs and moves on).
async function appendHistory(
  db: any,
  userId: string,
  scope: "server" | "domain",
  targetKey: string,
  targetName: string,
  health: DomainHealth,
): Promise<void> {
  try {
    await db.insert(healthHistory).values({
      userId,
      scope,
      targetKey,
      targetName,
      status: health.status,
      score: health.score,
      indicators: toSnapshot(health.indicators),
      checkedAt: new Date(health.checkedAt),
    });
    const rows = await db
      .select({ id: healthHistory.id })
      .from(healthHistory)
      .where(and(eq(healthHistory.userId, userId), eq(healthHistory.scope, scope), eq(healthHistory.targetKey, targetKey)))
      .orderBy(desc(healthHistory.checkedAt));
    const excess = rows.slice(100).map((r: any) => r.id);
    if (excess.length) await db.delete(healthHistory).where(inArray(healthHistory.id, excess));
  } catch (err) {
    console.error("health history write failed (is the table migrated?):", err);
  }
}

// Run the domain-level (DNS auth) health engine for one domain, persist, and return it.
async function runDomainOne(db: any, domain: any): Promise<DomainHealth> {
  const inboxes = await db
    .select()
    .from(plannedInboxes)
    .where(eq(plannedInboxes.domainId, domain.id));
  const subdomains = Array.from(new Set(inboxes.map((i: any) => String(i.subdomainFqdn)))) as string[];

  const health = await checkDomainHealth({
    name: domain.name,
    mailcowHostname: domain.mailcowHostname,
    mailcowApiKey: domain.mailcowApiKey,
    subdomains,
    plannedInboxCount: inboxes.length,
  });

  await db.update(domains).set({ health, healthCheckedAt: new Date() }).where(eq(domains.id, domain.id));
  await appendHistory(db, domain.userId, "domain", domain.id, domain.name, health);
  return health;
}

// Run the server-level (VPS/IP) health engine once for a representative domain and upsert the
// result keyed by (userId, ipAddress). Tolerant of a missing server_health table (returns null).
async function runServerOne(db: any, userId: string, rep: any): Promise<DomainHealth | null> {
  if (!rep.ipAddress) return null;
  const health = await checkServerHealth({
    ipAddress: rep.ipAddress,
    mailcowHostname: rep.mailcowHostname,
    mailcowApiKey: rep.mailcowApiKey,
    sshUser: rep.sshUser,
    sshPassword: rep.sshPassword,
  });
  try {
    const existingRows = await db
      .select()
      .from(serverHealth)
      .where(and(eq(serverHealth.userId, userId), eq(serverHealth.ipAddress, rep.ipAddress)))
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      await db
        .update(serverHealth)
        .set({ health, checkedAt: new Date(), mailcowHostname: rep.mailcowHostname })
        .where(eq(serverHealth.id, existing.id));
    } else {
      await db.insert(serverHealth).values({
        userId,
        ipAddress: rep.ipAddress,
        mailcowHostname: rep.mailcowHostname,
        health,
        checkedAt: new Date(),
      });
    }
  } catch (err) {
    // server_health table may not be migrated yet — degrade gracefully.
    console.error("serverHealth upsert failed (is the table migrated?):", err);
  }
  await appendHistory(db, userId, "server", rep.ipAddress, rep.ipAddress, health);
  return health;
}

// Group a batch's domains by IP, choosing the best SSH/Mailcow representative for each server.
function representativesByIp(rows: any[]): any[] {
  const byIp = new Map<string, any>();
  for (const d of rows) {
    if (!d.ipAddress) continue;
    const cur = byIp.get(d.ipAddress);
    const better = d.sshPassword && d.mailcowApiKey;
    if (!cur || (better && !(cur.sshPassword && cur.mailcowApiKey))) byIp.set(d.ipAddress, d);
  }
  return [...byIp.values()];
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
  const topIssues = Object.values(issueTally).sort((a, b) => b.count - a.count).slice(0, 5);
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
      const [health, serverHealthResult] = await Promise.all([
        runDomainOne(db, domain),
        runServerOne(db, userId, domain),
      ]);
      return { health, serverHealth: serverHealthResult };
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

    // Per-domain DNS checks.
    for (const d of rows) {
      try {
        await runDomainOne(db, d);
      } catch {
        /* per-domain failure reflected as unknown; continue */
      }
    }
    // Per-server checks, deduped by IP.
    for (const rep of representativesByIp(rows)) {
      try {
        await runServerOne(db, userId, rep);
      } catch {
        /* continue */
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
        await runDomainOne(db, d);
      } catch {
        /* continue */
      }
    }
    for (const rep of representativesByIp(rows)) {
      try {
        await runServerOne(db, userId, rep);
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
      return { total: 0, counts: { healthy: 0, warning: 0, critical: 0, unknown: 0 }, topIssues: [], lastCheckedAt: null };
    const rows = await db.select().from(domains).where(eq(domains.userId, userId));
    const lastCheckedAt = rows.map((r: any) => r.healthCheckedAt).filter(Boolean).sort().pop() ?? null;
    return { ...summarize(rows), lastCheckedAt };
  });

// Health-check history for one target (a server IP or a domain), oldest-first for charting, plus
// the regressed/recovered diff between the two most recent runs.
export const getHealthHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        scope: z.enum(["server", "domain"]),
        targetKey: z.string(),
        limit: z.number().int().min(2).max(200).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { db, userId } = context as any;
    if (!db) return { history: [], regressed: [], recovered: [] };
    try {
      const rows = await db
        .select()
        .from(healthHistory)
        .where(
          and(
            eq(healthHistory.userId, userId),
            eq(healthHistory.scope, data.scope),
            eq(healthHistory.targetKey, data.targetKey),
          ),
        )
        .orderBy(desc(healthHistory.checkedAt))
        .limit(data.limit ?? 60);

      const curr = rows[0];
      const prev = rows[1];
      const diff = curr
        ? diffSnapshots((prev?.indicators as IndicatorSnap[]) ?? null, (curr.indicators as IndicatorSnap[]) ?? [])
        : { regressed: [], recovered: [] };

      // Return chronological (oldest → newest) for the sparkline.
      return { history: rows.slice().reverse(), regressed: diff.regressed, recovered: diff.recovered };
    } catch {
      return { history: [], regressed: [], recovered: [] };
    }
  });

// Latest server-health rows for a batch's IPs (for the per-server list on the job dashboard).
export const getBatchServerHealth = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ batchId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = context as any;
    if (!db) return { servers: [] };
    try {
      const rows = await db
        .select()
        .from(domains)
        .where(and(eq(domains.userId, userId), eq(domains.batchId, data.batchId)));
      const ips = Array.from(new Set(rows.map((d: any) => d.ipAddress).filter(Boolean))) as string[];
      if (ips.length === 0) return { servers: [] };
      const sh = await db
        .select()
        .from(serverHealth)
        .where(and(eq(serverHealth.userId, userId), inArray(serverHealth.ipAddress, ips)));
      return { servers: sh };
    } catch {
      return { servers: [] };
    }
  });
