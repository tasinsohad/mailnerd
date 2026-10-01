import { describe, it, expect } from "vitest";
import { summarizeHealth, MAX_ISSUE_DOMAINS, MAX_TOP_ISSUES, type SummarizableDomain } from "../health-summary";

// Regression: the Overview's "Needs you now" could only link to the generic troubleshoot page,
// because the rollup threw away which domains an issue belonged to. Each issue now carries the
// indicator id and its domains, which is what the row's "Fix" link is built from.

type Ind = { id: string; label: string; status: "ok" | "warn" | "fail" | "skip" };

function domain(name: string, status: string | null, indicators: Ind[] = []): SummarizableDomain {
  return {
    id: `id-${name}`,
    name,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    health: status === null ? null : ({ status, score: 0, checkedAt: "", indicators } as any),
  };
}

const spfFail: Ind = { id: "spf", label: "SPF record", status: "fail" };
const spfWarn: Ind = { id: "spf", label: "SPF record", status: "warn" };
const dkimWarn: Ind = { id: "dkim", label: "DKIM key", status: "warn" };
const mxOk: Ind = { id: "mx", label: "MX record", status: "ok" };

describe("summarizeHealth", () => {
  it("counts domains by overall status, and unchecked ones as unknown", () => {
    const s = summarizeHealth([
      domain("a.com", "healthy"),
      domain("b.com", "warning"),
      domain("c.com", "critical"),
      domain("d.com", null),
    ]);
    expect(s.total).toBe(4);
    expect(s.counts).toEqual({ healthy: 1, warning: 1, critical: 1, unknown: 1 });
  });

  it("keeps the indicator id and the affected domains, so a row can link to the problem", () => {
    const s = summarizeHealth([
      domain("a.com", "critical", [spfFail, mxOk]),
      domain("b.com", "warning", [spfWarn]),
    ]);
    expect(s.topIssues).toHaveLength(1);
    const [issue] = s.topIssues;
    expect(issue.id).toBe("spf");
    expect(issue.label).toBe("SPF record");
    expect(issue.count).toBe(2);
    expect(issue.domains).toEqual([
      { id: "id-a.com", name: "a.com", status: "fail" },
      { id: "id-b.com", name: "b.com", status: "warn" },
    ]);
  });

  it("ignores indicators that pass or were skipped", () => {
    const s = summarizeHealth([
      domain("a.com", "healthy", [mxOk, { id: "ptr", label: "Reverse DNS", status: "skip" }]),
    ]);
    expect(s.topIssues).toEqual([]);
  });

  it("reports the worst reading of an issue, and lists failing domains first", () => {
    const s = summarizeHealth([
      domain("warn.com", "warning", [spfWarn]),
      domain("fail.com", "critical", [spfFail]),
    ]);
    expect(s.topIssues[0].worst).toBe("fail");
    expect(s.topIssues[0].domains.map((d) => d.name)).toEqual(["fail.com", "warn.com"]);
  });

  it("puts failures before warnings, then the issues hitting the most domains", () => {
    const s = summarizeHealth([
      domain("a.com", "warning", [dkimWarn]),
      domain("b.com", "warning", [dkimWarn]),
      domain("c.com", "warning", [dkimWarn]),
      domain("d.com", "critical", [spfFail]),
    ]);
    expect(s.topIssues.map((i) => i.id)).toEqual(["spf", "dkim"]);
  });

  it("caps the domains it lists per issue but keeps the true count", () => {
    const many = Array.from({ length: MAX_ISSUE_DOMAINS + 3 }, (_, i) =>
      domain(`d${i}.com`, "critical", [spfFail]),
    );
    const [issue] = summarizeHealth(many).topIssues;
    expect(issue.count).toBe(MAX_ISSUE_DOMAINS + 3);
    expect(issue.domains).toHaveLength(MAX_ISSUE_DOMAINS);
  });

  it("caps how many issues it returns", () => {
    const indicators: Ind[] = Array.from({ length: MAX_TOP_ISSUES + 2 }, (_, i) => ({
      id: `ind${i}`,
      label: `Check ${i}`,
      status: "fail",
    }));
    const s = summarizeHealth([domain("a.com", "critical", indicators)]);
    expect(s.topIssues).toHaveLength(MAX_TOP_ISSUES);
  });
});
