-- Deliverability checks Phase 2: append-only health-check history for trends.
-- Apply with `npm run db:push` (schema-driven) or run this SQL directly (psql). Idempotent.

CREATE TABLE IF NOT EXISTS "health_history" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "scope" text NOT NULL,
  "target_key" text NOT NULL,
  "target_name" text,
  "status" text NOT NULL,
  "score" integer NOT NULL DEFAULT 0,
  "indicators" jsonb,
  "checked_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "health_history_target_idx"
  ON "health_history" ("user_id", "scope", "target_key", "checked_at");
