import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { domains, dnsRecords, plannedInboxes, userSecrets, cloudflareZones } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveAndSaveCfZoneId } from "./domains";
import {
  QUOTA,
  generateMailboxPassword,
  mailcowRequest,
  parseMailcowResult,
  cfTxtContent,
} from "./mailcow-helpers";

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

    const host = domain.mailcowHostname;
    const apiKey = domain.mailcowApiKey;
    const mc = (path: string, body?: unknown) => mailcowRequest(host, apiKey, path, body);

    const inboxes = await db
      .select()
      .from(plannedInboxes)
      .where(eq(plannedInboxes.domainId, domain.id));
    const uniqueSubdomains = Array.from(new Set(inboxes.map((i: any) => String(i.subdomainFqdn))));

    const results: { type: string; name: string; success: boolean; error?: string | null }[] = [];

    // Quota sizing. IMPORTANT: Mailcow's add/domain fields are `mailboxes`, `quota`
    // (domain TOTAL, MB), `maxquota` (max a single mailbox may have, MB) and `defquota`.
    // Constraints Mailcow enforces: maxquota <= quota, and sum(mailbox quotas) <= quota.
    // (A previous version sent `max_mailboxes`/`max_quota` - names Mailcow ignores - plus
    // quota:1024, which made maxquota > domain quota => "mailbox_quota_exceeds_domain_quota".)
    const { DOMAIN_MAX_MAILBOXES, DOMAIN_QUOTA_MB, MAILBOX_MAX_QUOTA_MB, MAILBOX_QUOTA_MB } = QUOTA;

    // --- 1. Ensure mail domains exist with adequate quota (correct Mailcow field names) ---
    const addDomainErrors: Record<string, string> = {};
    for (const sub of uniqueSubdomains) {
      try {
        // Create if missing.
        const addRes = await mc("add/domain", {
          domain: sub,
          active: 1,
          mailboxes: DOMAIN_MAX_MAILBOXES,
          defquota: MAILBOX_QUOTA_MB,
          maxquota: MAILBOX_MAX_QUOTA_MB,
          quota: DOMAIN_QUOTA_MB,
        });
        const addOutcome = parseMailcowResult(addRes.ok, addRes.json);
        if (!addOutcome.success) {
          if (addOutcome.error) addDomainErrors[String(sub)] = addOutcome.error;
          // If it already exists, repair its limits via edit/domain (add is a no-op then).
          await mc("edit/domain", {
            items: [sub],
            attr: {
              mailboxes: DOMAIN_MAX_MAILBOXES,
              maxquota: MAILBOX_MAX_QUOTA_MB,
              quota: DOMAIN_QUOTA_MB,
            },
          });
        }
      } catch {
        // Verified against get/domain/all below - POST result is not trusted.
      }
    }

    // Source of truth: which mail domains does Mailcow actually have now?
    const existingDomains = new Set<string>();
    try {
      const { json } = await mc("get/domain/all");
      if (Array.isArray(json)) {
        for (const d of json) if (d?.domain_name) existingDomains.add(String(d.domain_name).toLowerCase());
      }
    } catch {
      // leave empty -> domains reported as missing below
    }
    for (const sub of uniqueSubdomains) {
      const ok = existingDomains.has(String(sub).toLowerCase());
      results.push({
        type: "domain",
        name: String(sub),
        success: ok,
        error: ok
          ? null
          : `add/domain rejected${addDomainErrors[String(sub)] ? `: ${addDomainErrors[String(sub)]}` : ""}`,
      });
    }

    // --- 2. Clean slate: delete existing mailboxes first (keep domain + DKIM) ---
    if (data.recreate && inboxes.length) {
      try {
        // delete/mailbox expects a JSON array of usernames
        await mc("delete/mailbox", inboxes.map((ib: any) => ib.email));
      } catch {
        // best effort; verification below reflects real state
      }
      await db
        .update(plannedInboxes)
        .set({ status: "planned", password: null })
        .where(eq(plannedInboxes.domainId, domain.id));
    }

    // --- 3. Create mailboxes ---
    const passwordByEmail: Record<string, string> = {};
    const createdThisRun = new Set<string>();
    for (const ib of inboxes) {
      const key = String(ib.email).toLowerCase();
      // Skip if the parent mail domain isn't actually in Mailcow - add/mailbox would fail.
      if (!existingDomains.has(String(ib.subdomainFqdn).toLowerCase())) {
        results.push({
          type: "mailbox",
          name: ib.email,
          success: false,
          error: `Parent mail domain ${ib.subdomainFqdn} is missing in Mailcow`,
        });
        continue;
      }
      try {
        const mailboxPassword = generateMailboxPassword();
        passwordByEmail[key] = mailboxPassword;
        const r = await mc("add/mailbox", {
          local_part: ib.localPart,
          domain: ib.subdomainFqdn,
          name: ib.personName,
          password: mailboxPassword,
          password2: mailboxPassword, // Mailcow requires the confirmation field; an
          // empty password2 triggers a misleading "password_complexity" error.
          quota: MAILBOX_QUOTA_MB,
          active: 1,
        });
        const outcome = parseMailcowResult(r.ok, r.json);
        if (outcome.success) createdThisRun.add(key);
        results.push({ type: "mailbox", name: ib.email, success: outcome.success, error: outcome.error ?? null });
      } catch (err) {
        results.push({ type: "mailbox", name: ib.email, success: false, error: String(err) });
      }
    }

    // --- 4. Verify mailboxes ACTUALLY exist in Mailcow (the source of truth) ---
    const existingMailboxes = new Set<string>();
    try {
      const { json } = await mc("get/mailbox/all");
      if (Array.isArray(json)) {
        for (const m of json) if (m?.username) existingMailboxes.add(String(m.username).toLowerCase());
      }
    } catch {
      // leave empty -> everything reported as failed below
    }

    let created = 0;
    let failed = 0;
    for (const ib of inboxes) {
      const key = String(ib.email).toLowerCase();
      const confirmed = existingMailboxes.has(key);
      if (confirmed) {
        created++;
        await db
          .update(plannedInboxes)
          .set({
            status: "active",
            // Only overwrite the password if WE created it this run; otherwise keep
            // whatever is already stored (re-running shouldn't clobber a known password).
            ...(createdThisRun.has(key) ? { password: passwordByEmail[key] } : {}),
          })
          .where(eq(plannedInboxes.id, ib.id));
      } else {
        failed++;
        await db.update(plannedInboxes).set({ status: "failed" }).where(eq(plannedInboxes.id, ib.id));
      }
    }

    // Reconcile per-mailbox result with verified reality so the UI never lies.
    const verifiedResults = results.map((r) => {
      if (r.type !== "mailbox") return r;
      const confirmed = existingMailboxes.has(String(r.name).toLowerCase());
      return {
        ...r,
        success: confirmed,
        error: confirmed ? null : r.error || "Mailbox not present in Mailcow after creation",
      };
    });

    return {
      results: verifiedResults,
      summary: { total: inboxes.length, created, failed },
    };
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
