// Servers the app must never set up, from PROTECTED_SERVER_IPS (comma-separated IPs or host names): say a
// mail server with live mailboxes that someone manages by hand. A setup run's server step and
// installMailcowOnServer refuse them before any SSH command that changes the server. Compared trimmed and
// lowercased, the way the server lock compares IPs. Leaf module: tests load it without the DB or SSH.

export const PROTECTED_SERVER_MESSAGE =
  "This server is protected (PROTECTED_SERVER_IPS) — the app won't install on it.";

/** The protected servers in `raw`: separated by commas (spaces and new lines work too), trimmed, lowercased. */
export function parseProtectedServerIps(raw: string | null | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[,\s]+/)
      .map((ip) => ip.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isProtectedServer(
  ip: string | null | undefined,
  raw: string | null | undefined = process.env.PROTECTED_SERVER_IPS,
): boolean {
  const key = (ip ?? "").trim().toLowerCase();
  return key !== "" && parseProtectedServerIps(raw).has(key);
}

/** Throws PROTECTED_SERVER_MESSAGE when `ip` is a protected server. */
export function assertServerNotProtected(
  ip: string | null | undefined,
  raw: string | null | undefined = process.env.PROTECTED_SERVER_IPS,
): void {
  if (isProtectedServer(ip, raw)) throw new Error(PROTECTED_SERVER_MESSAGE);
}
