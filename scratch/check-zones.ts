import "dotenv/config";
import { getDb } from "../src/lib/db";
import { domains } from "../src/lib/db/schema";
import { eq } from "drizzle-orm";

async function run() {
  const db = getDb();
  const domain = await db.query.domains.findFirst({
    where: eq(domains.id, "4ea95b91-4a17-49c8-945d-e0d31c09b6e1"),
  });
  console.log("Domain credentials:");
  console.log("IP:", domain?.ipAddress);
  console.log("User:", domain?.sshUser);
  console.log("Password length:", domain?.sshPassword?.length);
  console.log("Status:", domain?.status);
  process.exit(0);
}

run();
