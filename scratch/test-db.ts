import postgres from "postgres";

async function test() {
  console.log("Connecting...");
  const sql = postgres(
    "postgresql://postgres.zwiyljbvkshihrxkkxdm:lcSGMDWWWLYseZux@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres",
    { ssl: "require" }
  );
  
  try {
    const res = await sql`SELECT 1`;
    console.log("Success:", res);
  } catch (e: any) {
    console.error("Connection failed:", e.message);
  } finally {
    process.exit(0);
  }
}

test();
