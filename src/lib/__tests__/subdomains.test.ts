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
