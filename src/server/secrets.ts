import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { userSecrets, cloudflareZones } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// Validation schemas
const saveSecretsSchema = z.object({
  cfApiToken: z
    .string()
    .trim()
    .max(255, "API token too long")
    .optional()
    .nullable()
    .or(z.literal("")),
  cfAccountId: z
    .string()
    .trim()
    .max(255, "Account ID too long")
    .optional()
    .nullable()
    .or(z.literal("")),
});

const verifyCfTokenSchema = z.object({
  token: z.string().trim().min(1, "Token cannot be empty").max(255, "Token too long"),
});

export const getSecrets = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { db, userId, dbError } = (context as any) as { db: any; userId: string; dbError?: string };
    if (!db) {
      return { __error: `Database connection failed. Please check your DATABASE_URL environment variable. Details: ${dbError || "Unknown connection error"}` } as any;
    }
    try {
      const row = await db.query.userSecrets.findFirst({
        where: eq(userSecrets.userId, userId),
      });
      return row ?? {};
    } catch (error: any) {
      if (error.message?.includes("does not exist")) {
        return { __error: "The database connected successfully, but the tables are missing. Please run `npm run db:push` to create your database schema." } as any;
      }
      return { __error: `Database query failed: ${error.message}` } as any;
    }
  });

export const saveSecrets = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => saveSecretsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) {
      throw new Error("Database not connected. Please check your connection.");
    }
    const existing = await db.query.userSecrets.findFirst({
      where: eq(userSecrets.userId, userId),
    });
    if (existing) {
      await db.update(userSecrets).set(data as any).where(eq(userSecrets.userId, userId));
    } else {
      await db.insert(userSecrets).values({ userId, ...(data as any) });
    }
    return { ok: true };
  });

export const verifyCfToken = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => verifyCfTokenSchema.parse(d))
  .handler(async ({ data }) => {
    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: {
          Authorization: `Bearer ${data.token}`,
          "Content-Type": "application/json",
        },
      });
      const json = (await res.json()) as any;
      return {
        valid: json.success && json.result?.status === "active",
        error: json.errors?.[0]?.message,
      };
    } catch (error) {
      return { valid: false, error: String(error) };
    }
  });

export const syncCfZones = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return { error: "Database not connected" };

    const secrets = await db.query.userSecrets.findFirst({
      where: eq(userSecrets.userId, userId),
    });
    if (!secrets?.cfApiToken) return { error: "Cloudflare token not found" };

    try {
      const res = await fetch("https://api.cloudflare.com/client/v4/zones?per_page=50", {
        headers: {
          Authorization: `Bearer ${secrets.cfApiToken}`,
          "Content-Type": "application/json",
        },
      });
      const json = (await res.json()) as any;
      if (!json.success) return { error: json.errors?.[0]?.message };

      const zonesData = (json.result ?? []).map((z: any) => ({
        userId,
        zoneId: z.id,
        name: z.name,
        status: z.status,
      }));

      if (zonesData.length > 0) {
        await db.delete(cloudflareZones).where(eq(cloudflareZones.userId, userId));
        await db.insert(cloudflareZones).values(zonesData);
      }

      return { count: zonesData.length };
    } catch (error) {
      return { error: String(error) };
    }
  });

export const getCfZones = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    if (!db) return [];

    try {
      const cached = await db
        .select()
        .from(cloudflareZones)
        .where(eq(cloudflareZones.userId, userId));
      return cached.map((z: any) => ({ id: z.zoneId, name: z.name, status: z.status }));
    } catch {
      return [];
    }
  });
