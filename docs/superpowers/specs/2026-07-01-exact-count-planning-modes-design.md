# Exact-Count Planning Modes (Inboxes & Subdomains)

**Date:** 2026-07-01
**Status:** Approved (design) — ready for implementation plan
**Area:** Add Domains Wizard → planning phase

## Problem

Today the wizard's planning phase (Step 2) is **bottom-up**. The user sets a per-domain
*range* for both subdomains and inboxes (min–max), and every domain independently rolls a
random count inside that range. The batch total is whatever those independent rolls happen
to sum to — the user cannot say "I need exactly 200 inboxes across this batch."

The user wants the option to instead specify an **exact count** and have the system allocate
it down to the domain / subdomain level, while keeping the existing range behavior available.

## Solution overview

Add two **independent mode toggles** to Step 2 — one for Subdomains, one for Inboxes. Each
toggle is `[ Range | Exact ]`:

| Field      | Range (existing)                                   | Exact (new)                                             |
| ---------- | -------------------------------------------------- | ------------------------------------------------------- |
| Subdomains | min–max per domain; each domain rolls in range     | one number **N** = every domain gets exactly N subdomains |
| Inboxes    | min–max per domain; batch total is emergent        | one number = **batch total**, natural-split across domains |

The modes are orthogonal: any of the four combinations is valid.

**Architectural choice (Approach A):** the wizard resolves every mode to concrete per-domain
counts (`plannedInboxCount`, `plannedSubdomainCount`) *before* submit. The server already
re-plans each domain from those two numbers, so the mode logic stays entirely client-side and
the server contract keeps its shape. Two small server changes are still required (below), plus
one new pure function.

