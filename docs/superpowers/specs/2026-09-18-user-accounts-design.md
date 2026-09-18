# User Accounts, Admin Approval and Plans — Design

**Goal:** Let people sign up for Mail Nerd. An account can be used only after the admin activates it and gives it a plan (a length of time). Each user works in a private workspace, and the admin can open any workspace. The existing Nextus data becomes the admin's own account, untouched.

**Decisions (agreed 2026-09-18):**

| Question | Decision |
|---|---|
| Whose data a user works with | Their own private workspace. The admin can open any user's workspace. |
| How plan length is set | Presets (7-day trial, 1, 3, 6 or 12 months), or custom days, months or an exact end date. |
| When a plan ends | The account is locked: sign-in works but shows "plan ended". Data is kept, and a running server setup finishes. |
| Forgotten password | The admin sets a temporary password. No email is sent. |
| Where accounts live | The app's own `users` table, keeping the existing signed-cookie sign-in. Supabase Auth is not used. |

**Out of scope:** email of any kind, payments, more than one admin, per-plan limits on domains or mailboxes.

## 1. The Nextus workspace (existing data)

Today every row belongs to one internal `users` record (`admin@smtpforge.local`), which `requireAuth` looks up by email.

- **Backup:** before any database change, dump every public table and record its row count. Keep the dump locally and on the VPS.
- **Becomes the Nextus account:** that record is updated in place: `name = 'Nextus'`, `email = ADMIN_EMAIL`, `role = 'admin'`, `status = 'active'`, and no plan end. Its `id` doesn't change, so no domain, job, mailbox, server, secret or health row moves.
- **Setting the email:** the SQL can't know `ADMIN_EMAIL`, so a small script applies this update with the live server's value. Until it runs, `requireAuth` also finds the admin row by the old internal email, so nothing breaks in between.
- **Admin sign-in is unchanged:** it keeps using `ADMIN_EMAIL` / `ADMIN_PASSWORD` from the environment and resolves to the `role = 'admin'` row, not a lookup by email. Changing `ADMIN_EMAIL` later can't orphan the data.
- **Protection:** the admin row is never expired, suspended, rejected or deleted by any code path.
- **Afterwards:** check that per-table row counts for the Nextus user id are identical before and after.

## 2. Data model

New columns on `users`, added with an additive migration (`supabase/migrations/20260918100000_user_accounts.sql`, mirrored in `src/lib/db/schema.ts`):

| Column | Type | Notes |
|---|---|---|
| `name` | text | Shown in the admin panel and the header. |
| `password_hash` | text, nullable | `scrypt$N$r$p$salt$hash`. Null for the admin row, which signs in with the environment password. |
| `role` | text, default `'user'` | `'admin'` or `'user'`. Exactly one admin row. |
| `status` | text, default `'pending'` | `'pending'`, `'active'` or `'suspended'`. The existing row is set to `'active'`. |
| `plan_name` | text, nullable | The label picked, e.g. `1 month` or `Custom: 45 days`. |
| `plan_ends_at` | timestamptz, nullable | Access stops at this instant. Null only for the admin. |
| `activated_at` | timestamptz, nullable | |
| `last_sign_in_at` | timestamptz, nullable | |
| `session_version` | integer, default 1 | Bumped on password reset, suspension and password change, which signs out every existing session. |

Emails are stored lower-cased; the existing `unique(email)` constraint covers duplicates.

## 3. Sessions and the access decision

**Cookie:** `mn_session` carries `{ u: userId, v: sessionVersion, x: expiry }`.
- It is HMAC-signed with `SESSION_SECRET`.
- An admin token also carries a fingerprint of `ADMIN_PASSWORD`, so changing it still signs the admin out.
- Tokens in the old format (`{ e, x }`) are rejected, so the admin signs in once after the deploy.

**Access decision:** one pure function in `src/server/accounts-core.ts` decides access. It returns `{ ok: true }` or `{ ok: false, reason }` with reason `pending | suspended | expired | missing`:

| Account | Result |
|---|---|
| Admin | Always ok. |
| Row missing, or token version ≠ `session_version` | `missing`: treated as signed out. |
| `status = 'pending'` | `pending` |
| `status = 'suspended'` | `suspended` |
| `plan_ends_at` null or ≤ now (non-admin) | `expired` |
| Otherwise | ok |

**`requireAuth`** (`src/lib/auth.ts`) keeps the cross-site check first, then:
1. It verifies the token and loads the user by id.
2. It runs the access decision.
3. On `missing` it throws `UNAUTHENTICATED` (the browser goes to `/auth`). On any other refusal it throws `ACCOUNT_LOCKED: <reason>`, and `src/lib/providers.tsx` sends the browser to `/account`.
4. It passes `context = { db, userId, user, isAdmin, accountId }`:
   - `userId` is the **workspace** every existing query already scopes by. For a user it's their own id.
   - For the admin it's the workspace chosen with the switcher, defaulting to Nextus.
5. It checks the plan on every request, so an expiry locks the account mid-session.

**`requireAdmin`:** a second middleware for admin-only functions. It runs `requireAuth` and refuses non-admins with `FORBIDDEN`.

**Workspace switching:**
- The admin's choice is kept in an httpOnly cookie `mn_workspace`.
- It is honoured only for admin sessions, and only if the id is an existing user.
- For anyone else it is ignored.

## 4. Pages and flows

