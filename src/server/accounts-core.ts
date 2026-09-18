import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { createLoginThrottle, SESSION_TTL_SECONDS, type AuthConfig } from "./auth-core";

// Accounts: password hashing, the session token that names an account, who may use the app right now, and
// the sign-up rules. Leaf module (node:crypto + auth-core) so tests load it without the framework. Server only.

// ---------- passwords ----------

export const MIN_ACCOUNT_PASSWORD_LENGTH = 10;
const MAX_ACCOUNT_PASSWORD_LENGTH = 200;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

function scryptAsync(password: string, salt: Buffer, keylen: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `scrypt$N$r$p$<salt>$<hash>`, with a fresh 16-byte salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT.N, SCRYPT.r, SCRYPT.p);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

/** Whether `password` matches a stored hash. False for a missing or malformed hash; never throws. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 1 << 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await scryptAsync(password, salt, expected.length, N, r, p);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// A sign-in for an email nobody has still does one scrypt, so response times don't reveal which emails exist.
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("not a real account password");
  await verifyPassword(password, await dummyHash);
}

const TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
/** A temporary password the admin hands out after a reset: no look-alike characters (0/O, 1/l/I). */
export function generateTempPassword(length = 16): string {
  return Array.from({ length }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join("");
}

// ---------- session token ----------

export type AccountClaims = { accountId: string; version: number; admin: boolean };

function signingKey(config: AuthConfig): Buffer {
  return createHmac("sha256", config.secret).update("account-session-v2").digest();
}
// An admin token carries this, so changing ADMIN_PASSWORD still signs the admin out (users are signed out by
// bumping their session_version instead).
function adminFingerprint(config: AuthConfig): string {
  return createHmac("sha256", config.secret).update(`admin-password:${config.password}`).digest("base64url").slice(0, 22);
}
function sign(payload: string, config: AuthConfig): string {
  return createHmac("sha256", signingKey(config)).update(payload).digest("base64url");
}

export function createAccountToken(claims: AccountClaims, config: AuthConfig, nowMs = Date.now()): string {
  const body: Record<string, unknown> = {
    u: claims.accountId,
    v: claims.version,
    x: Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS,
  };
  if (claims.admin) body.a = adminFingerprint(config);
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${sign(payload, config)}`;
}

/** The claims of a valid token, or null for a missing, forged, expired or old-format one. Never throws. */
export function verifyAccountToken(
  token: string | null | undefined,
  config: AuthConfig,
  nowMs = Date.now(),
): AccountClaims | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(payload, config), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { u, v, x, a } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof u !== "string" || !u || !Number.isInteger(v) || typeof x !== "number") return null;
    if (x * 1000 <= nowMs) return null;
    if (a !== undefined && a !== adminFingerprint(config)) return null;
    return { accountId: u, version: v, admin: a !== undefined };
  } catch {
    return null;
  }
}

export function sessionCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: SESSION_TTL_SECONDS } as const;
}

// ---------- who may use the app ----------

export type AccountState = "admin" | "pending" | "active" | "expired" | "suspended";
export type AccessDenial = "pending" | "suspended" | "expired" | "missing";
export type AccessResult = { ok: true } | { ok: false; reason: AccessDenial };

type StateFields = { role: string; status: string; planEndsAt: Date | string | null };

export function accountState(account: StateFields, nowMs = Date.now()): AccountState {
  if (account.role === "admin") return "admin";
  if (account.status === "pending") return "pending";
  if (account.status !== "active") return "suspended";
  const ends = account.planEndsAt ? new Date(account.planEndsAt).getTime() : NaN;
  return Number.isFinite(ends) && ends > nowMs ? "active" : "expired";
}

/**
 * Whether a session may use the app. "missing" means treat it as signed out: the account is gone, its session
 * version moved on (password reset, suspension), or an admin token is used for a user row or the other way
 * round. The admin is never locked out.
 */
export function accessDecision(
  account: (StateFields & { sessionVersion: number }) | null | undefined,
  claims: AccountClaims,
  nowMs = Date.now(),
): AccessResult {
  if (!account || account.sessionVersion !== claims.version) return { ok: false, reason: "missing" };
  if (claims.admin !== (account.role === "admin")) return { ok: false, reason: "missing" };
  const state = accountState(account, nowMs);
  return state === "admin" || state === "active" ? { ok: true } : { ok: false, reason: state };
}

/** Whose data a request works on: a user always their own; the admin the workspace they picked, if it exists. */
export function workspaceFor(account: { id: string; role: string }, requested: string | undefined, requestedExists: boolean): string {
  return account.role === "admin" && requested && requestedExists ? requested : account.id;
}

// ---------- sign-up ----------

export const EMAIL_TAKEN = "An account with this email already exists.";

export function validateNewPassword(password: string, confirmPassword: string): string | null {
  if (password.length < MIN_ACCOUNT_PASSWORD_LENGTH) {
    return `Use a password of at least ${MIN_ACCOUNT_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_ACCOUNT_PASSWORD_LENGTH) {
    return `Use a password of at most ${MAX_ACCOUNT_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirmPassword) return "The passwords don't match.";
  return null;
}

export function validateSignup(
  input: { name: string; email: string; password: string; confirmPassword: string },
  adminEmail: string,
): { ok: true; value: { name: string; email: string; password: string } } | { ok: false; error: string } {
  const name = input.name.trim().replace(/\s+/g, " ");
  const email = input.email.trim().toLowerCase();
  if (!name || name.length > 80) return { ok: false, error: "Enter your name (up to 80 characters)." };
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  const passwordError = validateNewPassword(input.password, input.confirmPassword);
  if (passwordError) return { ok: false, error: passwordError };
  if (email === adminEmail.trim().toLowerCase()) return { ok: false, error: EMAIL_TAKEN };
  return { ok: true, value: { name, email, password: input.password } };
}

/** Counts sign-ups (call recordFailure for each one): 5 per client and 50 in total per hour. */
export function createSignupThrottle() {
  return createLoginThrottle({ maxFailures: 5, maxGlobalFailures: 50, windowMs: 60 * 60_000 });
}
