-- Add ipAddress and sshUser to domains table
ALTER TABLE public.domains
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS ssh_user text;