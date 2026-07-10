import type { HealthStatus } from "./health-types";

// A compact per-indicator snapshot stored in health_history (id + status only), for trend diffing.
export interface IndicatorSnap {
  id: string;
  status: HealthStatus;
}

// Severity rank so we can tell "got worse" from "got better". ok/skip are both fine (0).
function rank(status: HealthStatus): number {
  return status === "fail" ? 2 : status === "warn" ? 1 : 0;
}

// Compare the current check to the previous one and report which indicators regressed (got worse,
// including newly-appearing failures) and which recovered (got better). Deterministic, no I/O.
export function diffSnapshots(
  prev: IndicatorSnap[] | null | undefined,
  curr: IndicatorSnap[],
): { regressed: string[]; recovered: string[] } {
  const prevRank = new Map<string, number>();
  for (const s of prev ?? []) prevRank.set(s.id, rank(s.status));

  const regressed: string[] = [];
  const recovered: string[] = [];
  for (const s of curr) {
    const before = prevRank.has(s.id) ? prevRank.get(s.id)! : 0; // unseen id starts "fine"
    const now = rank(s.status);
    if (now > before) regressed.push(s.id);
    else if (now < before) recovered.push(s.id);
  }
  return { regressed, recovered };
}

// Reduce a full indicator list to the compact snapshot stored in history.
export function toSnapshot(indicators: { id: string; status: HealthStatus }[]): IndicatorSnap[] {
  return indicators.map((i) => ({ id: i.id, status: i.status }));
}
