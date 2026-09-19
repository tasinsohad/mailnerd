import type { ServerChoice, SetupState, SetupStep } from "../lib/setup-state";
import { SETUP_STEPS } from "../lib/setup-state";

// The order and rules of one domain's setup run, with the real work injected (src/server/domain-setup.ts) so
// this is unit-tested with fakes. Leaf module: no database, SSH or queue imports.

export type ServerInspection = {
  hasMailcow: boolean;
  hostname: string | null;
  /** Other app domains that use the same server IP (names only). */
  otherDomainsOnServer: string[];
  /** This domain's own earlier install finished: domain is ready and its mail host is the server's. */
  ownInstallComplete: boolean;
  /** This domain's own earlier install didn't finish: domain isn't ready, but the server's mail host is mail.<domain> or the
   *  domain's saved mailcowHostname. */
  ownUnfinishedInstall: boolean;
};

/**
 * What to do with the server. Wiping an existing Mailcow deletes every mailbox on it, so that only happens when
 * the user chose it, or when the only Mailcow there is this domain's own unfinished install.
 */
export function serverDecision(i: ServerInspection, choice: ServerChoice | null): "install" | "reuse" | "ask" {
  if (!i.hasMailcow) return "install";
  if (choice === "reinstall") return "install";
  if (choice === "reuse") return "reuse";
  if (i.ownInstallComplete) return "reuse";
  if (i.ownUnfinishedInstall && i.otherDomainsOnServer.length === 0) return "install";
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
