// "Wipe & re-provision" across several domains: a server that several of them share is wiped once. The first
// domain on each server gets "reinstall"; the others get "reuse" and are added to the fresh Mailcow (the
// server lock runs their server step after the reinstall). Reinstalls come first in the returned order, so
// they're queued before the domains that join them. IPs compare trimmed and lowercased, the way the server
// lock compares them; a domain without an IP counts as its own server. Pure and browser-safe.

export type WipeChoice = "reinstall" | "reuse";

export function wipeOncePerServer(
  targets: { id: string; ipAddress?: string | null }[],
): { id: string; serverChoice: WipeChoice }[] {
  const seen = new Set<string>();
  const reinstall: { id: string; serverChoice: WipeChoice }[] = [];
  const reuse: { id: string; serverChoice: WipeChoice }[] = [];
  for (const t of targets) {
    const key = (t.ipAddress ?? "").trim().toLowerCase();
    if (key && seen.has(key)) {
      reuse.push({ id: t.id, serverChoice: "reuse" });
      continue;
    }
    if (key) seen.add(key);
    reinstall.push({ id: t.id, serverChoice: "reinstall" });
  }
  return [...reinstall, ...reuse];
}
