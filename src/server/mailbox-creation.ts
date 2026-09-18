// Creating a domain's planned mailboxes in Mailcow, with retries. The database and Mailcow calls come in
// as `deps`, so these rules are tested directly (mailbox-creation.test.ts):
//
//  - A mailbox's password is saved the moment Mailcow accepts it. Saving only after a final check meant
//    an interrupted run left mailboxes in Mailcow with no password anywhere (dentimaxfirst.com: 13 of 24).
//  - Each mailbox gets one password for the whole run. A call that times out after Mailcow acted can't
//    leave Mailcow and the database holding different passwords once a later attempt goes through.
//  - Only a password Mailcow accepted in this run counts for a mailbox that wasn't already finished. A
//    password saved earlier for a mailbox missing from Mailcow proves nothing.
//  - A mailbox that already exists in Mailcow without a trusted password gets a new password instead of a
//    second add (which Mailcow would refuse).
//  - Anything not confirmed in Mailcow's mailbox list is retried RETRY_DELAYS_MS.length more times, then
//    marked failed with Mailcow's last reason, so the domain page can list it and offer a retry. The one
//    exception: a mailbox Mailcow accepted, when the final list read failed, is left as it is (not active,
//    so a retry still confirms it), because it may well exist.

export interface InboxToCreate {
  id: string;
  email: string;
  localPart: string;
  mailDomain: string;
  displayName: string;
  hasPassword: boolean;
}

export type MailcowOutcome = { ok: boolean; error?: string };

export interface MailboxCreationDeps {
  /** Lower-cased addresses that exist in Mailcow, or null when the list couldn't be read. */
  listMailboxes(): Promise<Set<string> | null>;
  mailDomainExists(fqdn: string): boolean;
  addMailbox(inbox: InboxToCreate, password: string): Promise<MailcowOutcome>;
  setPassword(inbox: InboxToCreate, password: string): Promise<MailcowOutcome>;
  savePassword(id: string, password: string): Promise<void>;
  clearPasswords(ids: string[]): Promise<void>;
  markActive(ids: string[]): Promise<void>;
  markFailed(ids: string[]): Promise<void>;
  newPassword(): string;
  sleep(ms: number): Promise<void>;
  /** Called once after the already-finished mailboxes are marked, after every mailbox Mailcow accepts
   *  in any round, and once at the end. `done` = mailboxes finished (already done + accepted this run). */
  onProgress?(done: number, total: number): void;
}

export interface MailboxCreationResult {
  total: number;
  created: number;
  failed: { email: string; error: string }[];
  results: { email: string; success: boolean; error: string | null }[];
}

/** The wait before each retry round: 3 retries after the first attempt. */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000];

const NOT_CONFIRMED = "Mailcow accepted it, but its mailbox list couldn't be read to confirm it";
const NOT_LISTED = "Mailcow accepted it, but it isn't in the mailbox list";

export async function runMailboxCreation(
  inboxes: InboxToCreate[],
  deps: MailboxCreationDeps,
  opts: { retryDelaysMs?: readonly number[] } = {},
): Promise<MailboxCreationResult> {
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const address = (ib: InboxToCreate) => ib.email.toLowerCase();
  const ids = (list: InboxToCreate[]) => list.map((ib) => ib.id);

  const initial = await deps.listMailboxes();
  if (initial === null) {
    throw new Error(
      "Could not read Mailcow's mailbox list, so nothing was changed. Try again once the mail server responds.",
    );
  }
  let existing: Set<string> = initial;

  const alreadyDone = inboxes.filter((ib) => ib.hasPassword && existing.has(address(ib)));
  if (alreadyDone.length) await deps.markActive(ids(alreadyDone));
  deps.onProgress?.(alreadyDone.length, inboxes.length);
  const doneIds = new Set(ids(alreadyDone));

  let pending = inboxes.filter((ib) => !doneIds.has(ib.id));
  const passwordFor = new Map<string, string>();
  const accepted = new Set<string>(); // Mailcow accepted this run's password, and it's saved
  const lastError = new Map<string, string>();
  let lastListOk = true;

  for (let round = 0; round <= delays.length && pending.length > 0; round++) {
    if (round > 0) await deps.sleep(delays[round - 1]);

    for (const ib of pending) {
      if (accepted.has(ib.id)) continue; // only waiting for Mailcow's list to show it
      if (!deps.mailDomainExists(ib.mailDomain)) {
        lastError.set(ib.id, `Mail domain ${ib.mailDomain} doesn't exist in Mailcow`);
        continue;
      }
      let password = passwordFor.get(ib.id);
      if (!password) {
        password = deps.newPassword();
        passwordFor.set(ib.id, password);
      }
      const outcome = existing.has(address(ib))
        ? await deps.setPassword(ib, password)
        : await deps.addMailbox(ib, password);
      if (outcome.ok) {
        await deps.savePassword(ib.id, password);
        accepted.add(ib.id);
        lastError.delete(ib.id);
        deps.onProgress?.(alreadyDone.length + accepted.size, inboxes.length);
      } else {
        lastError.set(ib.id, outcome.error || "Mailcow rejected it");
      }
    }

    const fresh = await deps.listMailboxes();
    lastListOk = fresh !== null;
    if (fresh === null) {
      for (const ib of pending) if (accepted.has(ib.id)) lastError.set(ib.id, NOT_CONFIRMED);
      continue;
    }
    existing = fresh;
    const confirmed = pending.filter((ib) => accepted.has(ib.id) && fresh.has(address(ib)));
    if (confirmed.length) await deps.markActive(ids(confirmed));
    const confirmedIds = new Set(ids(confirmed));
    pending = pending.filter((ib) => !confirmedIds.has(ib.id));
    for (const ib of pending) if (accepted.has(ib.id)) lastError.set(ib.id, NOT_LISTED);
  }

  if (pending.length) {
    const unconfirmed = new Set(lastListOk ? [] : ids(pending.filter((ib) => accepted.has(ib.id))));
    const failedNow = pending.filter((ib) => !unconfirmed.has(ib.id));
    // A failed mailbox has no password anyone can rely on: drop a saved one so it's never exported or trusted.
    const unusable = failedNow.filter((ib) => ib.hasPassword || accepted.has(ib.id));
    if (unusable.length) await deps.clearPasswords(ids(unusable));
    if (failedNow.length) await deps.markFailed(ids(failedNow));
  }

  const failedIds = new Set(ids(pending));
  const reason = (ib: InboxToCreate) => lastError.get(ib.id) ?? "Not created";
  deps.onProgress?.(inboxes.length - pending.length, inboxes.length);
  return {
    total: inboxes.length,
    created: inboxes.length - pending.length,
    failed: pending.map((ib) => ({ email: ib.email, error: reason(ib) })),
    results: inboxes.map((ib) => ({
      email: ib.email,
      success: !failedIds.has(ib.id),
      error: failedIds.has(ib.id) ? reason(ib) : null,
    })),
  };
}
