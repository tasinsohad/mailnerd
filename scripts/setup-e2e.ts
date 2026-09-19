// End-to-end check of setup runs against a running production build (plan Task 11 of the batch-provisioning-
// reliability work): one throwaway account, one domain, no Cloudflare token or zone — so its DNS step always
// fails, before any SSH is attempted. Exercises every server function in src/server/domain-setup-fns.ts:
//   - startJobSetup({ batchId }) starts the one domain; a second call retries it after it failed.
//   - startDomainSetup refuses while a run is active (the busy message).
//   - decideServerChoice refuses on a domain that isn't waiting for a server choice.
//   - getJobSetupBoard / getDomainSetup show the run's progress; another account's cookie sees none of it.
// Everything it creates is deleted at the end, even when a check fails, so no stale setup_state is left for
// the live VPS's reconcile (src/server/domain-setup.ts reconcileStuckSetupRuns) to pick up.
//
//   Local only (needs the server's SESSION_SECRET to mint session cookies directly):
//   SESSION_SECRET=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx scripts/setup-e2e.ts http://127.0.0.1:3101
// Server-function ids are read from .output/server, so build the same code the target runs first.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { inArray } from "drizzle-orm";
import { toJSONAsync, fromCrossJSON } from "seroval";
import * as schema from "../src/lib/db/schema";
import { createAccountToken } from "../src/server/accounts-core";

const repo = fileURLToPath(new URL("..", import.meta.url));
process.loadEnvFile(join(repo, ".env"));

const base = (process.argv[2] ?? "").replace(/\/$/, "");
const { SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (!base || !ADMIN_EMAIL || !ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error(
    "Usage: SESSION_SECRET=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx scripts/setup-e2e.ts <base-url>",
  );
  process.exit(1);
}

let dbUrl = process.env.DATABASE_URL ?? "";
if (dbUrl.includes("#") && !dbUrl.includes("%23")) dbUrl = dbUrl.replace(/#/, "%23");
const client = postgres(dbUrl, { prepare: false, max: 1, ssl: "require" });
const db = drizzle({ client, schema });
const tag = randomBytes(4).toString("hex");
const failures: string[] = [];

function check(ok: boolean, label: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------- server functions over HTTP, the way the browser calls them ----------

function serverFnIds(): Map<string, string> {
  const ids = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".mjs")) {
        const text = readFileSync(path, "utf8");
        for (const m of text.matchAll(/createServerRpc\(\{\s*id:\s*"([0-9a-f]{64})",\s*name:\s*"(\w+)"/g)) {
          ids.set(m[2], m[1]);
        }
      }
    }
  };
  walk(join(repo, ".output/server"));
  return ids;
}
const fnIds = serverFnIds();

async function call(
  name: string,
  method: "GET" | "POST",
  data: unknown,
  cookie = "",
): Promise<{ status: number; text: string; setCookie: string[] }> {
  const id = fnIds.get(name);
  if (!id) throw new Error(`No server function named ${name} in .output/server. Rebuild first.`);
  const payload = JSON.stringify(await toJSONAsync({ data }));
  const headers: Record<string, string> = {
    "x-tsr-serverFn": "true",
    "sec-fetch-site": "same-origin",
    accept: "application/json",
  };
  if (cookie) headers.cookie = cookie;
  let target = `${base}/_serverFn/${id}`;
  let body: string | undefined;
  if (method === "GET") target += `?payload=${encodeURIComponent(payload)}`;
  else {
    body = payload;
    headers["content-type"] = "application/json";
  }
  const res = await fetch(target, { method, headers, body });
  return { status: res.status, text: await res.text(), setCookie: res.headers.getSetCookie() };
}

// The server wraps every response as seroval "cross" JSON ({result, error, context}). A normal return value
// (including an `{ ok: false, error }` refusal, which is a return value, not a thrown error) decodes cleanly.
// A genuinely thrown error (e.g. "Job not found") is tagged with a custom class ($TSR/Error) that needs a
// plugin we don't load here, so decode() returns undefined for it and callers fall back to a text search —
// the same thing accounts-e2e.ts does for its FORBIDDEN / "already exists" checks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decode(text: string): any {
  try {
    return fromCrossJSON(JSON.parse(text), { refs: new Map() });
  } catch {
    return undefined;
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function result(name: string, method: "GET" | "POST", data: unknown, cookie: string): Promise<any> {
  const res = await call(name, method, data, cookie);
  return decode(res.text)?.result;
}

// ---------- cleanup (same OWNED list as scripts/accounts-e2e.ts) ----------

const OWNED = [
  schema.plannedInboxes,
  schema.dnsRecords,
  schema.domainPlans,
  schema.healthHistory,
  schema.serverHealth,
  schema.rateLimits,
  schema.domains,
  schema.domainBatches,
  schema.jobTemplates,
  schema.servers,
  schema.cloudflareZones,
  schema.userSecrets,
];
async function deleteAccounts(ids: string[]) {
  if (!ids.length) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const table of OWNED) await db.delete(table).where(inArray((table as any).userId, ids));
  await db.delete(schema.users).where(inArray(schema.users.id, ids));
}

// ---------- poll the board until this domain's run finishes ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pollUntilFinished(batchId: string, domainId: string, cookie: string, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let row: any = null;
  for (;;) {
    const board = await result("getJobSetupBoard", "GET", { batchId }, cookie);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row = board?.domains?.find((d: any) => d.id === domainId) ?? null;
    const status = row?.setupState?.status;
    if (status === "failed" || status === "done" || status === "waiting") return row;
    if (Date.now() >= deadline) return row;
    await sleep(3000);
  }
}

