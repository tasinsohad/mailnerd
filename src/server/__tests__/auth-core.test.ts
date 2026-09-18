import { describe, it, expect } from "vitest";
import {
  readAuthConfig,
  createSessionToken,
  verifySessionToken,
  credentialsMatch,
  createLoginThrottle,
  loginThrottleKey,
  crossSiteServerFnReason,
  CROSS_SITE_ERROR,
  SERVER_FN_BASE_PATH,
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

  it("names every missing variable, so the server log can say what to fix", () => {
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

describe("loginThrottleKey", () => {
  it("keeps an IPv4 address as it is", () => {
    expect(loginThrottleKey("203.0.113.7")).toBe("203.0.113.7");
    expect(loginThrottleKey(" 203.0.113.7 ")).toBe("203.0.113.7");
  });

  it("groups IPv6 addresses by their /64, however they are written", () => {
    const key = loginThrottleKey("2001:db8:1:2::1");
    expect(key).toBe("2001:db8:1:2::/64");
    expect(loginThrottleKey("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe(key);
    expect(loginThrottleKey("2001:db8:1:2:aaaa:bbbb::")).toBe(key);
    expect(loginThrottleKey("2001:db8:1:3::1")).not.toBe(key);
  });

  it("expands :: wherever it appears", () => {
    expect(loginThrottleKey("::")).toBe("0:0:0:0::/64");
    expect(loginThrottleKey("::1")).toBe("0:0:0:0::/64");
    expect(loginThrottleKey("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(loginThrottleKey("2001::7:8:9:a:b")).toBe("2001:0:0:7::/64");
  });

  it("counts an IPv4-mapped IPv6 address as its IPv4 address", () => {
    expect(loginThrottleKey("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(loginThrottleKey("::FFFF:c633:6404")).toBe("198.51.100.4");
    expect(loginThrottleKey("0:0:0:0:0:ffff:198.51.100.4")).toBe("198.51.100.4");
  });

  it("ignores a zone id", () => {
    expect(loginThrottleKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(loginThrottleKey("fe80::2%25en0")).toBe("fe80:0:0:0::/64");
  });

  it("leaves anything that isn't an IP address alone", () => {
    expect(loginThrottleKey("unknown")).toBe("unknown");
    expect(loginThrottleKey("not:an:ip")).toBe("not:an:ip");
    expect(loginThrottleKey("1::2::3")).toBe("1::2::3");
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

  it("by default allows 10 failures per address and 100 in total per 15 minutes", () => {
    const perAddress = createLoginThrottle();
    for (let i = 0; i < 9; i++) perAddress.recordFailure("192.0.2.1", NOW);
    expect(perAddress.retryAfterMs("192.0.2.1", NOW)).toBe(0);
    perAddress.recordFailure("192.0.2.1", NOW);
    expect(perAddress.retryAfterMs("192.0.2.1", NOW)).toBe(15 * 60_000);

    const total = createLoginThrottle();
    for (let i = 0; i < 99; i++) total.recordFailure(`10.0.0.${i}`, NOW);
    expect(total.retryAfterMs("192.0.2.1", NOW)).toBe(0);
    total.recordFailure("10.0.1.1", NOW);
    expect(total.retryAfterMs("192.0.2.1", NOW)).toBe(15 * 60_000);
  });

  it("counts every address in an IPv6 /64 as one client", () => {
    const throttle = createLoginThrottle({ maxFailures: 3, windowMs: 60_000 });
    throttle.recordFailure("2001:db8:1:2::1", NOW);
    throttle.recordFailure("2001:db8:1:2::2", NOW);
    throttle.recordFailure("2001:db8:1:2:ffff:ffff:ffff:ffff", NOW);
    expect(throttle.retryAfterMs("2001:db8:1:2::99", NOW)).toBe(60_000);
    expect(throttle.retryAfterMs("2001:db8:1:3::1", NOW)).toBe(0);

    // Signing in from any address in that /64 clears it.
    throttle.reset("2001:db8:1:2::abcd");
    expect(throttle.retryAfterMs("2001:db8:1:2::1", NOW)).toBe(0);
  });

  it("counts an IPv4-mapped address as its IPv4 address", () => {
    const throttle = createLoginThrottle({ maxFailures: 2, windowMs: 60_000 });
    throttle.recordFailure("::ffff:198.51.100.4", NOW);
    throttle.recordFailure("198.51.100.4", NOW);
    expect(throttle.retryAfterMs("198.51.100.4", NOW)).toBe(60_000);
    expect(throttle.retryAfterMs("::ffff:198.51.100.4", NOW)).toBe(60_000);
  });

  it("blocks every address once too many sign-ins failed in total, until they age out", () => {
    const throttle = createLoginThrottle({ maxFailures: 10, maxGlobalFailures: 3, windowMs: 60_000 });
    throttle.recordFailure("10.0.0.1", NOW);
    throttle.recordFailure("10.0.0.2", NOW + 10_000);
    throttle.recordFailure("10.0.0.3", NOW + 20_000);
    // An address with no failures of its own waits for the oldest failure to age out.
    expect(throttle.retryAfterMs("10.9.9.9", NOW + 30_000)).toBe(30_000);
    expect(throttle.retryAfterMs("10.0.0.1", NOW + 30_000)).toBe(30_000);
    expect(throttle.retryAfterMs("10.9.9.9", NOW + 60_000)).toBe(0);
  });

  it("records nothing while every address is blocked", () => {
    const throttle = createLoginThrottle({ maxFailures: 2, maxGlobalFailures: 2, windowMs: 60_000 });
    throttle.recordFailure("10.0.0.1", NOW);
    throttle.recordFailure("10.0.0.2", NOW);
    // Reported during the block: counting these would lock 10.0.0.3 out past the block.
    throttle.recordFailure("10.0.0.3", NOW + 30_000);
    throttle.recordFailure("10.0.0.3", NOW + 30_000);
    expect(throttle.trackedClients()).toBe(2);
    expect(throttle.retryAfterMs("10.0.0.3", NOW + 60_000)).toBe(0);
  });

  it("a successful sign-in clears only that address, not other addresses or the total", () => {
    const perAddress = createLoginThrottle({ maxFailures: 2, windowMs: 60_000 });
    perAddress.recordFailure("10.0.0.1", NOW);
    perAddress.recordFailure("10.0.0.1", NOW);
    perAddress.recordFailure("10.0.0.2", NOW);
    perAddress.recordFailure("10.0.0.2", NOW);
    perAddress.reset("10.0.0.1");
    expect(perAddress.retryAfterMs("10.0.0.1", NOW)).toBe(0);
    expect(perAddress.retryAfterMs("10.0.0.2", NOW)).toBe(60_000);

    const total = createLoginThrottle({ maxFailures: 5, maxGlobalFailures: 2, windowMs: 60_000 });
    total.recordFailure("10.0.0.1", NOW);
    total.recordFailure("10.0.0.2", NOW);
    total.reset("10.0.0.1");
    expect(total.retryAfterMs("10.0.0.1", NOW)).toBe(60_000);
  });

  it("forgets expired addresses once many are tracked, so memory stays bounded", () => {
    const throttle = createLoginThrottle({ maxFailures: 5, windowMs: 60_000, pruneAbove: 3 });
    for (const ip of ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"]) throttle.recordFailure(ip, NOW);
    // None has expired yet, so there is nothing to forget.
    expect(throttle.trackedClients()).toBe(4);
    throttle.recordFailure("10.0.0.5", NOW + 60_000);
    expect(throttle.trackedClients()).toBe(1);
  });
});

describe("crossSiteServerFnReason", () => {
  const fn = `${SERVER_FN_BASE_PATH}eyJmaWxlIjoic2Vzc2lvbi50cyJ9`;
  const request = (path: string, headers: Record<string, string>, method = "POST") => ({
    method,
    url: `https://app.example.com${path}`,
    headers: new Headers({ host: "app.example.com", ...headers }),
  });

  it("uses TanStack Start's server-function path", () => {
    expect(SERVER_FN_BASE_PATH).toBe("/_serverFn/");
  });

  it("refuses with FORBIDDEN, never UNAUTHENTICATED (which would send the browser to sign-in)", () => {
    expect(CROSS_SITE_ERROR).toBe("FORBIDDEN: this request came from another site.");
  });

  it("lets the app's own calls through, and ones typed into the address bar", () => {
    expect(crossSiteServerFnReason(request(fn, { "sec-fetch-site": "same-origin" }))).toBeNull();
    expect(crossSiteServerFnReason(request(fn, { "sec-fetch-site": "none" }, "GET"))).toBeNull();
  });

  it("refuses a server-function POST from a sibling subdomain (same-site)", () => {
    const reason = crossSiteServerFnReason(
      request(fn, { "sec-fetch-site": "same-site", "content-type": "text/plain" }),
    );
    expect(reason).toMatch(/same-site/);
    expect(reason).toContain(fn);
  });

  it("refuses cross-site calls, GET ones too", () => {
    expect(crossSiteServerFnReason(request(fn, { "sec-fetch-site": "cross-site" }))).not.toBeNull();
    expect(crossSiteServerFnReason(request(fn, { "sec-fetch-site": "cross-site" }, "GET"))).not.toBeNull();
  });

  it("never refuses a page request, which server-side rendering runs server functions with", () => {
    const fromLink = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" };
    expect(crossSiteServerFnReason(request("/domains/abc", fromLink, "GET"))).toBeNull();
    expect(crossSiteServerFnReason(request("/", fromLink, "GET"))).toBeNull();
    expect(crossSiteServerFnReason(request("/auth?redirect=%2F", fromLink, "GET"))).toBeNull();
  });

  it("only guards paths under the server-function base", () => {
    const crossSite = { "sec-fetch-site": "cross-site" };
    expect(crossSiteServerFnReason(request("/_serverFnX", crossSite))).toBeNull();
    expect(crossSiteServerFnReason(request("/api/_serverFn/abc", crossSite))).toBeNull();
  });

  it("without fetch metadata, refuses an Origin that isn't this request's Host", () => {
    expect(crossSiteServerFnReason(request(fn, { origin: "https://app.example.com" }))).toBeNull();
    expect(crossSiteServerFnReason(request(fn, { origin: "https://evil.example.com" }))).toMatch(
      /evil\.example\.com/,
    );
    expect(crossSiteServerFnReason(request(fn, { origin: "https://app.example.com:8443" }))).not.toBeNull();
    expect(crossSiteServerFnReason(request(fn, { origin: "null" }))).not.toBeNull();
  });

  it("compares hosts ignoring case and default ports", () => {
    expect(crossSiteServerFnReason(request(fn, { origin: "https://APP.Example.com" }))).toBeNull();
    expect(
      crossSiteServerFnReason(request(fn, { origin: "https://app.example.com", host: "app.example.com:443" })),
    ).toBeNull();
    expect(
      crossSiteServerFnReason({
        method: "POST",
        url: `http://localhost:3000${fn}`,
        headers: new Headers({ host: "localhost:3000", origin: "http://localhost:3000" }),
      }),
    ).toBeNull();
  });

  it("allows a call with neither Sec-Fetch-Site nor Origin (old clients, curl)", () => {
    expect(crossSiteServerFnReason(request(fn, {}))).toBeNull();
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
