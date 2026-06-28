import { describe, it, expect } from "vitest";
import { mergeProgress, ALL_STEPS } from "../pipeline";

describe("mergeProgress", () => {
  it("merges step state without losing previously-set steps", () => {
    const a = mergeProgress(null, { steps: { pushDns: "ok" } });
    const b = mergeProgress(a, { currentStep: "provision", steps: { provision: "running" } });
    expect(b.steps.pushDns).toBe("ok");
    expect(b.steps.provision).toBe("running");
    expect(b.currentStep).toBe("provision");
  });

  it("clears error only when explicitly passed", () => {
    const a = mergeProgress(null, { error: "boom" });
    const b = mergeProgress(a, { steps: { verify: "ok" } });
    expect(b.error).toBe("boom"); // not cleared by an unrelated patch
    const c = mergeProgress(b, { error: null });
    expect(c.error).toBe(null);
  });
});

describe("ALL_STEPS", () => {
  it("has the six pipeline steps in order", () => {
    expect(ALL_STEPS).toEqual([
      "pushDns",
      "provision",
      "ensureMailDomains",
      "createMailboxes",
      "syncDkim",
      "verify",
    ]);
  });
});
