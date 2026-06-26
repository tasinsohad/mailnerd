import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL!;
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });

try {
  const zones = await sql`SELECT id, name, zone_id, status FROM cloudflare_zones`;
  console.log("=== CLOUDFLARE ZONES ===");
  console.log(zones);

  const doms = await sql`SELECT id, name, cf_zone_id, status FROM domains`;
  console.log("=== DOMAINS ===");
  console.log(doms);
} catch (err: any) {
  console.error("Error:", err.message);
} finally {
  await sql.end();
  process.exit(0);
}
