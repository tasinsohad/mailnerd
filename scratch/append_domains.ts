export const batchPushDnsToCloudflare = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ domainId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    if (!db) return { error: "Database not connected" };

    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
    });
    if (!domain || !domain.cfZoneId) return { error: "Domain or Zone ID missing" };

    const secrets = await db.query.userSecrets.findFirst({
      where: eq(userSecrets.userId, userId),
    });
    if (!secrets?.cfApiToken) return { error: "Cloudflare token missing" };

    const records = await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domain.id));

    const results: any[] = [];

    // Batch records
    const batchSize = 10;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const promises = batch.map(async (record: any) => {
        if (record.status === "active")
          return { id: record.id, name: record.name, success: true, skipped: true };

        const name = record.name === "@" ? domain.name : `${record.name}.${domain.name}`;

        try {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${domain.cfZoneId}/dns_records`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${secrets.cfApiToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                type: record.type,
                name,
                content: record.content,
                ttl: record.ttl || 1,
                priority: record.priority,
                proxied: record.proxied || false,
              }),
            },
          );
          const json = (await res.json()) as any;
          if (json.success) {
            await db
              .update(dnsRecords)
              .set({ cfRecordId: json.result.id, status: "active", lastError: null })
              .where(eq(dnsRecords.id, record.id));
            return { id: record.id, name: record.name, success: true };
          } else {
            const errorMsg = json.errors?.[0]?.message || "Unknown Cloudflare error";
            await db
              .update(dnsRecords)
              .set({ lastError: errorMsg })
              .where(eq(dnsRecords.id, record.id));
            return { id: record.id, name: record.name, success: false, error: errorMsg };
          }
        } catch (err) {
          const errorMsg = String(err);
          await db
            .update(dnsRecords)
            .set({ lastError: errorMsg })
            .where(eq(dnsRecords.id, record.id));
          return { id: record.id, name: record.name, success: false, error: errorMsg };
        }
      });

      const batchResults = await Promise.allSettled(promises);
      for (const res of batchResults) {
        if (res.status === "fulfilled") {
          results.push(res.value);
        } else {
          results.push({ success: false, error: String(res.reason) });
        }
      }

      // Throttle slightly to respect CF limits (~1200 req/5min)
      await new Promise((r) => setTimeout(r, 200));
    }

    return { results };
  });

export const checkDnsPropagation = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ domainName: z.string() }).parse(d))
  .handler(async ({ data }) => {
    try {
      const aRecords = await dns.resolve4(`mail.${data.domainName}`).catch(() => []);
      const mxRecords = await dns.resolveMx(data.domainName).catch(() => []);

      const success =
        aRecords.length > 0 && mxRecords.some((mx) => mx.exchange === `mail.${data.domainName}`);

      return { success, aRecords, mxRecords };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
