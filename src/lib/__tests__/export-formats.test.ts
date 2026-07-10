import { describe, it, expect } from "vitest";
import {
  buildExportCsv,
  getExportFormat,
  EXPORT_FORMATS,
  DEFAULT_EXPORT_CONTEXT,
  type ExportInbox,
} from "../export-formats";

const inbox: ExportInbox = {
  firstName: "Alice",
  lastName: "Johnson",
  name: "Alice Johnson",
  email: "alice@team.example.com",
  password: "s3cret,pw", // contains a comma → exercises RFC-4180 quoting
  mailServer: "mail.example.com",
};

function parse(csv: string): string[][] {
  // Minimal split good enough for these fixtures (only the password field is quoted).
  return csv.split("\n").map((line) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  });
}

describe("export-formats registry", () => {
  it("falls back to the generic/default format for unknown ids", () => {
    expect(getExportFormat("nope").id).toBe("generic");
    expect(getExportFormat("generic").label).toBe("EmailBison (default)");
  });

  it("every registered format maps a row to exactly its header count", () => {
    for (const f of EXPORT_FORMATS) {
      const cells = f.mapRow(inbox, DEFAULT_EXPORT_CONTEXT);
      expect(cells.length, `${f.id} column count`).toBe(f.headers.length);
    }
  });

  it("generic/EmailBison format: headers + standard mapping", () => {
    const [headers, row] = parse(buildExportCsv("generic", [inbox]));
    expect(headers).toEqual([
      "Name", "Email", "Password", "IMAP Server", "IMAP Port",
      "SMTP Server", "SMTP Port", "Daily Limit", "SMTP Secure", "IMAP Secure",
    ]);
    expect(row[0]).toBe("Alice Johnson");
    expect(row[1]).toBe("alice@team.example.com");
    expect(row[2]).toBe("s3cret,pw"); // comma survived quoting round-trip
    expect(row[3]).toBe("mail.example.com"); // IMAP server
    expect(row[4]).toBe("993");
    expect(row[6]).toBe("587");
    expect(row[7]).toBe("15");
  });

  it("PulseVibe: exact headers, email→username, reused password, blank warmup section", () => {
    const [headers, row] = parse(buildExportCsv("pulsevibe", [inbox]));
    expect(headers).toEqual([
      "first_name", "last_name", "email", "daily_limit", "username", "password",
      "imap_host", "imap_port", "smtp_host", "smtp_port", "smtp_username", "smtp_password",
      "tags", "min_interval", "enable_camp_rampup", "camp_rampup_start", "camp_rampup_increment",
      "enable_warmup", "warmup_daily_limit", "enable_warmup_rampup", "warmup_rampup_start",
      "warmup_rampup_increment",
    ]);
    const col = (name: string) => row[headers.indexOf(name)];
    expect(col("first_name")).toBe("Alice");
    expect(col("last_name")).toBe("Johnson");
    expect(col("email")).toBe("alice@team.example.com");
    expect(col("username")).toBe("alice@team.example.com");
    expect(col("smtp_username")).toBe("alice@team.example.com");
    expect(col("password")).toBe("s3cret,pw");
    expect(col("smtp_password")).toBe("s3cret,pw");
    expect(col("imap_host")).toBe("mail.example.com");
    expect(col("imap_port")).toBe("993");
    expect(col("smtp_port")).toBe("587");
    expect(col("daily_limit")).toBe("15");
    // entire warmup / ramp-up section + tags/min_interval must be blank
    for (const b of [
      "tags", "min_interval", "enable_camp_rampup", "camp_rampup_start", "camp_rampup_increment",
      "enable_warmup", "warmup_daily_limit", "enable_warmup_rampup", "warmup_rampup_start",
      "warmup_rampup_increment",
    ]) {
      expect(col(b), `${b} should be blank`).toBe("");
    }
  });

  it("derives first/last from a full name when split parts are missing", () => {
    const [, row] = parse(
      buildExportCsv("pulsevibe", [{ ...inbox, firstName: null, lastName: null, name: "Marco Rossi" }]),
    );
    expect(row[0]).toBe("Marco");
    expect(row[1]).toBe("Rossi");
  });
});
