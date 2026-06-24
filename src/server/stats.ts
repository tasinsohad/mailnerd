import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { domains, plannedInboxes, servers } from "@/lib/db/schema";
import { count, eq } from "drizzle-orm";

export const getOverviewStats = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;

    // Return default values if db is not connected
    if (!db) {
      console.warn("Database not connected, returning empty stats");
      return {
        totalDomains: 0,
        totalInboxes: 0,
        totalServers: 0,
        activeJobs: 0,
      };
    }

    try {
      const [domainCount] = await db
        .select({ value: count() })
        .from(domains)
        .where(eq(domains.userId, userId));
      const [inboxCount] = await db
        .select({ value: count() })
        .from(plannedInboxes)
        .where(eq(plannedInboxes.userId, userId));
      const [serverCount] = await db
        .select({ value: count() })
        .from(servers)
        .where(eq(servers.userId, userId));

      return {
        totalDomains: domainCount?.value ?? 0,
        totalInboxes: inboxCount?.value ?? 0,
        totalServers: serverCount?.value ?? 0,
        activeJobs: 0,
      };
    } catch (error) {
      console.error("Error fetching stats:", error);
      return {
        totalDomains: 0,
        totalInboxes: 0,
        totalServers: 0,
        activeJobs: 0,
      };
    }
  });
