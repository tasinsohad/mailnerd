import { eq, and } from "drizzle-orm";
import { domains, userSecrets, cloudflareZones } from "@/lib/db/schema";

// Resolve a domain's Cloudflare zone id (from the domain row, the cached cloudflareZones
// table, or a live Cloudflare API lookup) and persist it. Returns null if it can't be
// resolved. Lives in this leaf module so both domains.ts and pipeline.ts can use it
// without an import cycle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveAndSaveCfZoneId(db: any, domain: any, userId: string): Promise<string | null> {
  if (domain.cfZoneId) return domain.cfZoneId;

  // 1. Try DB lookup in cloudflareZones
  const matchedDbZone = await db.query.cloudflareZones.findFirst({
    where: and(
      eq(cloudflareZones.userId, userId),
      eq(cloudflareZones.name, domain.name.toLowerCase())
    )
  });
  if (matchedDbZone) {
    await db
      .update(domains)
      .set({ cfZoneId: matchedDbZone.zoneId })
      .where(eq(domains.id, domain.id));
    return matchedDbZone.zoneId;
  }

  // 2. Try live Cloudflare API query
  const secrets = await db.query.userSecrets.findFirst({
    where: eq(userSecrets.userId, userId),
  });
  if (!secrets?.cfApiToken) return null;

  try {
    // Try querying zone by name directly: /zones?name=domainName
    let url = `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain.name.toLowerCase())}`;

    // If account ID is present, try accounts/{accountId}/zones?name=domainName
    if (secrets.cfAccountId) {
      url = `https://api.cloudflare.com/client/v4/accounts/${secrets.cfAccountId}/zones?name=${encodeURIComponent(domain.name.toLowerCase())}`;
    }

    let res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${secrets.cfApiToken}`,
        "Content-Type": "application/json",
      },
    });
    let json = await res.json() as any;

    // Fallback: If account-specific query fails/returns empty, try generic query
    if ((!json.success || !json.result || json.result.length === 0) && secrets.cfAccountId) {
      const fallbackUrl = `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain.name.toLowerCase())}`;
      res = await fetch(fallbackUrl, {
        headers: {
          Authorization: `Bearer ${secrets.cfApiToken}`,
          "Content-Type": "application/json",
        },
      });
      json = await res.json() as any;
    }

    if (json.success && json.result && json.result.length > 0) {
      const zoneId = json.result[0].id;

      // Save zone to cloudflare_zones cache
      const existingZone = await db.query.cloudflareZones.findFirst({
        where: and(
          eq(cloudflareZones.userId, userId),
          eq(cloudflareZones.zoneId, zoneId)
        )
      });
      if (!existingZone) {
        await db.insert(cloudflareZones).values({
          userId,
          zoneId: zoneId,
          name: json.result[0].name,
          status: json.result[0].status,
        });
      }

      // Update domain cfZoneId
      await db
        .update(domains)
        .set({ cfZoneId: zoneId })
        .where(eq(domains.id, domain.id));

      return zoneId;
    }
  } catch (err) {
    console.error("Live Cloudflare API query failed:", err);
  }

  return null;
}
