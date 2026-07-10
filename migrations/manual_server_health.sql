-- Deliverability checks Phase 1: per-server (VPS/IP) health snapshot.
-- Apply with `npm run db:push` (schema-driven) or run this SQL directly (psql).
-- Idempotent.

CREATE TABLE IF NOT EXISTS "server_health" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "ip_address" text NOT NULL,
  "mailcow_hostname" text,
  "health" jsonb,
  "checked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "server_health_user_ip_uniq"
  ON "server_health" ("user_id", "ip_address");
