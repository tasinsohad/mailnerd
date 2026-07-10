import { describe, it, expect } from "vitest";
import { diffSnapshots, toSnapshot } from "../health-history";

describe("diffSnapshots", () => {
  it("flags a check that got worse as regressed", () => {
    const prev = [{ id: "port25", status: "ok" as const }, { id: "queue", status: "ok" as const }];
    const curr = [{ id: "port25", status: "fail" as const }, { id: "queue", status: "warn" as const }];
    const d = diffSnapshots(prev, curr);
    expect(d.regressed.sort()).toEqual(["port25", "queue"]);
    expect(d.recovered).toEqual([]);
  });

  it("flags a check that got better as recovered", () => {
    const prev = [{ id: "dkim", status: "fail" as const }];
    const curr = [{ id: "dkim", status: "ok" as const }];
    expect(diffSnapshots(prev, curr)).toEqual({ regressed: [], recovered: ["dkim"] });
  });

  it("treats a newly-appearing failure as a regression", () => {
    const d = diffSnapshots([], [{ id: "blacklist", status: "fail" as const }]);
    expect(d.regressed).toEqual(["blacklist"]);
  });

  it("reports nothing when nothing changed", () => {
    const snap = [{ id: "tls", status: "ok" as const }, { id: "mx", status: "warn" as const }];
    expect(diffSnapshots(snap, snap)).toEqual({ regressed: [], recovered: [] });
  });

  it("handles a null previous run (first ever check)", () => {
    const d = diffSnapshots(null, [{ id: "spf", status: "ok" as const }, { id: "mx", status: "fail" as const }]);
    expect(d.regressed).toEqual(["mx"]); // fail from nothing = regression
    expect(d.recovered).toEqual([]);
  });
});

describe("toSnapshot", () => {
  it("keeps only id + status", () => {
    expect(
      toSnapshot([{ id: "port25", status: "ok", label: "x", detail: "y" } as any]),
    ).toEqual([{ id: "port25", status: "ok" }]);
  });
});
