import { describe, it, expect } from "vitest";
import { buildRemediationPlan } from "../remediation-planner";
import type { DomainHealth, HealthStatus } from "../health-types";

// Build a health snapshot from { indicatorId: status }.
function mk(inds: Record<string, HealthStatus>): DomainHealth {
  return {
    status: "critical",
    score: 0,
    checkedAt: "2026-07-18T00:00:00Z",
    indicators: Object.entries(inds).map(([id, status]) => ({ id, label: id, status, detail: "" })),
  };
}
const ids = (p: { steps: { id: string }[] }) => p.steps.map((s) => s.id);
const manualIds = (p: { manual: { id: string }[] }) => p.manual.map((m) => m.id);

describe("buildRemediationPlan", () => {
  it("all healthy → empty plan", () => {
    const p = buildRemediationPlan(mk({ mx: "ok", spf: "ok", dkim: "ok", dmarc: "ok" }), mk({ queue: "ok", port25: "ok" }), {});
    expect(p.steps).toEqual([]);
    expect(p.manual).toEqual([]);
    expect(p.summary).toContain("0 fix");
  });

  it("box down (containers fail) → ONLY restartMailcow, defer the rest", () => {
    const p = buildRemediationPlan(mk({ mx: "fail" }), mk({ containers: "fail", queue: "fail", firewall: "fail" }), {});
    expect(ids(p)).toEqual(["restartMailcow"]);
    expect(p.steps[0].disruptive).toBe(true);
  });

  it("listeners missing → restartMailcow first, nothing else", () => {
    const p = buildRemediationPlan(null, mk({ listeners: "fail", queue: "fail" }), {});
    expect(ids(p)).toEqual(["restartMailcow"]);
  });

  it("queue stuck + IPv6 stall → forcePostfixIPv4, NO separate flush", () => {
    const p = buildRemediationPlan(null, mk({ ipv6: "fail", queue: "fail", port25: "ok" }), {});
    expect(ids(p)).toContain("forcePostfixIPv4");
    expect(ids(p)).not.toContain("flushQueue");
  });

  it("queue stuck + port 25 blocked → manual relayhost, NO flush", () => {
    const p = buildRemediationPlan(null, mk({ queue: "fail", port25: "fail" }), {});
    expect(ids(p)).not.toContain("flushQueue");
    expect(manualIds(p)).toContain("queue-port25");
  });

  it("queue stuck + blacklisted → manual reputation, NO flush", () => {
    const p = buildRemediationPlan(null, mk({ queue: "fail", port25: "ok", blacklist: "fail" }), {});
    expect(ids(p)).not.toContain("flushQueue");
    expect(manualIds(p)).toContain("queue-reputation");
  });

  it("queue stuck + everything else fine → flushQueue", () => {
    const p = buildRemediationPlan(mk({ dkim: "ok", spf: "ok", dmarc: "ok" }), mk({ queue: "fail", port25: "ok" }), {});
    expect(ids(p)).toContain("flushQueue");
  });

  it("mail host proxied + Cloudflare token → fixDns step", () => {
    const p = buildRemediationPlan(null, mk({ mailhost: "fail" }), { hasCloudflareToken: true });
    expect(ids(p)).toContain("fixDns");
    expect(p.steps.find((s) => s.id === "fixDns")!.target).toBe("domain");
  });

  it("mail host proxied + NO token → manual fixDns", () => {
    const p = buildRemediationPlan(null, mk({ mailhost: "fail" }), { hasCloudflareToken: false });
    expect(ids(p)).not.toContain("fixDns");
    expect(manualIds(p)).toContain("fixDns");
  });

  it("domain auth broken → pushDns + syncDkim, target domain", () => {
    const p = buildRemediationPlan(mk({ mx: "fail", spf: "warn", dkim: "fail", dmarc: "ok" }), mk({ queue: "ok" }), {});
    expect(ids(p)).toContain("pushDns");
    expect(ids(p)).toContain("syncDkim");
    for (const id of ["pushDns", "syncDkim"]) expect(p.steps.find((s) => s.id === id)!.target).toBe("domain");
  });

  it("ordering invariant: auth before forcePostfixIPv4 before flushQueue; flush is last", () => {
    const p = buildRemediationPlan(mk({ mx: "fail", dkim: "fail" }), mk({ firewall: "fail", ipv6: "fail", queue: "fail", port25: "ok" }), { hasCloudflareToken: true });
    const order = ids(p);
    // no flushQueue here (ipv6 present), but forcePostfixIPv4 comes after pushDns/syncDkim/openFirewall
    expect(order.indexOf("pushDns")).toBeLessThan(order.indexOf("forcePostfixIPv4"));
    expect(order.indexOf("openFirewall")).toBeLessThan(order.indexOf("forcePostfixIPv4"));
  });

  it("blacklist alone → manual, no step", () => {
    const p = buildRemediationPlan(null, mk({ blacklist: "fail", queue: "ok" }), {});
    expect(p.steps).toEqual([]);
    expect(manualIds(p)).toContain("blacklist");
  });

  it("missing PTR (fcrdns fail) → manual ptr", () => {
    const p = buildRemediationPlan(null, mk({ fcrdns: "fail" }), {});
    expect(manualIds(p)).toContain("ptr");
  });
});
