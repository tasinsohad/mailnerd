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

/**
 * Which "client" the login throttle counts a failure against. IPv4 addresses count one by one. IPv6
 * addresses count per /64: one customer usually gets a whole /64 and can hop between its addresses
 * at will. An IPv4-mapped IPv6 address (::ffff:1.2.3.4, as Node reports IPv4 clients on a dual-stack
 * socket) counts as its IPv4 address. Anything that doesn't parse is used as it is.
 */
export function loginThrottleKey(ip: string): string {
  let value = ip.trim().toLowerCase();
  if (value.startsWith("[") && value.includes("]")) value = value.slice(1, value.indexOf("]"));
  const zone = value.indexOf("%"); // fe80::1%eth0: the zone names a local interface, not a host
  if (zone !== -1) value = value.slice(0, zone);
  if (!value.includes(":")) return value;

  const groups = parseIpv6(value);
  if (!groups) return value;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address (lowercase, no zone id), or null if it isn't one. */
function parseIpv6(value: string): number[] | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;

  // A dotted IPv4 tail (::ffff:1.2.3.4) may only end the address.
  const parseGroups = (part: string, mayEndWithIpv4: boolean): number[] | null => {
    if (part === "") return [];
    const pieces = part.split(":");
    const groups: number[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (mayEndWithIpv4 && i === pieces.length - 1 && piece.includes(".")) {
        const octets = parseIpv4(piece);
        if (!octets) return null;
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(piece)) {
        groups.push(parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return groups;
  };

  if (halves.length === 1) {
    const groups = parseGroups(halves[0], true);
    return groups && groups.length === 8 ? groups : null;
  }
  const head = parseGroups(halves[0], false);
  const tail = parseGroups(halves[1], true);
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length; // what "::" stands for: at least one zero group
  return missing >= 1 ? [...head, ...new Array<number>(missing).fill(0), ...tail] : null;
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const octets = parts.map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}

/**
 * Slows password guessing, per client and in total. A client (see loginThrottleKey; callers pass the
 * raw IP) waits out the window after `maxFailures` failed sign-ins. After `maxGlobalFailures` failures
 * from all clients together within the window, every sign-in waits until the oldest of them ages out,
 * so spreading guesses over many addresses gets no further.
 */
export function createLoginThrottle({
  maxFailures = 10,
  maxGlobalFailures = 100,
  windowMs = 15 * 60_000,
  pruneAbove = 1000,
} = {}) {
  const failures = new Map<string, { count: number; firstAt: number }>();
  // When each recent failure happened, oldest first. Never longer than maxGlobalFailures: nothing is
  // recorded while that many are recent.
  const recent: number[] = [];

  const expired = (at: number, nowMs: number) => nowMs - at >= windowMs;

  const globalWaitMs = (nowMs: number): number => {
    while (recent.length > 0 && expired(recent[0], nowMs)) recent.shift();
    return recent.length >= maxGlobalFailures ? windowMs - (nowMs - recent[0]) : 0;
  };

  return {
    /** Milliseconds until this client may try again; 0 means it may try now. */
    retryAfterMs(ip: string, nowMs = Date.now()): number {
      const key = loginThrottleKey(ip);
      let ownWaitMs = 0;
      const entry = failures.get(key);
      if (entry && expired(entry.firstAt, nowMs)) failures.delete(key);
      else if (entry && entry.count >= maxFailures) ownWaitMs = windowMs - (nowMs - entry.firstAt);
      return Math.max(ownWaitMs, globalWaitMs(nowMs));
    },

    recordFailure(ip: string, nowMs = Date.now()): void {
      // Everyone is blocked already. Counting more would only stretch one client's block past it.
      if (globalWaitMs(nowMs) > 0) return;
      recent.push(nowMs);

      const key = loginThrottleKey(ip);
      const entry = failures.get(key);
      if (!entry || expired(entry.firstAt, nowMs)) failures.set(key, { count: 1, firstAt: nowMs });
      else entry.count++;

      // Many distinct clients must not grow the map forever. At most maxGlobalFailures entries can be
      // live at once, so dropping the expired ones keeps it small.
      if (failures.size > pruneAbove) {
        for (const [k, e] of failures) if (expired(e.firstAt, nowMs)) failures.delete(k);
      }
    },

    /** After a successful sign-in: forgets this client's failures (not the total). */
    reset(ip: string): void {
      failures.delete(loginThrottleKey(ip));
    },

    /** How many clients have failures on record (for tests). */
    trackedClients(): number {
      return failures.size;
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

/**
 * The path TanStack Start serves server functions under: its default `serverFns.base` ("/_serverFn",
 * @tanstack/start-plugin-core schema.js) joined with the router basepath (none here) and a trailing
 * slash. The build output has the same value (.output/server/_ssr/index.mjs, SERVER_FN_BASE), and the
 * request handler treats any path starting with it as a server-function call.
 */
export const SERVER_FN_BASE_PATH = "/_serverFn/";

/** Error for a refused cross-site call. Not UNAUTHENTICATED, which sends the browser to sign-in. */
export const CROSS_SITE_ERROR = "FORBIDDEN: this request came from another site.";

type RequestLike = { method: string; url: string; headers: { get(name: string): string | null } };

/**
 * Why a server-function call must be refused as coming from another site, or null to let it run.
 *
 * The SameSite=Lax session cookie still rides along on requests from a sibling subdomain (same-site,
 * not cross-site), and server functions accept form-encoded and plain-text POSTs, which browsers send
 * without a CORS preflight. So check where the request came from:
 * - Sec-Fetch-Site sent: only same-origin (the app itself) and none (typed into the address bar) pass.
 * - Not sent (older browsers): an Origin whose host isn't this request's Host is refused.
 * - Neither header (curl, scripts): allowed.
 *
 * Only real HTTP server-function calls are checked. During server-side rendering, server functions run
 * in-process with the PAGE request, and a page opened from a link on another site rightly says
 * cross-site, so any other path passes.
 */
export function crossSiteServerFnReason(
  request: RequestLike,
  basePath: string = SERVER_FN_BASE_PATH,
): string | null {
  let url: URL;
  try {
    url = new URL(request.url, "http://localhost");
  } catch {
    return null; // The server-function handler can't route this either.
  }
  if (!url.pathname.startsWith(basePath)) return null;
  // Path only: a GET call's query string carries its input.
  const call = `${request.method.toUpperCase()} ${url.pathname}`;

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null) {
    const site = fetchSite.trim().toLowerCase();
    return site === "same-origin" || site === "none"
      ? null
      : `${call}: Sec-Fetch-Site is ${site.slice(0, 40) || "empty"}`;
  }

  const origin = request.headers.get("origin");
  if (origin === null) return null;
  const refusal = `${call}: Origin ${origin.slice(0, 200)} is not this site`;
  try {
    const from = new URL(origin);
    // Parse the Host header with the Origin's scheme, so a default port written out (":443") and
    // letter case don't count as a difference. The URL's own host stands in if Host is missing.
    const host = request.headers.get("host") ?? url.host;
    return new URL(`${from.protocol}//${host}`).host === from.host ? null : refusal;
  } catch {
    return refusal; // "null" (sandboxed or privacy-sensitive contexts), or a malformed header.
  }
}
