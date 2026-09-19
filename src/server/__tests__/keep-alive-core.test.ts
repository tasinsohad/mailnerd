import { describe, it, expect, vi } from "vitest";

// The module's status is pinned to globalThis (see the note in keep-alive-core.ts, mirroring
// domain-locks.ts), so each test resets modules and re-imports to get its own clean state.
async function freshCore() {
  // The state object itself is pinned to globalThis (surviving module reload on purpose, so two loaded
  // copies of the module share one status); clear it here so each test starts from a clean slate.
  delete (globalThis as Record<string, unknown>).__keepAliveState;
  vi.resetModules();
  return import("../keep-alive-core");
}

describe("keep-alive-core", () => {
  it("is ok when the query and the rest check both succeed", async () => {
    const { pingDatabaseOnce, getKeepAliveState } = await freshCore();
    await pingDatabaseOnce({ query: async () => {}, rest: async () => {} });
    const state = getKeepAliveState();
    expect(state.lastError).toBeNull();
    expect(state.lastOkAt).not.toBeNull();
    expect(state.lastAttemptAt).not.toBeNull();
  });

  it("is ok when rest is omitted and only the query is checked", async () => {
    const { pingDatabaseOnce, getKeepAliveState } = await freshCore();
    await pingDatabaseOnce({ query: async () => {} });
    const state = getKeepAliveState();
    expect(state.lastError).toBeNull();
    expect(state.lastOkAt).not.toBeNull();
  });

  it("records the query's error and never throws, without calling rest", async () => {
    const { pingDatabaseOnce, getKeepAliveState } = await freshCore();
    const rest = vi.fn(async () => {});
    await expect(
      pingDatabaseOnce({
        query: async () => {
          throw new Error("query boom");
        },
        rest,
      }),
    ).resolves.toBeUndefined();
    const state = getKeepAliveState();
    expect(state.lastError).toBe("query boom");
    expect(state.lastOkAt).toBeNull();
    expect(rest).not.toHaveBeenCalled();
  });

  it("records the rest check's error even though the query succeeded", async () => {
    const { pingDatabaseOnce, getKeepAliveState } = await freshCore();
    await pingDatabaseOnce({
      query: async () => {},
      rest: async () => {
        throw new Error("rest boom");
      },
    });
    const state = getKeepAliveState();
    expect(state.lastError).toBe("rest boom");
    expect(state.lastOkAt).toBeNull();
  });

  it("trims a long error message to 300 characters", async () => {
    const { pingDatabaseOnce, getKeepAliveState } = await freshCore();
    await pingDatabaseOnce({
      query: async () => {
        throw new Error("x".repeat(400));
      },
    });
    expect(getKeepAliveState().lastError).toHaveLength(300);
  });
});
