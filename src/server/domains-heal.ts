// Thin, log-aware wrappers around the DNS-heal pipeline steps (pushDns, syncDkim), so the
// remediation executor (remediation.ts) can run them server-to-server with a ConsoleLog and get
// back a uniform { ok, detail } result — what `executeStep` needs to report a step's outcome.
//
// The actual DNS/Mailcow work already lives in pipeline.ts's `pushDns` / `syncDkim` — the exact
// functions `domains.ts`'s `pushDnsToCloudflare` and `mailcow.ts`'s `fetchDkimAndSync` server fns
// already call. So there is nothing to "extract" out of those handlers; this file wraps the same
// pipeline calls with console breadcrumbs and a summarized ok/detail, and `pushDnsToCloudflare` /
// `fetchDkimAndSync` are updated to call these wrappers instead of `pipeline.ts` directly — one
// implementation, reached three ways (the two existing buttons + the new executor), behaviour of
// the two server fns unchanged (same `{ results }` / `{ error }` shapes as before).
//
// Reachable two ways: (1) `remediation.ts` — a mixed module that can't be stubbed out of the
// client bundle — dynamic-imports this file from inside `executeStep`, never at its own top
// level (see that file's header comment); (2) `domains.ts` / `mailcow.ts` import it statically,
// same as they already statically import `./pipeline` today. That's safe: pipeline.ts's own
// transitive imports (mailcow-helpers, cloudflare, cloudflare.functions) never touch
// `@/lib/ssh` / `node-ssh`, so nothing native rides along.

import type { ConsoleLog } from "./console-bus";
import { pushDns, syncDkim } from "./pipeline";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Domain = any;

export interface DnsRecordResult {
  id: string;
  name: string;
  success: boolean;
  error?: string;
}

export interface DkimSyncResult {
  name: string;
  success: boolean;
  error?: string;
}

// Push this domain's planned DNS records to Cloudflare. `results` is returned unchanged so
// `pushDnsToCloudflare` can keep returning exactly what it always has; `ok`/`detail` are what the
// executor needs. Errors (e.g. missing Cloudflare token/zone) propagate rather than being
// swallowed here, same as pipeline.ts's own functions — each caller already has the try/catch
// that's right for it (the server fn's `{ error }` response, or executeStep's catch-all).
export async function pushDnsForDomain(
  db: Db,
  domain: Domain,
  userId: string,
  log?: ConsoleLog,
): Promise<{ ok: boolean; detail: string; results: DnsRecordResult[] }> {
  log?.info(`Pushing DNS records for ${domain.name} to Cloudflare…`);
  const { pushed, failed, results } = await pushDns(db, domain, userId);
  for (const r of results) {
    if (r.success) log?.out(`${r.name}: pushed`);
    else log?.error(`${r.name}: ${r.error ?? "failed"}`);
  }
  const ok = failed === 0;
  const detail =
    failed === 0
      ? pushed === 0
        ? "All DNS records were already active — nothing to push."
        : `Pushed ${pushed} DNS record${pushed === 1 ? "" : "s"}.`
      : `Pushed ${pushed} of ${pushed + failed} DNS record${pushed + failed === 1 ? "" : "s"}; ${failed} failed.`;
  log?.info(detail);
  return { ok, detail, results };
}

// Fetch each subdomain's DKIM key from Mailcow and sync it to Cloudflare. Same treatment as
// pushDnsForDomain above: `results` unchanged for fetchDkimAndSync, `ok`/`detail` for the executor.
export async function syncDkimForDomain(
  db: Db,
  domain: Domain,
  userId: string,
  log?: ConsoleLog,
): Promise<{ ok: boolean; detail: string; results: DkimSyncResult[] }> {
  log?.info(`Syncing DKIM for ${domain.name}…`);
  const { results } = await syncDkim(db, domain, userId);
  for (const r of results) {
    if (r.success) log?.out(`${r.name}: DKIM synced`);
    else log?.error(`${r.name}: ${r.error ?? "failed"}`);
  }
  const okCount = results.filter((r) => r.success).length;
  const ok = okCount === results.length;
  const detail =
    results.length === 0
      ? "No subdomains to sync DKIM for."
      : ok
        ? `Synced DKIM for ${okCount} subdomain${okCount === 1 ? "" : "s"}.`
        : `Synced DKIM for ${okCount} of ${results.length} subdomain${results.length === 1 ? "" : "s"}; ${results.length - okCount} failed.`;
  log?.info(detail);
  return { ok, detail, results };
}
