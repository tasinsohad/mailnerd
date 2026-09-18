# Job Setup Automation, Mailbox Progress and Supabase Keep-alive — Design

**Goal:** Setting up a job's domains becomes one reliable, server-side run: DNS → server → mailboxes → DKIM for every domain. It shows live progress, keeps going when the page or phone is closed, and never wipes a server that other domains use without asking. Mailbox creation shows % and time left. The Supabase free project is kept awake.

**Decisions (agreed 2026-09-18):**

| Question | Decision |
|---|---|
| How a job's domains get set up | One **Set up everything** button on the job page, plus per-domain Start / Retry / Open log on a live board. |
| Where the automation runs | On the server (queued jobs). Step state is saved in the database, so any device sees the same board and a restart resumes. |
| A server that already runs Mailcow | Setup pauses that domain and **asks the user**: *Add to existing Mailcow* (keep everything) or *Wipe & reinstall* (confirm first). Other domains keep going. |
| Mailbox progress | % and estimated time left, from the measured recent rate. Shown for automated and manual runs. |
| Supabase keep-alive | A tiny read-only query every 12 h. The last ping time shows in Settings. |

## 1. Problems this fixes

The 2026-09-18 code map found these problems:
- After creating a job, the wizard sends you to the newest domain, not the job.
- The job page has no one-button run: its stepper needs clicks, and its DNS push loops in the browser.
- The domain page's `runFullAutomation`:
  - gives up after 15 min, but a setup takes 20–40 min;
  - collides with the setup job's own mailbox creation ("already running");
  - treats the first failed attempt as final;
  - stops when the page closes.
- The job DNS push needs `cfZoneId`, which new domains don't have. It then reports "done" having done nothing.
- Every setup runs `docker compose down -v` and reinstalls Mailcow, wiping any other domain on the same server.
- Mailbox creation reports only at the end.

## 2. Data

These columns are added to `domains` with an additive migration, `supabase/migrations/20260918300000_setup_runs.sql`:
- `setup_state jsonb`: the current or last setup run (shape in `src/lib/setup-state.ts`):
  - `runId`
  - `status` (`queued | running | waiting | done | failed`)
  - `step`
  - `steps` (per step: `pending | running | done | failed`)
  - `attempt`, `error`
  - `waiting` (the server-choice prompt data)
  - `serverChoice` (`reuse | reinstall | null`)
  - `startedAt`, `updatedAt`, `finishedAt`
- `mailbox_progress jsonb`: the latest mailbox run: `total`, `done`, `failed`, `startedAt`, `updatedAt`, `finishedAt`, and `secondsPerMailbox` (a moving average).

The existing `domains.status` values (`pending/provisioning/ready/failed…`) keep their meaning for the rest of the UI.

## 3. The run (server)

One queued job per domain, job name `domain-setup`, on the existing BullMQ queue and worker. It carries `{ domainId, runId, fromStep, lockOwner }` and is limited by `PROVISION_CONCURRENCY` (3). Without Redis, the in-process fallback runs it with the same slot limit.

The steps run in order, skipping any already `done`, so a retry resumes where it failed:
1. **dns:**
   - `resolveAndSaveCfZoneId` (saves the zone).
   - `pushDns` (adopts existing records; any failed record fails the step with its reason).
   - `unproxyDns` (the mail host must be DNS-only).
2. **server:**
   - Inspect the server over SSH: does `mailcow.conf` exist, and what is its `MAILCOW_HOSTNAME`? Which other app domains use the same IP?
   - Decide with the pure rule `serverDecision`:
     - no Mailcow → install;
     - a user choice exists → follow it;
     - this domain's own completed install (domain `ready` and its `mailcowHostname` is the server's) → reuse;
     - this domain's own unfinished install, and no other domains on the IP → install;
     - otherwise → **ask**.
   - **Ask:** save `status: "waiting"` with the prompt data and end the job successfully, which releases the locks. The user's answer queues a new pass starting at `server`.
   - **Reuse:** read the hostname and API key over SSH, save them on the domain, and set status `ready`. Nothing is reinstalled.
   - **Install:** the existing deploy (install) part of `executeProvisionJob`, unchanged.
   - Only one setup at a time per server IP: an in-memory, owner-based lock. A job that finds the IP busy is delayed 60 s, the same way domain claims work.
