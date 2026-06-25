// @ts-ignore - drizzle-orm exports drizzle from the postgres module
import { drizzle } from "drizzle-orm/postgres-js";
// @ts-ignore
import postgres from "postgres";
import * as schema from "./schema";

// Check if Database is properly configured
function hasDbConfig(customUrl?: string): boolean {
  if (customUrl) return true;
  const url = process.env.DATABASE_URL || process.env.SUPABASE_URL;

  // Check for presence and not placeholder values
  return !!(
    url &&
    (url.startsWith("postgres://") || url.startsWith("postgresql://")) &&
    !url.includes("your-database-url")
  );
}

// Map to hold connection pools per URL
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbInstances = new Map<string, any>();

export function getDb(customDbUrl?: string): any {
  const isCustom = !!customDbUrl;
  let dbUrl = customDbUrl || process.env.DATABASE_URL || process.env.SUPABASE_URL!;

  // Check for valid configuration
  if (!isCustom && !hasDbConfig()) {
    throw new Error(
      "❌ Database connection string not found!\n" +
        "Please set DATABASE_URL in your environment variables.\n" +
        "Format: postgresql://postgres.[project-id]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres",
    );
  }

  // Fix: If the password contains '#' it must be encoded as '%23' for the URL to be valid
  if (dbUrl.includes("#") && !dbUrl.includes("%23")) {
    dbUrl = dbUrl.replace(/#/, "%23");
  }

  // Reuse connection per URL (postgres pools connections automatically)
  if (!dbInstances.has(dbUrl)) {
    // Use SSL for production, disable for local development
    const isLocal = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1");

    const sql = postgres(dbUrl, {
      ssl: isLocal ? false : "require",
      // REQUIRED for Supabase Transaction Pooler (port 6543)
      prepare: false,
      // Add connection timeout to prevent hanging
      connect_timeout: 10,
      // Connection timeout for queries
      idle_timeout: 20,
      // Maximum connections in pool (keep it low for serverless)
      max: 1,
    });

    dbInstances.set(dbUrl, drizzle({ client: sql, schema }));
  }

  return dbInstances.get(dbUrl);
}

// Export types
export type SupabaseDb = ReturnType<typeof getDb>;
