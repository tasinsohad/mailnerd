// Subdomain export helpers. Pure, DOM-free, testable. Given the planned inboxes for a domain or
// a whole job, produce the unique list of mail subdomains (e.g. web.example.com) for export.
//
// The apex/root domain is excluded on purpose: when mailboxes sit on the bare domain (placement
// "main"), that row's prefix is "@" and its FQDN is the domain itself — not a subdomain.

export interface SubdomainExportInput {
  domainName: string; // parent domain, e.g. example.com
  subdomainPrefix: string; // "web", or "@" for the apex
  subdomainFqdn: string; // fully-qualified host, e.g. web.example.com
}

export interface SubdomainRow {
  domain: string;
  subdomain: string;
}

// Unique, apex-excluded, sorted-by-FQDN list of subdomains.
export function subdomainExportRows(items: SubdomainExportInput[]): SubdomainRow[] {
  const seen = new Set<string>();
  const rows: SubdomainRow[] = [];
  for (const it of items) {
    if (!it.subdomainFqdn) continue;
    if (it.subdomainPrefix === "@") continue; // apex is not a subdomain
    const key = it.subdomainFqdn.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ domain: it.domainName, subdomain: it.subdomainFqdn });
  }
  rows.sort((a, b) => a.subdomain.localeCompare(b.subdomain));
  return rows;
}

// Newline-separated FQDNs — the "copy" payload.
export function subdomainListText(rows: SubdomainRow[]): string {
  return rows.map((r) => r.subdomain).join("\n");
}

// RFC 4180-safe CSV with `domain,subdomain` columns. Hostnames never contain commas/quotes, but
// we quote defensively so a stray value can't corrupt the file.
function esc(v: string): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildSubdomainCsv(rows: SubdomainRow[]): string {
  const header = ["domain", "subdomain"];
  return [header, ...rows.map((r) => [r.domain, r.subdomain])]
    .map((r) => r.map(esc).join(","))
    .join("\n");
}
