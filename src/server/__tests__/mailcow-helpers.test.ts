import { describe, it, expect } from "vitest";
import {
  parseMailcowResult,
  generateMailboxPassword,
  cfTxtContent,
  buildCfRecordBody,
  findMatchingCfRecord,
  isCfAlreadyExistsError,
  isTransientHttp,
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

describe("buildCfRecordBody", () => {
  it("sends A/MX/TXT via content (not data)", () => {
    const a = buildCfRecordBody(
      { type: "A", name: "mail", content: "1.2.3.4", ttl: 1, proxied: false },
      "mail.example.com",
      "example.com",
    );
    expect(a).toMatchObject({ type: "A", name: "mail.example.com", content: "1.2.3.4", proxied: false });
    expect(a.data).toBeUndefined();

    const mx = buildCfRecordBody(
      { type: "MX", name: "@", content: "mail.example.com", ttl: 1, priority: 10 },
      "example.com",
      "example.com",
    );
    expect(mx).toMatchObject({ type: "MX", priority: 10, content: "mail.example.com" });

    const txt = buildCfRecordBody(
      { type: "TXT", name: "@", content: "v=spf1 -all", ttl: 1 },
      "example.com",
      "example.com",
    );
    expect(txt.content).toBe('"v=spf1 -all"');
  });

  it("builds a TLSA data object from 'usage selector matching_type certificate'", () => {
    const body = buildCfRecordBody(
      { type: "TLSA", name: "_25._tcp.mail", content: "3 1 1 abc123def", ttl: 1 },
      "_25._tcp.mail.example.com",
      "example.com",
    );
    expect(body.content).toBeUndefined();
    expect(body.data).toEqual({
      usage: 3,
      selector: 1,
      matching_type: 1,
      certificate: "abc123def",
    });
  });

  it("builds an SRV data object from 'weight port target' + separate priority", () => {
    const body = buildCfRecordBody(
      { type: "SRV", name: "_autodiscover._tcp.enterprise", content: "0 443 mail.example.com", ttl: 1, priority: 0 },
      "_autodiscover._tcp.enterprise.example.com",
      "example.com",
    );
    expect(body.content).toBeUndefined();
    expect(body.data).toEqual({
      service: "_autodiscover",
      proto: "_tcp",
      name: "enterprise.example.com",
      priority: 0,
      weight: 0,
      port: 443,
      target: "mail.example.com",
    });
  });

  it("SRV on the apex derives the domain as the data name", () => {
    const body = buildCfRecordBody(
      { type: "SRV", name: "_autodiscover._tcp", content: "0 443 mail.example.com", ttl: 1, priority: 0 },
      "_autodiscover._tcp.example.com",
      "example.com",
    );
    expect((body.data as any).name).toBe("example.com");
  });
});

describe("findMatchingCfRecord", () => {
  const existing = [
    { id: "1", type: "A", name: "mail.example.com", content: "1.2.3.4" },
    { id: "2", type: "TXT", name: "example.com", content: '"v=spf1 -all"' },
    { id: "3", type: "TXT", name: "example.com", content: '"other"' },
  ];
  it("matches by type + name (case-insensitive)", () => {
    expect(findMatchingCfRecord(existing, "A", "MAIL.example.com", "1.2.3.4")?.id).toBe("1");
  });
  it("disambiguates multiple same-name records by content", () => {
    expect(findMatchingCfRecord(existing, "TXT", "example.com", "v=spf1 -all")?.id).toBe("2");
  });
  it("returns null when nothing matches", () => {
    expect(findMatchingCfRecord(existing, "CNAME", "x.example.com", "y")).toBeNull();
  });
});

describe("isCfAlreadyExistsError", () => {
  it("treats identical-record and host-collision messages as already-exists", () => {
    expect(isCfAlreadyExistsError("An identical record already exists.")).toBe(true);
    expect(
      isCfAlreadyExistsError("An A, AAAA, or CNAME record with that host already exists."),
    ).toBe(true);
  });
  it("does not swallow unrelated errors", () => {
    expect(isCfAlreadyExistsError("weight is a required data field.")).toBe(false);
  });
});

describe("isTransientHttp", () => {
  it("treats network (0), rate-limit (429), and 5xx as transient", () => {
    for (const s of [0, 429, 500, 502, 503, 504]) expect(isTransientHttp(s)).toBe(true);
  });
  it("treats 2xx and deterministic 4xx as non-transient", () => {
    for (const s of [200, 201, 400, 401, 403, 404, 409]) expect(isTransientHttp(s)).toBe(false);
  });
});

describe("QUOTA", () => {
  it("keeps maxquota <= domain quota", () => {
    expect(QUOTA.MAILBOX_MAX_QUOTA_MB).toBeLessThanOrEqual(QUOTA.DOMAIN_QUOTA_MB);
  });
});
