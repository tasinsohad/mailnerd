// @ts-ignore - drizzle-orm exports drizzle from the postgres module
import { drizzle } from "drizzle-orm/postgres-js";
// @ts-ignore
import postgres from "postgres";
import * as schema from "./schema";

// Check if Database is properly configured
function hasDbConfig(): boolean {
  const url = process.env.DATABASE_URL;

  // Check for presence and not placeholder values
  return !!(
    url &&
    (url.startsWith("postgres://") || url.startsWith("postgresql://")) &&
    !url.includes("your-database-url")
  );
}

// Singleton DB instance for serverless
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dbInstance: any = null;

export function getDb(): any {
  // Check for valid configuration
  if (!hasDbConfig()) {
    // If DATABASE_URL is missing, we try to use SUPABASE_URL if it looks like a connection string
    const fallbackUrl = process.env.SUPABASE_URL;
    if (
      !fallbackUrl ||
      (!fallbackUrl.startsWith("postgres://") && !fallbackUrl.startsWith("postgresql://"))
    ) {
      throw new Error(
        "❌ Database connection string not found!\n" +
          "Please set DATABASE_URL in your environment variables.\n" +
          "Format: postgresql://postgres.[project-id]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres",
      );
    }
  }

  // Reuse singleton connection (postgres pools connections automatically)
  if (!dbInstance) {
    let dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_URL!;

    // Fix: If the password contains '#' it must be encoded as '%23' for the URL to be valid
    // This is a common issue with Supabase pooler passwords.
    if (dbUrl.includes("#") && !dbUrl.includes("%23")) {
      dbUrl = dbUrl.replace(/#/, "%23");
    }

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

    dbInstance = drizzle(sql, { schema });
  }

  return dbInstance;
}

// Export types
export type SupabaseDb = ReturnType<typeof getDb>;
