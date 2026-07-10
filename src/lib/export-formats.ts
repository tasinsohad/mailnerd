// Platform-specific mailbox CSV export formats. ONE registry so every export surface
// (domain 3-dot menu, domain detail, domains list, job export, bulk "download all") can offer
// the same set of platforms and produce byte-identical files.
//
// Each platform's importer keys on EXACT header strings — a wrong/missing header silently drops
// a column or rejects the file. So headers here are ground truth: verified against a real sample
// template or provided by the user. Never approximate them. When adding/fixing a format, record
// its `source` and `confidence`.
//
// The app only knows a thin row per mailbox: one password (reused for IMAP + SMTP), a mail host
// (mailcowHostname || mail.<domain>), fixed ports (IMAP 993 / SMTP 587), and a name. The value
// mapping below is the team-confirmed "standard mapping":
//   IMAP user = SMTP user = full email; single password for both; daily limit 15; warmup TRUE
//   where a column requires it.

export interface ExportInbox {
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null; // full display name, if the split parts aren't set
  email: string;
  password: string;
  mailServer: string; // host clients connect to for IMAP + SMTP, e.g. mail.example.com
}

export interface ExportContext {
  dailyLimit: number; // per-mailbox daily send limit
  imapPort: number;
  smtpPort: number;
  warmupEnabled: boolean;
}

export const DEFAULT_EXPORT_CONTEXT: ExportContext = {
  dailyLimit: 15,
  imapPort: 993,
  smtpPort: 587,
  warmupEnabled: true,
};

export type ExportConfidence = "verified" | "user-provided" | "best-effort";

export interface ExportFormat {
  id: string;
  label: string;
  headers: string[];
  mapRow: (ib: ExportInbox, ctx: ExportContext) => (string | number)[];
  source?: string;
  confidence: ExportConfidence;
}

// Derive full/first/last from whatever the row carries. Falls back to the email local-part so a
// name column is never empty.
function names(ib: ExportInbox): { full: string; first: string; last: string } {
  const full =
    (ib.name || `${ib.firstName ?? ""} ${ib.lastName ?? ""}`.trim()) ||
    ib.email.split("@")[0] ||
    "";
  let first = ib.firstName ?? "";
  let last = ib.lastName ?? "";
  if (!first && !last && full) {
    const parts = full.split(/\s+/);
    first = parts[0] ?? "";
    last = parts.slice(1).join(" ");
  }
  return { full, first, last };
}

// --- EmailBison / default ---
// The team's existing default export format is EmailBison-compatible ("bison is already by
// default"), so this doubles as the Bison format. Output is unchanged from the original CSV.
const GENERIC: ExportFormat = {
  id: "generic",
  label: "EmailBison (default)",
  confidence: "verified",
  source: "SMTP Forge default format (team-confirmed EmailBison-compatible)",
  headers: [
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
  ],
  mapRow: (ib, ctx) => {
    const { full } = names(ib);
    return [
      full,
      ib.email,
      ib.password,
      ib.mailServer, // IMAP Server
      ctx.imapPort,
      ib.mailServer, // SMTP Server
      ctx.smtpPort,
      ctx.dailyLimit,
      "TLS", // SMTP Secure (STARTTLS on 587)
      "SSL", // IMAP Secure (implicit TLS on 993)
    ];
  },
};

// --- PulseVibe ---
// Headers provided verbatim by the team (tab-separated in their sheet; emitted here as CSV).
// Per the team: leave the entire warmup/ramp-up section blank (including enable_warmup), plus
// tags/min_interval, so PulseVibe applies its own defaults. Only the identity/host/port/limit
// columns are populated.
const PULSEVIBE: ExportFormat = {
  id: "pulsevibe",
  label: "PulseVibe",
  confidence: "user-provided",
  source: "Team-provided header row (2026-07-02)",
  headers: [
    "first_name",
    "last_name",
    "email",
    "daily_limit",
    "username",
    "password",
    "imap_host",
    "imap_port",
    "smtp_host",
    "smtp_port",
    "smtp_username",
    "smtp_password",
    "tags",
    "min_interval",
    "enable_camp_rampup",
    "camp_rampup_start",
    "camp_rampup_increment",
    "enable_warmup",
    "warmup_daily_limit",
    "enable_warmup_rampup",
    "warmup_rampup_start",
    "warmup_rampup_increment",
  ],
  mapRow: (ib, ctx) => {
    const { first, last } = names(ib);
    return [
      first,
      last,
      ib.email,
      ctx.dailyLimit,
      ib.email, // username (IMAP)
      ib.password,
      ib.mailServer, // imap_host
      ctx.imapPort,
      ib.mailServer, // smtp_host
      ctx.smtpPort,
      ib.email, // smtp_username
      ib.password, // smtp_password
      "", // tags
      "", // min_interval
      "", // enable_camp_rampup
      "", // camp_rampup_start
      "", // camp_rampup_increment
      "", // enable_warmup
      "", // warmup_daily_limit
      "", // enable_warmup_rampup
      "", // warmup_rampup_start
      "", // warmup_rampup_increment
    ];
  },
};

// Future formats (Smartlead, Instantly, …) drop in here once the team provides their exact
// header rows. Add an entry with verified `headers` + `mapRow` and it shows up everywhere.

export const EXPORT_FORMATS: ExportFormat[] = [GENERIC, PULSEVIBE];

export function getExportFormat(id: string): ExportFormat {
  return EXPORT_FORMATS.find((f) => f.id === id) ?? GENERIC;
}

// RFC 4180 quoting.
function esc(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildExportCsv(
  formatId: string,
  rows: ExportInbox[],
  ctx: ExportContext = DEFAULT_EXPORT_CONTEXT,
): string {
  const fmt = getExportFormat(formatId);
  const body = rows.map((r) => fmt.mapRow(r, ctx));
  return [fmt.headers, ...body].map((r) => r.map(esc).join(",")).join("\n");
}
