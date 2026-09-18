-- Lifetime plans: an account with plan_lifetime = true never expires (plan_ends_at stays null). The admin can
-- still suspend it. Additive and idempotent; the running release ignores the column.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS plan_lifetime boolean NOT NULL DEFAULT false;
