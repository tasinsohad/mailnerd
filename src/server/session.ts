import { createServerFn } from "@tanstack/react-start";
import {
  deleteCookie,
  getCookie,
  getRequest,
  getRequestHeader,
  getRequestIP,
  getRequestUrl,
  setCookie,
} from "@tanstack/react-start/server";
import { z } from "zod";
import {
  createLoginThrottle,
  createSessionToken,
  credentialsMatch,
  CROSS_SITE_ERROR,
  crossSiteServerFnReason,
  isHttpsRequest,
  readAuthConfig,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifySessionToken,
} from "./auth-core";

// Sign-in for the app: one account from ADMIN_EMAIL / ADMIN_PASSWORD, remembered in a signed cookie.
// requireAuth (src/lib/auth.ts) checks that cookie before every other server function, and the
// live-log stream (sse-node.ts) checks it too.
//
// Only createServerFn exports here. One plain runtime export would make this a "mixed" module that
// TanStack Start can't strip out of the browser bundle.

// Failed sign-ins per client (an IPv6 /64 counts as one), plus a cap on failures from everyone
// together. In memory: a restart clears it, which is fine for slowing guessing.
const throttle = createLoginThrottle();

// What an anonymous visitor learns when sign-in isn't configured. Which variables are missing or too
// short goes to the server log instead.
const NOT_CONFIGURED = "Sign-in isn't configured on the server yet. Check the server logs.";
let reportedSetupProblems = false;

function reportSetupProblems(problems: string[]) {
  if (reportedSetupProblems) return; // process.env doesn't change without a restart
  reportedSetupProblems = true;
  console.error(`Sign-in is not configured: ${problems.join("; ")}. Fix .env and restart the app.`);
}

// Signing in and out change the session cookie, so another site mustn't be able to trigger either.
// requireAuth makes the same check for every other server function.
function refuseCrossSiteCall() {
  const reason = crossSiteServerFnReason(getRequest());
  if (reason) {
    console.warn(`Refused a server function call from another site: ${reason}`);
    throw new Error(CROSS_SITE_ERROR);
  }
}

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
  const auth = readAuthConfig(process.env);
  if (!auth.ok) {
    reportSetupProblems(auth.problems);
    return { authenticated: false, email: null as string | null, setupError: NOT_CONFIGURED as string | null };
  }
  const email = verifySessionToken(getCookie(SESSION_COOKIE), auth.config);
  return { authenticated: email !== null, email, setupError: null as string | null };
});

export const login = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ email: z.string().max(320), password: z.string().max(1024) }).parse(d),
  )
  .handler(async ({ data }) => {
    refuseCrossSiteCall();

    const auth = readAuthConfig(process.env);
    if (!auth.ok) {
      reportSetupProblems(auth.problems);
      return { ok: false, error: NOT_CONFIGURED };
    }

    // Caddy sets X-Forwarded-For. The app's port isn't published (docker-compose.yml), so nobody
    // outside can forge it to dodge the limit.
    const client = getRequestIP({ xForwardedFor: true }) ?? "unknown";
    const waitMs = throttle.retryAfterMs(client);
    if (waitMs > 0) {
      const minutes = Math.ceil(waitMs / 60_000);
      return {
        ok: false,
        error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      };
    }

    if (!credentialsMatch(data.email, data.password, auth.config)) {
      throttle.recordFailure(client);
      return { ok: false, error: "Wrong email or password." };
    }

    throttle.reset(client);
    setCookie(SESSION_COOKIE, createSessionToken(auth.config), {
      httpOnly: true,
      sameSite: "lax",
      // Secure only over HTTPS: browsers drop a Secure cookie sent over plain http://, and sign-in
      // would silently loop back to this page.
      secure: isHttpsRequest(getRequestUrl().href, getRequestHeader("x-forwarded-proto")),
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return { ok: true, error: null as string | null };
  });

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  refuseCrossSiteCall();
  deleteCookie(SESSION_COOKIE, { path: "/" });
  return { ok: true };
});
