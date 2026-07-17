import { describe, it, expect } from "vitest";
import { dedupePlanByServer } from "../remediation";
import type { RemediationStep } from "../remediation-planner";

const server = (id: string): RemediationStep => ({ id, action: "restartMailcow", target: "server", label: id, why: "", disruptive: true });
const domain = (id: string): RemediationStep => ({ id, action: "pushDns", target: "domain", label: id, why: "", disruptive: false });

describe("dedupePlanByServer", () => {
  it("collapses identical server steps that share an IP to one", () => {
    const out = dedupePlanByServer([
      { domainId: "d1", ipAddress: "1.1.1.1", plan: { steps: [server("restartMailcow")], manual: [], summary: "" } },
      { domainId: "d2", ipAddress: "1.1.1.1", plan: { steps: [server("restartMailcow")], manual: [], summary: "" } },
    ]);
    expect(out.serverSteps.filter((s) => s.step.id === "restartMailcow")).toHaveLength(1);
    expect(out.serverSteps[0].ipAddress).toBe("1.1.1.1");
  });

  it("keeps server steps separate across different IPs", () => {
    const out = dedupePlanByServer([
      { domainId: "d1", ipAddress: "1.1.1.1", plan: { steps: [server("flushQueue")], manual: [], summary: "" } },
      { domainId: "d2", ipAddress: "2.2.2.2", plan: { steps: [server("flushQueue")], manual: [], summary: "" } },
    ]);
    expect(out.serverSteps).toHaveLength(2);
  });

  it("never dedups domain steps — one per domain", () => {
    const out = dedupePlanByServer([
      { domainId: "d1", ipAddress: "1.1.1.1", plan: { steps: [domain("pushDns")], manual: [], summary: "" } },
      { domainId: "d2", ipAddress: "1.1.1.1", plan: { steps: [domain("pushDns")], manual: [], summary: "" } },
    ]);
    expect(out.domainSteps).toHaveLength(2);
    expect(out.domainSteps.map((d) => d.domainId).sort()).toEqual(["d1", "d2"]);
  });
});
