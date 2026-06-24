import { createMiddleware } from "@tanstack/react-start";
import { users } from "./db/schema";
import { eq } from "drizzle-orm";

const DEFAULT_USER_EMAIL = "admin@smtpforge.local";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const requireAuth = createMiddleware().server(async ({ next }: any) => {
  let db: any = null;
  let user: any = null;
  let userId: string = "dev-user";

  try {
    // Dynamically import to avoid errors at module load time
    const { getDb } = await import("./db");
    db = getDb();

    user = await db.query.users.findFirst({
      where: eq(users.email, DEFAULT_USER_EMAIL),
    });

    if (!user) {
      const [newUser] = await db
        .insert(users)
        .values({
          email: DEFAULT_USER_EMAIL,
        })
        .returning();
      user = newUser;
      userId = newUser?.id ?? "dev-user";
    } else {
      userId = user.id;
    }

    return next({
      context: {
        db,
        userId,
        user,
      },
    });
  } catch (error) {
    console.error("CRITICAL: Database connection error:", error);
    user = { id: "dev-user", email: DEFAULT_USER_EMAIL };
    userId = "dev-user";
    db = null;
    return next({
      context: {
        db: null,
        userId: "dev-user",
        user: { id: "dev-user", email: DEFAULT_USER_EMAIL },
        dbError: String(error),
      },
    });
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const optionalAuth = createMiddleware().server(async ({ next }: any) => {
  let db: any = null;
  let user: any = null;
  let userId: string | null = null;

  try {
    const { getDb } = await import("./db");
    db = getDb();
    user = await db.query.users.findFirst({
      where: eq(users.email, DEFAULT_USER_EMAIL),
    });
    userId = user?.id ?? null;
  } catch (error) {
    console.error("Database connection error (optional auth):", error);
  }

  return next({
    context: {
      db,
      userId,
      user,
    },
  });
});
