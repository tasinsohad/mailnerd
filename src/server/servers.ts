import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { servers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

// Validation schemas
const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
const hostnameRegex = /^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/;

const serverInputSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_\-\s]+$/, "Label contains invalid characters"),
  hostname: z.string().min(1).max(255).regex(hostnameRegex, "Invalid hostname format"),
  ipAddress: z
    .string()
    .min(1)
    .refine(
      (val) => ipv4Regex.test(val) || hostnameRegex.test(val),
      "Invalid IP address or hostname",
    ),
  sshUser: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-zA-Z0-9_-]+$/, "Invalid SSH username"),
});

export const listServers = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId, dbError } = context as any;
    if (!db) {
      console.error("listServers failed:", dbError);
      return [];
    }

    try {
      const rows = await db.select().from(servers).where(eq(servers.userId, userId));
      return rows;
    } catch {
      return [];
    }
  });

export const createServer = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => serverInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId, dbError } = context as any;
    if (!db) return { error: dbError || "Database not connected" };

    try {
      const [row] = await db
        .insert(servers)
        .values({
          userId,
          label: data.label,
          hostname: data.hostname,
          ipAddress: data.ipAddress,
          sshUser: data.sshUser,
          status: "configuring",
        })
        .returning();
      return row;
    } catch (error) {
      return { error: String(error) };
    }
  });

export const deleteServer = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().min(1) }).parse(d))
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId, dbError } = context as any;
    if (!db) return { ok: false, error: dbError || "Database not connected" };

    try {
      await db.delete(servers).where(and(eq(servers.id, data.id), eq(servers.userId, userId)));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
