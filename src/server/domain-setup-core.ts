import type { ServerChoice, SetupState, SetupStep } from "../lib/setup-state";
import { SETUP_STEPS } from "../lib/setup-state";

// The order and rules of one domain's setup run, with the real work injected (src/server/domain-setup.ts) so
// this is unit-tested with fakes. Leaf module: no database, SSH or queue imports.

export type ServerInspection = {
  hasMailcow: boolean;
  hostname: string | null;
  /** Other app domains that use the same server IP (names only), plus generic entries for other accounts'
   *  domains and for mail domains on the server's Mailcow that no app domain accounts for (otherDomainsOnServer). */
  otherDomainsOnServer: string[];
  /** This domain's own earlier install finished: domain is ready and its mail host is the server's. */
  ownInstallComplete: boolean;
  /** This domain's own earlier install didn't finish (isOwnUnfinishedInstall): domain isn't ready, the server's
   *  mail host is mail.<domain> or the domain's saved mailcowHostname, and none of its mailboxes is live. */
  ownUnfinishedInstall: boolean;
  /** This domain's planned mailboxes marked active (live in Mailcow). */
  activeMailboxes?: number;
  /** The mail domains the server's Mailcow serves, or null when they couldn't be read (the check is skipped). */
  mailDomains?: string[] | null;
};

/** otherDomainsOnServer's entry for app domains of other accounts: their names aren't shown. */
export const OTHER_ACCOUNT_DOMAIN = "another account's domain";
/** otherDomainsOnServer's entry for mail domains on the server's Mailcow that no app domain accounts for. */
export const FOREIGN_MAIL_DOMAIN = "another mail domain on this server";

/**
 * Whether the Mailcow on the server is this domain's own unfinished install, which the run may wipe and
 * reinstall without asking. The domain isn't ready, the server's mail host is this domain's, and none of its
 * mailboxes is live: a domain marked failed, error or provisioning can still have a working Mailcow with
 * mailboxes in use (older installs often do), and wiping those needs the user's say-so.
 */
export function isOwnUnfinishedInstall(i: {
  domainReady: boolean;
  hostMatches: boolean;
  activeMailboxes: number;
}): boolean {
  return !i.domainReady && i.hostMatches && i.activeMailboxes === 0;
}

const normalizeDomain = (d: string) => d.trim().toLowerCase().replace(/\.$/, "");

/** The mail domains that are neither `ownDomain` (or a subdomain of it) nor one of `knownDomains` (or theirs). */
export function foreignMailDomains(
  mailDomains: string[],
  ownDomain: string,
  knownDomains: string[] = [],
): string[] {
  const owners = [ownDomain, ...knownDomains].map(normalizeDomain).filter(Boolean);
  return mailDomains
    .map(normalizeDomain)
    .filter((d) => d && !owners.some((o) => d === o || d.endsWith(`.${o}`)));
}

/**
 * The inspection's otherDomainsOnServer: the owner's other app domains on the same IP by name, one generic
 * entry for any other account's (their names stay private), and one for mail domains the server's Mailcow
 * serves that none of these domains accounts for. `mailDomains` null: they couldn't be read, so that last
 * check is skipped.
 */
export function otherDomainsOnServer(opts: {
  userId: string;
  domainName: string;
  others: { name: string; userId: string }[];
  mailDomains: string[] | null;
}): string[] {
  const list = opts.others.filter((o) => o.userId === opts.userId).map((o) => o.name);
  if (opts.others.some((o) => o.userId !== opts.userId)) list.push(OTHER_ACCOUNT_DOMAIN);
  if (
    opts.mailDomains &&
    foreignMailDomains(opts.mailDomains, opts.domainName, opts.others.map((o) => o.name)).length
  )
    list.push(FOREIGN_MAIL_DOMAIN);
  return list;
}

/**
 * What to do with the server. Wiping an existing Mailcow deletes every mailbox on it, so that only happens when
 * the user chose it, or when the only Mailcow there is this domain's own unfinished install with no live
 * mailboxes and nothing else on the server.
 */
export function serverDecision(i: ServerInspection, choice: ServerChoice | null): "install" | "reuse" | "ask" {
  if (!i.hasMailcow) return "install";
  if (choice === "reinstall") return "install";
  if (choice === "reuse") return "reuse";
  if (i.ownInstallComplete) return "reuse";
  if (i.ownUnfinishedInstall && i.otherDomainsOnServer.length === 0 && !((i.activeMailboxes ?? 0) > 0))
    return "install";
  return "ask";
}

export interface SetupDeps {
  load(): Promise<SetupState>;
  save(patch: Partial<SetupState>): Promise<SetupState>;
  log(line: string): void;
  dns(): Promise<void>;
  inspectServer(): Promise<ServerInspection & { ip: string }>;
  install(): Promise<void>;
  reuse(): Promise<void>;
  mailboxes(): Promise<{ created: number; failed: number; total: number }>;
  dkim(): Promise<void>;
}

export async function runDomainSetup(deps: SetupDeps): Promise<"done" | "waiting"> {
  let state = await deps.load();
  state = await deps.save({ status: "running", attempt: state.attempt + 1, error: null, waiting: null });

  for (const step of SETUP_STEPS) {
    if (state.steps[step] === "done") continue;
    // stepStartedAt lets the board show how long the step has run (a Mailcow install takes 20–40 min).
    state = await deps.save({
      step,
      steps: { ...state.steps, [step]: "running" },
      stepStartedAt: new Date().toISOString(),
    });
    try {
      if (step === "server") {
        const inspection = await deps.inspectServer();
        const decision = serverDecision(inspection, state.serverChoice);
        if (decision === "ask") {
          deps.log(`Server ${inspection.ip} already runs Mailcow. Waiting for you to choose what to do.\n`);
          await deps.save({
            status: "waiting",
            steps: { ...state.steps, server: "pending" },
            waiting: { kind: "server-choice", ip: inspection.ip, hostname: inspection.hostname, otherDomains: inspection.otherDomainsOnServer },
          });
          return "waiting";
        }
        if (decision === "reuse") await deps.reuse();
        else await deps.install();
      } else if (step === "dns") {
        await deps.dns();
      } else if (step === "mailboxes") {
        const result = await deps.mailboxes();
        if (result.failed > 0) throw new Error(`${result.failed} of ${result.total} mailboxes couldn't be created`);
      } else {
        await deps.dkim();
      }
      state = await deps.save({ steps: { ...state.steps, [step]: "done" } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await deps.save({ steps: { ...state.steps, [step]: "failed" }, error: message });
      throw err;
    }
  }

  await deps.save({ status: "done", step: null, finishedAt: new Date().toISOString() });
  return "done";
}
