import { describe, it, expect } from "vitest";
import { ContaboManager, mailPtrHostname, reverseDnsBlockingNotice } from "../contabo";

// Reverse DNS (PTR) automation for Contabo provisioning. The provider's public compute API has no
// rDNS endpoint, so by default the manager reports it as unsupported (without calling the network) and
// provisioning surfaces a clear blocking notice telling the user exactly what PTR to set and where.

const baseConfig = {
  clientId: "id",
  clientSecret: "secret",
  apiUser: "user",
  apiPassword: "pw",
};

describe("mailPtrHostname", () => {
  it("is mail.<domain>, normalised", () => {
    expect(mailPtrHostname("Example.com")).toBe("mail.example.com");
    expect(mailPtrHostname("example.com.")).toBe("mail.example.com");
    expect(mailPtrHostname("  example.com ")).toBe("mail.example.com");
  });
});

describe("reverseDnsBlockingNotice", () => {
  it("names the IP, the exact PTR, and that it blocks going live", () => {
    const notice = reverseDnsBlockingNotice("203.0.113.7", "mail.example.com");
    expect(notice).toContain("203.0.113.7");
    expect(notice).toContain("mail.example.com");
    expect(notice).toMatch(/before mailboxes go live/i);
  });
});

describe("ContaboManager.setReverseDns", () => {
  it("defaults to unsupported and does not touch the network", async () => {
    const mgr = new ContaboManager(baseConfig);
    expect(mgr.supportsReverseDns).toBe(false);
    const res = await mgr.setReverseDns({
      instanceId: "i-1",
      ipAddress: "203.0.113.7",
      hostname: "mail.example.com",
    });
    expect(res).toEqual({ set: false, unsupported: true });
  });

  it("reflects the configured capability flag", () => {
    const mgr = new ContaboManager({ ...baseConfig, supportsReverseDns: true });
    expect(mgr.supportsReverseDns).toBe(true);
  });
});
