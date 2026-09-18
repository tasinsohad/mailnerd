import { createMiddleware } from "@tanstack/react-start";

// Runs before every server function except sign-in/sign-up (src/server/session.ts).
// - A call another site made is refused with FORBIDDEN (see crossSiteServerFnReason in src/server/auth-core.ts).
// - Without a valid session the error says UNAUTHENTICATED, and the browser (src/lib/providers.tsx) goes to
//   sign-in. A pending, suspended or expired account gets ACCOUNT_LOCKED and goes to /account.
// - context.userId is the WORKSPACE every query scopes by: a user's own id, or for the admin the workspace
//   picked with the switcher (the Nextus workspace by default). context.accountId is who is signed in.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const requireAuth = createMiddleware().server(async ({ next }: any) => {
  // Imported inside the server-only callback so none of it can end up in the browser bundle.
  const [
    { getCookie, getRequest },
    { readAuthConfig, SESSION_COOKIE, crossSiteServerFnReason, CROSS_SITE_ERROR },
    { resolveSession, WORKSPACE_COOKIE },
    { getDb },
  ] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("../server/auth-core"),
    import("../server/accounts-db"),
    import("./db"),
  ]);

  // For a page render this is the page's request, which is never refused; for an HTTP call it's the
  // server-function request itself.
  const crossSite = crossSiteServerFnReason(getRequest());
  if (crossSite) {
    console.warn(`Refused a server function call from another site: ${crossSite}`);
    throw new Error(CROSS_SITE_ERROR);
  }

  const auth = readAuthConfig(process.env);
  if (!auth.ok) throw new Error("UNAUTHENTICATED: sign in to continue.");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let session: Awaited<ReturnType<typeof resolveSession>>;
  try {
    db = getDb();
    session = await resolveSession(db, getCookie(SESSION_COOKIE), getCookie(WORKSPACE_COOKIE), auth.config);
  } catch (error) {
    console.error("requireAuth: couldn't check the session:", error instanceof Error ? error.message : error);
    throw new Error("The database isn't answering, so your session couldn't be checked. Try again in a moment.");
  }

  if (session.state === "signed-out") throw new Error("UNAUTHENTICATED: sign in to continue.");
  if (session.state === "locked") throw new Error(`ACCOUNT_LOCKED: ${session.reason}`);

  return next({
    context: {
      db,
      userId: session.workspaceId,
      user: session.account,
      accountId: session.account.id,
      isAdmin: session.isAdmin,
    },
  });
});

// For the admin panel's server functions: requireAuth, then only the admin may continue.
export const requireAdmin = createMiddleware()
  .middleware([requireAuth])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .server(async ({ next, context }: any) => {
    if (!context.isAdmin) throw new Error("FORBIDDEN: only the admin can do this.");
    return next();
  });
