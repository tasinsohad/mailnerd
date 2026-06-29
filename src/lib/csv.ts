// Shared inbox-CSV format. ONE source of truth so the domain page, the per-domain 3-dot
// export, and the bulk "download all" all produce identical, outreach-tool-ready files.
// Headers are exactly what the outreach importer expects (do not reorder/rename).

export interface InboxExportRow {
  name: string;
  email: string;
  password: string;
  mailServer: string; // host clients connect to, e.g. mail.example.com
}

const HEADERS = [
  "Name",
  "Email",
  "Password",
  "IMAP Server",
  "IMAP Port",
  "SMTP Server",
  "SMTP Port",
  "Daily Limit",
  "SMTP Secure",
  "IMAP Secure",
];

// RFC 4180 quoting.
function esc(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildInboxCsv(rows: InboxExportRow[]): string {
  const body = rows.map((r) => [
    r.name,
    r.email,
    r.password,
    r.mailServer, // IMAP Server
    "993", // IMAP Port
    r.mailServer, // SMTP Server
    "587", // SMTP Port (STARTTLS)
    "15", // Daily Limit
    "TLS", // SMTP Secure (STARTTLS on 587)
    "SSL", // IMAP Secure (implicit TLS on 993)
  ]);
  return [HEADERS, ...body].map((r) => r.map(esc).join(",")).join("\n");
}

// Trigger a browser download of CSV text. Client-only.
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
