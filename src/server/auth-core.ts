import { createHmac, timingSafeEqual } from "node:crypto";

// Sign-in for this app: one operator account configured through environment variables, remembered in
// a signed session cookie. App data stays owned by the internal user record it has always used, so
// turning sign-in on doesn't orphan any existing domain, server or job.
//
// Leaf module (node:crypto only) so tests can load it without the framework. Server code only.

export const SESSION_COOKIE = "mn_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const MIN_PASSWORD_LENGTH = 12;
const MIN_SECRET_LENGTH = 32;

export type AuthConfig = { email: string; password: string; secret: string };
export type AuthConfigResult = { ok: true; config: AuthConfig } | { ok: false; problems: string[] };

export function readAuthConfig(env: Record<string, string | undefined>): AuthConfigResult {
  const email = env.ADMIN_EMAIL?.trim() ?? "";
  const password = env.ADMIN_PASSWORD ?? "";
  const secret = env.SESSION_SECRET ?? "";

  const problems: string[] = [];
  if (!email) problems.push("ADMIN_EMAIL is not set");
  if (!password) problems.push("ADMIN_PASSWORD is not set");
  else if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!secret) problems.push("SESSION_SECRET is not set");
  else if (secret.length < MIN_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  return problems.length ? { ok: false, problems } : { ok: true, config: { email, password, secret } };
}

// The signing key mixes in the password, so changing ADMIN_PASSWORD (or SESSION_SECRET) signs every
// existing session out.
function sign(payload: string, config: AuthConfig): string {
  const key = createHmac("sha256", config.secret).update(`session-key:${config.password}`).digest();
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function createSessionToken(config: AuthConfig, nowMs = Date.now()): string {
  const claims = { e: config.email.toLowerCase(), x: Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(payload, config)}`;
}

/** The signed-in email, or null for a missing, forged, expired or outdated token. Never throws. */
export function verifySessionToken(
  token: string | null | undefined,
  config: AuthConfig,
  nowMs = Date.now(),
): string | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;

  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(payload, config), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const { e, x } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof e !== "string" || typeof x !== "number") return null;
    if (x * 1000 <= nowMs) return null;
    // Issued for the account that is configured now, not one ADMIN_EMAIL used to name.
    if (e !== config.email.toLowerCase()) return null;
    return e;
  } catch {
    return null;
  }
}

/** Email of the signed-in operator for a session cookie value, or null. */
export function sessionEmail(
  token: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const auth = readAuthConfig(env);
  return auth.ok ? verifySessionToken(token, auth.config) : null;
}

// Compare HMAC digests rather than the raw strings: equal-length buffers let timingSafeEqual run on
// whatever was typed, so the response time doesn't reveal how much of the password was right.
function digest(value: string, config: AuthConfig): Buffer {
  return createHmac("sha256", config.secret).update(value).digest();
}

export function credentialsMatch(email: string, password: string, config: AuthConfig): boolean {
  const emailOk = timingSafeEqual(
    digest(email.trim().toLowerCase(), config),
    digest(config.email.toLowerCase(), config),
  );
  const passwordOk = timingSafeEqual(digest(password, config), digest(config.password, config));
  return emailOk && passwordOk;
}

/** Slows password guessing: after `maxFailures` failed sign-ins, a client waits out the window. */
export function createLoginThrottle({ maxFailures = 10, windowMs = 15 * 60_000 } = {}) {
  const failures = new Map<string, { count: number; firstAt: number }>();

  const expired = (entry: { firstAt: number }, nowMs: number) => nowMs - entry.firstAt >= windowMs;

  return {
    /** Milliseconds until this client may try again; 0 means it may try now. */
    retryAfterMs(key: string, nowMs = Date.now()): number {
      const entry = failures.get(key);
      if (!entry) return 0;
      if (expired(entry, nowMs)) {
        failures.delete(key);
        return 0;
      }
      return entry.count >= maxFailures ? windowMs - (nowMs - entry.firstAt) : 0;
    },

    recordFailure(key: string, nowMs = Date.now()): void {
      // Many distinct clients must not grow the map forever.
      if (failures.size > 10_000) {
        for (const [k, entry] of failures) if (expired(entry, nowMs)) failures.delete(k);
      }
      const entry = failures.get(key);
      if (!entry || expired(entry, nowMs)) failures.set(key, { count: 1, firstAt: nowMs });
      else entry.count++;
    },

    reset(key: string): void {
      failures.delete(key);
    },
  };
}

/** One cookie's value from a raw Cookie header (for handlers outside TanStack Start, like /api/sse). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** Whether the browser reached us over HTTPS: directly, or through a proxy such as Caddy. */
export function isHttpsRequest(url: string | undefined, forwardedProto: string | undefined): boolean {
  if (forwardedProto) return forwardedProto.split(",")[0].trim().toLowerCase() === "https";
  return url?.startsWith("https:") ?? false;
}
