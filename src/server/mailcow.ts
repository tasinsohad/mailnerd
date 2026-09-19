import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { domains, plannedInboxes } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { ensureMailDomains, createMailboxes, unproxyDns } from "./pipeline";
import { ensureWorkingApiKey } from "./mailcow-key";
import { syncDkimForDomain } from "./domains-heal";
import { claimDomain, releaseDomain, busyMessage } from "./domain-locks";
import { createMailboxProgressWriter } from "./mailbox-progress-store";

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

    // One mailbox run per domain, and never alongside a server setup (which re-installs Mailcow).
    const claim = claimDomain(loaded.id, "mailbox setup");
    if (!claim.ok) return { error: busyMessage(claim.running) };

    try {
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
      const { existingDomains, results: domainResults, ssh } = ensured;
      // Live progress for the job board / domain page (src/lib/mailbox-progress.ts): total is the
      // domain's full planned inbox count, not just what's pending this run.
      const [{ n: plannedTotal }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(plannedInboxes)
        .where(eq(plannedInboxes.domainId, domain.id));
      const progressWriter = createMailboxProgressWriter(db, domain.id, plannedTotal);
      // Reuse the transport ensureMailDomains chose (direct, or SSH-tunnel when the app's IP is
      // allow-list-blocked) so the mailbox creates go the same reachable way.
      const { results: mailboxResults, summary, failed } = await createMailboxes(db, domain, existingDomains, {
        recreate: data.recreate,
        ssh,
        onProgress: (done, failedCount, total, finished) =>
          finished ? void progressWriter.finish(done, failedCount) : progressWriter.update(done),
      });
      // createMailboxes reports the finish before it returns: let that last write land before the page
      // stops polling the progress.
      await progressWriter.settled();
      return { results: [...domainResults, ...mailboxResults], summary, failed };
    } finally {
      releaseDomain(loaded.id, claim.owner);
    }
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
      with: { server: true }, // so syncDkim can tunnel the API over SSH when the app IP is blocked
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
