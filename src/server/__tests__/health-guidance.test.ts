import { describe, it, expect } from "vitest";
import {
  fcrdnsGuidance,
  mailhostGuidance,
  submissionGuidance,
  port25Guidance,
  queueGuidance,
  mailcowGuidance,
  tlsGuidance,
  blacklistGuidance,
  mxGuidance,
  spfGuidance,
  dkimGuidance,
  dmarcGuidance,
  containersGuidance,
  listenersGuidance,
  firewallGuidance,
  mailLogGuidance,
  MAIL_PORTS,
} from "../health-guidance";

const ctx = { ipAddress: "62.72.45.90", mailHost: "mail.ictbridge.com" };
const dctx = { ...ctx, domain: "ictbridge.com" };

describe("health-guidance", () => {
  it("marks a proxied FCrDNS as High with a Cloudflare un-proxy step and DNS example", () => {
    const g = fcrdnsGuidance("proxied", { ...ctx, ptrHost: "mail.ictbridge.com" });
    expect(g.severity).toBe("high");
    expect(g.steps?.join(" ")).toMatch(/DNS Only|grey/i);
    expect(g.dns?.length).toBeGreaterThan(0);
    expect(g.verification?.length).toBeGreaterThan(0);
  });

  it("treats a confirmed FCrDNS and a healthy mail host as Info with no action", () => {
    expect(fcrdnsGuidance("confirmed", ctx).severity).toBe("info");
    expect(mailhostGuidance("ok", ctx).severity).toBe("info");
  });

  it("flags a Cloudflare-proxied mail host as Critical with dig commands", () => {
    const g = mailhostGuidance("proxied", ctx);
    expect(g.severity).toBe("critical");
    expect(g.commands?.some((c) => c.startsWith("dig"))).toBe(true);
    expect(g.commands?.some((c) => c.includes("nslookup"))).toBe(true);
  });

  it("gives submission-port guidance the docker/ss/ufw commands and a next step", () => {
    const g = submissionGuidance("down", ctx);
    expect(g.severity).toBe("high");
    const cmds = g.commands?.join("\n") ?? "";
    expect(cmds).toMatch(/docker ps/);
    expect(cmds).toMatch(/ss -tlnp/);
    expect(cmds).toMatch(/ufw allow 587/);
    expect(g.nextStep).toBeTruthy();
  });

  it("rates a blocked port 25 as Critical with telnet/nc tests", () => {
    const g = port25Guidance("blocked", ctx);
    expect(g.severity).toBe("critical");
    expect(g.commands?.some((c) => c.includes("telnet gmail-smtp-in"))).toBe(true);
    expect(g.commands?.some((c) => c.includes("nc -zv"))).toBe(true);
  });

  it("classifies queue guidance by deferral reason", () => {
    expect(queueGuidance("ok", ctx).severity).toBe("info");
    const timeout = queueGuidance("fail", ctx, "timeout");
    expect(timeout.severity).toBe("high");
    expect(timeout.explanation).toMatch(/timeout/i);
    expect(queueGuidance("fail", ctx, "rejected").explanation).toMatch(/reject/i);
  });

  it("lists the core Mailcow containers when services are down", () => {
    const g = mailcowGuidance("down", ctx);
    expect(g.severity).toBe("critical");
    expect(g.causes?.join(" ")).toMatch(/Docker/);
    expect(mailcowGuidance("ok", ctx).severity).toBe("info");
  });

  it("treats a missing API key as Info, not a server fault", () => {
    // We simply couldn't run the API-only checks — container health still comes from SSH, so
    // this must not imply anything is wrong with the server (and must not say "not provisioned").
    const g = mailcowGuidance("notprovisioned", ctx);
    expect(g.severity).toBe("info");
    expect(g.explanation).not.toMatch(/not provisioned/i);
    expect(g.steps?.join(" ")).toMatch(/Quick fix can create an API key/i);
  });

  it("handles TLS states: ok=info, self-signed=warning, expired=high", () => {
    expect(tlsGuidance("ok", ctx).severity).toBe("info");
    expect(tlsGuidance("selfsigned", ctx).severity).toBe("warning");
    expect(tlsGuidance("expired", ctx).severity).toBe("high");
    expect(tlsGuidance("unreachable", ctx).severity).toBe("high");
  });

  it("escalates a listed IP to Critical and names the blacklist in the next step", () => {
    const clean = blacklistGuidance(false, ctx);
    expect(clean.severity).toBe("info");
    const listed = blacklistGuidance(true, { ...ctx, blacklists: ["zen.spamhaus.org"] });
    expect(listed.severity).toBe("critical");
    expect(listed.steps?.join(" ")).toMatch(/[Ss]top sending/);
    expect(listed.nextStep).toMatch(/spamhaus/);
  });

  it("exposes the full mail-port set for firewall guidance", () => {
    expect(MAIL_PORTS).toEqual([25, 465, 587, 993, 995, 143, 110, 80, 443]);
  });

  it("gives MX guidance a ready-to-paste record and dig test", () => {
    expect(mxGuidance("ok", dctx).severity).toBe("info");
    const g = mxGuidance("missing", dctx);
    expect(g.severity).toBe("high");
    expect(g.dns?.join("\n")).toMatch(/MX\s+10\s+mail\.ictbridge\.com/);
    expect(g.commands?.some((c) => c.includes("dig MX ictbridge.com"))).toBe(true);
  });

  it("flags a missing/duplicate SPF with a v=spf1 example", () => {
    expect(spfGuidance("ok", dctx).severity).toBe("info");
    const missing = spfGuidance("missing", dctx);
    expect(missing.severity).toBe("high");
    expect(missing.dns?.join("\n")).toMatch(/v=spf1/);
    expect(spfGuidance("multiple", dctx).explanation).toMatch(/only one/i);
  });

  it("points DKIM guidance at the selector record and Mailcow key", () => {
    expect(dkimGuidance("ok", dctx).severity).toBe("info");
    const missing = dkimGuidance("missing", dctx);
    expect(missing.severity).toBe("high");
    expect(missing.dns?.join("\n")).toMatch(/dkim\._domainkey\.ictbridge\.com/);
    expect(dkimGuidance("mismatch", dctx).explanation).toMatch(/does NOT match|rotated/i);
  });

  it("treats a missing DMARC as Warning with a _dmarc example", () => {
    expect(dmarcGuidance("ok", dctx).severity).toBe("info");
    const g = dmarcGuidance("missing", dctx);
    expect(g.severity).toBe("warning");
    expect(g.dns?.join("\n")).toMatch(/_dmarc\.ictbridge\.com.*v=DMARC1/);
  });

  it("gives container guidance the runbook's up -d vs restart branch", () => {
    expect(containersGuidance("ok", ctx).severity).toBe("info");

    const down = containersGuidance("down", { ...ctx, stopped: ["postfix"] });
    expect(down.severity).toBe("critical");
    expect(down.explanation).toMatch(/postfix/);
    expect(down.commands?.some((c) => c.includes("docker compose up -d"))).toBe(true);

    // Present-but-unhealthy takes the restart branch, not up -d.
    const unhealthy = containersGuidance("unhealthy", { ...ctx, unhealthy: ["rspamd"] });
    expect(unhealthy.severity).toBe("warning");
    expect(unhealthy.commands?.some((c) => c.includes("docker compose restart"))).toBe(true);
  });

  it("distinguishes 'not listening' from a firewall block", () => {
    expect(listenersGuidance("ok", ctx).severity).toBe("info");
    const g = listenersGuidance("missing", { ...ctx, missing: [465, 587] });
    expect(g.severity).toBe("critical");
    expect(g.commands?.some((c) => c.includes("restart postfix-mailcow"))).toBe(true);
    expect(g.nextStep).toMatch(/firewall/i);
  });

  it("gives firewall guidance the ufw allow commands and provider reminder", () => {
    expect(firewallGuidance("ok", ctx).severity).toBe("info");
    const g = firewallGuidance("blocked", { ...ctx, blocked: [25, 587] });
    expect(g.severity).toBe("high");
    expect(g.commands?.some((c) => c === "sudo ufw allow 25/tcp")).toBe(true);
    expect(g.commands?.some((c) => c.includes("ufw reload"))).toBe(true);
    expect(g.nextStep).toMatch(/provider/i);
  });

  it("reads the dominant mail-log error to point at the right cause", () => {
    expect(mailLogGuidance("ok", ctx).severity).toBe("info");
    expect(mailLogGuidance("errors", { ...ctx, dominant: "timeout" }).explanation).toMatch(
      /port 25/i,
    );
    expect(mailLogGuidance("errors", { ...ctx, dominant: "hostNotFound" }).explanation).toMatch(
      /DNS/i,
    );
    expect(mailLogGuidance("errors", { ...ctx, dominant: "blocked" }).explanation).toMatch(
      /reputation|blacklist/i,
    );
  });
});
