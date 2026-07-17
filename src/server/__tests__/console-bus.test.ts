import { describe, it, expect } from "vitest";
import { redact, ConsoleLog, consoleChannel } from "../console-bus";
import { jobEvents } from "../events";

// The console streams raw SSH output to the browser, and those commands read mailcow.conf and
// call mysql with -p<dbroot>. Anything secret must never reach the client.
describe("redact", () => {
  it("redacts the Mailcow API key and DB credentials from config output", () => {
    const out = [
      "MAILCOW_HOSTNAME=mail.example.com",
      "API_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "DBROOT=sup3rs3cr3troot",
      "DBPASS=anotherSecret123",
      "REDISPASS=redisSecret99",
    ].join("\n");
    const r = redact(out);
    expect(r).toContain("MAILCOW_HOSTNAME=mail.example.com"); // non-secrets survive
    expect(r).not.toContain("sup3rs3cr3troot");
    expect(r).not.toContain("anotherSecret123");
    expect(r).not.toContain("redisSecret99");
    expect(r).not.toMatch(/[a-f0-9]{64}/);
    expect(r).toContain("<redacted>");
  });

  it("redacts a password passed inline to mysql and an API header", () => {
    expect(redact("docker exec mysql-mailcow mysql -u root -psup3rs3cr3t mailcow")).not.toContain(
      "sup3rs3cr3t",
    );
    expect(redact("curl -H 'X-API-Key: abc123def456ghi'")).not.toContain("abc123def456ghi");
  });

  it("leaves ordinary output untouched", () => {
    const line = "postfix-mailcow  running  Up 2 hours (healthy)";
    expect(redact(line)).toBe(line);
  });
});

describe("ConsoleLog", () => {
  it("records a transcript and skips blank lines", () => {
    const log = new ConsoleLog(null);
    log.info("starting");
    log.cmd("docker ps");
    log.out("   \n");
    log.out("postfix-mailcow running");
    const t = log.transcript();
    expect(t).toEqual([
      { kind: "info", text: "starting" },
      { kind: "cmd", text: "docker ps" },
      { kind: "out", text: "postfix-mailcow running" },
    ]);
  });

  it("redacts secrets before they ever enter the transcript", () => {
    const log = new ConsoleLog(null);
    log.out("DBROOT=hunter2hunter2");
    expect(JSON.stringify(log.transcript())).not.toContain("hunter2hunter2");
  });

  it("keys the stream channel by runId", () => {
    expect(consoleChannel("abc-123")).toBe("console:abc-123");
  });

  it("publishes each line to that run's channel (what the SSE handler subscribes to)", () => {
    const received: unknown[] = [];
    const listener = (d: unknown) => received.push(d);
    jobEvents.on(consoleChannel("run-42"), listener);
    try {
      const log = new ConsoleLog("run-42");
      log.cmd("docker ps");
      log.out("postfix-mailcow running");
      expect(received).toEqual([
        { kind: "cmd", text: "docker ps" },
        { kind: "out", text: "postfix-mailcow running" },
      ]);
    } finally {
      jobEvents.off(consoleChannel("run-42"), listener);
    }
  });

  it("does not publish to other runs' channels", () => {
    const received: unknown[] = [];
    const listener = (d: unknown) => received.push(d);
    jobEvents.on(consoleChannel("someone-else"), listener);
    try {
      new ConsoleLog("run-42").out("private output");
      expect(received).toEqual([]);
    } finally {
      jobEvents.off(consoleChannel("someone-else"), listener);
    }
  });
});
