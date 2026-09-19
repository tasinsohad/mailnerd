import { describe, it, expect, vi } from "vitest";

// "Re-provision" is the destructive, confirmed health fix: it must ask the setup run to wipe and reinstall,
// not to reuse (or ask about) the Mailcow already on the server.
const provisionServer = vi.fn(async (_args: unknown) => ({ success: true }));
vi.mock("@/server/provisioning", () => ({
  provisionServer: (args: unknown) => provisionServer(args),
}));

import { runHealthFix, healthFixTargets, DESTRUCTIVE_ACTIONS } from "../health-fixes";

describe("the Re-provision health fix", () => {
  it("is confirmed first and asks the run to reinstall", async () => {
    expect(DESTRUCTIVE_ACTIONS.has("provision")).toBe(true);
    await runHealthFix("provision", "dom-1");
    expect(provisionServer).toHaveBeenCalledWith({
      data: { domainId: "dom-1", serverChoice: "reinstall" },
    });
  });

  it("passes a reuse choice through for the other domains on a server already being reinstalled", async () => {
    await runHealthFix("provision", "dom-2", { serverChoice: "reuse" });
    expect(provisionServer).toHaveBeenLastCalledWith({
      data: { domainId: "dom-2", serverChoice: "reuse" },
    });
  });

  it("wipes each shared server once across several targets", () => {
    expect(
      healthFixTargets("provision", [
        { id: "a", ipAddress: "1.2.3.4" },
        { id: "b", ipAddress: "1.2.3.4 " },
        { id: "c", ipAddress: "9.9.9.9" },
      ]),
    ).toEqual([
      { id: "a", serverChoice: "reinstall" },
      { id: "c", serverChoice: "reinstall" },
      { id: "b", serverChoice: "reuse" },
    ]);
  });

  it("leaves other fixes in their order with no server choice", () => {
    expect(
      healthFixTargets("recreate", [
        { id: "a", ipAddress: "1.2.3.4" },
        { id: "b", ipAddress: "1.2.3.4" },
      ]),
    ).toEqual([{ id: "a" }, { id: "b" }]);
  });
});
