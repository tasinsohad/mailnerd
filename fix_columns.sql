-- Add missing columns to planned_inboxes
ALTER TABLE planned_inboxes
ADD COLUMN IF NOT EXISTS full_name TEXT,
ADD COLUMN IF NOT EXISTS first_name TEXT,
ADD COLUMN IF NOT EXISTS last_name TEXT;

-- Verify job_templates columns exist (should be text[] arrays)
-- If they exist but are text type, convert them:
-- ALTER TABLE job_templates ALTER COLUMN subdomain_prefixes TYPE text[];
-- ALTER TABLE job_templates ALTER COLUMN person_names TYPE text[];