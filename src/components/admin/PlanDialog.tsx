import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { PLAN_PRESETS, planFor, type PlanChoice, type PlanPresetId } from "@/lib/plans";
import { applyPlan } from "@/server/admin-users";

export type PlanTarget = { id: string; name: string; email: string; state: string; planEndsAt: string | null };

// Activate a sign-up or change a plan: a preset (or lifetime), a custom number of days or months, or an exact
// end date. The preview uses the same planFor the server stores with.
export function PlanDialog({ user, onClose, onDone }: { user: PlanTarget; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<"preset" | "custom" | "until">("preset");
  const [preset, setPreset] = useState<PlanPresetId | "lifetime">(user.state === "pending" ? "trial-7d" : "1m");
  const [amount, setAmount] = useState("30");
  const [unit, setUnit] = useState<"days" | "months">("days");
  const [until, setUntil] = useState("");
  const [saving, setSaving] = useState(false);

  const untilDate = until ? new Date(`${until}T23:59:59`) : null; // the end of that day, in your timezone
  const choice: PlanChoice | null =
    kind === "preset"
      ? preset === "lifetime"
        ? { lifetime: true }
        : { preset }
      : kind === "custom"
        ? unit === "days"
          ? { days: Number(amount) }
          : { months: Number(amount) }
        : untilDate && Number.isFinite(untilDate.getTime())
          ? { until: untilDate.toISOString() }
          : null; // no date typed, or one Date can't represent (e.g. a year out of range)

  let preview = "Pick an end date.";
  let valid = false;
  if (choice) {
    try {
      const { endsAt } = planFor(choice, user.planEndsAt);
      preview = endsAt ? `Access until ${endsAt.toLocaleString()}` : "Access never expires (lifetime).";
      valid = true;
    } catch (err) {
      preview = err instanceof Error ? err.message : "That plan isn't valid.";
    }
  }

  const activating = user.state === "pending";
  const save = async () => {
    if (!choice) return;
    setSaving(true);
    try {
      const result = await applyPlan({ data: { userId: user.id, choice } });
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't save the plan.");
        return;
      }
      toast.success(activating ? `${user.name} is activated.` : `${user.name}'s plan is updated.`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the plan.");
    } finally {
      setSaving(false);
    }
  };

  const tab = (id: typeof kind, label: string) => (
    <button
      type="button"
      onClick={() => setKind(id)}
      className={cn(
        "flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        kind === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{activating ? `Activate ${user.name}` : `Change plan for ${user.name}`}</DialogTitle>
          <DialogDescription>
            {user.email}. A length is added to the current end date while the plan is still running, otherwise it
            starts today.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {tab("preset", "Plan")}
          {tab("custom", "Custom")}
          {tab("until", "End date")}
        </div>

        {kind === "preset" && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PLAN_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPreset(p.id)}
                className={cn(
                  "rounded-lg border px-3 py-3 text-sm font-medium transition-colors",
                  preset === p.id ? "border-primary bg-primary/10 text-foreground" : "border-border hover:bg-muted",
                )}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPreset("lifetime")}
              className={cn(
                "rounded-lg border px-3 py-3 text-sm font-medium transition-colors",
                preset === "lifetime" ? "border-primary bg-primary/10 text-foreground" : "border-border hover:bg-muted",
              )}
            >
              Lifetime
            </button>
          </div>
        )}

        {kind === "custom" && (
          <div className="flex gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="plan-amount">Length</Label>
              <Input id="plan-amount" type="number" inputMode="numeric" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="w-36 space-y-1.5">
              <Label>Unit</Label>
              <Select value={unit} onValueChange={(v) => setUnit(v as "days" | "months")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="days">Days</SelectItem>
                  <SelectItem value="months">Months</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {kind === "until" && (
          <div className="space-y-1.5">
            <Label htmlFor="plan-until">Last day of access</Label>
            <Input id="plan-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </div>
        )}

        <p className={cn("text-sm", valid ? "text-muted-foreground" : "text-destructive")}>{preview}</p>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!valid || saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {activating ? "Activate" : "Save plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
