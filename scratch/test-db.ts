import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL!;
console.log("Testing:", url.replace(/:([^:@]+)@/, ":***@"));

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 5 });

try {
  const rows = await sql`SELECT 1 as ok`;
  console.log("✅ DB connection OK:", rows);
} catch (e: any) {
  console.error("❌ DB FAIL:", e.message);
} finally {
  await sql.end();
  process.exit(0);
}
