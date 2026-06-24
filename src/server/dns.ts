import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { dnsRecords } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export const listDnsRecords = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ domainId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    return await db
      .select()
      .from(dnsRecords)
      .where(and(eq(dnsRecords.domainId, data.domainId), eq(dnsRecords.userId, userId)))
      .orderBy(dnsRecords.type);
  });

const createDnsRecordSchema = z.object({
  domainId: z.string(),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "SRV"]),
  name: z.string(),
  content: z.string(),
  ttl: z.number().default(1),
  priority: z.number().optional().nullable(),
});

export const createDnsRecord = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => createDnsRecordSchema.parse(d))
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    const [res] = await db
      .insert(dnsRecords)
      .values({
        userId,
        ...data,
        status: "pending",
      })
      .returning();
    return res;
  });
