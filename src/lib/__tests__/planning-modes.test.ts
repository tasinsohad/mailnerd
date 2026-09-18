import { describe, it, expect } from "vitest";
import { splitEvenly, allocateInboxes, inboxCountSettingsError, planDomain } from "../planning";

// Regression: a 7-domain batch asked for 140 mailboxes and got a random 13-27 per domain, because
// "exact total" always split at random. These are the count modes the wizard now offers.

const NAMES = ["Alice Smith", "Bob Jones", "Carol White", "Dan Brown", "Eve Black"];
const PREFIXES = ["web", "app", "api", "shop"];
const sum = (counts: number[]) => counts.reduce((a, b) => a + b, 0);

describe("splitEvenly", () => {
  it("gives every domain the same count when the total divides evenly (7 domains, 140 mailboxes)", () => {
    expect(splitEvenly(140, 7)).toEqual([20, 20, 20, 20, 20, 20, 20]);
  });

  it("hands out the remainder one each, so counts differ by at most 1 and still add up", () => {
    const counts = splitEvenly(10, 3);
    expect(sum(counts)).toBe(10);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("handles more domains than mailboxes, and zero domains", () => {
    expect(splitEvenly(2, 5)).toEqual([1, 1, 0, 0, 0]);
    expect(splitEvenly(5, 0)).toEqual([]);
  });
});

describe("allocateInboxes", () => {
  it("even: always adds up to the total, with counts within 1 of each other", () => {
    for (const total of [7, 50, 140, 141, 999]) {
      for (const domains of [1, 3, 7, 13]) {
        if (total < domains) continue;
        const counts = allocateInboxes({ mode: "even", total }, domains);
        expect(counts).toHaveLength(domains);
        expect(sum(counts)).toBe(total);
        expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("random: always adds up to the total, and every domain gets at least one", () => {
    for (let i = 0; i < 20; i++) {
      const counts = allocateInboxes({ mode: "random", total: 140 }, 7);
      expect(sum(counts)).toBe(140);
      expect(counts.every((n) => n >= 1)).toBe(true);
    }
  });

  it("fixed: the same number for every domain", () => {
    expect(allocateInboxes({ mode: "fixed", perDomain: 25 }, 3)).toEqual([25, 25, 25]);
  });

  it("range: every domain lands inside min..max", () => {
    for (let i = 0; i < 50; i++) {
      const counts = allocateInboxes({ mode: "range", min: 10, max: 15 }, 6);
      expect(counts).toHaveLength(6);
      expect(counts.every((n) => n >= 10 && n <= 15)).toBe(true);
    }
  });

  it("manual: exactly the counts entered", () => {
    expect(allocateInboxes({ mode: "manual", manual: [5, 40, 12] }, 3)).toEqual([5, 40, 12]);
  });

  it("throws the same message the wizard shows for invalid settings", () => {
    const message = inboxCountSettingsError({ mode: "even", total: 5 }, 7);
    expect(message).not.toBeNull();
    expect(() => allocateInboxes({ mode: "even", total: 5 }, 7)).toThrow(message!);
  });
});

describe("planning safeguards", () => {
  it("random: never gives one domain more than the 10000 the server accepts", () => {
    for (let i = 0; i < 20; i++) {
      const counts = allocateInboxes({ mode: "random", total: 29990 }, 3);
      expect(sum(counts)).toBe(29990);
      expect(Math.max(...counts)).toBeLessThanOrEqual(10000);
    }
    expect(allocateInboxes({ mode: "random", total: 30000 }, 3)).toEqual([10000, 10000, 10000]);
  });

  it("random: still adds up with many domains", () => {
    for (let i = 0; i < 20; i++) expect(sum(allocateInboxes({ mode: "random", total: 1000 }, 20))).toBe(1000);
  });

  it("treats subdomain prefixes that differ only in case as the same subdomain", () => {
    const plan = planDomain("example.com", {
      totalInboxes: 12,
      prefixes: ["Web", "web", "WEB"],
      names: NAMES,
      minSubdomains: 3,
      maxSubdomains: 3,
    });
    expect(new Set(plan.inboxes.map((i) => i.subdomainFqdn))).toEqual(new Set(["web.example.com"]));
  });

  it("accepts a previewed split whose prefix case differs from the batch's prefixes", () => {
    const plan = planDomain("example.com", {
      totalInboxes: 3,
      prefixes: ["web"],
      names: NAMES,
      distribution: [{ prefix: "Web", count: 3 }],
    });
    expect(plan.inboxes.every((i) => i.subdomainFqdn === "web.example.com")).toBe(true);
  });

  it("never plans the same address twice, even with one name and thousands of mailboxes", () => {
    const plan = planDomain("example.com", {
      totalInboxes: 3000,
      prefixes: ["web"],
      names: ["Solo"],
      minSubdomains: 1,
      maxSubdomains: 1,
    });
    expect(plan.inboxes).toHaveLength(3000);
    expect(new Set(plan.inboxes.map((i) => i.email)).size).toBe(3000);
  });
});

describe("inboxCountSettingsError", () => {
  it("accepts valid settings", () => {
    expect(inboxCountSettingsError({ mode: "even", total: 140 }, 7)).toBeNull();
    expect(inboxCountSettingsError({ mode: "random", total: 7 }, 7)).toBeNull();
    expect(inboxCountSettingsError({ mode: "fixed", perDomain: 1 }, 3)).toBeNull();
    expect(inboxCountSettingsError({ mode: "range", min: 3, max: 3 }, 3)).toBeNull();
    expect(inboxCountSettingsError({ mode: "manual", manual: [1, 2, 3] }, 3)).toBeNull();
  });

  it("explains what's wrong", () => {
    expect(inboxCountSettingsError({ mode: "even", total: 5 }, 7)).toMatch(/at least 7/);
    expect(inboxCountSettingsError({ mode: "fixed", perDomain: 0 }, 3)).toMatch(/at least 1/);
    expect(inboxCountSettingsError({ mode: "range", min: 9, max: 4 }, 3)).toMatch(/max/i);
    expect(inboxCountSettingsError({ mode: "manual", manual: [3, 0, 2] }, 3)).toMatch(/at least 1/);
    expect(inboxCountSettingsError({ mode: "manual", manual: [3, 2] }, 3)).toMatch(/every domain/i);
    expect(inboxCountSettingsError({ mode: "even", total: 2.5 }, 1)).toMatch(/whole number/i);
  });
});

describe("planDomain with an explicit split", () => {
  const base = { prefixes: PREFIXES, names: NAMES };

  it("creates exactly the previewed split", () => {
    const plan = planDomain("example.com", {
      ...base,
      totalInboxes: 8,
      distribution: [
        { prefix: "web", count: 5 },
        { prefix: "app", count: 3 },
      ],
    });
    expect(plan.inboxes).toHaveLength(8);
    expect(plan.inboxes.filter((i) => i.subdomainFqdn === "web.example.com")).toHaveLength(5);
    expect(plan.inboxes.filter((i) => i.subdomainFqdn === "app.example.com")).toHaveLength(3);
    expect(plan.subdomainDistribution).toEqual({ web: 5, app: 3 });
    expect(plan.subdomainCount).toBe(2);
  });

  it("supports the main domain (@) with placement 'both'", () => {
    const plan = planDomain("example.com", {
      ...base,
      totalInboxes: 10,
      placement: "both",
      distribution: [
        { prefix: "@", count: 4 },
        { prefix: "web", count: 6 },
      ],
    });
    expect(plan.inboxes.filter((i) => i.subdomainFqdn === "example.com")).toHaveLength(4);
    expect(plan.inboxes.filter((i) => i.subdomainFqdn === "web.example.com")).toHaveLength(6);
  });

  it("rejects a split that doesn't match the total, the placement, or the prefixes", () => {
    expect(() =>
      planDomain("example.com", {
        ...base,
        totalInboxes: 9,
        distribution: [
          { prefix: "web", count: 5 },
          { prefix: "app", count: 3 },
        ],
      }),
    ).toThrow(/adds up to 8/);
    expect(() =>
      planDomain("example.com", { ...base, totalInboxes: 4, distribution: [{ prefix: "@", count: 4 }] }),
    ).toThrow(/main domain/i);
    expect(() =>
      planDomain("example.com", {
        ...base,
        totalInboxes: 4,
        placement: "main",
        distribution: [{ prefix: "web", count: 4 }],
      }),
    ).toThrow(/subdomain/i);
    expect(() =>
      planDomain("example.com", { ...base, totalInboxes: 4, distribution: [{ prefix: "mail", count: 4 }] }),
    ).toThrow(/reserved/i);
    expect(() =>
      planDomain("example.com", { ...base, totalInboxes: 4, distribution: [{ prefix: "blog", count: 4 }] }),
    ).toThrow(/not one of/i);
  });
});
