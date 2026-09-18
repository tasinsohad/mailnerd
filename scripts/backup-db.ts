// Full backup of every table in the public schema: one JSON file per table plus counts.json.
// Run before any schema change:  npx tsx scripts/backup-db.ts <output-dir>
// The files hold plain-text credentials (SSH passwords, API keys), so the output must be outside the repo.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const repo = fileURLToPath(new URL("..", import.meta.url));
process.loadEnvFile(join(repo, ".env"));

const outArg = process.argv[2];
if (!outArg) {
  console.error("Usage: npx tsx scripts/backup-db.ts <output-dir>");
  process.exit(1);
}
const outDir = resolve(outArg);
if (outDir.toLowerCase().startsWith(resolve(repo).toLowerCase())) {
  console.error("Write the backup outside the repository: it contains credentials.");
  process.exit(1);
}

let url = process.env.DATABASE_URL ?? "";
if (url.includes("#") && !url.includes("%23")) url = url.replace(/#/, "%23"); // same fix as src/lib/db
const sql = postgres(url, { prepare: false, max: 1, ssl: "require" });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(outDir, `mailnerd-${stamp}`);
mkdirSync(dir, { recursive: true });

const tables = await sql<{ tablename: string }[]>`
  select tablename from pg_tables where schemaname = 'public' order by tablename`;
const counts: Record<string, number> = {};
for (const { tablename } of tables) {
  const rows = await sql.unsafe(`select * from public."${tablename}"`);
  const file = join(dir, `${tablename}.json`);
  writeFileSync(file, JSON.stringify(rows));
  const readBack = JSON.parse(readFileSync(file, "utf8")) as unknown[];
  if (readBack.length !== rows.length) {
    throw new Error(`${tablename}: wrote ${rows.length} rows but read back ${readBack.length}`);
  }
  counts[tablename] = rows.length;
}
writeFileSync(join(dir, "counts.json"), JSON.stringify(counts, null, 2));
console.log(`Backed up ${tables.length} tables to ${dir}`);
for (const [table, n] of Object.entries(counts)) console.log(`  ${table}: ${n}`);
await sql.end();
