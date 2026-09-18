// Plans: how long an account may use the app. Pure and browser-safe: the admin panel previews the end date
// with the same function the server (src/server/admin-users.ts) uses to store it.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_PLAN_DAYS = 3660;
export const MAX_PLAN_MONTHS = 120;

export const PLAN_PRESETS = [
  { id: "trial-7d", label: "7-day trial", days: 7 },
  { id: "1m", label: "1 month", months: 1 },
  { id: "3m", label: "3 months", months: 3 },
  { id: "6m", label: "6 months", months: 6 },
  { id: "12m", label: "1 year", months: 12 },
] as const;

export type PlanPresetId = (typeof PLAN_PRESETS)[number]["id"];
export type PlanChoice =
  | { preset: PlanPresetId }
  | { days: number }
  | { months: number }
  | { until: string }
  | { lifetime: true };

export const LIFETIME_LABEL = "Lifetime";

/** `months` calendar months after `date` (UTC): the same day, or the month's last day when it's shorter. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * When a plan choice ends, and the name to show for it. A length is added to the current end while that plan
 * is still running (extending never loses paid-for time), otherwise it starts now. An exact date is used as
 * given. A lifetime plan has no end (endsAt null) and never expires. Throws an Error with a message fit to
 * show the admin.
 */
export function planFor(
  choice: PlanChoice,
  currentEnd: Date | string | null | undefined,
  nowMs: number = Date.now(),
): { endsAt: Date | null; label: string; lifetime: boolean } {
  if ("lifetime" in choice) return { endsAt: null, label: LIFETIME_LABEL, lifetime: true };

  if ("until" in choice) {
    const endsAt = new Date(choice.until);
    if (!Number.isFinite(endsAt.getTime())) throw new Error("Pick a valid end date.");
    if (endsAt.getTime() <= nowMs) throw new Error("The end date must be in the future.");
    return { endsAt, label: `Until ${endsAt.toISOString().slice(0, 10)}`, lifetime: false };
  }

  const current = currentEnd ? new Date(currentEnd).getTime() : NaN;
  const base = new Date(Number.isFinite(current) && current > nowMs ? current : nowMs);

  if ("preset" in choice) {
    const preset = PLAN_PRESETS.find((p) => p.id === choice.preset);
    if (!preset) throw new Error("Unknown plan.");
    const endsAt = "days" in preset ? new Date(base.getTime() + preset.days * DAY_MS) : addMonths(base, preset.months);
    return { endsAt, label: preset.label, lifetime: false };
  }
  if ("days" in choice) {
    const { days } = choice;
    if (!Number.isInteger(days) || days < 1 || days > MAX_PLAN_DAYS) {
      throw new Error(`Days must be a whole number from 1 to ${MAX_PLAN_DAYS}.`);
    }
    return { endsAt: new Date(base.getTime() + days * DAY_MS), label: `Custom: ${plural(days, "day")}`, lifetime: false };
  }
  const { months } = choice;
  if (!Number.isInteger(months) || months < 1 || months > MAX_PLAN_MONTHS) {
    throw new Error(`Months must be a whole number from 1 to ${MAX_PLAN_MONTHS}.`);
  }
  return { endsAt: addMonths(base, months), label: `Custom: ${plural(months, "month")}`, lifetime: false };
}

/** Whole days left on a plan, rounded up; 0 once it has ended (or if there is none). */
export function daysLeft(planEndsAt: Date | string | null | undefined, nowMs: number = Date.now()): number {
  if (!planEndsAt) return 0;
  const ms = new Date(planEndsAt).getTime() - nowMs;
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / DAY_MS) : 0;
}
