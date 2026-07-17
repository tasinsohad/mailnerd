import { describe, it, expect } from "vitest";
import {
  subdomainExportRows,
  subdomainListText,
  buildSubdomainCsv,
} from "../subdomains";

const items = [
  { domainName: "example.com", subdomainPrefix: "web", subdomainFqdn: "web.example.com" },
  { domainName: "example.com", subdomainPrefix: "web", subdomainFqdn: "web.example.com" }, // dup
  { domainName: "example.com", subdomainPrefix: "app", subdomainFqdn: "app.example.com" },
  { domainName: "example.com", subdomainPrefix: "@", subdomainFqdn: "example.com" }, // apex
  { domainName: "other.net", subdomainPrefix: "mail", subdomainFqdn: "mail.other.net" },
];

describe("subdomainExportRows", () => {
  it("dedupes, excludes the apex, and sorts by FQDN", () => {
    const rows = subdomainExportRows(items);
    expect(rows).toEqual([
      { domain: "example.com", subdomain: "app.example.com" },
      { domain: "other.net", subdomain: "mail.other.net" },
      { domain: "example.com", subdomain: "web.example.com" },
    ]);
  });

  it("returns [] when everything is apex or empty", () => {
    expect(
      subdomainExportRows([
        { domainName: "x.com", subdomainPrefix: "@", subdomainFqdn: "x.com" },
        { domainName: "x.com", subdomainPrefix: "web", subdomainFqdn: "" },
      ]),
    ).toEqual([]);
  });
});

describe("subdomainListText", () => {
  it("joins FQDNs with newlines", () => {
    expect(subdomainListText(subdomainExportRows(items))).toBe(
      "app.example.com\nmail.other.net\nweb.example.com",
    );
  });
});

describe("buildSubdomainCsv", () => {
  it("emits a domain,subdomain header and rows", () => {
    expect(buildSubdomainCsv(subdomainExportRows(items))).toBe(
      "domain,subdomain\nexample.com,app.example.com\nother.net,mail.other.net\nexample.com,web.example.com",
    );
  });
});

describe("VPS IP inclusion", () => {
  const ipItems = [
    { domainName: "example.com", subdomainPrefix: "web", subdomainFqdn: "web.example.com", ipAddress: "1.2.3.4" },
    { domainName: "other.net", subdomainPrefix: "mail", subdomainFqdn: "mail.other.net", ipAddress: null },
  ];

  it("carries the ip onto rows only when present", () => {
    const rows = subdomainExportRows(ipItems);
    expect(rows).toEqual([
      { domain: "other.net", subdomain: "mail.other.net" },
      { domain: "example.com", subdomain: "web.example.com", ip: "1.2.3.4" },
    ]);
  });

  it("appends tab-separated IPs to the copy text when asked", () => {
    const rows = subdomainExportRows(ipItems);
    expect(subdomainListText(rows, true)).toBe("mail.other.net\t\nweb.example.com\t1.2.3.4");
    expect(subdomainListText(rows)).toBe("mail.other.net\nweb.example.com");
  });

  it("adds an ip column to the CSV when asked", () => {
    const rows = subdomainExportRows(ipItems);
    expect(buildSubdomainCsv(rows, true)).toBe(
      "domain,subdomain,ip\nother.net,mail.other.net,\nexample.com,web.example.com,1.2.3.4",
    );
  });
});
