// Shared types for the deliverability health engine. Kept in a leaf module so the pure logic
// (health-checks), the domain engine (health), and the server engine (health-server) can all
// import them without a cycle.

export type HealthStatus = "ok" | "warn" | "fail" | "skip";
export type HealthAction = "pushDns" | "syncDkim" | "fixDns" | "recreate" | "provision";

export interface Indicator {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
  fix?: string;
  action?: HealthAction;
}

export interface DomainHealth {
  status: "healthy" | "warning" | "critical" | "unknown";
  score: number; // 0-100 over non-skipped indicators
  checkedAt: string;
  indicators: Indicator[];
}

// Roll a set of indicators up to an overall status + score (shared by the domain & server engines).
export function rollUp(indicators: Indicator[]): { status: DomainHealth["status"]; score: number } {
  const scored = indicators.filter((i) => i.status !== "skip");
  if (scored.length === 0) return { status: "unknown", score: 0 };
  const okCount = scored.filter((i) => i.status === "ok").length;
  const score = Math.round((okCount / scored.length) * 100);
  if (scored.some((i) => i.status === "fail")) return { status: "critical", score };
  if (scored.some((i) => i.status === "warn")) return { status: "warning", score };
  return { status: "healthy", score };
}
