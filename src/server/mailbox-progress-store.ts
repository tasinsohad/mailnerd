// Persists one mailbox-creation run's progress to domains.mailbox_progress, so the job board and the
// domain page can show a live percent / ETA (src/lib/mailbox-progress.ts does that math). Plain
// server-only helper — no createServerFn export — imported by mailcow.ts's setupMailcowDomain and the
// setup run's mailbox step (domain-setup.ts).
//
// A DB write per accepted mailbox would hammer the database on a large batch, so `update` persists at
// most every UPDATE_INTERVAL_MS. An update that arrives sooner isn't lost: the newest count is kept and a
// trailing write persists it when the interval is up. Each persisted frame is one rate sample, so the
// moving average still measures ~2 s windows.
//
// Writes run one after another, so an older frame can never land after a newer one, and `finish` is
// always the last write (updates after it are ignored). Callers await `finish` (or `settled`) so the final
// state is saved before they report the run as done. It must never throw into the mailbox run: a
// progress-write hiccup can't be allowed to fail provisioning, so failures are only console.error'd.

import { eq } from "drizzle-orm";
import { domains } from "@/lib/db/schema";
import {
  newMailboxProgress,
  recordProgress,
  finishProgress,
  type MailboxProgress,
} from "@/lib/mailbox-progress";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export const UPDATE_INTERVAL_MS = 2000;

export interface MailboxProgressWriter {
  /** `done` mailboxes are finished. Persisted now, or within UPDATE_INTERVAL_MS. Never throws. */
  update(done: number): void;
  /** The run ended: persist the final counts after every earlier write. Resolves once saved; never rejects. */
  finish(done: number, failed: number): Promise<void>;
  /** Resolves once every write queued so far has landed. Never rejects. */
  settled(): Promise<void>;
}

export function createMailboxProgressWriter(
  db: Db,
  domainId: string,
  total: number,
): MailboxProgressWriter {
  let state: MailboxProgress = newMailboxProgress(total, new Date().toISOString());
  let lastWriteMs = 0;
  let pendingDone: number | null = null;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  let chain: Promise<void> = Promise.resolve();

  const persist = (snapshot: MailboxProgress): Promise<void> => {
    chain = chain.then(async () => {
      try {
        await db.update(domains).set({ mailboxProgress: snapshot }).where(eq(domains.id, domainId));
      } catch (err) {
        console.error(
          `[mailbox-progress-store] failed to save progress for domain ${domainId}:`,
          err,
        );
      }
    });
    return chain;
  };

  const cancelTrailing = () => {
    if (trailing) clearTimeout(trailing);
    trailing = null;
  };

  // Record `done` as a rate sample and queue the write (skipped when nothing changed).
  const record = (done: number) => {
    cancelTrailing();
    pendingDone = null;
    const now = Date.now();
    lastWriteMs = now;
    const next = recordProgress(state, done, now);
    if (next === state) return;
    state = next;
    void persist(state);
  };

  return {
    update(done: number) {
      if (finished) return;
      try {
        const sinceLast = Date.now() - lastWriteMs;
        if (sinceLast >= UPDATE_INTERVAL_MS) {
          record(done);
          return;
        }
        pendingDone = done;
        if (!trailing) {
          trailing = setTimeout(() => {
            trailing = null;
            if (!finished && pendingDone !== null) record(pendingDone);
          }, UPDATE_INTERVAL_MS - sinceLast);
        }
      } catch (err) {
        console.error(
          `[mailbox-progress-store] progress update failed for domain ${domainId}:`,
          err,
        );
      }
    },

    finish(done: number, failed: number) {
      if (finished) return chain;
      finished = true;
      cancelTrailing();
      pendingDone = null;
      state = finishProgress(state, done, failed, new Date().toISOString());
      return persist(state);
    },

    settled() {
      return chain;
    },
  };
}
