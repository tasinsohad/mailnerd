// End-to-end check of accounts against a running production build (plan Task 12):
//  1. Isolation (needs the server's SESSION_SECRET, so local only): throwaway account B calls every server
//     function that takes an id, with throwaway account A's ids. Nothing of A's may come back and none of A's
//     rows may change. Positive controls prove A, B and the admin still see what they should.
//  2. Account flow (local or live): sign up, wait for approval, activate, empty workspace, suspend, reset password,
//     change password, plan expiry. Signs in through the real login function.
// Everything it creates is deleted at the end, even when a check fails.
//
//   Local: SESSION_SECRET=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx scripts/accounts-e2e.ts http://127.0.0.1:3101
//   Live:  ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx scripts/accounts-e2e.ts https://mail.nxtcloudsystems.com --flow-only
// Server-function ids are read from .output/server, so build the same code the target runs first.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray } from "drizzle-orm";
import { toJSONAsync } from "seroval";
import * as schema from "../src/lib/db/schema";
import { createAccountToken } from "../src/server/accounts-core";

const repo = fileURLToPath(new URL("..", import.meta.url));
process.loadEnvFile(join(repo, ".env"));

const base = (process.argv[2] ?? "").replace(/\/$/, "");
const flowOnly = process.argv.includes("--flow-only");
const { SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (!base || !ADMIN_EMAIL || !ADMIN_PASSWORD || (!flowOnly && !SESSION_SECRET)) {
  console.error(
    "Usage: SESSION_SECRET=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx scripts/accounts-e2e.ts <base-url> [--flow-only]",
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

function sessionCookie(setCookie: string[]): string {
  const found = setCookie.find((c) => c.startsWith("mn_session="));
  if (!found) throw new Error("The server didn't set a session cookie");
  return found.split(";")[0];
}
const isSignedOut = (text: string) => !/"(ok|pending|expired|suspended)"/.test(text);

// ---------- cleanup ----------

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

async function adminRow() {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.role, "admin"));
  if (!row) throw new Error("No admin row: run the accounts migration first.");
  return row;
}

// ---------- 1. isolation ----------

async function isolation(created: string[]) {
  const active = { role: "user", status: "active", planName: "e2e", planEndsAt: new Date(Date.now() + 86_400_000) };
  const [a] = await db.insert(schema.users).values({ email: `iso-a-${tag}@example.invalid`, name: `Iso A ${tag}`, ...active }).returning();
  created.push(a.id);
  const [b] = await db.insert(schema.users).values({ email: `iso-b-${tag}@example.invalid`, name: `Iso B ${tag}`, ...active }).returning();
  created.push(b.id);

  const domainName = `iso-a-${tag}.invalid`;
  const [template] = await db.insert(schema.jobTemplates).values({ userId: a.id, name: `iso-template-${tag}` }).returning();
  const [batch] = await db.insert(schema.domainBatches).values({ userId: a.id, name: `iso-batch-${tag}`, templateId: template.id }).returning();
  const [domA] = await db
    .insert(schema.domains)
    .values({ userId: a.id, batchId: batch.id, name: domainName, ipAddress: "192.0.2.10", sshUser: "root", sshPassword: `iso-ssh-secret-${tag}` })
    .returning();
  await db.insert(schema.domains).values({ userId: b.id, name: `iso-b-${tag}.invalid` });
  const [planA] = await db.insert(schema.domainPlans).values({ userId: a.id, domainId: domA.id, totalInboxes: 1, subdomainCount: 1 }).returning();
  await db.insert(schema.plannedInboxes).values({
    userId: a.id,
    domainId: domA.id,
    planId: planA.id,
    subdomainPrefix: "web",
    subdomainFqdn: `web.${domainName}`,
    localPart: "iso",
    email: `iso@web.${domainName}`,
    password: `iso-mailbox-secret-${tag}`,
    status: "active",
  });
  await db.insert(schema.dnsRecords).values({ userId: a.id, domainId: domA.id, type: "TXT", name: "iso", content: `iso-record-${tag}` });
  await db.insert(schema.userSecrets).values({ userId: a.id, cfApiToken: `iso-cf-token-${tag}-0123456789` });
  const [serverA] = await db
    .insert(schema.servers)
    .values({ userId: a.id, label: `iso-server-${tag}`, hostname: `srv.${domainName}`, ipAddress: "192.0.2.11", sshPassword: `iso-server-secret-${tag}` })
    .returning();
  await db.insert(schema.cloudflareZones).values({ userId: a.id, zoneId: `iso-zone-${tag}`, name: domainName });

  const markers = [
    domainName,
    `iso-record-${tag}`,
    `iso-mailbox-secret-${tag}`,
    `iso-cf-token-${tag}`,
    `iso-server-${tag}`,
    `iso-template-${tag}`,
    `iso-zone-${tag}`,
    `iso-batch-${tag}`,
    `iso-ssh-secret-${tag}`,
  ];
  const leaked = (text: string) => markers.filter((m) => text.includes(m));

  const config = { email: ADMIN_EMAIL!, password: ADMIN_PASSWORD!, secret: SESSION_SECRET! };
  const cookieA = `mn_session=${createAccountToken({ accountId: a.id, version: 1, admin: false }, config)}`;
  const cookieB = `mn_session=${createAccountToken({ accountId: b.id, version: 1, admin: false }, config)}`;
  const admin = await adminRow();
  const cookieAdmin = `mn_session=${createAccountToken({ accountId: admin.id, version: admin.sessionVersion, admin: true }, config)}`;

  // Positive controls: owners see their own data, so a clean result below means something.
  check((await call("listDomains", "GET", {}, cookieA)).text.includes(domainName), "A sees A's domain");
  check((await call("listDomains", "GET", {}, cookieB)).text.includes(`iso-b-${tag}.invalid`), "B sees B's domain");

  const reads: [string, "GET" | "POST", unknown][] = [
    ["listDomains", "GET", {}],
    ["getDomain", "GET", { id: domA.id }],
    ["getDomainDetails", "GET", { id: domA.id }],
    ["getBatchDetails", "GET", { id: batch.id }],
    ["listDomainBatches", "GET", {}],
    ["listDomainPlans", "GET", {}],
    ["getDomainPlan", "GET", { domainId: domA.id }],
    ["listPlannedInboxes", "GET", { domainId: domA.id }],
    ["getInboxExport", "GET", { domainId: domA.id }],
    ["getInboxExport", "GET", {}],
    ["getSubdomainExport", "GET", { domainId: domA.id }],
    ["getSubdomainExport", "GET", { batchId: batch.id }],
    // listDnsRecords (src/server/dns.ts) is never imported by the app, so the build tree-shakes it out
    // entirely: it has no id in .output/server and can't be invoked over HTTP at all. getDomainDetails
    // below already returns a domain's DNS records, so leakage through that shape is still covered.
    ["getSecrets", "GET", {}],
    ["getCfZones", "GET", {}],
    ["listServers", "GET", {}],
    ["listJobTemplates", "GET", {}],
    ["getOverviewStats", "GET", {}],
    ["getHealthOverview", "GET", {}],
    ["getBatchServerHealth", "GET", { batchId: batch.id }],
  ];
  for (const [name, method, data] of reads) {
    const found = leaked((await call(name, method, data, cookieB)).text);
    check(found.length === 0, `B ${name} ${JSON.stringify(data)} shows nothing of A's${found.length ? `: ${found.join(", ")}` : ""}`);
  }

  const spoof = await call("listDomains", "GET", {}, `${cookieB}; mn_workspace=${a.id}`);
  check(leaked(spoof.text).length === 0, "B can't open A's workspace with a forged mn_workspace cookie");

  const domBefore = await db.query.domains.findFirst({ where: eq(schema.domains.id, domA.id) });

  const writes: [string, unknown][] = [
    ["updateDomain", { id: domA.id, ipAddress: "192.0.2.99" }],
    // createDnsRecord (src/server/dns.ts) is likewise dead code, absent from .output/server (see the
    // listDnsRecords note above); DNS-record writes actually reachable from the app go through
    // regeneratePlan / pushDnsToCloudflare / repairDomainDns below, which are tested.
    ["regeneratePlan", { domainId: domA.id, totalInboxes: 1, prefixes: ["web"], names: ["Hi Jack"] }],
    ["saveJobTemplate", { id: template.id, name: "hijack", subdomainPrefixes: ["web"], personNames: ["Hi Jack"] }],
    ["createDomainBatch", { name: `iso-b-batch-${tag}`, templateId: template.id }],
    ["resetDomainMailboxPasswords", { domainId: domA.id }],
    ["setupMailcowDomain", { domainId: domA.id }],
    ["provisionServer", { domainId: domA.id }],
    ["testSshConnection", { domainId: domA.id }],
    ["resetMailcowAdminPassword", { domainId: domA.id }],
    ["pushDnsToCloudflare", { domainId: domA.id }],
    ["batchPushDnsToCloudflare", { domainId: domA.id }],
    ["repairDomainDns", { domainId: domA.id }],
    ["fetchDkimAndSync", { domainId: domA.id }],
    ["runDomainHealth", { domainId: domA.id }],
    ["runJobHealth", { batchId: batch.id }],
    ["runJobRemediation", { batchId: batch.id }],
    ["restartMailcowForDomain", { domainId: domA.id }],
    ["createApiKeyForDomain", { domainId: domA.id }],
    ["deleteJobTemplate", { id: template.id }],
    ["deleteServer", { id: serverA.id }],
    ["deleteDomainBatch", { id: batch.id }],
    ["deleteDomain", { id: domA.id }],
  ];
  for (const [name, data] of writes) {
    const found = leaked((await call(name, "POST", data, cookieB)).text);
    check(found.length === 0, `B ${name} on A's ids reveals nothing${found.length ? `: ${found.join(", ")}` : ""}`);
  }

  // None of A's rows changed.
  const domAfter = await db.query.domains.findFirst({ where: eq(schema.domains.id, domA.id) });
  check(JSON.stringify(domAfter) === JSON.stringify(domBefore), "A's domain row is unchanged (every column)");
  const aHealth = await db.select().from(schema.serverHealth).where(eq(schema.serverHealth.userId, a.id));
  const aHistory = await db.select().from(schema.healthHistory).where(eq(schema.healthHistory.userId, a.id));
  check(aHealth.length === 0 && aHistory.length === 0, "no health checks ran on A's servers");
  const records = await db.select().from(schema.dnsRecords).where(eq(schema.dnsRecords.domainId, domA.id));
  check(records.length === 1 && records[0].name === "iso", "A's DNS records are unchanged (nothing added by B)");
  const inboxes = await db.select().from(schema.plannedInboxes).where(eq(schema.plannedInboxes.domainId, domA.id));
  check(inboxes.length === 1 && inboxes[0].password === `iso-mailbox-secret-${tag}`, "A's mailbox and its password are unchanged");
  const planAfter = await db.query.domainPlans.findFirst({ where: eq(schema.domainPlans.id, planA.id) });
  check(planAfter?.totalInboxes === 1, "A's plan is unchanged");
  const templateAfter = await db.query.jobTemplates.findFirst({ where: eq(schema.jobTemplates.id, template.id) });
  check(templateAfter?.name === `iso-template-${tag}`, "A's template is unchanged");
  check(Boolean(await db.query.servers.findFirst({ where: eq(schema.servers.id, serverA.id) })), "A's server still exists");
  check(Boolean(await db.query.domainBatches.findFirst({ where: eq(schema.domainBatches.id, batch.id) })), "A's job still exists");
  const bBatches = await db.select().from(schema.domainBatches).where(eq(schema.domainBatches.userId, b.id));
  check(bBatches.every((x) => x.templateId !== template.id), "B couldn't link A's template to a job");

  // Live setup logs.
  const sseB = await fetch(`${base}/api/sse?domainId=${domA.id}`, { headers: { cookie: cookieB } });
  check(sseB.status === 403, `B can't stream A's setup log (HTTP ${sseB.status})`);
  await sseB.body?.cancel();
  const sseA = await fetch(`${base}/api/sse?domainId=${domA.id}`, { headers: { cookie: cookieA } });
  check(sseA.status === 200, `A can stream A's setup log (HTTP ${sseA.status})`);
  await sseA.body?.cancel();

  // Admin-only functions refuse a user.
  const adminOnly: [string, "GET" | "POST", unknown][] = [
    ["listUsers", "GET", {}],
    ["listWorkspaces", "GET", {}],
    ["applyPlan", "POST", { userId: b.id, choice: { preset: "12m" } }],
    ["setWorkspace", "POST", { userId: a.id }],
    ["setSuspended", "POST", { userId: a.id, suspended: true }],
    ["resetUserPassword", "POST", { userId: a.id }],
    ["rejectSignup", "POST", { userId: a.id }],
  ];
  for (const [name, method, data] of adminOnly) {
    check((await call(name, method, data, cookieB)).text.includes("FORBIDDEN"), `B is refused ${name}`);
  }
  const [aRow] = await db.select().from(schema.users).where(eq(schema.users.id, a.id));
  check(aRow?.status === "active" && aRow?.sessionVersion === 1, "B's refused admin-only calls left A's account untouched");

  // The admin: Nextus doesn't show A's data; A's workspace does; Nextus lists every one of its domains.
  const adminOwn = await call("listDomains", "GET", {}, cookieAdmin);
  check(leaked(adminOwn.text).length === 0, "the admin's own (Nextus) workspace doesn't show A's data");
  check((await call("listDomains", "GET", {}, `${cookieAdmin}; mn_workspace=${a.id}`)).text.includes(domainName), "the admin sees A's data in A's workspace");
  const nextus = await db.select({ id: schema.domains.id }).from(schema.domains).where(eq(schema.domains.userId, admin.id));
  // One "batchName" key per domain row in the serialized list. If this ever misfires, print adminOwn.text.slice(0, 600).
  check((adminOwn.text.match(/"batchName"/g) ?? []).length === nextus.length, `the Nextus workspace lists all ${nextus.length} of its domains`);
}

// ---------- 2. account flow ----------

async function flow(created: string[]) {
  const email = `e2e-${tag}@example.invalid`;
  const password = `e2e-password-${tag}`;
  const admin = await adminRow();

  const signup = await call("signup", "POST", { name: `E2E ${tag}`, email, password, confirmPassword: password });
  const [row] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (row) created.push(row.id);
  check(row?.status === "pending", "sign-up creates a pending account");
  let cookieC = sessionCookie(signup.setCookie);
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"pending"'), "a new account sees 'waiting for approval'");
  check((await call("listDomains", "GET", {}, cookieC)).text.includes("ACCOUNT_LOCKED"), "a pending account can't use the app");
  const dup = await call("signup", "POST", { name: "Dup", email: email.toUpperCase(), password, confirmPassword: password });
  check(dup.text.includes("An account with this email already exists."), "the same email can't sign up twice");

  const cookieAdmin = sessionCookie((await call("login", "POST", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).setCookie);
  check((await call("listUsers", "GET", {}, cookieAdmin)).text.includes(email), "the admin sees the sign-up");
  await call("applyPlan", "POST", { userId: row.id, choice: { preset: "trial-7d" } }, cookieAdmin);
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"ok"'), "activation lets the account in");
  const [nextusDomain] = await db.select({ name: schema.domains.name }).from(schema.domains).where(eq(schema.domains.userId, admin.id)).limit(1);
  const own = await call("listDomains", "GET", {}, cookieC);
  check(!own.text.includes("ACCOUNT_LOCKED") && (!nextusDomain || !own.text.includes(nextusDomain.name)), "an activated account starts with an empty workspace");

  await call("setSuspended", "POST", { userId: row.id, suspended: true }, cookieAdmin);
  check(isSignedOut((await call("getSession", "GET", {}, cookieC)).text), "suspending signs the account out everywhere");
  cookieC = sessionCookie((await call("login", "POST", { email, password })).setCookie);
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"suspended"'), "a suspended account sees 'suspended'");
  await call("setSuspended", "POST", { userId: row.id, suspended: false }, cookieAdmin);

  const reset = await call("resetUserPassword", "POST", { userId: row.id }, cookieAdmin);
  const temp = reset.text.match(/[A-HJ-NP-Za-km-z2-9]{16}/)?.[0] ?? "";
  check(temp.length === 16 && isSignedOut((await call("getSession", "GET", {}, cookieC)).text), "a password reset signs the account out");
  cookieC = sessionCookie((await call("login", "POST", { email, password: temp })).setCookie);
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"ok"'), "the temporary password works");
  check((await call("login", "POST", { email, password })).text.includes("Wrong email or password."), "the old password stops working");

  const changed = await call("changePassword", "POST", { currentPassword: temp, newPassword: password, confirmPassword: password }, cookieC);
  cookieC = sessionCookie(changed.setCookie);
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"ok"'), "changing the password keeps this session signed in");

  await db.update(schema.users).set({ planEndsAt: new Date(Date.now() - 60_000) }).where(eq(schema.users.id, row.id));
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"expired"'), "an ended plan locks the account");
  check((await call("listDomains", "GET", {}, cookieC)).text.includes("ACCOUNT_LOCKED"), "an expired account can't use the app");
  const sseLocked = await fetch(`${base}/api/sse?runId=00000000-0000-4000-8000-000000000000`, { headers: { cookie: cookieC } });
  check(sseLocked.status === 403, `a locked account can't open live streams (HTTP ${sseLocked.status})`);
  await sseLocked.body?.cancel();
  await call("applyPlan", "POST", { userId: row.id, choice: { days: 3 } }, cookieAdmin);
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"ok"'), "extending the plan brings the account back");

  // Lifetime: no end date, never expires; switching back to a timed plan starts from today.
  await call("applyPlan", "POST", { userId: row.id, choice: { lifetime: true } }, cookieAdmin);
  const [lifetimeRow] = await db.select().from(schema.users).where(eq(schema.users.id, row.id));
  check(lifetimeRow?.planLifetime === true && lifetimeRow?.planEndsAt === null, "a lifetime plan is stored with no end date");
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"ok"'), "a lifetime account can use the app");
  await call("setSuspended", "POST", { userId: row.id, suspended: true }, cookieAdmin);
  cookieC = sessionCookie((await call("login", "POST", { email, password })).setCookie);
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"suspended"'), "a lifetime account can still be suspended");
  await call("setSuspended", "POST", { userId: row.id, suspended: false }, cookieAdmin);
  cookieC = sessionCookie((await call("login", "POST", { email, password })).setCookie);
  await call("applyPlan", "POST", { userId: row.id, choice: { preset: "1m" } }, cookieAdmin);
  const [timedRow] = await db.select().from(schema.users).where(eq(schema.users.id, row.id));
  check(timedRow?.planLifetime === false && timedRow?.planEndsAt instanceof Date, "switching back to a timed plan sets an end date again");
  check((await call("getSession", "GET", {}, cookieC)).text.includes('"ok"'), "the account keeps working on the timed plan");
}

// ---------- run ----------

const created: string[] = [];
try {
  if (!flowOnly) {
    console.log("== Isolation");
    await isolation(created);
  }
  console.log("== Account flow");
  await flow(created);
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
