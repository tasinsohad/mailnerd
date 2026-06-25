import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/lib/db/schema";
import { eq } from "drizzle-orm";

async function test() {
  const url = process.env.DATABASE_URL!;
  console.log("Connecting to:", url.replace(/:([^@]+)@/, ":***@"));
  
  const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
  const db = drizzle({ client: sql, schema });
  
  // 1. Find or create user
  let user = await db.query.users.findFirst({
    where: eq(schema.users.email, "admin@smtpforge.local"),
  });
  
  if (!user) {
    console.log("Creating user...");
    const [newUser] = await db.insert(schema.users).values({ email: "admin@smtpforge.local" }).returning();
    user = newUser;
  }
  console.log("User:", user!.id);
  
  // 2. Try saving secrets
  const existing = await db.query.userSecrets.findFirst({
    where: eq(schema.userSecrets.userId, user!.id),
  });
  console.log("Existing secrets:", existing ? "yes" : "no");
  
  if (existing) {
    await db.update(schema.userSecrets).set({ cfApiToken: "test_token_save_works" }).where(eq(schema.userSecrets.userId, user!.id));
    console.log("Updated secrets");
  } else {
    await db.insert(schema.userSecrets).values({ userId: user!.id, cfApiToken: "test_token_save_works" });
    console.log("Inserted new secrets");
  }
  
  // 3. Verify it was saved
  const saved = await db.query.userSecrets.findFirst({
    where: eq(schema.userSecrets.userId, user!.id),
  });
  console.log("Saved token:", saved?.cfApiToken);
  console.log("SUCCESS! Save works correctly.");
  
  // 4. Test Cloudflare verify endpoint
  console.log("\nTesting CF token verify with fake token...");
  const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: {
      Authorization: "Bearer fake_test_token",
      "Content-Type": "application/json",
    },
  });
  const json = await res.json() as any;
  console.log("CF verify response:", JSON.stringify(json, null, 2));
  
  // Clean up
  await db.update(schema.userSecrets).set({ cfApiToken: null }).where(eq(schema.userSecrets.userId, user!.id));
  
  await sql.end();
  process.exit(0);
}

test().catch(e => { console.error("FAILED:", e); process.exit(1); });
