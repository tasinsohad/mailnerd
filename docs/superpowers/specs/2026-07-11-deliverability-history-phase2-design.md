# Deliverability Checks — Phase 2 (historical logging + trends)

**Date:** 2026-07-11
**Status:** Approved (design) — implementing
**Depends on:** Phase 1 (server + domain check engine)

## Scope

Persist a time-series of every health check so we can see **when** a server or domain degraded and
show **trends**. Also compute what changed since the previous run (regressed vs recovered checks) —
useful now in the UI and a prerequisite for later alerting.

**In scope:** history table, write-on-check, prune, a regression/recovery diff, a read endpoint,
and a score sparkline + "degraded since last run" line in the HealthCard.

**Deferred:** alerting, 6h scheduling, live-send, volume correlation (no send-volume source yet).

## Storage

New table `health_history` (append-only time series):

| column | type | notes |
| --- | --- | --- |
| id | text pk | uuid |
| userId | text → users.id | |
| scope | text | `"server"` or `"domain"` |
| targetKey | text | ipAddress (server) or domainId (domain) |
| targetName | text | ip or domain name, for display |
| status | text | healthy / warning / critical / unknown |
| score | integer | 0–100 |
| indicators | jsonb | compact `[{id, status}]` snapshot (for diffing + detail) |
| checkedAt | timestamptz | |

Index `(userId, scope, targetKey, checkedAt)`. Retention: after each insert, prune rows for that
target beyond the newest ~100.

## Write path

In `health-actions.ts`, after `checkServerHealth` / `checkDomainHealth` returns and the latest
snapshot is stored, append a `health_history` row (compact indicators). Wrapped in try/catch so a
missing/unmigrated table never breaks a check run.

## Diff (pure, tested)

`src/server/health-history.ts`:

```ts
diffSnapshots(prev: Snap[] | null, curr: Snap[]): { regressed: string[]; recovered: string[] }
```

Severity rank ok/skip=0, warn=1, fail=2. `regressed` = ids whose rank rose vs the previous run;
`recovered` = ids whose rank fell. New ids that start failing count as regressed. Unit-tested.

## Read

`getHealthHistory({ scope, targetKey, limit })` → newest-first rows for a target (default 60),
plus `regressed`/`recovered` computed from the two newest snapshots.

## UI

- **`HealthTrend`** — a small dependency-free inline-SVG sparkline of `score` over `checkedAt`
  (last N runs), with the current status colour.
- **HealthCard** renders `HealthTrend` for the Domain section (its domainId history) and the Server
  section (its ipAddress history), plus a line: *"N checks degraded since last run"* (or "recovered")
  when the newest diff is non-empty.

## Files

- **New:** `src/server/health-history.ts` (pure diff + snapshot type), `HealthTrend.tsx`,
  `__tests__/health-history.test.ts`, a migration for `health_history`.
- **Modify:** `src/lib/db/schema.ts` (`healthHistory` table), `src/server/health-actions.ts`
  (write history + prune, `getHealthHistory`), `src/components/HealthCard.tsx` (trend + diff line),
  `src/server/domains.ts` (return recent history alongside domain/server health for first paint).

## Testing

- `diffSnapshots` across regressions, recoveries, new-failing, and no-change.
- Existing suites stay green; typecheck clean.
- Live: after two `Re-check`s the sparkline shows two points and the diff line reflects any change.
