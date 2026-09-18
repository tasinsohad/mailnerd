import { describe, it, expect } from "vitest";
import {
  accessDecision,
  accountState,
  burnPasswordCheck,
  createAccountToken,
  createSignupThrottle,
  EMAIL_TAKEN,
  generateTempPassword,
  hashPassword,
  sessionCookieOptions,
  validateNewPassword,
  validateSignup,
  verifyAccountToken,
  verifyPassword,
  workspaceFor,
} from "../accounts-core";
import { createSessionToken, SESSION_TTL_SECONDS } from "../auth-core";

const config = { email: "owner@example.com", password: "admin-password-123", secret: "s".repeat(40) };
const NOW = Date.UTC(2026, 8, 18, 12);
const DAY = 24 * 60 * 60 * 1000;

describe("password hashing", () => {
  it("verifies the right password and refuses a wrong one", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password")).not.toBe(await hashPassword("same password"));
  });

  it("refuses missing or malformed hashes instead of throwing", async () => {
    for (const bad of [null, undefined, "", "scrypt$x", "bcrypt$1$2$3$4$5", "scrypt$99999999$8$1$AAAA$AAAA"]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });

  it("burns time on a check for an unknown account without throwing", async () => {
    await expect(burnPasswordCheck("whatever")).resolves.toBeUndefined();
  });
});

describe("account tokens", () => {
  const user = { accountId: "user-1", version: 3, admin: false };
  const admin = { accountId: "admin-1", version: 1, admin: true };

  it("round-trips user and admin claims", () => {
    expect(verifyAccountToken(createAccountToken(user, config, NOW), config, NOW)).toEqual(user);
    expect(verifyAccountToken(createAccountToken(admin, config, NOW), config, NOW)).toEqual(admin);
  });

  it("expires after the session lifetime", () => {
    const token = createAccountToken(user, config, NOW);
    expect(verifyAccountToken(token, config, NOW + SESSION_TTL_SECONDS * 1000 + 1)).toBeNull();
  });

  it("rejects tampering, other secrets and the old admin-only token format", () => {
    const token = createAccountToken(user, config, NOW);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "admin-1", v: 1, x: 9e9, a: "x" })).toString("base64url");
    expect(verifyAccountToken(`${forged}.${sig}`, config, NOW)).toBeNull();
    expect(verifyAccountToken(`${payload}.${sig}x`, config, NOW)).toBeNull();
    expect(verifyAccountToken(token, { ...config, secret: "t".repeat(40) }, NOW)).toBeNull();
    expect(verifyAccountToken(createSessionToken(config, NOW), config, NOW)).toBeNull();
    expect(verifyAccountToken(null, config, NOW)).toBeNull();
  });

  it("signs the admin out when ADMIN_PASSWORD changes, but not users", () => {
    const changed = { ...config, password: "a-new-admin-password" };
    expect(verifyAccountToken(createAccountToken(admin, config, NOW), changed, NOW)).toBeNull();
    expect(verifyAccountToken(createAccountToken(user, config, NOW), changed, NOW)).toEqual(user);
  });
});

