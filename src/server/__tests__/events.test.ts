import { describe, it, expect, vi } from "vitest";

// Regression test for the live console going silent.
//
// events.ts is instantiated TWICE in one process: vite.config.ts imports sse-node.ts directly
// (Vite compiles the config to node_modules/.vite-temp/vite.config.*.mjs and Node loads it, so
// that import resolves through Node's own registry), while server fns load through Vite's SSR
// module graph. Two registries = two module instances.
//
// With a plain `export const jobEvents = new JobEvents()`, each instance gets its OWN emitter:
// a server fn publishes to emitter A, the /api/sse handler listens on emitter B, and the stream
// connects then sits silent forever. Pinning to globalThis is what makes them the same object.
//
// vi.resetModules() reproduces exactly that: it drops the module cache so the next import
// re-executes events.ts as a fresh instance.
describe("jobEvents module identity", () => {
  it("is the same emitter across module re-instantiation", async () => {
    const first = (await import("../events")).jobEvents;
    vi.resetModules(); // second registry loads events.ts again
    const second = (await import("../events")).jobEvents;
    expect(second).toBe(first);
  });

  it("delivers an emit from one module instance to a listener on the other", async () => {
    // Listener registered via the "SSE handler" instance…
    const sseSide = (await import("../events")).jobEvents;
    const received: unknown[] = [];
    const listener = (d: unknown) => received.push(d);
    sseSide.on("console:xyz", listener);

    try {
      // …and the publish comes from a freshly re-instantiated "server fn" instance.
      vi.resetModules();
      const serverFnSide = (await import("../events")).jobEvents;
      serverFnSide.emit("console:xyz", { kind: "cmd", text: "docker ps" });

      expect(received).toEqual([{ kind: "cmd", text: "docker ps" }]);
    } finally {
      sseSide.off("console:xyz", listener);
    }
  });
});
