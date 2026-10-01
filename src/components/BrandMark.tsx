import { cn } from "@/lib/utils";

/* The Mail Nerd mark: an M whose two inner strokes form an open envelope flap.
   Tile version (ink square, light strokes) for app chrome; see the design system's
   assets/Logos for the standalone files and usage rules. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-primary text-primary-foreground",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_1px_2px_rgba(18,18,16,0.2)]",
        className,
      )}
    >
      <svg viewBox="0 0 32 32" aria-hidden="true" className="h-4 w-4">
        <path
          d="M9 22 V11.5 L16 17.5 L23 11.5 V22"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
