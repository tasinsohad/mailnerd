import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { getHealthHistory } from "@/server/health-actions";

const STROKE: Record<string, string> = {
  healthy: "var(--color-success, #16a34a)",
  warning: "var(--color-warning, #d97706)",
  critical: "var(--color-destructive, #dc2626)",
  unknown: "#9ca3af",
};

// Dependency-free score sparkline + "changed since last run" line for one target (a server IP or a
// domain). `version` bumps from the parent after a re-check so the history refetches.
export function HealthTrend({
  scope,
  targetKey,
  version = 0,
}: {
  scope: "server" | "domain";
  targetKey: string;
  version?: number;
}) {
  const { data } = useQuery({
    queryKey: ["health-history", scope, targetKey, version],
    queryFn: () => getHealthHistory({ data: { scope, targetKey, limit: 60 } }),
    enabled: Boolean(targetKey),
  });

  const history = ((data as any)?.history ?? []) as { score: number; status: string; checkedAt: string }[];
  const regressed = ((data as any)?.regressed ?? []) as string[];
  const recovered = ((data as any)?.recovered ?? []) as string[];

  if (history.length < 2) return null;

  const W = 120;
  const H = 26;
  const last = history[history.length - 1];
  const color = STROKE[last?.status ?? "unknown"];
  const n = history.length;
  const points = history
    .map((h, i) => {
      const x = (i / (n - 1)) * (W - 2) + 1;
      const y = H - 2 - (Math.max(0, Math.min(100, h.score)) / 100) * (H - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const change =
    regressed.length > 0
      ? { text: `${regressed.length} check${regressed.length === 1 ? "" : "s"} degraded since last run`, tone: "text-destructive" }
      : recovered.length > 0
        ? { text: `${recovered.length} recovered since last run`, tone: "text-success" }
        : null;

  return (
    <div className="flex items-center gap-3">
      <svg width={W} height={H} className="overflow-visible" role="img" aria-label="score trend">
        <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        <circle
          cx={W - 1}
          cy={H - 2 - (Math.max(0, Math.min(100, last.score)) / 100) * (H - 4)}
          r={2}
          fill={color}
        />
      </svg>
      <span className="ident text-xs text-muted-foreground">{last.score}%</span>
      {change && <span className={cn("text-[11px] font-medium", change.tone)}>{change.text}</span>}
    </div>
  );
}
