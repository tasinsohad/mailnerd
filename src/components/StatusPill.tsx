import { cn } from "@/lib/utils";

// Status presentation shared across the app: an LED dot whose color carries meaning.
export const STATUS_STYLE: Record<string, { color: string; label: string; pulse?: boolean }> = {
  ready: { color: "text-success", label: "Ready" },
  active: { color: "text-success", label: "Active" },
  provisioning: { color: "text-warning", label: "Provisioning", pulse: true },
  configuring: { color: "text-warning", label: "Configuring", pulse: true },
  queued: { color: "text-muted-foreground", label: "Queued" },
  pending: { color: "text-muted-foreground", label: "Pending" },
  failed: { color: "text-destructive", label: "Failed" },
  error: { color: "text-destructive", label: "Error" },
};

export function StatusPill({ status, className }: { status?: string; className?: string }) {
  const s = STATUS_STYLE[String(status ?? "").toLowerCase()] ?? {
    color: "text-muted-foreground",
    label: status ? String(status) : "Unknown",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground",
        className,
      )}
    >
      <span className={cn("status-dot", s.color, s.pulse && "status-dot--pulse")} />
      {s.label}
    </span>
  );
}
