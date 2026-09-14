import { createMiddleware } from "@tanstack/react-start";
import { users } from "./db/schema";
import { eq } from "drizzle-orm";

// All app data belongs to this one internal user record, which predates sign-in: existing domains,
// servers and jobs point at it. Signing in (src/server/session.ts) is what grants access to it.
const DEFAULT_USER_EMAIL = "admin@smtpforge.local";

// Runs before every server function. Without a valid session cookie nothing runs, and the error says
// UNAUTHENTICATED so the browser (src/lib/providers.tsx) goes to the sign-in page.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const requireAuth = createMiddleware().server(async ({ next }: any) => {
  // Imported inside the server-only callback so none of it can end up in the browser bundle.
  const [{ getCookie }, { readAuthConfig, verifySessionToken, SESSION_COOKIE }] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("../server/auth-core"),
  ]);
  const auth = readAuthConfig(process.env);
  if (!auth.ok || !verifySessionToken(getCookie(SESSION_COOKIE), auth.config)) {
    throw new Error("UNAUTHENTICATED: sign in to continue.");
  }

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
  } catch (error: any) {
    console.error("CRITICAL: Database connection error:", error);

    // Extract postgres-js detailed error fields if present
    const details = [];
    if (error?.severity) details.push(`[${error.severity}]`);
    if (error?.code) details.push(`Code: ${error.code}`);
    if (error?.detail) details.push(`Detail: ${error.detail}`);
    if (error?.hint) details.push(`Hint: ${error.hint}`);
    if (error?.cause) details.push(`Cause: ${error.cause?.message || String(error.cause)}`);
    if (error?.originalError) details.push(`OriginalError: ${error.originalError?.message || String(error.originalError)}`);

    const dbErrorMessage = details.length > 0
      ? `${error?.message || "Query failed"} (${details.join(", ")})`
      : error?.message || String(error);

    user = { id: "dev-user", email: DEFAULT_USER_EMAIL };
    userId = "dev-user";
    db = null;
    return next({
      context: {
        db: null,
        userId: "dev-user",
        user: { id: "dev-user", email: DEFAULT_USER_EMAIL },
        dbError: dbErrorMessage,
      },
    });
  }
});
