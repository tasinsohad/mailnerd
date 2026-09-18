import { describe, it, expect } from "vitest";
import { addMonths, daysLeft, planFor, DAY_MS, PLAN_PRESETS } from "../plans";

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

describe("addMonths", () => {
  it("keeps the day of the month", () => {
    expect(addMonths(new Date(Date.UTC(2026, 0, 15)), 1).toISOString()).toBe("2026-02-15T00:00:00.000Z");
  });
  it("uses the last day of a shorter month", () => {
    expect(addMonths(new Date(Date.UTC(2026, 0, 31)), 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(addMonths(new Date(Date.UTC(2028, 0, 31)), 1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
  it("crosses into the next year", () => {
    expect(addMonths(new Date(Date.UTC(2026, 10, 30)), 3).toISOString()).toBe("2027-02-28T00:00:00.000Z");
  });
});

describe("planFor", () => {
  it("starts a new account's plan now", () => {
    expect(planFor({ preset: "trial-7d" }, null, NOW)).toEqual({
      endsAt: new Date(NOW + 7 * DAY_MS),
      label: "7-day trial",
      lifetime: false,
    });
  });

  it("adds time to the end of a plan that is still running", () => {
    const current = new Date(NOW + 10 * DAY_MS);
    expect(planFor({ days: 5 }, current, NOW)).toEqual({ endsAt: new Date(NOW + 15 * DAY_MS), label: "Custom: 5 days", lifetime: false });
  });

  it("restarts an ended plan from now", () => {
    const ended = new Date(NOW - 3 * DAY_MS).toISOString();
    expect(planFor({ preset: "1m" }, ended, NOW)).toEqual({ endsAt: addMonths(new Date(NOW), 1), label: "1 month", lifetime: false });
  });

  it("adds calendar months for a custom length", () => {
    expect(planFor({ months: 2 }, null, NOW)).toEqual({ endsAt: addMonths(new Date(NOW), 2), label: "Custom: 2 months", lifetime: false });
    expect(planFor({ days: 1 }, null, NOW).label).toBe("Custom: 1 day");
    expect(planFor({ months: 1 }, null, NOW).label).toBe("Custom: 1 month");
  });

  it("sets an exact end date, which must be in the future", () => {
    const until = new Date(Date.UTC(2026, 11, 31, 23, 59, 59)).toISOString();
    expect(planFor({ until }, null, NOW)).toEqual({ endsAt: new Date(until), label: "Until 2026-12-31", lifetime: false });
    expect(() => planFor({ until: new Date(NOW - 1000).toISOString() }, null, NOW)).toThrow(/future/);
    expect(() => planFor({ until: "not a date" }, null, NOW)).toThrow(/valid end date/);
  });

  it("refuses lengths that aren't whole numbers in range", () => {
    expect(() => planFor({ days: 0 }, null, NOW)).toThrow(/Days/);
    expect(() => planFor({ days: 1.5 }, null, NOW)).toThrow(/Days/);
    expect(() => planFor({ days: 3661 }, null, NOW)).toThrow(/Days/);
    expect(() => planFor({ months: 121 }, null, NOW)).toThrow(/Months/);
  });

  it("gives a lifetime plan no end date, whatever the current plan is", () => {
    const lifetime = { endsAt: null, label: "Lifetime", lifetime: true };
    expect(planFor({ lifetime: true }, null, NOW)).toEqual(lifetime);
    expect(planFor({ lifetime: true }, new Date(NOW + 10 * DAY_MS), NOW)).toEqual(lifetime);
  });

  it("starts a timed plan from now when it replaces a lifetime one", () => {
    // A lifetime account has no end date, so there's nothing to extend from.
    expect(planFor({ preset: "1m" }, null, NOW)).toEqual({ endsAt: addMonths(new Date(NOW), 1), label: "1 month", lifetime: false });
  });

  it("gives every preset a later end date than now", () => {
    for (const preset of PLAN_PRESETS) {
      expect(planFor({ preset: preset.id }, null, NOW).endsAt?.getTime()).toBeGreaterThan(NOW);
    }
  });
});

describe("daysLeft", () => {
  it("rounds partial days up and is 0 once ended", () => {
    expect(daysLeft(null, NOW)).toBe(0);
    expect(daysLeft(new Date(NOW - 1), NOW)).toBe(0);
    expect(daysLeft(new Date(NOW + 1.2 * DAY_MS), NOW)).toBe(2);
    expect(daysLeft(new Date(NOW + 3 * DAY_MS).toISOString(), NOW)).toBe(3);
  });
});
