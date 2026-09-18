// Persists one mailbox-creation run's progress to domains.mailbox_progress, so the job board and the
// domain page can show a live percent / ETA (src/lib/mailbox-progress.ts does that math). Plain
// server-only helper — no createServerFn export — imported by mailcow.ts's setupMailcowDomain
// alongside its other server imports (its static imports are fine there; see mailcow.ts's own header).
//
// A DB write per accepted mailbox would hammer the database on a large batch, so `update` persists at
// most every UPDATE_INTERVAL_MS: the in-memory `state` always holds the latest write, and a throttled
// call is simply dropped — a later `update` (once the interval clears) or `finish` (which always
// writes) carries the current `done`/`failed` forward, so nothing meaningful is ever lost, only
// intermediate frames. It's fire-and-forget and must never throw into the mailbox run: a progress-write
// hiccup here can't be allowed to fail provisioning, so failures are only console.error'd.

import { eq } from "drizzle-orm";
import { domains } from "@/lib/db/schema";
import { newMailboxProgress, recordProgress, finishProgress, type MailboxProgress } from "@/lib/mailbox-progress";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

const UPDATE_INTERVAL_MS = 2000;

export function createMailboxProgressWriter(
  db: Db,
  domainId: string,
  total: number,
): { update(done: number): void; finish(done: number, failed: number): Promise<void> } {
  let state: MailboxProgress = newMailboxProgress(total, new Date().toISOString());
  let lastWriteMs = 0;

  const write = async (next: MailboxProgress) => {
    state = next;
    try {
      await db.update(domains).set({ mailboxProgress: state }).where(eq(domains.id, domainId));
    } catch (err) {
      console.error(`[mailbox-progress-store] failed to save progress for domain ${domainId}:`, err);
    }
  };

  return {
    update(done: number) {
      const now = Date.now();
      if (now - lastWriteMs < UPDATE_INTERVAL_MS) return;
      lastWriteMs = now;
      void write(recordProgress(state, done, now));
    },
    async finish(done: number, failed: number) {
      await write(finishProgress(state, done, failed, new Date().toISOString()));
    },
  };
}
