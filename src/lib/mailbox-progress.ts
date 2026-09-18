// Progress of one mailbox-creation run: % and a time-left estimate from the measured rate. Stored in
// domains.mailbox_progress by the server and shown on the job board and the domain page. Pure and browser-safe.

export interface MailboxProgress {
  total: number;
  done: number;
  failed: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** Moving average of seconds per mailbox; null until the first mailbox is measured. */
  secondsPerMailbox: number | null;
}

// Weight of the newest measurement: high enough to follow a real slowdown, low enough that one slow mailbox
// doesn't swing the estimate.
const SMOOTHING = 0.3;

export function newMailboxProgress(total: number, nowIso: string): MailboxProgress {
  return { total, done: 0, failed: 0, startedAt: nowIso, updatedAt: nowIso, finishedAt: null, secondsPerMailbox: null };
}

/** `done` mailboxes are finished now; update the rate from the time since the last update. */
export function recordProgress(prev: MailboxProgress, done: number, nowMs: number): MailboxProgress {
  const delta = done - prev.done;
  if (delta <= 0) return prev;
  const elapsed = Math.max(0, (nowMs - new Date(prev.updatedAt).getTime()) / 1000);
  const sample = elapsed / delta;
  const rate = prev.secondsPerMailbox === null ? sample : SMOOTHING * sample + (1 - SMOOTHING) * prev.secondsPerMailbox;
  return { ...prev, done, updatedAt: new Date(nowMs).toISOString(), secondsPerMailbox: rate };
}

export function finishProgress(prev: MailboxProgress, done: number, failed: number, nowIso: string): MailboxProgress {
  return { ...prev, done, failed, updatedAt: nowIso, finishedAt: nowIso };
}

export function progressPercent(p: MailboxProgress): number {
  if (p.finishedAt || p.total <= 0) return 100;
  return Math.min(100, Math.floor(((p.done + p.failed) / p.total) * 100));
}

export function secondsLeft(p: MailboxProgress): number | null {
  if (p.finishedAt) return 0;
  if (p.secondsPerMailbox === null) return null;
  return Math.max(0, p.total - p.done - p.failed) * p.secondsPerMailbox;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null) return "estimating time left…";
  if (seconds <= 0) return "finishing…";
  if (seconds < 60) return "under a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  return `about ${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}