3. **mailboxes:** `ensureMailDomains` + `createMailboxes`, writing `mailbox_progress` at most every 2 s. If any mailbox failed after its retries, the step fails with "N of M mailboxes couldn't be created".
4. **dkim:** `syncDkim` to Cloudflare.

**Failures:**
- A failing step throws. BullMQ retries the job, 3 attempts with 30 s exponential backoff, and the next attempt resumes at the failed step.
- After the last attempt: `status: "failed"` with the error. The board shows **Needs attention** and a **Retry** button, which queues a new run starting at the failed step.
- The domain claim (`"server setup"`) is held for the whole run, so manual actions on that domain are refused while it runs.

**Logs:** the same terminal log as today (`terminalLogs` + `server-log:<domainId>`), for **Open log**.

**Existing entry points now use the run:**
- The domain page's **Run Full Automation**, **Provision** (from `server`), and **Wipe & re-provision** (from `server` with `serverChoice: "reinstall"`, after the existing confirm).
- The job actions "Provision servers".
- `provisionServer` itself.

## 4. Server functions (`src/server/domain-setup-fns.ts`)

- `startDomainSetup({ domainId, fromStep?, serverChoice? })`: starts a run for one domain. It refuses if a run is already queued, running or waiting.
- `startJobSetup({ batchId })`: starts every domain in the job that isn't `ready` with a finished run, and isn't already queued, running or waiting. Returns the counts.
- `decideServerChoice({ domainId, choice })`: only while waiting. Saves the choice and queues the run from `server`.
- `getJobSetupBoard({ batchId })`: per domain `{ id, name, ipAddress, status, setupState, mailboxProgress }`, workspace-scoped.
- `getDomainSetup({ domainId })`: the same for one domain.

`addDomainsWizardAction` also returns `batchId`.

## 5. UI

- **Wizard:** after creating a job, go to `/jobs/<batchId>`.
- **Job page:**
  - The PRE_FLIGHT / DNS_PUSH / SERVER_SETUP stepper is replaced by a **Setup** board, below the existing health panels.
  - **Set up everything** button and a summary: done · running · waiting for you · needs attention · not started.
  - Each domain row shows:
    - step chips (DNS / Server / Mailboxes / DKIM);
    - a status line, e.g. "Installing Mailcow (20–40 min) · 12 min so far" or "Mailboxes 240/500 · 48% · about 6 min left";
    - a progress bar;
    - Start / Retry / Open log (log dialog with the existing terminal stream).
  - **Waiting rows** show the server-choice panel: "Server 1.2.3.4 already runs Mailcow (hosting: …)", with **Add to existing Mailcow** and **Wipe & reinstall** (confirm).
  - The board polls every 3 s while anything is queued, running or waiting, and works at phone width.
- **Domain page:**
  - The top shows the same row for this domain.
  - **Run Full Automation** starts the server run; the client-side loop is removed.
  - Manual **Set up mailboxes / Retry / Recreate** show the mailbox progress bar while running (poll `getDomainSetup` every 2 s during the mutation).

## 6. Keep-alive

- A Nitro plugin, `src/server/keep-alive.ts` (production only). It runs at boot and then every 12 h:
  - `select 1` through the app's database connection;
  - if `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, a `GET {SUPABASE_URL}/rest/v1/` with those headers.
- The results (last OK time, last error) are kept in memory. `getKeepAliveStatus` (admin) returns them, and Settings shows "Database keep-alive: last ping N h ago (every 12 h)" for the admin.

## 7. Testing

- **Pure unit tests:**
  - setup-state helpers: new state from a step, merge, board summary, status text;
  - mailbox-progress helpers: percent, moving-average rate, time left, formatting;
  - `serverDecision`: every branch;
  - the per-server lock;
  - `runDomainSetup` with fake steps: order, skipping done steps, starting from a step, waiting on a choice, failure marks the step and rethrows, resume after failure;
  - `runMailboxCreation` progress callbacks.
- **Local build check (no real servers touched):**
  - a throwaway account with a `.invalid` domain;
  - start its setup: the DNS step fails (no Cloudflare zone), the board shows Needs attention with the reason, Retry queues again;
  - the wizard redirect goes to the job page.
- **Standard gates:** tsc, vitest, build, the bundle-leak grep, and the existing `scripts/accounts-e2e.ts`.
