// Rolling up domain health into the numbers and the issue list the Overview shows.
//
// Each issue keeps the indicator id and the domains it affects, because the Overview has to send
// someone to the place the problem actually is — that domain's health panel, with that indicator
// open. Without the ids every issue could only link to the generic troubleshoot page, which is a
// manual-entry tool for servers this app doesn't manage.
import type { DomainHealth, HealthStatus } from "@/server/health-types";

export type HealthCount = "healthy" | "warning" | "critical" | "unknown";

/** The shape this needs off a domain row; real rows carry more. */
export interface SummarizableDomain {
  id: string;
  name: string;
  health?: DomainHealth | null;
}

export interface IssueDomain {
  id: string;
  name: string;
  /** How this indicator reads for this domain: a hard failure or a warning. */
  status: "fail" | "warn";
}

export interface TopIssue {
  /** The indicator id ("spf", "dkim", …), which deep-links to the row in the domain's health panel. */
  id: string;
  label: string;
  /** How many domains this indicator is failing or warning on. */
  count: number;
  /** The worst reading across those domains. */
  worst: "fail" | "warn";
  /** The affected domains, hard failures first, capped at MAX_ISSUE_DOMAINS. */
  domains: IssueDomain[];
}

export interface HealthSummary {
  total: number;
  counts: Record<HealthCount, number>;
  topIssues: TopIssue[];
}

/** Enough affected domains to act on without turning the Overview into a second domain list. */
export const MAX_ISSUE_DOMAINS = 6;
export const MAX_TOP_ISSUES = 5;

const isProblem = (status: HealthStatus): status is "fail" | "warn" => status === "fail" || status === "warn";

export function summarizeHealth(rows: SummarizableDomain[]): HealthSummary {
  const counts: Record<HealthCount, number> = { healthy: 0, warning: 0, critical: 0, unknown: 0 };
  const tally = new Map<string, { label: string; domains: IssueDomain[] }>();

  for (const row of rows) {
    const health = row.health ?? null;
    const status = (health?.status ?? "unknown") as HealthCount;
    counts[status] = (counts[status] ?? 0) + 1;
    for (const ind of health?.indicators ?? []) {
      if (!isProblem(ind.status)) continue;
      const entry = tally.get(ind.id) ?? { label: ind.label, domains: [] };
      entry.domains.push({ id: row.id, name: row.name, status: ind.status });
      tally.set(ind.id, entry);
    }
  }

  const topIssues: TopIssue[] = [...tally.entries()]
    .map(([id, entry]) => {
      // Hard failures first, so the domains that can't send are the ones on offer.
      const domains = [...entry.domains].sort((a, b) => (a.status === b.status ? 0 : a.status === "fail" ? -1 : 1));
      return {
        id,
        label: entry.label,
        count: domains.length,
        worst: domains.some((d) => d.status === "fail") ? ("fail" as const) : ("warn" as const),
        domains: domains.slice(0, MAX_ISSUE_DOMAINS),
      };
    })
    // Failures before warnings, then the ones hitting the most domains.
    .sort((a, b) => (a.worst === b.worst ? b.count - a.count : a.worst === "fail" ? -1 : 1))
    .slice(0, MAX_TOP_ISSUES);

  return { total: rows.length, counts, topIssues };
}
