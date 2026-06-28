import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { domains, dnsRecords, plannedInboxes, userSecrets } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveAndSaveCfZoneId } from "./domains";
import { mailcowRequest, cfTxtContent } from "./mailcow-helpers";
import { ensureMailDomains, createMailboxes } from "./pipeline";

export const setupMailcowDomain = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    // `recreate: true` = clean slate. Deletes the planned mailboxes in Mailcow first
    // (keeping the mail domain + DKIM intact), then recreates them with fresh passwords.
    z.object({ domainId: z.string(), recreate: z.boolean().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    if (!db) return { error: "Database not connected" };

    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
    });
    if (!domain || !domain.mailcowHostname || !domain.mailcowApiKey) {
      return { error: "Mailcow credentials missing for this domain" };
    }

    const { existingDomains, results: domainResults } = await ensureMailDomains(db, domain);
    const { results: mailboxResults, summary } = await createMailboxes(db, domain, existingDomains, {
      recreate: data.recreate,
    });
    return { results: [...domainResults, ...mailboxResults], summary };
  });

export const fetchDkimAndSync = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ domainId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    if (!db) return { error: "Database not connected" };

    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
    });
    if (!domain) return { error: "Domain not found" };

    // Automatically associate and populate the Cloudflare Zone ID if missing
    await resolveAndSaveCfZoneId(db, domain, userId);

    if (!domain.mailcowHostname || !domain.mailcowApiKey) {
      return { error: "Mailcow credentials missing" };
    }

    const secrets = await db.query.userSecrets.findFirst({
      where: eq(userSecrets.userId, userId),
    });
    if (!secrets?.cfApiToken) return { error: "Cloudflare token missing" };

    const inboxes = await db
      .select()
      .from(plannedInboxes)
      .where(eq(plannedInboxes.domainId, domain.id));
    const uniqueSubdomains = [
      domain.name,
      ...Array.from(new Set(inboxes.map((i: any) => i.subdomainFqdn))),
    ];

    const results = [];

    for (const sub of uniqueSubdomains) {
      try {
        // 7.1 Fetch DKIM (self-signed-cert tolerant, like the rest of the Mailcow API)
        const { json } = await mailcowRequest(
          domain.mailcowHostname,
          domain.mailcowApiKey,
          `get/dkim/${sub}`,
        );
        const dkimPublic = (json as any)?.dkim_public;
        if (!dkimPublic) {
          results.push({ name: sub, success: false, error: "DKIM not found in Mailcow" });
          continue;
        }

        const dkimKey = String(dkimPublic).replace(/(\r\n|\n|\r)/gm, "");

        // 7.2 Update Cloudflare
        const dnsRec = await db.query.dnsRecords.findFirst({
          where: and(
            eq(dnsRecords.domainId, domain.id),
            eq(dnsRecords.type, "TXT"),
            eq(
              dnsRecords.name,
              sub === domain.name ? "dkim._domainkey" : `dkim._domainkey.${sub.split(".")[0]}`,
            ),
          ),
        });

        let cfRes;
        let isNew = false;
        const recName = sub === domain.name ? "dkim._domainkey" : `dkim._domainkey.${sub.split(".")[0]}`;
        const fullRecName = recName === "@" ? domain.name : `${recName}.${domain.name}`;
        const recordContent = `v=DKIM1;k=rsa;t=s;s=email;p=${dkimKey}`;

        if (dnsRec?.cfRecordId) {
          cfRes = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${domain.cfZoneId}/dns_records/${dnsRec.cfRecordId}`,
            {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${secrets.cfApiToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                type: "TXT",
                name: fullRecName,
                content: cfTxtContent("TXT", recordContent),
                ttl: 1,
              }),
            },
          );
        } else {
          isNew = true;
          cfRes = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${domain.cfZoneId}/dns_records`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${secrets.cfApiToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                type: "TXT",
                name: fullRecName,
                content: cfTxtContent("TXT", recordContent),
                ttl: 1,
              }),
            },
          );
        }

        const cfJson = await cfRes.json();
        
        if (cfJson.success && isNew) {
           await db.insert(dnsRecords).values({
             userId,
             domainId: domain.id,
             type: "TXT",
             name: recName,
             content: recordContent,
             ttl: 1,
             cfRecordId: cfJson.result.id,
             status: "active"
           });
        } else if (cfJson.success && dnsRec) {
           await db.update(dnsRecords)
             .set({ content: recordContent })
             .where(eq(dnsRecords.id, dnsRec.id));
        }

        results.push({ name: sub, success: cfJson.success, error: cfJson.errors?.[0]?.message });
      } catch (err) {
        results.push({ name: sub, success: false, error: String(err) });
      }
    }

    return { results };
  });
