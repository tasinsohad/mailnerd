import { describe, it, expect } from "vitest";
import {
  PROTECTED_SERVER_MESSAGE,
  assertServerNotProtected,
  isProtectedServer,
  parseProtectedServerIps,
} from "../protected-servers";

// PROTECTED_SERVER_IPS: servers the app must never install on or set up.

describe("parseProtectedServerIps", () => {
  it("splits on commas, trims, lowercases and drops empty entries", () => {
    expect([...parseProtectedServerIps(" 1.2.3.4, ,5.6.7.8 ,Mail.Example.com,")]).toEqual([
      "1.2.3.4",
      "5.6.7.8",
      "mail.example.com",
    ]);
  });

  it("accepts spaces and new lines as separators too", () => {
    expect([...parseProtectedServerIps("1.2.3.4 5.6.7.8\n9.9.9.9")]).toEqual(["1.2.3.4", "5.6.7.8", "9.9.9.9"]);
  });

  it("is empty when unset", () => {
    expect(parseProtectedServerIps(undefined).size).toBe(0);
    expect(parseProtectedServerIps("").size).toBe(0);
  });
});

describe("isProtectedServer", () => {
  const list = "1.2.3.4, mail.example.com";

  it("matches a listed server, trimmed and in any case", () => {
    expect(isProtectedServer("1.2.3.4", list)).toBe(true);
    expect(isProtectedServer(" 1.2.3.4 ", list)).toBe(true);
    expect(isProtectedServer("MAIL.example.com", list)).toBe(true);
  });

  it("doesn't match other servers, prefixes, or a missing IP", () => {
    expect(isProtectedServer("1.2.3.40", list)).toBe(false);
    expect(isProtectedServer("11.2.3.4", list)).toBe(false);
    expect(isProtectedServer("", list)).toBe(false);
    expect(isProtectedServer(null, list)).toBe(false);
    expect(isProtectedServer("1.2.3.4", undefined)).toBe(false);
  });
});

describe("assertServerNotProtected", () => {
  it("throws the protected-server message for a listed server only", () => {
    expect(() => assertServerNotProtected("1.2.3.4", "1.2.3.4")).toThrow(PROTECTED_SERVER_MESSAGE);
    expect(() => assertServerNotProtected("5.6.7.8", "1.2.3.4")).not.toThrow();
  });
});
