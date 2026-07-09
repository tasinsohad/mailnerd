import { describe, it, expect } from "vitest";
import { allocateInboxesAcrossDomains } from "../planning";

describe("allocateInboxesAcrossDomains", () => {
  it("sums to exactly the total across many shapes", () => {
    for (const total of [1, 2, 5, 8, 50, 100, 200, 517, 1000]) {
      for (const domains of [1, 2, 3, 5, 8, 13]) {
        const alloc = allocateInboxesAcrossDomains(total, domains);
        expect(alloc.length).toBe(domains);
        expect(alloc.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it("gives every domain at least 1 when total >= domainCount", () => {
    for (const [total, domains] of [[8, 8], [50, 8], [200, 8], [13, 5]] as const) {
      const alloc = allocateInboxesAcrossDomains(total, domains);
      expect(alloc.every((n) => n >= 1)).toBe(true);
    }
  });

  it("produces real variance (not a near-even split) for large totals", () => {
    let sawSpread = false;
    for (let t = 0; t < 20; t++) {
      const alloc = allocateInboxesAcrossDomains(200, 8);
      if (Math.max(...alloc) - Math.min(...alloc) >= 5) sawSpread = true;
    }
    expect(sawSpread).toBe(true);
  });

  it("handles total < domainCount: 1 to `total` domains, 0 to the rest", () => {
    const alloc = allocateInboxesAcrossDomains(3, 8);
    expect(alloc.reduce((a, b) => a + b, 0)).toBe(3);
    expect(alloc.filter((n) => n === 1).length).toBe(3);
    expect(alloc.filter((n) => n === 0).length).toBe(5);
  });

  it("returns [] for zero domains and zeros for zero total", () => {
    expect(allocateInboxesAcrossDomains(10, 0)).toEqual([]);
    expect(allocateInboxesAcrossDomains(0, 4)).toEqual([0, 0, 0, 0]);
  });
});