Rejected alternatives: **B — server-driven allocation** (fights the current "client previews,
server re-plans" architecture; needs a server round-trip for the preview). **C — persist the
exact previewed plan verbatim** (best fidelity, largest change; out of scope).

## Current behavior (baseline)

- `AddDomainWizard.tsx` Step 2 holds `minSubdomains/maxSubdomains` and `minInboxes/maxInboxes`.
- `planAllDomains()` loops each domain, rolls `randInt(minInboxes,maxInboxes)` and
  `randInt(minSubdomains,maxSubdomains)`, calls `planDomain()`, and stores the results into
  each row's `plannedInboxCount` / `plannedSubdomainCount` / `plannedDistribution`.
- `handleSubmit()` sends those per-domain numbers (not the inbox list) to
  `addDomainsWizardAction`.
- `addDomainsWizardAction` (`src/server/domains.ts`) **re-plans** each domain:
  - `totalInboxes = row.plannedInboxCount ?? randInt(8,40)` → **inbox total is honored exactly**.
  - `minSubdomains: 1, maxSubdomains: row.plannedSubdomainCount ?? 15` → **subdomain count is
    re-rolled `randInt(1,N)`, so the previewed count is NOT honored.**
- `addDomainsWizardSchema` caps `plannedInboxCount` at **100** and `plannedSubdomainCount` at
  **20** per domain. `plannedDistribution` is sent but unused server-side (server re-plans).

## Detailed design

### 1. New pure function — `allocateInboxesAcrossDomains`

Location: `src/lib/planning.ts` (pure, no DB/React), exported.

```ts
export function allocateInboxesAcrossDomains(total: number, domainCount: number): number[]
```

**Invariants:**
- Returns an array of length `domainCount`.
- Sum of the array is **exactly** `total`.
- Every entry is `>= 1` when `total >= domainCount` (caller guarantees this via validation).
- Output is **visibly varied**, not near-uniform. A naive reuse of `naturalSplit` collapses to
  ~even (its cap is `ceil(total/buckets)`), so this function uses a genuinely higher-variance
  method:
  1. Give each domain a random weight (e.g. `randFloat(0.4, 1.6)`).
  2. Allocate `total` proportionally to weights; round with the largest-remainder method so the
     sum stays exact.
  3. Enforce a floor of 1 per domain and a soft per-domain cap (a multiple of the average, e.g.
     `ceil(average * 3)`) so no single domain swallows the batch; re-balance any overflow onto
     domains below the cap, preserving the exact sum.

Edge cases: `domainCount <= 0` → `[]`; `total <= 0` → array of zeros; `total === domainCount`
→ all ones.

### 2. Wizard state & UI (`AddDomainWizard.tsx`, Step 2)

New state:
- `subdomainMode: "range" | "exact"` (default `"range"`)
- `inboxMode: "range" | "exact"` (default `"range"`)
- `exactSubdomains: number` (default e.g. 3)
- `exactTotalInboxes: number` (default e.g. 50)

Keep existing `minSubdomains/maxSubdomains/minInboxes/maxInboxes` for range mode.

UI: each of the two setting blocks gets a small segmented `[ Range | Exact ]` control.
- **Subdomains — Exact:** single number input, label "Subdomains per domain (exact)".
- **Inboxes — Exact:** single number input, label "Total inboxes for the batch", with a helper
  line "≈ {Math.round(total / domainCount)} per domain across {domainCount} domains".

### 3. `planAllDomains()` — branch on the two modes

For each domain row, determine its inbox count and subdomain count from the active modes:

- **Subdomain count:** `subdomainMode === "exact" ? exactSubdomains : randInt(min,max)`.
- **Inbox count:**
  - Range: `randInt(minInboxes, maxInboxes)` (unchanged).
  - Exact total: compute `allocateInboxesAcrossDomains(exactTotalInboxes, domainRows.length)`
    **once, before the loop**; each domain takes its slot from that array.

Then call `planDomain(row.domain, { totalInboxes, prefixes, names, minSubdomains: subCount,
maxSubdomains: subCount, placement })` (pass the resolved subdomain count as both min and max so
the preview is exact). Store results into the row as today.

"Re-randomize All" (Step 3) simply re-invokes `planAllDomains()`. In exact-inbox mode the total
is a fixed input, so the allocator reshuffles the split while the batch total stays constant.

### 4. Server changes (`src/server/domains.ts`)

- **Honor exact subdomain count.** Replace `minSubdomains: 1, maxSubdomains: row.plannedSubdomainCount ?? 15`
  with `minSubdomains: row.plannedSubdomainCount ?? 1, maxSubdomains: row.plannedSubdomainCount ?? 15`
  so the server reproduces the previewed subdomain count exactly. This also fixes range-mode
  preview drift (preview count now matches what is persisted).
- **Raise the per-domain inbox cap.** In `addDomainsWizardSchema`, raise `plannedInboxCount` max
  from `100` to `1000` so a large batch total whose per-domain slice exceeds 100 is not rejected.
  (`plannedSubdomainCount` max of 20 is retained.)

No new fields are added to the server payload — the mode toggles are purely a client concern.

### 5. Validation (Step 2)

Per active mode:
- **Subdomains — Range:** `min >= 1`, `max >= min` (existing).
- **Subdomains — Exact:** `N >= 1`; soft hint when `N` exceeds the number of prefixes in the pool
  ("only {P} prefixes available — subdomains will be capped at {P}"), since `planDomain` clamps
  `subdomainCount` to `prefixes.length`.
- **Inboxes — Range:** existing rules (`min >= 1`, `max >= min`, and the existing "min inboxes ≥
  max subdomains" guard when subdomains are also in range mode).
- **Inboxes — Exact:** `total >= domainRows.length` (**inline error** otherwise: each domain must
  get at least one inbox). Upper bound guidance: `total <= domainCount * 1000` to stay within the
  raised per-domain cap.

The "Next"/plan action is blocked while any active-mode validation fails.

## Testing

- **Unit (`src/lib/__tests__/planning-count.test.ts` or a sibling):** for
  `allocateInboxesAcrossDomains` across a matrix of `(total, domainCount)` values —
  - sum equals `total` exactly,
  - length equals `domainCount`,
  - every entry `>= 1` when `total >= domainCount`,
  - spread is real (max − min > 0 for reasonable inputs, i.e. not all-equal when it need not be).
- **Existing `planDomain` tests** must continue to pass unchanged (exact-subdomain path already
  supported via `min == max`).
- **Manual smoke:** all four mode combinations produce a preview whose totals match the inputs;
  exact-inbox total in the Step 3 summary equals the typed total; re-randomize keeps that total.

## Files touched

- `src/lib/planning.ts` — add `allocateInboxesAcrossDomains`.
- `src/lib/__tests__/…` — tests for the allocator.
- `src/components/AddDomainWizard.tsx` — mode state, Step 2 toggles + inputs, `planAllDomains`
  branching, per-mode validation.
- `src/server/domains.ts` — honor exact subdomain count; raise `plannedInboxCount` schema cap.

## Out of scope

- `regeneratePlan` (single-domain regenerate on the domain detail page) — unchanged.
- Persisting the exact previewed plan verbatim (Approach C).
- Any change to DNS record generation, placement, name/prefix pools, or the CSV export.
