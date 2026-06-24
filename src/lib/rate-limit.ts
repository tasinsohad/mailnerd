import { createMiddleware } from "@tanstack/react-start";
import { rateLimits } from "./db/schema";
import { eq, and, gte } from "drizzle-orm";
import { getDb } from "./db";

const DEFAULT_LIMIT = 100;
const DEFAULT_WINDOW_MS = 60 * 1000;

interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
  keyPrefix?: string;
}

export function createRateLimiter(options: RateLimitOptions = {}) {
  const { limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS, keyPrefix = "global" } = options;

  return createMiddleware().server(async ({ context, next }) => {
    const ctx = context as unknown as { userId?: string };
    const userId = ctx.userId;
    if (!userId) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const db = getDb();
      const now = new Date();
      const windowStart = new Date(now.getTime() - windowMs);

      const existing = await db.query.rateLimits.findFirst({
        where: and(
          eq(rateLimits.userId, userId),
          eq(rateLimits.provider, keyPrefix),
          gte(rateLimits.windowStart, windowStart),
        ),
      });

      if (existing && existing.count >= limit) {
        return new Response(
          JSON.stringify({
            error: "Rate limit exceeded",
            retryAfter: Math.ceil(
              (existing.windowStart.getTime() + windowMs - now.getTime()) / 1000,
            ),
          }),
          {
            status: 429,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (existing) {
        await db
          .update(rateLimits)
          .set({ count: existing.count + 1 })
          .where(eq(rateLimits.id, existing.id));
      } else {
        await db.insert(rateLimits).values({
          userId,
          provider: keyPrefix,
          count: 1,
          windowStart: now,
        });
      }
    } catch (error) {
      console.error("Rate limit check failed:", error);
    }

    return next();
  });
}

export const apiRateLimiter = createRateLimiter({
  limit: 100,
  windowMs: 60 * 1000,
  keyPrefix: "api",
});

export const dnsPushRateLimiter = createRateLimiter({
  limit: 10,
  windowMs: 60 * 1000,
  keyPrefix: "dns-push",
});

export const serverSetupRateLimiter = createRateLimiter({
  limit: 5,
  windowMs: 300 * 1000,
  keyPrefix: "server-setup",
});
