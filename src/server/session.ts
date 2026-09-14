import { createServerFn } from "@tanstack/react-start";
import {
  deleteCookie,
  getCookie,
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

// Failed sign-ins per client IP. In memory: a restart clears it, which is fine for slowing guessing.
const throttle = createLoginThrottle();

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
  const auth = readAuthConfig(process.env);
  if (!auth.ok) {
    return { authenticated: false, email: null as string | null, setupProblems: auth.problems };
  }
  const email = verifySessionToken(getCookie(SESSION_COOKIE), auth.config);
  return { authenticated: email !== null, email, setupProblems: [] as string[] };
});

export const login = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ email: z.string().max(320), password: z.string().max(1024) }).parse(d),
  )
  .handler(async ({ data }) => {
    const auth = readAuthConfig(process.env);
    if (!auth.ok) {
      return { ok: false, error: `Sign-in isn't set up on the server: ${auth.problems.join("; ")}.` };
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
  deleteCookie(SESSION_COOKIE, { path: "/" });
  return { ok: true };
});
