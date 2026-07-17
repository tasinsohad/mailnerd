import { describe, it, expect } from "vitest";
import { isValidMailcowApiKey, isApiAllowListPermissive } from "../mailcow-key";

describe("isValidMailcowApiKey", () => {
  it("accepts the 64-hex key our own provisioning generates", () => {
    expect(isValidMailcowApiKey("a".repeat(64))).toBe(true);
    expect(isValidMailcowApiKey("0f9c2b7d".repeat(8))).toBe(true);
  });

  it("accepts the dashed key format Mailcow's UI generates", () => {
    // syncApiKeyFromServer's hex-only check would reject these — external servers need looser.
    expect(isValidMailcowApiKey("1A2B3-4C5D6-7E8F9-0A1B2-3C4D5")).toBe(true);
    expect(isValidMailcowApiKey("ABCDE-FGHIJ-KLMNO-PQRST-UVWXY")).toBe(true);
  });

  it("rejects empty, too-short and junk values", () => {
    expect(isValidMailcowApiKey("")).toBe(false);
    expect(isValidMailcowApiKey("   ")).toBe(false);
    expect(isValidMailcowApiKey("short")).toBe(false);
    // A grep miss can yield a whole line or shell noise — must not be treated as a key.
    expect(isValidMailcowApiKey("API_KEY=abc123def456ghi789")).toBe(false);
    expect(isValidMailcowApiKey("no such file or directory")).toBe(false);
  });
});

describe("isApiAllowListPermissive", () => {
  it("treats an open or auto allow-list as permissive", () => {
    expect(isApiAllowListPermissive("127.0.0.1,auto,0.0.0.0/0,::/0")).toBe(true);
    expect(isApiAllowListPermissive("0.0.0.0/0")).toBe(true);
    expect(isApiAllowListPermissive("auto")).toBe(true);
  });

  it("treats a specific IP list as restricted", () => {
    expect(isApiAllowListPermissive("172.22.1.1,127.0.0.1")).toBe(false);
    expect(isApiAllowListPermissive("203.0.113.5")).toBe(false);
  });

  it("treats an absent allow-list as not permissive", () => {
    expect(isApiAllowListPermissive(null)).toBe(false);
    expect(isApiAllowListPermissive("")).toBe(false);
  });
});
