import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { domains, dnsRecords, plannedInboxes, userSecrets, cloudflareZones } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveAndSaveCfZoneId } from "./domains";

export const setupMailcowDomain = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ domainId: z.string() }).parse(d))
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

    const inboxes = await db
      .select()
      .from(plannedInboxes)
      .where(eq(plannedInboxes.domainId, domain.id));
    const uniqueSubdomains = Array.from(new Set(inboxes.map((i: any) => i.subdomainFqdn)));

    const results = [];

    // 6.1 Add Subdomains as Mail Domains
    for (const sub of uniqueSubdomains) {
      try {
        const res = await fetch(`https://${domain.mailcowHostname}/api/v1/add/domain`, {
          method: "POST",
          headers: {
            "X-API-Key": domain.mailcowApiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            domain: sub,
            active: 1,
            max_mailboxes: 10,
            max_quota: 10240,
            quota: 10240,
          }),
        });
        const json = await res.json();
        results.push({ type: "domain", name: sub, success: res.ok, data: json });
      } catch (err) {
        results.push({ type: "domain", name: sub, success: false, error: String(err) });
      }
    }

    // 6.2 Create Mailboxes
    for (const ib of inboxes) {
      try {
        const mailboxPassword = Math.random().toString(36).slice(-10) + "1!A";
        const res = await fetch(`https://${domain.mailcowHostname}/api/v1/add/mailbox`, {
          method: "POST",
          headers: {
            "X-API-Key": domain.mailcowApiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            local_part: ib.localPart,
            domain: ib.subdomainFqdn,
            name: ib.personName,
            password: mailboxPassword,
            quota: 3072,
            active: 1,
          }),
        });
        const json = await res.json();

        if (res.ok) {
          await db
            .update(plannedInboxes)
            .set({
              password: mailboxPassword,
              status: "active",
            })
            .where(eq(plannedInboxes.id, ib.id));
        }

        results.push({ type: "mailbox", name: ib.email, success: res.ok, data: json });
      } catch (err) {
        results.push({ type: "mailbox", name: ib.email, success: false, error: String(err) });
      }
    }

    return { results };
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
        // 7.1 Fetch DKIM
        const res = await fetch(`https://${domain.mailcowHostname}/api/v1/get/dkim/${sub}`, {
          headers: { "X-API-Key": domain.mailcowApiKey },
        });
        const json = await res.json();
        if (!json.dkim_public) {
          results.push({ name: sub, success: false, error: "DKIM not found in Mailcow" });
          continue;
        }

        const dkimKey = json.dkim_public.replace(/(\r\n|\n|\r)/gm, "");

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

        if (dnsRec?.cfRecordId) {
          const cfRes = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${domain.cfZoneId}/dns_records/${dnsRec.cfRecordId}`,
            {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${secrets.cfApiToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                type: "TXT",
                name: dnsRec.name === "@" ? domain.name : `${dnsRec.name}.${domain.name}`,
                content: `v=DKIM1;k=rsa;t=s;s=email;p=${dkimKey}`,
                ttl: 1,
              }),
            },
          );
          const cfJson = await cfRes.json();
          results.push({ name: sub, success: cfJson.success, error: cfJson.errors?.[0]?.message });
        } else {
          results.push({
            name: sub,
            success: false,
            error: "Cloudflare Record ID not found in DB",
          });
        }
      } catch (err) {
        results.push({ name: sub, success: false, error: String(err) });
      }
    }

    return { results };
  });