// ---------- the check ----------

async function setupChecks(created: string[]) {
  const active = { role: "user", status: "active", planName: "e2e", planEndsAt: new Date(Date.now() + 86_400_000) };
  const [a] = await db.insert(schema.users).values({ email: `setup-${tag}@example.invalid`, name: `Setup ${tag}`, ...active }).returning();
  created.push(a.id);
  const [b] = await db.insert(schema.users).values({ email: `setup-other-${tag}@example.invalid`, name: `Setup Other ${tag}`, ...active }).returning();
  created.push(b.id);

  const domainName = `setup-${tag}.invalid`;
  const [batch] = await db.insert(schema.domainBatches).values({ userId: a.id, name: `setup-batch-${tag}` }).returning();
  const [domain] = await db
    .insert(schema.domains)
    .values({ userId: a.id, batchId: batch.id, name: domainName, ipAddress: "192.0.2.20", sshUser: "root", sshPassword: "x" })
    .returning();

  const config = { email: ADMIN_EMAIL!, password: ADMIN_PASSWORD!, secret: SESSION_SECRET! };
  const cookieA = `mn_session=${createAccountToken({ accountId: a.id, version: 1, admin: false }, config)}`;
  const cookieB = `mn_session=${createAccountToken({ accountId: b.id, version: 1, admin: false }, config)}`;

  // 1. Start the job: the one domain in it is started.
  const started1 = await result("startJobSetup", "POST", { batchId: batch.id }, cookieA);
  check(started1?.ok === true && started1?.started === 1 && started1?.skipped === 0, `startJobSetup starts the one domain (got ${JSON.stringify(started1)})`);

  // 2. While that run is active (the claim is taken synchronously, before the DNS step even starts):
  // startDomainSetup is refused with the busy message, and decideServerChoice is refused because the domain
  // isn't waiting for a server choice.
  const busy = await result("startDomainSetup", "POST", { domainId: domain.id }, cookieA);
  check(busy?.ok === false && /already running for this domain/.test(busy?.error ?? ""), `startDomainSetup refuses while a run is active (got ${JSON.stringify(busy)})`);
  const decideEarly = await result("decideServerChoice", "POST", { domainId: domain.id, choice: "reuse" }, cookieA);
  check(decideEarly?.ok === false && /isn't waiting for a server choice/.test(decideEarly?.error ?? ""), `decideServerChoice refuses a non-waiting domain while running (got ${JSON.stringify(decideEarly)})`);

  // 3. Poll the board (up to 120 s) until the run finishes. It must fail at the DNS step — this account has
  // no Cloudflare token or zone — and the server step must stay "pending": no SSH was ever attempted.
  const run1 = await pollUntilFinished(batch.id, domain.id, cookieA);
  const state1 = run1?.setupState;
  check(state1?.status === "failed", `run 1 fails (polled up to 120s), got status=${state1?.status}`);
  check(state1?.steps?.dns === "failed", `run 1's DNS step fails, got steps.dns=${state1?.steps?.dns}`);
  check(state1?.steps?.server === "pending", `run 1 never touches the server step (no SSH attempted), got steps.server=${state1?.steps?.server}`);
  check(typeof state1?.error === "string" && /cloudflare/i.test(state1.error), `run 1's error mentions Cloudflare (got ${JSON.stringify(state1?.error)})`);

  // Same row via getDomainSetup (the single-domain sibling of getJobSetupBoard).
  const single1 = await result("getDomainSetup", "GET", { domainId: domain.id }, cookieA);
  check(single1?.setupState?.runId === state1?.runId && single1?.setupState?.status === "failed", "getDomainSetup shows the same failed run as the board");

  // 4. startJobSetup again: the failed domain isn't "done" or already active, so it's a retry — started, not
  // skipped — and it fails the same way, with a fresh runId.
  const started2 = await result("startJobSetup", "POST", { batchId: batch.id }, cookieA);
  check(started2?.ok === true && started2?.started === 1 && started2?.skipped === 0, `startJobSetup retries the failed domain (got ${JSON.stringify(started2)})`);

  const run2 = await pollUntilFinished(batch.id, domain.id, cookieA);
  const state2 = run2?.setupState;
  check(state2?.status === "failed", `run 2 (the retry) also fails, got status=${state2?.status}`);
  check(state2?.runId !== state1?.runId, "run 2 is a fresh run (a different runId from run 1)");
  check(state2?.steps?.dns === "failed", `run 2's DNS step fails, got steps.dns=${state2?.steps?.dns}`);
  check(state2?.steps?.server === "pending", `run 2 never touches the server step either, got steps.server=${state2?.steps?.server}`);
  check(typeof state2?.error === "string" && /cloudflare/i.test(state2.error), `run 2's error mentions Cloudflare (got ${JSON.stringify(state2?.error)})`);

  // 5. decideServerChoice still refuses now that the run has failed (still not "waiting").
  const decideAfter = await result("decideServerChoice", "POST", { domainId: domain.id, choice: "reuse" }, cookieA);
  check(decideAfter?.ok === false && /isn't waiting for a server choice/.test(decideAfter?.error ?? ""), `decideServerChoice refuses a non-waiting (failed) domain (got ${JSON.stringify(decideAfter)})`);

  // 6. Another account's cookie: getJobSetupBoard on this batchId shows nothing of it (the lookup is scoped
  // by userId, so it doesn't find the job at all — no domain name, IP or setup state leaks into the response).
  const otherBoard = await call("getJobSetupBoard", "GET", { batchId: batch.id }, cookieB);
  const otherLeak = [domainName, "192.0.2.20"].filter((m) => otherBoard.text.includes(m));
  check(otherLeak.length === 0, `another account's getJobSetupBoard on this batch shows nothing of it${otherLeak.length ? `: ${otherLeak.join(", ")}` : ""}`);
  check(otherBoard.text.includes("Job not found"), "another account's getJobSetupBoard on this batch is refused (Job not found)");
  const otherSingle = await result("getDomainSetup", "GET", { domainId: domain.id }, cookieB);
  check(otherSingle === null || otherSingle === undefined, `another account's getDomainSetup on this domain returns nothing (got ${JSON.stringify(otherSingle)})`);
}

// ---------- run ----------

const created: string[] = [];
try {
  console.log("== Setup runs");
  await setupChecks(created);
} catch (err) {
  failures.push(`crashed: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  await deleteAccounts(created);
  const left = created.length ? await db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, created)) : [];
  console.log(`Cleaned up ${created.length} test account(s); ${left.length} left.`);
  await client.end();
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
