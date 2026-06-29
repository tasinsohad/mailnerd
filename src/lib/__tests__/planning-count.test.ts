import { describe, it, expect } from "vitest";
import { planDomain } from "../planning";

const NAMES = ["Alice Smith", "Bob Jones", "Carol White", "Dan Brown", "Eve Black"];
const MANY_PREFIXES = ["web", "app", "api", "shop", "blog", "dev", "cloud", "portal", "info"];

describe("planDomain generates exactly the requested number of inboxes", () => {
  // Regression: a 28-inbox plan that landed on 1 subdomain used to produce only 8 (per-sub cap),
  // silently dropping 20 inboxes.
  it("places all 28 inboxes even with a single prefix", () => {
    const plan = planDomain("hgrtech.com", {
      totalInboxes: 28,
      prefixes: ["group"],
      names: NAMES,
      minSubdomains: 1,
      maxSubdomains: 1,
    });
    expect(plan.inboxes.length).toBe(28);
  });

  it("produces exactly totalInboxes across a range of sizes and prefix counts", () => {
    for (const total of [1, 5, 8, 9, 28, 30, 50, 120]) {
      for (const prefixes of [["group"], ["web", "app"], MANY_PREFIXES]) {
        const plan = planDomain("example.com", {
          totalInboxes: total,
          prefixes,
          names: NAMES,
        });
        expect(plan.inboxes.length).toBe(total);
        // distribution sums to the same total
        const distSum = Object.values(plan.subdomainDistribution).reduce((a, b) => a + b, 0);
        expect(distSum).toBe(total);
      }
    }
  });

  it("generates unique email addresses", () => {
    const plan = planDomain("example.com", {
      totalInboxes: 50,
      prefixes: ["web", "app"],
      names: NAMES,
    });
    const emails = new Set(plan.inboxes.map((i) => i.email));
    expect(emails.size).toBe(50);
  });
});
