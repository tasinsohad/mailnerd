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

  it("marks the disruptive ones destructive (they interrupt mail)", () => {
    expect(DESTRUCTIVE_ACTIONS.has("forcePostfixIPv4")).toBe(true);
    expect(DESTRUCTIVE_ACTIONS.has("createApiKey")).toBe(true);
    // a plain flush is not destructive
    expect(DESTRUCTIVE_ACTIONS.has("flushQueue")).toBe(false);
  });
});
