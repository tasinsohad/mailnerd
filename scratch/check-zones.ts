import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL!;
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });

try {
  const result = await sql`
    SELECT id, name, status, ip_address, ssh_user,
           LEFT(terminal_logs, 500) as log_preview
    FROM domains
    ORDER BY created_at DESC
  `;
  console.log("=== DOMAINS ===");
  console.dir(result, { depth: null });
} catch (err: any) {
  console.error("Error:", err.message);
} finally {
  await sql.end();
  process.exit(0);
}
