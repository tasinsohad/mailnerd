import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL!;
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });

try {
  const columns = await sql`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'domains'
  `;
  console.log("=== DOMAINS COLUMNS ===");
  console.dir(columns, { depth: null });
} catch (err: any) {
  console.error("Error:", err.message);
} finally {
  await sql.end();
  process.exit(0);
}
