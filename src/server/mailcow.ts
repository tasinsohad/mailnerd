import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { domains } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { ensureMailDomains, createMailboxes, unproxyDns } from "./pipeline";
import { ensureWorkingApiKey } from "./mailcow-key";
import { syncDkimForDomain } from "./domains-heal";

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

    const loaded = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
      with: { server: true },
    });
    if (!loaded || !loaded.mailcowHostname || !loaded.mailcowApiKey) {
      return { error: "Mailcow credentials missing for this domain" };
    }

    // Self-heal a drifted API key (401 after a re-provision) by re-reading it from the server
    // before touching mailboxes — otherwise ensureMailDomains throws "API not reachable".
    const { domain } = await ensureWorkingApiKey(db, loaded);

    // Probe + create the mail domains. The classic failure here is a Cloudflare-PROXIED mail host
    // (orange cloud) intercepting the API — commonly a pre-existing `mail.<domain>` record that
    // pushDns adopted as-is (it matches by name/content and never flips the proxy off). When that
    // happens, self-heal: un-proxy the mail host (idempotent — deletes proxied/wrong-IP mail A
    // records and ensures one DNS-only mail A → server IP) and retry once. Only on the failure path,
    // so a healthy setup is untouched; if the box is genuinely down it still surfaces the error.
    let ensured;
    try {
      ensured = await ensureMailDomains(db, domain);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not reachable/i.test(msg) && domain.ipAddress) {
        await unproxyDns(db, domain, userId).catch(() => {});
        ensured = await ensureMailDomains(db, domain); // re-probes (retries cover re-propagation)
      } else {
        throw e;
      }
    }
    const { existingDomains, results: domainResults } = ensured;
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
    if (!domain.mailcowHostname || !domain.mailcowApiKey) {
      return { error: "Mailcow credentials missing" };
    }

    try {
      const { results } = await syncDkimForDomain(db, domain, userId);
      return { results };
    } catch (err) {
      return { error: String(err) };
    }
  });
