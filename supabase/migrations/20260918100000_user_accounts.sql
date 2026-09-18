-- User accounts: sign-up, admin approval and plans (docs/superpowers/specs/2026-09-18-user-accounts-design.md).
-- Additive and idempotent. The release before accounts ignores these columns, so this runs before deploying.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS plan_name text,
  ADD COLUMN IF NOT EXISTS plan_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'user'));
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE public.users ADD CONSTRAINT users_status_check CHECK (status IN ('pending', 'active', 'suspended'));

-- Exactly one admin, and emails unique regardless of case.
CREATE UNIQUE INDEX IF NOT EXISTS users_single_admin ON public.users (role) WHERE role = 'admin';
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON public.users (lower(email));

-- The internal record that owns all existing data becomes the Nextus admin account. Same id, so no row moves.
UPDATE public.users
SET role = 'admin', status = 'active', name = COALESCE(name, 'Nextus'), activated_at = COALESCE(activated_at, now())
WHERE email = 'admin@smtpforge.local';

-- Nobody holding Supabase's public anon key may read or change these tables (password hashes, SSH passwords).
-- The app connects as the table owner with BYPASSRLS, so it is unaffected. Undo per table:
--   ALTER TABLE public.<name> DISABLE ROW LEVEL SECURITY;
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
