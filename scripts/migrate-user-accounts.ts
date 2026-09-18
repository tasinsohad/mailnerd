// Applies the accounts migrations (MIGRATIONS below, in order) in one transaction (safe to re-run), then
// checks every table still has the rows the backup recorded.
//
//   npx tsx scripts/migrate-user-accounts.ts --compare <backup-dir>/counts.json
//   npx tsx scripts/migrate-user-accounts.ts --set-admin-email you@example.com     (after deploying)
//
// --set-admin-email renames the admin row to the live ADMIN_EMAIL. Run it only AFTER the accounts release is
// deployed: the release before it finds its data by the old internal email, and would create an empty
// account if that email disappeared.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const repo = fileURLToPath(new URL("..", import.meta.url));
process.loadEnvFile(join(repo, ".env"));

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

let url = process.env.DATABASE_URL ?? "";
if (url.includes("#") && !url.includes("%23")) url = url.replace(/#/, "%23");
const sql = postgres(url, { prepare: false, max: 1, ssl: "require" });

const adminEmail = flag("--set-admin-email");
if (adminEmail) {
  const email = adminEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Not an email address: ${adminEmail}`);
  const clash = await sql`select id from public.users where lower(email) = ${email} and role <> 'admin'`;
  if (clash.length) throw new Error(`Another account already uses ${email}; not renaming the admin.`);
  const updated = await sql`update public.users set email = ${email} where role = 'admin' returning id`;
  if (updated.length === 0) throw new Error("No admin row found: run the migration first.");
  console.log(`Admin account now uses ${email}.`);
} else {
  const MIGRATIONS = ["20260918100000_user_accounts.sql", "20260918200000_lifetime_plans.sql"];
  await sql.begin(async (tx) => {
    for (const file of MIGRATIONS) await tx.unsafe(readFileSync(join(repo, "supabase/migrations", file), "utf8"));
  });
  console.log("Migration applied.");
}

const [admin] = await sql`select id, email, name, role, status from public.users where role = 'admin'`;
if (!admin) {
  await sql.end();
  throw new Error("Admin row missing after the migration.");
}
console.log(`Admin row: ${admin.id} (${admin.name}, ${admin.status})`);

const comparePath = flag("--compare");
if (comparePath) {
  const expected = JSON.parse(readFileSync(comparePath, "utf8")) as Record<string, number>;
  let mismatches = 0;
  for (const [table, n] of Object.entries(expected)) {
    const [{ count }] = await sql.unsafe(`select count(*)::int as count from public."${table}"`);
    const ok = count === n;
    if (!ok) mismatches++;
    console.log(`${ok ? "ok  " : "DIFF"} ${table}: backup ${n}, now ${count}`);
  }
  if (mismatches) {
    await sql.end();
    throw new Error(`${mismatches} table(s) differ from the backup.`);
  }
}
const rls = await sql`select count(*)::int as off from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`;
console.log(`Tables without row level security: ${rls[0].off}`);
await sql.end();
