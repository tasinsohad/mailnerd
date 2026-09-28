import { describe, it, expect } from "vitest";
import { generateDnsRecords, planDomain, type DomainPlan } from "../planning";

// The DNS plan must ALWAYS carry the root-domain mail records (MX, SPF) and root _dmarc, even when
// mailboxes only live on subdomains — our best-performing zones publish these on the apex regardless.
// Root DKIM is synced separately from Mailcow (pipeline.ts), so it isn't in this template.

const DOMAIN = "example.com";
const IP = "203.0.113.7";

function subdomainOnlyPlan(): DomainPlan {
  return planDomain(DOMAIN, {
    totalInboxes: 12,
    prefixes: ["team", "sales", "hello"],
    names: ["Alice Smith", "Bob Jones", "Carol White"],
    placement: "subdomain",
  });
}

const rootRecords = (recs: ReturnType<typeof generateDnsRecords>, type: string) =>
  recs.filter((r) => r.type === type && r.name === "@");

describe("generateDnsRecords root-domain mail records", () => {
  it("always emits a root MX -> mail.<domain> even for subdomain-only placement", () => {
    const recs = generateDnsRecords(DOMAIN, IP, subdomainOnlyPlan());
    const mx = rootRecords(recs, "MX");
    expect(mx).toHaveLength(1);
    expect(mx[0].content).toBe(`mail.${DOMAIN}`);
    expect(mx[0].priority).toBe(10);
  });

  it("always emits a root SPF with the server IP and -all for subdomain-only placement", () => {
    const recs = generateDnsRecords(DOMAIN, IP, subdomainOnlyPlan());
    const spf = rootRecords(recs, "TXT").filter((r) => /v=spf1/i.test(r.content));
    expect(spf).toHaveLength(1);
    expect(spf[0].content).toBe(`v=spf1 ip4:${IP} -all`);
  });

  it("keeps the root _dmarc record (quarantine)", () => {
    const recs = generateDnsRecords(DOMAIN, IP, subdomainOnlyPlan());
    const dmarc = recs.filter((r) => r.type === "TXT" && r.name === "_dmarc");
    expect(dmarc).toHaveLength(1);
    expect(dmarc[0].content).toMatch(/v=DMARC1;\s*p=quarantine/i);
  });

  it("does NOT duplicate the root MX/SPF when a mailbox also uses the apex (@) prefix", () => {
    const plan = planDomain(DOMAIN, {
      totalInboxes: 10,
      prefixes: ["team", "sales"],
      names: ["Alice Smith", "Bob Jones"],
      placement: "both",
      distribution: [
        { prefix: "@", count: 4 },
        { prefix: "team", count: 3 },
        { prefix: "sales", count: 3 },
      ],
    });
    const recs = generateDnsRecords(DOMAIN, IP, plan);
    expect(rootRecords(recs, "MX")).toHaveLength(1);
    expect(rootRecords(recs, "TXT").filter((r) => /v=spf1/i.test(r.content))).toHaveLength(1);
    // The apex still gets its autodiscovery records.
    expect(recs.some((r) => r.type === "CNAME" && r.name === "autodiscover")).toBe(true);
  });

  it("still un-proxies the mail host A record and points it at the server IP", () => {
    const recs = generateDnsRecords(DOMAIN, IP, subdomainOnlyPlan());
    const mailA = recs.find((r) => r.type === "A" && r.name === "mail");
    expect(mailA?.content).toBe(IP);
    expect(mailA?.proxied).toBe(false);
  });
});
