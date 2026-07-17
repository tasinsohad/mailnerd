// Shared types for the deliverability health engine. Kept in a leaf module so the pure logic
// (health-checks), the domain engine (health), and the server engine (health-server) can all
// import them without a cycle.

export type HealthStatus = "ok" | "warn" | "fail" | "skip";
export type HealthAction =
  | "pushDns"
  | "syncDkim"
  | "fixDns"
  | "restartMailcow" // bring up / restart the Mailcow stack over SSH
  | "openFirewall" // ufw allow the mail ports over SSH
  | "recreate"
  | "provision";

// Finer-grained severity for the "How to Fix" guidance (independent of the ok/warn/fail dot).
export type FixSeverity = "info" | "warning" | "high" | "critical";

// Structured remediation guidance attached to an indicator. Only `severity` + `explanation` are
// always present; the rest are filled in when relevant to the specific verdict.
export interface FixGuidance {
  severity: FixSeverity;
  explanation: string; // what the problem means AND why it affects email delivery
  causes?: string[]; // most likely root causes, most-common first
  steps?: string[]; // step-by-step remediation
  commands?: string[]; // shell commands to run (Linux)
  dns?: string[]; // DNS configuration example lines
  logs?: string[]; // real log lines captured from the server, when relevant
  verification?: string[]; // checklist to confirm the fix worked
  nextStep?: string; // when we can't diagnose further: the next command/test to run
}

export interface Indicator {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
  fix?: string;
  action?: HealthAction;
  guidance?: FixGuidance; // rich "How to Fix" block for the troubleshoot UI
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