- **`/auth` (sign-in):** one form for everyone.
  - It checks the environment admin first, then `users` by email.
  - Wrong email and wrong password give the same message.
  - The existing login throttle applies.
  - A successful sign-in records `last_sign_in_at`.
  - The page gains a "Create an account" link.
- **`/signup`:**
  - Fields: name, email, password (≥ 10 characters), confirm password.
  - An email already in use, or equal to `ADMIN_EMAIL`, is refused with "An account with this email already exists."
  - Limits: 5 sign-ups per hour per IP (IPv6 by /64), and 50 per hour in total.
  - A new account is created as `pending` and signed in, then goes to `/account`.
- **`/account`:** status page for locked accounts. The message depends on the reason:
  - pending: "Waiting for admin approval"
  - suspended: "Your account is suspended — contact the admin"
  - expired: "Your plan ended on <date> — contact the admin"
  - It also has a Sign out button.
  - An active user who opens it is sent to `/`.
- **Header:** a non-admin sees "Plan ends in N days" (amber within 7 days). The admin sees the workspace switcher and, when viewing another workspace, a banner: "Viewing Alice's workspace — back to Nextus".
- **Settings, "Change password":** for non-admins. It needs the current password, and bumps `session_version` but keeps the current session signed in.
- **`/admin` (Users):** admin only, with a sidebar item and a pending-count badge.
  - Filters: Pending (default when any exist), Active, Expired, Suspended, All.
  - Each row shows: name, email, signed up, status, plan name, ends at / days left, last sign-in, domains, jobs.
  - Actions:
    - **Activate** (pending): pick a plan and set the account active.
    - **Extend / change plan:** add a preset or custom length, or set an exact end date.
    - **Suspend / Reactivate:** both bump `session_version`.
    - **Reset password:** generates a 16-character temporary password, shown once, and bumps `session_version`.
    - **Reject:** deletes a *pending* account, only if it owns no rows.
    - **Open workspace:** switches to that user.

## 5. Plan arithmetic

This is a pure function, `planEndsAt({ currentEnd, now, choice })`:

- **Choice** is a preset (`trial-7d`, `1m`, `3m`, `6m`, `12m`), `{ days: n }`, `{ months: n }` or `{ until: ISO timestamp }`.
- **Extend / activate:**
  - Base date: the current end if it's in the future, otherwise now.
  - Days add 24-hour days. Months add calendar months, clamped to the last day of the month (Jan 31 + 1 month = Feb 28/29).
- **Exact date:** the browser sends the end of the chosen day in the admin's timezone, and the server stores it as is. It must be in the future.
- **Plan name:** the preset label, or `Custom: N days` / `Custom: N months` / `Until <date>`.

## 6. Keeping workspaces apart

Every server function already receives `userId` from `requireAuth`, and most queries filter by it. The work is to make that complete:

- **Audit all 91 server functions.** Every read or write that takes a record id (domain, batch, server, plan, inbox, DNS record, template, health row) must also match `userId`. A mismatch returns "not found", never another user's data.
- **Where the audit adds checks:** functions that load a domain by id and then act on its relations. It also checks helpers that fetch `user_secrets` for the domain's owner, not the caller's.
- **`/api/sse`:** the live log stream accepts the domain only if `domain.userId` equals the session's workspace (the admin's chosen workspace, or the user's own).
- **Background work:** the queue worker and in-process setups load by domain id and act for the domain's owner, as today. They don't depend on who is signed in.
- **Domain names stay unique across the app,** because a domain can't be provisioned twice. A duplicate is refused with "This domain is already in the app", which doesn't say whose.
- **External troubleshooting tools** don't read stored data and stay available to any active user.

## 7. Database protection

- **Row Level Security:** enable it on every public table in the same migration, with no policies. Users' password hashes would otherwise be readable by anyone holding Supabase's public anon key.
  - The app connects as `postgres` (table owner, `bypassrls`) and `service_role` bypasses RLS, so the app is unaffected. Both were verified on 2026-09-15.
  - To undo: `ALTER TABLE … DISABLE ROW LEVEL SECURITY`.
- **Password hashing:** `node:crypto` scrypt with a 16-byte random salt per password, compared with `timingSafeEqual`.

## 8. Testing

- **Unit tests (vitest):**
  - password hash and verify: round trip, wrong password, malformed hash
  - session token: user id, version, expiry, tampering, old-format rejection, admin fingerprint
  - the access decision for every row of the table in §3
  - plan arithmetic: extend from the future vs from the past, month clamping, exact date in the past refused
  - sign-up validation and the sign-up throttle
- **Isolation test on a local build:**
  - Setup: two test accounts, each with a domain.
  - Account B calls every server function that takes an id with account A's ids and must get "not found" or be refused.
  - `/api/sse` for A's domain must be refused for B.
- **Nextus check:** after migrating, the admin sees the same counts of domains, jobs, mailboxes and servers as the backup.
- **Standard gates:** typecheck, full test suite, production build, and the client-bundle leak check.

## 9. Rollout

1. Back up all public tables and record the row counts.
2. Apply the additive migration: the new columns, Nextus becoming the admin row, and Row Level Security.
3. Verify the Nextus row counts against the backup.
4. Confirm the queue is empty, then redeploy (DEPLOY.md). The admin signs in once more because the token format changed.
5. On the live site, sign in as admin: the Nextus data is intact. Create a test sign-up, activate it, and confirm it sees an empty workspace. Then reject or suspend it.
