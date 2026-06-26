import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL!;
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });

try {
  const doms = await sql`SELECT * FROM domains`;
  console.log("=== DOMAINS ===");
  console.dir(doms, { depth: null });
} catch (err: any) {
  console.error("Error:", err.message);
} finally {
  await sql.end();
  process.exit(0);
}
