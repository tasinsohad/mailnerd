import { Check, CircleDashed, Loader2, Minus, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";

/* The design system status badge: a tinted pill carrying three cues at once —
   a glyph, the word, and the color — so state never depends on hue alone.
   Tones: success (ready/healthy), progress (work is moving), warning, danger, neutral. */

type Tone = "success" | "progress" | "warning" | "danger" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  success: "text-success bg-success-soft",
  progress: "text-brand bg-brand-soft",
  warning: "text-warning bg-warning-soft",
  danger: "text-destructive bg-danger-soft",
  neutral: "text-muted-foreground bg-neutral-soft",
};

const TONE_ICON: Record<Tone, typeof Check> = {
  success: Check,
  progress: Loader2,
  warning: TriangleAlert,
  danger: X,
  neutral: CircleDashed,
};

export const STATUS_STYLE: Record<string, { tone: Tone; label: string; spin?: boolean }> = {
  ready: { tone: "success", label: "Ready" },
  active: { tone: "success", label: "Active" },
  healthy: { tone: "success", label: "Healthy" },
  provisioning: { tone: "progress", label: "Provisioning", spin: true },
  configuring: { tone: "progress", label: "Configuring", spin: true },
  running: { tone: "progress", label: "Running", spin: true },
  queued: { tone: "neutral", label: "Queued" },
  pending: { tone: "neutral", label: "Pending" },
  unknown: { tone: "neutral", label: "Not checked" },
  warning: { tone: "warning", label: "Needs attention" },
  failed: { tone: "danger", label: "Failed" },
  error: { tone: "danger", label: "Error" },
  critical: { tone: "danger", label: "Critical" },
};

export function StatusPill({ status, className }: { status?: string; className?: string }) {
  const s = STATUS_STYLE[String(status ?? "").toLowerCase()] ?? {
    tone: "neutral" as Tone,
    label: status ? String(status) : "Unknown",
  };
  const Icon = s.tone === "neutral" && !STATUS_STYLE[String(status ?? "").toLowerCase()] ? Minus : TONE_ICON[s.tone];
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full py-0 pl-2 pr-2.5 text-xs font-medium",
        "shadow-[inset_0_0_0_1px_color-mix(in_srgb,currentColor_22%,transparent)]",
        TONE_CLASS[s.tone],
        className,
      )}
    >
      <Icon className={cn("h-3 w-3 shrink-0", s.spin && "animate-spin [animation-duration:1.8s]")} aria-hidden />
      {s.label}
    </span>
  );
}
