import { describe, it, expect } from "vitest";
import { ACTION_LABEL, ACTION_ORDER, DESTRUCTIVE_ACTIONS } from "../health-fixes";

describe("health-fixes registry covers the new actions", () => {
  const NEW = ["forcePostfixIPv4", "flushQueue", "createApiKey"] as const;

  it("labels every new action", () => {
    for (const a of NEW) expect(ACTION_LABEL[a]).toBeTruthy();
  });

  it("orders every new action", () => {
    for (const a of NEW) expect(ACTION_ORDER).toContain(a);
  });

  it("keeps ACTION_ORDER in sync with the full action set (regression guard)", () => {
    // Exact array, not just membership: a missing/dropped element (e.g. restartMailcow) must
    // fail this test, since JobIssuesPanel renders fixes by walking ACTION_ORDER.
    expect(ACTION_ORDER).toEqual([
      "fixDns",
      "pushDns",
      "syncDkim",
      "openFirewall",
      "restartMailcow",
      "createApiKey",
      "forcePostfixIPv4",
      "flushQueue",
      "recreate",
      "provision",
    ]);
    // Belt-and-suspenders: every labeled action must appear in ACTION_ORDER, or its one-click
    // fix silently disappears from the UI.
    for (const a of Object.keys(ACTION_LABEL)) expect(ACTION_ORDER).toContain(a);
  });

  it("marks the disruptive ones destructive (they interrupt mail)", () => {
    expect(DESTRUCTIVE_ACTIONS.has("forcePostfixIPv4")).toBe(true);
    expect(DESTRUCTIVE_ACTIONS.has("createApiKey")).toBe(true);
    // a plain flush is not destructive
    expect(DESTRUCTIVE_ACTIONS.has("flushQueue")).toBe(false);
  });
});
