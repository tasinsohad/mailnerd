import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { userSecrets, cloudflareZones } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// Validation schemas
const saveSecretsSchema = z.object({
  cfApiToken: z
    .string()
    .min(1, "API token cannot be empty")
    .max(255, "API token too long")
    .optional()
    .nullable(),
  cfAccountId: z
    .string()
    .min(1, "Account ID cannot be empty")
    .max(255, "Account ID too long")
    .optional()
    .nullable(),
});

const verifyCfTokenSchema = z.object({
  token: z.string().min(1, "Token cannot be empty").max(255, "Token too long"),
});

export const getSecrets = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    const row = await db.query.userSecrets.findFirst({
      where: eq(userSecrets.userId, userId),
    });
    return row ?? null;
  });

export const saveSecrets = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => saveSecretsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { db, userId } = (context as any) as { db: any; userId: string };
    const existing = await db.query.userSecrets.findFirst({
      where: eq(userSecrets.userId, userId),
    });
    if (existing) {
      await db.update(userSecrets).set(data).where(eq(userSecrets.userId, userId));
    } else {
      await db.insert(userSecrets).values({ userId, ...data });
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
