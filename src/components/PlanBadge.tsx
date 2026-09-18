import { daysLeft } from "@/lib/plans";
import { cn } from "@/lib/utils";

// "Plan ends in N days" for a user's own plan; amber in the last week.
export function PlanBadge({ planEndsAt, className }: { planEndsAt: string | null; className?: string }) {
  const days = daysLeft(planEndsAt);
  const text = days <= 1 ? "Plan ends within a day" : `Plan ends in ${days} days`;
  return (
    <span
      title={planEndsAt ? `Plan ends ${new Date(planEndsAt).toLocaleString()}` : undefined}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
        days <= 7 ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground",
        className,
      )}
    >
      {text}
    </span>
  );
}
