import { describe, it, expect } from "vitest";
import {
  parseMailcowResult,
  generateMailboxPassword,
  cfTxtContent,
  QUOTA,
} from "../mailcow-helpers";

describe("parseMailcowResult", () => {
  it("fails on !ok", () => expect(parseMailcowResult(false, []).success).toBe(false));
  it("fails on danger body even with HTTP ok", () => {
    const r = parseMailcowResult(true, [
      { type: "danger", msg: "mailbox_quota_exceeds_domain_quota" },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toContain("mailbox_quota_exceeds_domain_quota");
  });
  it("succeeds only with a success entry and no errors", () => {
    expect(parseMailcowResult(true, [{ type: "success" }]).success).toBe(true);
  });
  it("fails when no success and no error (empty object)", () =>
    expect(parseMailcowResult(true, {}).success).toBe(false));
});

describe("generateMailboxPassword", () => {
  it("is 20 chars with all four character classes", () => {
    for (let i = 0; i < 20; i++) {
      const p = generateMailboxPassword();
      expect(p.length).toBe(20);
      expect(/[A-Z]/.test(p)).toBe(true);
      expect(/[a-z]/.test(p)).toBe(true);
      expect(/[0-9]/.test(p)).toBe(true);
      expect(/[^A-Za-z0-9]/.test(p)).toBe(true);
    }
  });
});

describe("cfTxtContent", () => {
  it("wraps TXT in quotes", () => expect(cfTxtContent("TXT", "v=DMARC1")).toBe('"v=DMARC1"'));
  it("leaves already-quoted TXT untouched", () => expect(cfTxtContent("TXT", '"x"')).toBe('"x"'));
  it("leaves non-TXT untouched", () => expect(cfTxtContent("A", "1.2.3.4")).toBe("1.2.3.4"));
});

describe("QUOTA", () => {
  it("keeps maxquota <= domain quota", () => {
    expect(QUOTA.MAILBOX_MAX_QUOTA_MB).toBeLessThanOrEqual(QUOTA.DOMAIN_QUOTA_MB);
  });
});
