import { jobEvents } from "./events";

// Live console for the ad-hoc troubleshoot flow. Diagnostics and fixes run real commands over SSH;
// this streams what they run and what comes back to the browser, so the user can watch instead of
// staring at a spinner.
//
// The channel is keyed by a runId the CLIENT generates, so it can subscribe BEFORE kicking off the
// run (no chicken-and-egg). The runId is an unguessable UUID, so knowing it is the capability to
// read that run's output — nothing else is keyed off it and it's never persisted.
//
// In-process only (jobEvents), unlike the provisioning queue's Redis channel. In a single-process
// deployment (dev, or a long-running Node server) the server fn and the SSE handler share the same
// jobEvents emitter, so lines stream live. On serverless (Vercel), the fn and the SSE route can land
// on DIFFERENT lambda instances that don't share the emitter, so the live stream stays silent there.
// Either way callers always get the full transcript back in the response, and every consumer applies
// it as a fallback, so the console degrades to "shown at the end" rather than losing anything. Making
// it stream in prod would mean moving this channel onto Redis pub/sub like the provisioning queue.

export const consoleChannel = (runId: string) => `console:${runId}`;

export type ConsoleKind = "cmd" | "out" | "info" | "error";

export interface ConsoleLine {
  kind: ConsoleKind;
  text: string;
}

// A transcript that records every line AND (when a runId is present) streams it live.
export class ConsoleLog {
  private lines: ConsoleLine[] = [];
  constructor(private runId?: string | null) {}

  push(kind: ConsoleKind, text: string): void {
    const clean = String(text ?? "").replace(/\r/g, "");
    if (!clean.trim()) return;
    // Never let a captured credential ride along into the browser.
    const safe = redact(clean);
    this.lines.push({ kind, text: safe });
    if (this.runId) {
      jobEvents.emit(consoleChannel(this.runId), { kind, text: safe });
    }
  }

  cmd(text: string) {
    this.push("cmd", text);
  }
  out(text: string) {
    this.push("out", text);
  }
  info(text: string) {
    this.push("info", text);
  }
  error(text: string) {
    this.push("error", text);
  }

  transcript(): ConsoleLine[] {
    return this.lines;
  }
}

// Strip anything that looks like a secret out of console output. The console is shown in the
// browser, and these commands touch mailcow.conf (API keys) and mysql (-p<dbroot>).
export function redact(text: string): string {
  return String(text ?? "")
    .replace(/(API_KEY\s*=\s*)([^\s"']+)/gi, "$1<redacted>")
    .replace(/(DBROOT\s*=\s*)([^\s"']+)/gi, "$1<redacted>")
    .replace(/(DBPASS\s*=\s*)([^\s"']+)/gi, "$1<redacted>")
    .replace(/(REDISPASS\s*=\s*)([^\s"']+)/gi, "$1<redacted>")
    .replace(/(-p)([A-Za-z0-9!@#$%^&*_+=-]{6,})/g, "$1<redacted>")
    .replace(/(X-API-Key:\s*)(\S+)/gi, "$1<redacted>")
    .replace(/\b[a-f0-9]{64}\b/gi, "<redacted>");
}
