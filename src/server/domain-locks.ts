// Which domains have a server setup or mailbox run going right now. A second run on the same domain
// used to start freely: three server setups hit dentimaxfirst.com within 11 minutes, two at once, each
// re-installing Mailcow under the other and losing track of the mailboxes it created.
//
// Each claim belongs to one run (its owner id). Only that owner can release it, so a refused duplicate or a
// finished retry can't free a domain another run still holds. The owner can claim again: a queued setup
// keeps one owner id in its job data, so its retries, and its resumption after an app restart, hold the same
// claim. A claim its owner hasn't refreshed for STALE_CLAIM_MS is treated as abandoned.
//
// In-process only, which covers how this app runs: one long-lived server that also hosts the BullMQ
// worker. Pinned to globalThis because server functions and the worker/SSE code can load through
// different module registries (see events.ts). Leaf module so tests can import it.

export type DomainRunKind = "server setup" | "mailbox setup" | "mailbox count change" | "password reset";

interface Claim {
  kind: DomainRunKind;
  owner: string;
  since: number;
}

/** Longer than a full server setup with all its retries (each attempt can take ~50 minutes). */
export const STALE_CLAIM_MS = 6 * 60 * 60 * 1000;

const g = globalThis as unknown as { __domainClaims?: Map<string, Claim> };
const claims: Map<string, Claim> = g.__domainClaims ?? (g.__domainClaims = new Map());

function liveClaim(domainId: string, now: number): Claim | undefined {
  const claim = claims.get(domainId);
  if (claim && now - claim.since > STALE_CLAIM_MS) {
    claims.delete(domainId);
    return undefined;
  }
  return claim;
}

export function newClaimOwner(): string {
  return globalThis.crypto.randomUUID();
}

export function activeRun(domainId: string, now = Date.now()): DomainRunKind | undefined {
  return liveClaim(domainId, now)?.kind;
}

/** Claim a domain for a run (or refresh the owner's own claim), or learn which run already holds it. */
export function claimDomain(
  domainId: string,
  kind: DomainRunKind,
  owner: string = newClaimOwner(),
  now = Date.now(),
): { ok: true; owner: string } | { ok: false; running: DomainRunKind } {
  const current = liveClaim(domainId, now);
  if (current && current.owner !== owner) return { ok: false, running: current.kind };
  claims.set(domainId, { kind, owner, since: now });
  return { ok: true, owner };
}

/** Release a domain, but only if `owner` is the run holding it. */
export function releaseDomain(domainId: string, owner: string): void {
  if (claims.get(domainId)?.owner === owner) claims.delete(domainId);
}

export function busyMessage(running: DomainRunKind): string {
  return `A ${running} is already running for this domain. Wait for it to finish, then try again.`;
}

const g2 = globalThis as unknown as { __serverClaims?: Map<string, { owner: string; since: number }> };
const serverClaims = g2.__serverClaims ?? (g2.__serverClaims = new Map());
const ipKey = (ip: string) => ip.trim().toLowerCase();

/** One setup per server IP at a time: two Mailcow installs on one box would trample each other. */
export function claimServer(ip: string, owner: string, now = Date.now()): { ok: true } | { ok: false; heldBy: string } {
  const key = ipKey(ip);
  const current = serverClaims.get(key);
  if (current && now - current.since <= STALE_CLAIM_MS && current.owner !== owner) return { ok: false, heldBy: current.owner };
  serverClaims.set(key, { owner, since: now });
  return { ok: true };
}

export function releaseServer(ip: string, owner: string): void {
  const key = ipKey(ip);
  if (serverClaims.get(key)?.owner === owner) serverClaims.delete(key);
}
