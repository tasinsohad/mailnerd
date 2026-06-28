import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { domains } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { ensureMailDomains, createMailboxes, syncDkim } from "./pipeline";

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
    if (!domain.mailcowHostname || !domain.mailcowApiKey) {
      return { error: "Mailcow credentials missing" };
    }

    try {
      return await syncDkim(db, domain, userId);
    } catch (err) {
      return { error: String(err) };
    }
  });
