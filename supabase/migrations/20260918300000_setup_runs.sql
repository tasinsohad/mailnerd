-- Server-side setup runs (docs/superpowers/specs/2026-09-18-job-setup-automation-design.md). Additive, idempotent.
ALTER TABLE public.domains ADD COLUMN IF NOT EXISTS setup_state jsonb;
ALTER TABLE public.domains ADD COLUMN IF NOT EXISTS mailbox_progress jsonb;
