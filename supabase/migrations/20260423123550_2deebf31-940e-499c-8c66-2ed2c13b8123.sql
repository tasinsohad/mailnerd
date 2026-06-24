-- 1. user_secrets: add default lists
ALTER TABLE public.user_secrets
  ADD COLUMN IF NOT EXISTS subdomain_prefixes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS person_names text[] NOT NULL DEFAULT '{}';

-- 2. domains: requested inbox count
ALTER TABLE public.domains
  ADD COLUMN IF NOT EXISTS planned_inbox_count integer;

-- 3. domain_plans
CREATE TABLE IF NOT EXISTS public.domain_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  domain_id uuid NOT NULL,
  total_inboxes integer NOT NULL,
  subdomain_count integer NOT NULL,
  status text NOT NULL DEFAULT 'planned',
  prefixes_snapshot text[] NOT NULL DEFAULT '{}',
  names_snapshot text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain_id)
);

ALTER TABLE public.domain_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "domain_plans_owner_all"
  ON public.domain_plans FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER domain_plans_set_updated_at
  BEFORE UPDATE ON public.domain_plans
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- 4. planned_inboxes
CREATE TABLE IF NOT EXISTS public.planned_inboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  domain_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  subdomain_prefix text NOT NULL,
  subdomain_fqdn text NOT NULL,
  local_part text NOT NULL,
  email text NOT NULL,
  person_name text,
  format text,
  status text NOT NULL DEFAULT 'planned',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS planned_inboxes_domain_idx ON public.planned_inboxes(domain_id);
CREATE INDEX IF NOT EXISTS planned_inboxes_plan_idx ON public.planned_inboxes(plan_id);

ALTER TABLE public.planned_inboxes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "planned_inboxes_owner_all"
  ON public.planned_inboxes FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER planned_inboxes_set_updated_at
  BEFORE UPDATE ON public.planned_inboxes
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();