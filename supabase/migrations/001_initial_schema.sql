-- SMTP Forge Database Migration
-- Run this in Supabase SQL Editor to set up all tables
-- Drop existing tables if they exist (for fresh setup)

-- Drop tables in reverse order (foreign keys first)
drop table if exists dns_records cascade;
drop table if exists planned_inboxes cascade;
drop table if exists domain_plans cascade;
drop table if exists user_secrets cascade;
drop table if exists job_templates cascade;
drop table if exists domain_batches cascade;
drop table if exists domains cascade;
drop table if exists servers cascade;
drop table if exists rate_limits cascade;

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- 1. Servers table
create table servers (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) not null,
  label text,
  hostname text,
  ip_address text,
  ssh_user text,
  ssh_key text,
  status text default 'pending',
  setup_steps jsonb,
  created_at timestamptz default now()
);

-- 2. Domains table
create table domains (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) not null,
  name text unique not null,
  server_id uuid references servers(id),
  status text default 'pending',
  cf_zone_id text,
  cf_account_id text,
  mailcow_hostname text,
  mailcow_api_key text,
  planned_inbox_count int,
  batch_id uuid,
  created_at timestamptz default now()
);

-- 3. DNS Records table
create table dns_records (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) not null,
  domain_id uuid references domains(id) not null,
  type text not null,
  name text not null,
  content text,
  ttl int default 1,
  priority int,
  proxied bool default false,
  status text default 'pending',
  cf_record_id text,
  last_error text,
  created_at timestamptz default now()
);

-- 4. Domain Plans table
create table domain_plans (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) not null,
  domain_id uuid references domains(id) not null,
  total_inboxes int,
  subdomain_count int,
  status text default 'pending',
  prefixes_snapshot text[],
  names_snapshot text[],
  created_at timestamptz default now()
);

-- 5. Planned Inboxes table
create table planned_inboxes (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) not null,
  domain_id uuid references domains(id) not null,
  plan_id uuid references domain_plans(id),
  subdomain_prefix text,
  subdomain_fqdn text,
  local_part text,
  email text,
  person_name text,
  format text,
  status text default 'pending',
  created_at timestamptz default now()
);

-- 6. User Secrets table
create table user_secrets (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) not null unique,
  cf_api_token text,
  cf_account_id text,
  subdomain_prefixes text[] default array['mail','contact','hello','team','support','info'],
  person_names text[] default array['Alice Johnson','John Doe','Marco','Sofia Rossi'],
  created_at timestamptz default now()
);

-- 7. Domain Batches table
create table domain_batches (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) not null,
  name text,
  template_id uuid,
  created_at timestamptz default now()
);

-- 8. Job Templates table
create table job_templates (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) not null,
  name text not null,
  subdomain_prefixes text[],
  person_names text[],
  created_at timestamptz default now()
);

-- 9. Rate Limits table (for API rate limiting)
create table rate_limits (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) not null,
  provider text not null,
  count int default 0,
  window_start timestamptz default now(),
  unique(user_id, provider)
);

-- ============ Enable RLS ============

alter table servers enable row level security;
alter table domains enable row level security;
alter table dns_records enable row level security;
alter table domain_plans enable row level security;
alter table planned_inboxes enable row level security;
alter table user_secrets enable row level security;
alter table domain_batches enable row level security;
alter table job_templates enable row level security;
alter table rate_limits enable row level security;

-- ============ RLS Policies ============

-- Servers policies
create policy "Users can select own servers" on servers for select using (auth.uid() = user_id);
create policy "Users can insert own servers" on servers for insert with check (auth.uid() = user_id);
create policy "Users can update own servers" on servers for update using (auth.uid() = user_id);
create policy "Users can delete own servers" on servers for delete using (auth.uid() = user_id);

-- Domains policies
create policy "Users can select own domains" on domains for select using (auth.uid() = user_id);
create policy "Users can insert own domains" on domains for insert with check (auth.uid() = user_id);
create policy "Users can update own domains" on domains for update using (auth.uid() = user_id);
create policy "Users can delete own domains" on domains for delete using (auth.uid() = user_id);

-- DNS Records policies
create policy "Users can select own dns_records" on dns_records for select using (auth.uid() = user_id);
create policy "Users can insert own dns_records" on dns_records for insert with check (auth.uid() = user_id);
create policy "Users can update own dns_records" on dns_records for update using (auth.uid() = user_id);
create policy "Users can delete own dns_records" on dns_records for delete using (auth.uid() = user_id);

-- Domain Plans policies
create policy "Users can select own domain_plans" on domain_plans for select using (auth.uid() = user_id);
create policy "Users can insert own domain_plans" on domain_plans for insert with check (auth.uid() = user_id);
create policy "Users can update own domain_plans" on domain_plans for update using (auth.uid() = user_id);
create policy "Users can delete own domain_plans" on domain_plans for delete using (auth.uid() = user_id);

-- Planned Inboxes policies
create policy "Users can select own planned_inboxes" on planned_inboxes for select using (auth.uid() = user_id);
create policy "Users can insert own planned_inboxes" on planned_inboxes for insert with check (auth.uid() = user_id);
create policy "Users can update own planned_inboxes" on planned_inboxes for update using (auth.uid() = user_id);
create policy "Users can delete own planned_inboxes" on planned_inboxes for delete using (auth.uid() = user_id);

-- User Secrets policies
create policy "Users can select own user_secrets" on user_secrets for select using (auth.uid() = user_id);
create policy "Users can insert own user_secrets" on user_secrets for insert with check (auth.uid() = user_id);
create policy "Users can update own user_secrets" on user_secrets for update using (auth.uid() = user_id);

-- Domain Batches policies
create policy "Users can select own domain_batches" on domain_batches for select using (auth.uid() = user_id);
create policy "Users can insert own domain_batches" on domain_batches for insert with check (auth.uid() = user_id);
create policy "Users can update own domain_batches" on domain_batches for update using (auth.uid() = user_id);
create policy "Users can delete own domain_batches" on domain_batches for delete using (auth.uid() = user_id);

-- Job Templates policies
create policy "Users can select own job_templates" on job_templates for select using (auth.uid() = user_id);
create policy "Users can insert own job_templates" on job_templates for insert with check (auth.uid() = user_id);
create policy "Users can update own job_templates" on job_templates for update using (auth.uid() = user_id);
create policy "Users can delete own job_templates" on job_templates for delete using (auth.uid() = user_id);

-- Rate Limits policies (allow read for all authenticated, insert/update for service role)
create policy "Users can select own rate_limits" on rate_limits for select using (auth.uid() = user_id);
create policy "Users can upsert own rate_limits" on rate_limits for all using (auth.uid() = user_id);

-- ============ Indexes ============

create index idx_domains_user_id on domains(user_id);
create index idx_domains_name on domains(name);
create index idx_dns_records_domain_id on dns_records(domain_id);
create index idx_dns_records_type on dns_records(type);
create index idx_domain_plans_domain_id on domain_plans(domain_id);
create index idx_planned_inboxes_domain_id on planned_inboxes(domain_id);
create index idx_planned_inboxes_email on planned_inboxes(email);
create index idx_servers_user_id on servers(user_id);
create index idx_rate_limits_user_provider on rate_limits(user_id, provider);