import { describe, it, expect } from "vitest";
import {
  readAuthConfig,
  createSessionToken,
  verifySessionToken,
  credentialsMatch,
  createLoginThrottle,
  readCookie,
  isHttpsRequest,
  SESSION_TTL_SECONDS,
} from "../auth-core";

const config = {
  email: "Ops@Example.com",
  password: "correct horse battery staple",
  secret: "s".repeat(40),
};
const NOW = Date.UTC(2026, 8, 14);

describe("readAuthConfig", () => {
  it("accepts a complete configuration", () => {
    expect(
      readAuthConfig({
        ADMIN_EMAIL: " ops@example.com ",
        ADMIN_PASSWORD: "a-long-password!",
        SESSION_SECRET: "x".repeat(32),
      }),
    ).toEqual({
      ok: true,
      config: { email: "ops@example.com", password: "a-long-password!", secret: "x".repeat(32) },
    });
  });

  it("names every missing variable, so the sign-in page can say what to fix", () => {
    const result = readAuthConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(" ")).toMatch(/ADMIN_EMAIL.*ADMIN_PASSWORD.*SESSION_SECRET/);
    }
  });

  it("rejects a short password and a short session secret", () => {
    const result = readAuthConfig({
      ADMIN_EMAIL: "ops@example.com",
      ADMIN_PASSWORD: "short",
      SESSION_SECRET: "too-short",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.some((p) => p.includes("ADMIN_PASSWORD"))).toBe(true);
      expect(result.problems.some((p) => p.includes("SESSION_SECRET"))).toBe(true);
    }
  });
});

describe("session tokens", () => {
  it("round-trips: a fresh token names the configured account", () => {
    expect(verifySessionToken(createSessionToken(config, NOW), config, NOW)).toBe("ops@example.com");
  });

  it("expires after the session lifetime", () => {
    const token = createSessionToken(config, NOW);
    const lifetimeMs = SESSION_TTL_SECONDS * 1000;
    expect(verifySessionToken(token, config, NOW + lifetimeMs - 1000)).toBe("ops@example.com");
    expect(verifySessionToken(token, config, NOW + lifetimeMs)).toBeNull();
  });

  it("rejects a token whose payload was edited (e.g. a pushed-out expiry)", () => {
    const [payload, signature] = createSessionToken(config, NOW).split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const edited = Buffer.from(JSON.stringify({ ...claims, x: 9_999_999_999 })).toString("base64url");
    expect(verifySessionToken(`${edited}.${signature}`, config, NOW)).toBeNull();
  });

  it("signs everyone out when SESSION_SECRET or ADMIN_PASSWORD changes", () => {
    const token = createSessionToken(config, NOW);
    expect(verifySessionToken(token, { ...config, secret: "t".repeat(40) }, NOW)).toBeNull();
    expect(verifySessionToken(token, { ...config, password: "a different password" }, NOW)).toBeNull();
  });

  it("rejects a token issued for a different ADMIN_EMAIL", () => {
    const token = createSessionToken(config, NOW);
    expect(verifySessionToken(token, { ...config, email: "someone@else.com" }, NOW)).toBeNull();
  });

  it("returns null, never throws, for missing or malformed cookies", () => {
    const malformed = [undefined, null, "", "abc", "a.b.c", ".sig", "payload.", "!!!.???", "e30.x"];
    for (const token of malformed) {
      expect(verifySessionToken(token, config, NOW)).toBeNull();
    }
  });
});

describe("credentialsMatch", () => {
  it("accepts the configured account, ignoring email case and surrounding spaces", () => {
    expect(credentialsMatch("  ops@EXAMPLE.com ", "correct horse battery staple", config)).toBe(true);
  });

  it("rejects a wrong password or a wrong email", () => {
    expect(credentialsMatch("ops@example.com", "correct horse battery stapl", config)).toBe(false);
    expect(credentialsMatch("ops@example.org", "correct horse battery staple", config)).toBe(false);
  });

  it("treats the password as exact: no trimming, case-sensitive", () => {
    expect(credentialsMatch("ops@example.com", " correct horse battery staple", config)).toBe(false);
    expect(credentialsMatch("ops@example.com", "Correct horse battery staple", config)).toBe(false);
  });
});

describe("createLoginThrottle", () => {
  it("locks a client out after too many failures, until the window passes", () => {
    const throttle = createLoginThrottle({ maxFailures: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      expect(throttle.retryAfterMs("1.2.3.4", NOW)).toBe(0);
      throttle.recordFailure("1.2.3.4", NOW);
    }
    expect(throttle.retryAfterMs("1.2.3.4", NOW + 1000)).toBe(59_000);
    expect(throttle.retryAfterMs("5.6.7.8", NOW + 1000)).toBe(0);
    expect(throttle.retryAfterMs("1.2.3.4", NOW + 60_000)).toBe(0);
  });

  it("clears a client's failures when it signs in successfully", () => {
    const throttle = createLoginThrottle({ maxFailures: 2, windowMs: 60_000 });
    throttle.recordFailure("ip", NOW);
    throttle.reset("ip");
    throttle.recordFailure("ip", NOW);
    expect(throttle.retryAfterMs("ip", NOW)).toBe(0);
  });
});

describe("readCookie", () => {
  it("finds the named cookie among others", () => {
    expect(readCookie("theme=dark; mn_session=abc.def; other=1", "mn_session")).toBe("abc.def");
  });

  it("does not match a cookie whose name only ends with the one asked for", () => {
    expect(readCookie("xmn_session=nope", "mn_session")).toBeUndefined();
  });

  it("handles a request without cookies", () => {
    expect(readCookie(undefined, "mn_session")).toBeUndefined();
  });
});

describe("isHttpsRequest", () => {
  it("trusts X-Forwarded-Proto from the proxy (Caddy terminates HTTPS)", () => {
    expect(isHttpsRequest("http://app:3000/_serverFn/x", "https")).toBe(true);
    expect(isHttpsRequest("http://1.2.3.4:3000/", "http")).toBe(false);
  });

  it("falls back to the request URL when there is no proxy", () => {
    expect(isHttpsRequest("https://app.example.com/", undefined)).toBe(true);
    expect(isHttpsRequest("http://localhost:3000/", undefined)).toBe(false);
  });
});
