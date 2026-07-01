# Exact-Count Planning Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user choose, per count, between a per-domain *range* and an *exact* count in the Add Domains wizard — an exact batch inbox total (natural-split across domains) and an exact subdomains-per-domain number — while keeping the existing range behavior.

**Architecture:** The wizard resolves both mode toggles to concrete per-domain counts (`plannedInboxCount`, `plannedSubdomainCount`) before submit. The server already re-plans each domain from those two numbers, so the mode logic stays client-side; the server only changes to honor the exact subdomain count and to raise the per-domain inbox cap. A new pure function performs the batch-total → per-domain split and is unit-tested.

**Tech Stack:** React + TanStack Start server functions, Zod validation, Drizzle ORM, Vitest 4 (`npm test` → `vitest run`), Tailwind + shadcn/ui.

## Global Constraints

- Allocator `allocateInboxesAcrossDomains(total, domainCount)`: returned array length `== domainCount`, sums **exactly** to `total`, every entry `>= 1` when `total >= domainCount`, and output is **visibly varied** (not a near-even split).
- Exact inbox **total must be ≥ number of domains** (hard validation error otherwise).
- Per-domain inbox cap in `addDomainsWizardSchema` raised from `100` to `1000`. `plannedSubdomainCount` max stays `20`; the UI caps exact subdomains at `20`.
- Exact subdomains = every domain gets exactly N subdomains, physically bounded by that domain's inbox count and the prefix-pool size (`planDomain` clamps `subdomainCount` to `min(N, prefixes.length, totalInboxes)`).
- Two toggles are independent; all four mode combinations are valid. Modes are a client-only concern — no new server payload fields.
- Existing `planDomain` tests and behavior must remain green (exact-subdomain path uses the already-supported `min == max`).

---

## File Structure

- `src/lib/planning.ts` — **modify**: add exported pure fn `allocateInboxesAcrossDomains`.
- `src/lib/__tests__/planning-allocate.test.ts` — **create**: unit tests for the allocator.
- `src/server/domains.ts` — **modify**: honor exact subdomain count; raise `plannedInboxCount` schema max.
- `src/components/AddDomainWizard.tsx` — **modify**: mode state, Step 2 toggles + inputs, `planAllDomains` branching, per-mode validation gating.

---

## Task 1: Batch-total allocator (`allocateInboxesAcrossDomains`)

**Files:**
- Modify: `src/lib/planning.ts` (add exported function near the other pure helpers, after `naturalSplit`)
- Test: `src/lib/__tests__/planning-allocate.test.ts`

**Interfaces:**
- Consumes: existing module-private `randFloat` and exported `shuffle` in `planning.ts`.
- Produces: `export function allocateInboxesAcrossDomains(total: number, domainCount: number): number[]`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/planning-allocate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { allocateInboxesAcrossDomains } from "../planning";