describe("accountState and accessDecision", () => {
  const future = new Date(NOW + DAY);
  const past = new Date(NOW - DAY);
  const row = (over: Partial<{ role: string; status: string; planEndsAt: Date | null; sessionVersion: number }>) => ({
    role: "user",
    status: "active",
    planEndsAt: future as Date | null,
    sessionVersion: 1,
    ...over,
  });
  const userClaims = { accountId: "u", version: 1, admin: false };

  it("names each state", () => {
    expect(accountState(row({ role: "admin", status: "active", planEndsAt: null }), NOW)).toBe("admin");
    expect(accountState(row({ status: "pending" }), NOW)).toBe("pending");
    expect(accountState(row({ status: "suspended" }), NOW)).toBe("suspended");
    expect(accountState(row({ status: "something-else" }), NOW)).toBe("suspended");
    expect(accountState(row({ planEndsAt: past }), NOW)).toBe("expired");
    expect(accountState(row({ planEndsAt: null }), NOW)).toBe("expired");
    expect(accountState(row({}), NOW)).toBe("active");
  });

  it("lets active users and the admin in", () => {
    expect(accessDecision(row({}), userClaims, NOW)).toEqual({ ok: true });
    expect(
      accessDecision(row({ role: "admin", planEndsAt: null }), { accountId: "a", version: 1, admin: true }, NOW),
    ).toEqual({ ok: true });
  });

  it("says why everyone else is refused", () => {
    expect(accessDecision(row({ status: "pending" }), userClaims, NOW)).toEqual({ ok: false, reason: "pending" });
    expect(accessDecision(row({ status: "suspended" }), userClaims, NOW)).toEqual({ ok: false, reason: "suspended" });
    expect(accessDecision(row({ planEndsAt: past }), userClaims, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("treats a missing account, an old session version or a role mismatch as signed out", () => {
    expect(accessDecision(null, userClaims, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(accessDecision(row({ sessionVersion: 2 }), userClaims, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(accessDecision(row({}), { ...userClaims, admin: true }, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(accessDecision(row({ role: "admin" }), userClaims, NOW)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("workspaceFor", () => {
  it("keeps a user in their own workspace whatever they ask for", () => {
    expect(workspaceFor({ id: "u1", role: "user" }, "u2", true)).toBe("u1");
  });
  it("opens the workspace the admin picked, if it exists", () => {
    expect(workspaceFor({ id: "a", role: "admin" }, "u2", true)).toBe("u2");
    expect(workspaceFor({ id: "a", role: "admin" }, "gone", false)).toBe("a");
    expect(workspaceFor({ id: "a", role: "admin" }, undefined, false)).toBe("a");
  });
});

describe("validateSignup", () => {
  const good = { name: "  Alice   Smith ", email: " Alice@Example.COM ", password: "long-enough-1", confirmPassword: "long-enough-1" };

  it("tidies the name and lower-cases the email", () => {
    expect(validateSignup(good, config.email)).toEqual({
      ok: true,
      value: { name: "Alice Smith", email: "alice@example.com", password: "long-enough-1" },
    });
  });

  it("explains what's wrong", () => {
    expect(validateSignup({ ...good, name: "  " }, config.email)).toMatchObject({ ok: false, error: /name/ });
    expect(validateSignup({ ...good, email: "not-an-email" }, config.email)).toMatchObject({ ok: false, error: /valid email/ });
    expect(validateSignup({ ...good, password: "short", confirmPassword: "short" }, config.email)).toMatchObject({
      ok: false,
      error: /at least 10/,
    });
    expect(validateSignup({ ...good, confirmPassword: "different-1" }, config.email)).toMatchObject({
      ok: false,
      error: /don't match/,
    });
  });

  it("refuses the admin's email as if it were taken", () => {
    expect(validateSignup({ ...good, email: "OWNER@example.com" }, config.email)).toEqual({ ok: false, error: EMAIL_TAKEN });
  });

  it("checks a new password on its own", () => {
    expect(validateNewPassword("long-enough-1", "long-enough-1")).toBeNull();
    expect(validateNewPassword("short", "short")).toMatch(/at least 10/);
    expect(validateNewPassword("long-enough-1", "long-enough-2")).toMatch(/don't match/);
  });
});

describe("generateTempPassword", () => {
  it("makes 16 unambiguous characters, different each time", () => {
    const a = generateTempPassword();
    expect(a).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);
    expect(generateTempPassword()).not.toBe(a);
  });
});

describe("createSignupThrottle", () => {
  it("allows 5 sign-ups per client per hour", () => {
    const throttle = createSignupThrottle();
    for (let i = 0; i < 5; i++) throttle.recordFailure("203.0.113.9", NOW);
    expect(throttle.retryAfterMs("203.0.113.9", NOW)).toBeGreaterThan(0);
    expect(throttle.retryAfterMs("203.0.113.10", NOW)).toBe(0);
    expect(throttle.retryAfterMs("203.0.113.9", NOW + 60 * 60_000)).toBe(0);
  });

  it("allows 50 sign-ups per hour from everyone together", () => {
    const throttle = createSignupThrottle();
    for (let i = 0; i < 50; i++) throttle.recordFailure(`198.51.100.${i}`, NOW);
    expect(throttle.retryAfterMs("192.0.2.1", NOW)).toBeGreaterThan(0);
  });
});

describe("sessionCookieOptions", () => {
  it("is httpOnly, lax, site-wide, and Secure only over HTTPS", () => {
    expect(sessionCookieOptions(true)).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: SESSION_TTL_SECONDS });
    expect(sessionCookieOptions(false).secure).toBe(false);
  });
});
