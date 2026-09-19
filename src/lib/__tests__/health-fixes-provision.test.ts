import { describe, it, expect, vi } from "vitest";

// "Re-provision" is the destructive, confirmed health fix: it must ask the setup run to wipe and reinstall,
// not to reuse (or ask about) the Mailcow already on the server.
const provisionServer = vi.fn(async (_args: unknown) => ({ success: true }));
vi.mock("@/server/provisioning", () => ({
  provisionServer: (args: unknown) => provisionServer(args),
}));

import { runHealthFix, DESTRUCTIVE_ACTIONS } from "../health-fixes";

describe("the Re-provision health fix", () => {
  it("is confirmed first and asks the run to reinstall", async () => {
    expect(DESTRUCTIVE_ACTIONS.has("provision")).toBe(true);
    await runHealthFix("provision", "dom-1");
    expect(provisionServer).toHaveBeenCalledWith({
      data: { domainId: "dom-1", serverChoice: "reinstall" },
    });
  });
});
