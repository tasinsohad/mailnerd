import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { userSecrets, cloudflareZones } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// Validation schemas
const saveSecretsSchema = z.object({
  // The browser never receives the saved token, so the settings form starts empty: an empty or
  // missing value keeps the saved token. Only a new value replaces it.
  cfApiToken: z
    .string()
    .trim()
    .max(255, "API token too long")
    .optional()
    .nullable()
    .or(z.literal("")),
  // Removing the saved token has to be asked for explicitly.
  clearCfApiToken: z.boolean().optional(),
  cfAccountId: z
    .string()
    .trim()
    .max(255, "Account ID too long")
    .optional()
    .nullable()
    .or(z.literal("")),
});

const verifyCfTokenSchema = z.object({
  // Leave it out to check the saved token, which the browser doesn't have.
  token: z.string().trim().max(255, "Token too long").optional(),
});

// Enough of a saved token to recognise it (its last 4 characters). A very short value would be
// mostly given away by that, so it gets no hint.
function tokenHint(token: string): string | null {
  return token.length >= 12 ? token.slice(-4) : null;
}

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
      // Never the token itself: server code that calls Cloudflare reads it from the database.
      const token: string | null = row?.cfApiToken || null;
      return {
        cfAccountId: (row?.cfAccountId as string | null | undefined) ?? null,
        hasCfApiToken: token !== null,
        cfApiTokenHint: token ? tokenHint(token) : null,
      };
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
    const changes: { cfApiToken?: string | null; cfAccountId?: string | null } = {};
    if (data.clearCfApiToken) changes.cfApiToken = null;
    else if (data.cfApiToken) changes.cfApiToken = data.cfApiToken;
    // The account ID isn't secret: the form always shows and sends it, so "" clears it as before.
    if (data.cfAccountId !== undefined) changes.cfAccountId = data.cfAccountId;

    const existing = await db.query.userSecrets.findFirst({
      where: eq(userSecrets.userId, userId),
    });
    if (existing) {
      if (Object.keys(changes).length > 0) {
        await db.update(userSecrets).set(changes).where(eq(userSecrets.userId, userId));
      }
    } else {
      await db.insert(userSecrets).values({ userId, ...changes });
    }
    return { ok: true };
  });

export const verifyCfToken = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => verifyCfTokenSchema.parse(d))
  .handler(async ({ data, context }) => {
    try {
      let token = data.token;
      if (!token) {
        const { db, userId } = (context as any) as { db: any; userId: string };
        if (!db) return { valid: false, error: "Database not connected" };
        const saved = await db.query.userSecrets.findFirst({
          where: eq(userSecrets.userId, userId),
        });
        token = saved?.cfApiToken || undefined;
        if (!token) return { valid: false, error: "No Cloudflare API token is saved yet" };
      }

      // 1. Try standard user tokens verify
      const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      const json = (await res.json()) as any;
      if (json.success && json.result?.status === "active") {
        return { valid: true };
      }

      // 2. Fallback: Test if token can list zones (which is the actual capability required by the app)
      const zonesRes = await fetch("https://api.cloudflare.com/client/v4/zones?per_page=1", {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      const zonesJson = (await zonesRes.json()) as any;
      if (zonesJson.success) {
        return { valid: true };
      }

      // If both fail, return the error
      return {
        valid: false,
        error: zonesJson.errors?.[0]?.message || json.errors?.[0]?.message || "Invalid API token",
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