describe("allocateInboxesAcrossDomains", () => {
  it("sums to exactly the total across many shapes", () => {
    for (const total of [1, 2, 5, 8, 50, 100, 200, 517, 1000]) {
      for (const domains of [1, 2, 3, 5, 8, 13]) {
        const alloc = allocateInboxesAcrossDomains(total, domains);
        expect(alloc.length).toBe(domains);
        expect(alloc.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it("gives every domain at least 1 when total >= domainCount", () => {
    for (const [total, domains] of [[8, 8], [50, 8], [200, 8], [13, 5]] as const) {
      const alloc = allocateInboxesAcrossDomains(total, domains);
      expect(alloc.every((n) => n >= 1)).toBe(true);
    }
  });

  it("produces real variance (not a near-even split) for large totals", () => {
    let sawSpread = false;
    for (let t = 0; t < 20; t++) {
      const alloc = allocateInboxesAcrossDomains(200, 8);
      if (Math.max(...alloc) - Math.min(...alloc) >= 5) sawSpread = true;
    }
    expect(sawSpread).toBe(true);
  });

  it("handles total < domainCount: 1 to `total` domains, 0 to the rest", () => {
    const alloc = allocateInboxesAcrossDomains(3, 8);
    expect(alloc.reduce((a, b) => a + b, 0)).toBe(3);
    expect(alloc.filter((n) => n === 1).length).toBe(3);
    expect(alloc.filter((n) => n === 0).length).toBe(5);
  });

  it("returns [] for zero domains and zeros for zero total", () => {
    expect(allocateInboxesAcrossDomains(10, 0)).toEqual([]);
    expect(allocateInboxesAcrossDomains(0, 4)).toEqual([0, 0, 0, 0]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/planning-allocate.test.ts`
Expected: FAIL — `allocateInboxesAcrossDomains` is not exported / not a function.

- [ ] **Step 3: Implement the function**

In `src/lib/planning.ts`, add after the `naturalSplit` function (before `parseList`):

```ts
// Split a batch `total` of inboxes across `domainCount` domains for the wizard's "exact total"
// mode. INVARIANTS: length === domainCount; sum === total; every entry >= 1 when total >=
// domainCount. Unlike naturalSplit (tuned to ~8 per subdomain, which collapses to near-even at
// domain scale), this uses random weights so the per-domain counts are visibly varied, with a
// soft per-domain cap so no single domain swallows the batch.
export function allocateInboxesAcrossDomains(total: number, domainCount: number): number[] {
  if (domainCount <= 0) return [];
  if (total <= 0) return new Array(domainCount).fill(0);
  if (total <= domainCount) {
    // one inbox to the first `total` domains (shuffled), rest zero
    return shuffle(new Array(domainCount).fill(0).map((_, i) => (i < total ? 1 : 0)));
  }

  const average = total / domainCount;
  const cap = Math.max(2, Math.ceil(average * 3));

  // 1. random weights → 2. proportional raw allocation (sums to `total`)
  const weights = new Array(domainCount).fill(0).map(() => randFloat(0.4, 1.6));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (w / weightSum) * total);

  // 3. floor with a floor-of-1, then fix the rounding drift so the sum is exact
  const result = raw.map((x) => Math.max(1, Math.floor(x)));
  let remainder = total - result.reduce((a, b) => a + b, 0);

  if (remainder > 0) {
    // hand out the surplus to the largest fractional parts, respecting the cap
    const order = raw
      .map((x, i) => ({ i, frac: x - Math.floor(x) }))
      .sort((a, b) => b.frac - a.frac);
    let k = 0;
    while (remainder > 0 && k < domainCount * 1000) {
      const idx = order[k % order.length].i;
      if (result[idx] < cap) {
        result[idx]++;
        remainder--;
      }
      k++;
    }
  } else if (remainder < 0) {
    // over-allocated (many tiny weights bumped up to 1) — trim from the largest buckets
    const order = result.map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v);
    let k = 0;
    while (remainder < 0 && k < domainCount * 1000) {
      const idx = order[k % order.length].i;
      if (result[idx] > 1) {
        result[idx]--;
        remainder++;
      }
      k++;
    }
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/planning-allocate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the existing planning tests to confirm no regressions**

Run: `npx vitest run src/lib/__tests__/planning-count.test.ts src/lib/__tests__/planning-reserved.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/planning.ts src/lib/__tests__/planning-allocate.test.ts
git commit -m "feat(planning): add allocateInboxesAcrossDomains for exact-total batches"
```

---

## Task 2: Server honors exact subdomain count + higher inbox cap

**Files:**
- Modify: `src/server/domains.ts` (schema `addDomainsWizardSchema` ~line 275; handler `addDomainsWizardAction` ~lines 314-315)

**Interfaces:**
- Consumes: existing per-domain `plannedInboxCount` / `plannedSubdomainCount` fields on the wizard payload.
- Produces: no new fields; behavioral change only (exact subdomain count honored; inbox cap raised).

- [ ] **Step 1: Raise the per-domain inbox cap in the schema**

In `src/server/domains.ts`, in `addDomainsWizardSchema`, change:

```ts
      plannedInboxCount: z.number().int().min(1).max(100).optional(),
```

to:

```ts
      plannedInboxCount: z.number().int().min(1).max(1000).optional(),
```

- [ ] **Step 2: Honor the exact subdomain count in the handler**

In `addDomainsWizardAction`, inside the `for (const row of data.domains)` loop, change the `planDomain` call's subdomain bounds from:

```ts
            minSubdomains: 1,
            maxSubdomains: row.plannedSubdomainCount ?? 15,
```

to:

```ts
            // Honor the exact subdomain count previewed in the wizard (min == max). This also
            // makes range-mode previews faithful — the count the user saw is the count persisted.
            minSubdomains: row.plannedSubdomainCount ?? 1,
            maxSubdomains: row.plannedSubdomainCount ?? 15,
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 4: Run the server test suite to confirm no regressions**

Run: `npx vitest run src/server/__tests__`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/domains.ts
git commit -m "feat(domains): honor exact subdomain count and raise per-domain inbox cap"
```

---

## Task 3: Wizard Step 2 — mode toggles, allocation, validation

**Files:**
- Modify: `src/components/AddDomainWizard.tsx` (import line ~100; state ~line 150; `planAllDomains` ~308-356; `handleNext` step-2 branch ~394-397; Step 2 settings card ~717-793)

**Interfaces:**
- Consumes: `allocateInboxesAcrossDomains` from `@/lib/planning` (Task 1).
- Produces: no exported interface; drives `planAllDomains` to set `plannedInboxCount` / `plannedSubdomainCount` per row, consumed unchanged by `handleSubmit` → `addDomainsWizardAction` (Task 2).

- [ ] **Step 1: Import the allocator**

Change the planning import (near line 100) from:

```ts
import { parseList, planDomain, randInt, DomainPlan, generateDnsRecords } from "@/lib/planning";
```

to:

```ts
import {
  parseList,
  planDomain,
  randInt,
  allocateInboxesAcrossDomains,
  DomainPlan,
  generateDnsRecords,
} from "@/lib/planning";
```

- [ ] **Step 2: Add mode state**

Immediately after the `placement` state (the `const [placement, setPlacement] = useState<...>("subdomain");` line, ~150), add:

```ts
  // Each count control can be a per-domain range or an exact count (independent toggles).
  const [subdomainMode, setSubdomainMode] = useState<"range" | "exact">("range");
  const [inboxMode, setInboxMode] = useState<"range" | "exact">("range");
  const [exactSubdomains, setExactSubdomains] = useState(3);
  const [exactTotalInboxes, setExactTotalInboxes] = useState(50);
```

- [ ] **Step 3: Add a Step 2 validation helper**

Directly above `const planAllDomains = () => {`, add:

```ts
  // Returns a human-readable error string if the active Step-2 modes are invalid, else null.
  const step2Errors = (): string | null => {
    if (subdomainMode === "range") {
      if (minSubdomains < 1) return "Min subdomains must be ≥ 1";
      if (maxSubdomains < minSubdomains) return "Max subdomains must be ≥ Min subdomains";
    } else if (exactSubdomains < 1) {
      return "Exact subdomains must be ≥ 1";
    }
    if (inboxMode === "range") {
      if (minInboxes < 1) return "Min inboxes must be ≥ 1";
      if (maxInboxes < minInboxes) return "Max inboxes must be ≥ Min inboxes";
      if (subdomainMode === "range" && minInboxes < maxSubdomains)
        return "Min inboxes must be ≥ Max subdomains (to ensure at least 1 inbox per subdomain)";
    } else if (exactTotalInboxes < domainRows.length) {
      return `Total inboxes must be ≥ number of domains (${domainRows.length}) so each domain gets at least one`;
    }
    return null;
  };
```

- [ ] **Step 4: Branch `planAllDomains` on the two modes**

Replace the entire `planAllDomains` function with:

```ts
  const planAllDomains = () => {
    const prefixes = parseList(prefixesText);
    const names = parseList(namesText);
    const results: DomainPlan[] = [];

    // In exact-total inbox mode, split the batch total across domains up front.
    const inboxAllocation =
      inboxMode === "exact"
        ? allocateInboxesAcrossDomains(exactTotalInboxes, domainRows.length)
        : null;

    for (let d = 0; d < domainRows.length; d++) {
      const row = domainRows[d];
      let attempts = 0;
      let plan: DomainPlan | null = null;

      while (attempts < 10 && !plan) {
        const subdomainCount =
          subdomainMode === "exact" ? exactSubdomains : randInt(minSubdomains, maxSubdomains);
        const totalInboxes =
          inboxMode === "exact" ? inboxAllocation![d] : randInt(minInboxes, maxInboxes);

        try {
          plan = planDomain(row.domain, {
            totalInboxes,
            prefixes,
            names,
            minSubdomains: subdomainCount,
            maxSubdomains: subdomainCount,
            placement,
          });
          if (plan.inboxes.length !== totalInboxes) {
            plan = null;
            attempts++;
          }
        } catch (e) {
          attempts++;
        }
      }

      if (!plan) {
        toast.error(`Failed to plan ${row.domain} after 10 attempts`);
        return;
      }

      results.push(plan);
    }

    setPlannedResults(results);
    setDomainRows((prev) =>
      prev.map((row, i) => ({
        ...row,
        plannedSubdomainCount: results[i]?.subdomainCount,
        plannedInboxCount: results[i]?.totalInboxes,
        plannedDistribution: results[i] ? Object.values(results[i].subdomainDistribution) : [],
      })),
    );
  };
```

- [ ] **Step 5: Gate the Step-2 "Next" action on validation**

In `handleNext`, replace the `else if (step === 2) {` branch:

```ts
    } else if (step === 2) {
      planAllDomains();
      setStep(3);
    }
```

with:

```ts
    } else if (step === 2) {
      const err = step2Errors();
      if (err) {
        toast.error(err);
        return;
      }
      planAllDomains();
      setStep(3);
    }
```

- [ ] **Step 6: Replace the Step-2 settings card with the two-toggle UI**

Replace the entire "Global Range Settings" card — the block that starts with
`<div className="bg-success/10/50 border border-green-100 rounded-xl p-6">` and ends at the
matching closing `</div>` before `{/* Domain List with Server Config */}` — with:

```tsx
                <div className="bg-success/10/50 border border-green-100 rounded-xl p-6">
                  <h3 className="font-semibold text-foreground text-sm mb-1">Count Settings</h3>
                  <p className="text-[10px] text-muted-foreground mb-4">
                    Set subdomains and inboxes as a per-domain range (each domain rolls a random
                    value) or as an exact count. Exact inboxes are split across the batch's domains.
                  </p>

                  <div className="grid grid-cols-2 gap-6">
                    {/* Subdomains */}
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-foreground font-bold text-xs">Subdomains</Label>
                        <div className="flex rounded-lg bg-muted p-0.5">
                          {(["range", "exact"] as const).map((m) => (
                            <button
                              key={m}
                              type="button"
                              onClick={() => setSubdomainMode(m)}
                              className={`px-2 py-0.5 text-[10px] rounded-md capitalize transition-colors ${
                                subdomainMode === m
                                  ? "bg-card text-foreground shadow-sm"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                      </div>
                      {subdomainMode === "range" ? (
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            value={minSubdomains}
                            onChange={(e) => setMinSubdomains(Number(e.target.value))}
                            className="h-9 rounded-xl text-xs"
                            placeholder="Min"
                            min={1}
                          />
                          <span className="text-muted-foreground">—</span>
                          <Input
                            type="number"
                            value={maxSubdomains}
                            onChange={(e) => setMaxSubdomains(Number(e.target.value))}
                            className="h-9 rounded-xl text-xs"
                            placeholder="Max"
                            min={1}
                          />
                        </div>
                      ) : (
                        <Input
                          type="number"
                          value={exactSubdomains}
                          onChange={(e) => setExactSubdomains(Number(e.target.value))}
                          className="h-9 rounded-xl text-xs"
                          placeholder="Subdomains per domain"
                          min={1}
                          max={20}
                        />
                      )}
                    </div>

                    {/* Inboxes */}
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-foreground font-bold text-xs">Inboxes</Label>
                        <div className="flex rounded-lg bg-muted p-0.5">
                          {(["range", "exact"] as const).map((m) => (
                            <button
                              key={m}
                              type="button"
                              onClick={() => setInboxMode(m)}
                              className={`px-2 py-0.5 text-[10px] rounded-md capitalize transition-colors ${
                                inboxMode === m
                                  ? "bg-card text-foreground shadow-sm"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                      </div>
                      {inboxMode === "range" ? (
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            value={minInboxes}
                            onChange={(e) => setMinInboxes(Number(e.target.value))}
                            className="h-9 rounded-xl text-xs"
                            placeholder="Min"
                            min={1}
                          />
                          <span className="text-muted-foreground">—</span>
                          <Input
                            type="number"
                            value={maxInboxes}
                            onChange={(e) => setMaxInboxes(Number(e.target.value))}
                            className="h-9 rounded-xl text-xs"
                            placeholder="Max"
                            min={1}
                          />
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <Input
                            type="number"
                            value={exactTotalInboxes}
                            onChange={(e) => setExactTotalInboxes(Number(e.target.value))}
                            className="h-9 rounded-xl text-xs"
                            placeholder="Total inboxes for the batch"
                            min={1}
                          />
                          <span className="text-[10px] text-muted-foreground">
                            ≈{" "}
                            {domainRows.length > 0
                              ? Math.round(exactTotalInboxes / domainRows.length)
                              : 0}{" "}
                            per domain across {domainRows.length} domains
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Validation */}
                  {subdomainMode === "range" && minSubdomains < 1 && (
                    <p className="text-[10px] text-red-500 mt-2">Min subdomains must be ≥ 1</p>
                  )}
                  {subdomainMode === "range" && maxSubdomains < minSubdomains && (
                    <p className="text-[10px] text-red-500 mt-2">Max subdomains must be ≥ Min</p>
                  )}
                  {subdomainMode === "exact" &&
                    exactSubdomains > parseList(prefixesText).length && (
                      <p className="text-[10px] text-warning mt-2">
                        Only {parseList(prefixesText).length} prefixes available — subdomains will be
                        capped at {parseList(prefixesText).length}.
                      </p>
                    )}
                  {inboxMode === "range" && minInboxes < 1 && (
                    <p className="text-[10px] text-red-500 mt-2">Min inboxes must be ≥ 1</p>
                  )}
                  {inboxMode === "range" && maxInboxes < minInboxes && (
                    <p className="text-[10px] text-red-500 mt-2">Max inboxes must be ≥ Min inboxes</p>
                  )}
                  {inboxMode === "range" &&
                    subdomainMode === "range" &&
                    minInboxes < maxSubdomains && (
                      <p className="text-[10px] text-red-500 mt-2">
                        Min inboxes must be ≥ Max subdomains (to ensure at least 1 inbox per
                        subdomain)
                      </p>
                    )}
                  {inboxMode === "exact" && exactTotalInboxes < domainRows.length && (
                    <p className="text-[10px] text-red-500 mt-2">
                      Total inboxes must be ≥ number of domains ({domainRows.length}) so each domain
                      gets at least one.
                    </p>
                  )}
                </div>
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 8: Manual smoke test**

Run: `npm run dev`, open the app, launch the Add Domains wizard, and for a 3-domain batch verify:
1. Step 2 shows a `Range | Exact` toggle above both the Subdomains and Inboxes inputs.
2. **Inboxes = Exact, total = 60** → Step 3 "Total Inboxes" summary equals exactly `60`, and the per-domain counts vary (not all `20`).
3. **Subdomains = Exact, N = 4** → each domain's "Subdomains" column shows `4` (or fewer when a domain's inbox count or the prefix pool is smaller).
4. **Inboxes = Exact, total = 2, domains = 3** → "Next" is blocked with the "≥ number of domains" toast.
5. **Both = Range** → behaves exactly as before.
6. "Re-randomize All" in exact-inbox mode keeps the total at `60` while reshuffling the split.

- [ ] **Step 9: Commit**

```bash
git add src/components/AddDomainWizard.tsx
git commit -m "feat(wizard): range/exact toggles for subdomains and batch inbox total"
```

---

## Self-Review

**Spec coverage:**
- Two independent toggles → Task 3 Steps 2, 6. ✓
- Exact inboxes = batch total, natural-split → Task 1 (allocator) + Task 3 Step 4. ✓
- Exact subdomains = N per domain → Task 3 Step 4 (`min == max`) + Task 2 Step 2 (server honors it). ✓
- New pure `allocateInboxesAcrossDomains` with real variance + tests → Task 1. ✓
- Server: honor exact subdomain count + raise inbox cap → Task 2. ✓
- Validation (total ≥ domains; prefix-pool hint; range rules retained) → Task 3 Steps 3, 6. ✓
- Re-randomize holds total constant → Task 3 Step 4 (fixed `exactTotalInboxes` input) + Step 8.6. ✓
- Out of scope (`regeneratePlan`, Approach C) → untouched. ✓

**Placeholder scan:** none — every code step shows complete code and exact commands.

**Type consistency:** `allocateInboxesAcrossDomains(total, domainCount): number[]` is defined in Task 1 and called with the same signature in Task 3 Step 4. `subdomainMode`/`inboxMode`/`exactSubdomains`/`exactTotalInboxes` are declared in Task 3 Step 2 and used consistently in Steps 3, 4, 6. Server fields `plannedInboxCount`/`plannedSubdomainCount` match the existing schema and payload.
