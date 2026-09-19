import type { HealthAction } from "@/server/health";
import { pushDnsToCloudflare, repairDomainDns } from "@/server/domains";
import { fetchDkimAndSync, setupMailcowDomain } from "@/server/mailcow";
import { provisionServer } from "@/server/provisioning";
import {
  restartMailcowForDomain,
  reloadCertsForDomain,
  openFirewallForDomain,
  flushQueueForDomain,
  forcePostfixIPv4ForDomain,
  createApiKeyForDomain,
} from "@/server/server-fixes";
import { wipeOncePerServer, type WipeChoice } from "@/lib/wipe-plan";

// Single source of truth mapping a health indicator's `action` to its human label, the server
// function that performs it, and whether it's destructive (needs a confirm). Used by the
// per-domain HealthCard and the job-level JobIssuesPanel so the two never drift.

export const ACTION_LABEL: Record<HealthAction, string> = {
  fixDns: "Fix DNS",
  pushDns: "Push DNS",
  syncDkim: "Sync DKIM",
  openFirewall: "Open mail ports",
  restartMailcow: "Restart Mailcow",
  reloadCerts: "Reload mail certs",
  forcePostfixIPv4: "Force IPv4",
  flushQueue: "Flush queue",
  createApiKey: "Create API key",
  recreate: "Recreate mailboxes",
  provision: "Re-provision",
};

// Order fixes from least to most disruptive — the sequence a human would apply them in.
export const ACTION_ORDER: HealthAction[] = [
  "fixDns",
  "pushDns",
  "syncDkim",
  "openFirewall",
  "restartMailcow",
  "reloadCerts",
  "createApiKey",
  "forcePostfixIPv4",
  "flushQueue",
  "recreate",
  "provision",
];

// These rebuild real state (delete+recreate mailboxes, wipe+reinstall the server) or briefly
// interrupt mail (a stack restart) — confirm first.
export const DESTRUCTIVE_ACTIONS: ReadonlySet<HealthAction> = new Set<HealthAction>([
  "restartMailcow",
  "createApiKey",
  "forcePostfixIPv4",
  "recreate",
  "provision",
]);

// Run one fix against one domain. Returns the server-fn result ({ error? } or a summary). `serverChoice` is for
// "provision" across several domains (healthFixTargets): the other domains on a server another target
// reinstalls join it ("reuse") instead of wiping it again.
export function runHealthFix(
  action: HealthAction,
  domainId: string,
  opts: { serverChoice?: WipeChoice } = {},
): Promise<any> {
  switch (action) {
    case "pushDns":
      return pushDnsToCloudflare({ data: { domainId } });
    case "syncDkim":
      return fetchDkimAndSync({ data: { domainId } });
    case "fixDns":
      return repairDomainDns({ data: { domainId } });
    case "openFirewall":
      return openFirewallForDomain({ data: { domainId } });
    case "restartMailcow":
      return restartMailcowForDomain({ data: { domainId } });
    case "reloadCerts":
      return reloadCertsForDomain({ data: { domainId } });
    case "flushQueue":
      return flushQueueForDomain({ data: { domainId } });
    case "forcePostfixIPv4":
      return forcePostfixIPv4ForDomain({ data: { domainId } });
    case "createApiKey":
      return createApiKeyForDomain({ data: { domainId } });
    case "recreate":
      return setupMailcowDomain({ data: { domainId, recreate: true } });
    case "provision":
      // "Re-provision" is destructive and confirmed first (DESTRUCTIVE_ACTIONS): wipe and reinstall.
      return provisionServer({ data: { domainId, serverChoice: opts.serverChoice ?? "reinstall" } });
  }
}

// The order and server choices to run `action` across several domains in. "provision" wipes each server once
// (wipe-plan.ts): the first target on a server reinstalls it, the others on it reuse the fresh Mailcow.
export function healthFixTargets(
  action: HealthAction,
  targets: { id: string; ipAddress?: string | null }[],
): { id: string; serverChoice?: WipeChoice }[] {
  if (action === "provision") return wipeOncePerServer(targets);
  return targets.map((t) => ({ id: t.id }));
}
