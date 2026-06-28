import { describe, it, expect } from "vitest";
import { planDomain } from "../planning";

describe("planDomain reserved-prefix filtering", () => {
  it("never uses `mail` (or other reserved names) as a sending subdomain", () => {
    // Even if the caller passes reserved names, they must be filtered out so they can't
    // collide with the mail host (mail.<domain>) and break the Mailcow API.
    const plan = planDomain("example.com", {
      totalInboxes: 30,
      prefixes: ["mail", "autodiscover", "autoconfig", "www", "team", "sales", "hello"],
      names: ["Alice Smith", "Bob Jones", "Carol White"],
      minSubdomains: 3,
      maxSubdomains: 4,
    });
    const used = new Set(plan.inboxes.map((i) => i.subdomainPrefix));
    expect(used.has("mail")).toBe(false);
    expect(used.has("autodiscover")).toBe(false);
    expect(used.has("autoconfig")).toBe(false);
    expect(used.has("www")).toBe(false);
    // and it still produced a valid plan using only the non-reserved prefixes
    expect(plan.inboxes.length).toBeGreaterThan(0);
    for (const u of used) expect(["team", "sales", "hello"]).toContain(u);
  });
});
