import { describe, it, expect } from "vitest";
import { mapLimit } from "../map-limit";

// "Re-check all" awaited each domain, then each server, strictly one at a time. Every check is
// mostly waiting on DNS/SSH/HTTP, so a real account serialised into minutes of dead time.
// mapLimit is what makes the sweep fan out — these pin down the properties that matter.
describe("mapLimit", () => {
  it("processes every item exactly once", async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const seen: number[] = [];
    await mapLimit(items, 4, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // …and it genuinely runs in parallel, not one at a time
  });

  it("actually runs concurrently (the whole point)", async () => {
    // 8 x 20ms serialised would be ~160ms; with 4 workers it should be ~40ms.
    const start = Date.now();
    await mapLimit(Array.from({ length: 8 }), 4, async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(Date.now() - start).toBeLessThan(120);
  });

  it("keeps going when one item throws — one bad server can't abort the sweep", async () => {
    const done: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
        if (n === 3) throw new Error("unreachable host");
        done.push(n);
      }),
    ).resolves.toBeUndefined();
    expect(done.sort()).toEqual([1, 2, 4, 5]);
  });

  it("handles an empty list without hanging", async () => {
    await expect(mapLimit([], 4, async () => {})).resolves.toBeUndefined();
  });

  it("handles fewer items than the limit", async () => {
    const seen: number[] = [];
    await mapLimit([1, 2], 8, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2]);
  });
});
