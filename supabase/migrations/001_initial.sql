-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- VPS nodes (both auto-provisioned via Contabo and manually registered)
CREATE TABLE vps_nodes (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source tracking
  provisioning_source         TEXT NOT NULL DEFAULT 'manual',
  -- 'contabo' = auto-provisioned via API
  -- 'manual'  = user-registered existing VPS

  -- Contabo-specific fields (null if manual)
  contabo_instance_id         TEXT,
  contabo_product_id          TEXT,

  -- Common fields
  hostname                    TEXT NOT NULL,
  main_ip                     INET NOT NULL UNIQUE,
  ssh_port                    INTEGER NOT NULL DEFAULT 22,
  ssh_username                TEXT NOT NULL DEFAULT 'root',
  ssh_private_key_encrypted   TEXT,
  ssh_password_encrypted      TEXT,
  ssh_public_key              TEXT,

  -- Mailcow state
  mailcow_installed           BOOLEAN NOT NULL DEFAULT false,
  mailcow_api_key_encrypted   TEXT,
  mailcow_api_endpoint        TEXT,

  -- Capacity management
  max_domains_per_node        INTEGER NOT NULL DEFAULT 1,
  current_domain_count        INTEGER NOT NULL DEFAULT 0,

  -- Status
  status                      TEXT NOT NULL DEFAULT 'pending',

  -- Metadata
  location                    TEXT,
  provider_label              TEXT,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ DEFAULT now(),
  updated_at                  TIMESTAMPTZ DEFAULT now()
);

-- IP/VPS pool
CREATE TABLE ip_pool (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vps_id                    UUID NOT NULL REFERENCES vps_nodes(id) ON DELETE CASCADE,
  ip_address                INET NOT NULL UNIQUE,
  is_primary                BOOLEAN NOT NULL DEFAULT true,
  created_at                TIMESTAMPTZ DEFAULT now()
);

-- Provisioning jobs
CREATE TABLE provisioning_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root_domain       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  progress          INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  total_subdomains  INTEGER,
  total_mailboxes   INTEGER,
  inngest_run_id    TEXT,
  result_encrypted  TEXT,
  error_message     TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- Subdomain plans
CREATE TABLE subdomain_plans (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                    UUID NOT NULL REFERENCES provisioning_jobs(id) ON DELETE CASCADE,
  vps_id                    UUID REFERENCES vps_nodes(id),
  prefix                    TEXT NOT NULL,
  suffix                    TEXT NOT NULL,
  full_subdomain            TEXT NOT NULL,
  assigned_ip               INET,
  dkim_selector             TEXT,
  dkim_public_key           TEXT,
  postfix_config_applied    BOOLEAN NOT NULL DEFAULT false,
  status                    TEXT NOT NULL DEFAULT 'pending',
  error_message             TEXT,
  created_at                TIMESTAMPTZ DEFAULT now()
);

-- Mailboxes
CREATE TABLE mailboxes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subdomain_id        UUID NOT NULL REFERENCES subdomain_plans(id) ON DELETE CASCADE,
  email               TEXT NOT NULL UNIQUE,
  password_encrypted  TEXT NOT NULL,
  first_name          TEXT,
  last_name           TEXT,
  status              TEXT NOT NULL DEFAULT 'created',
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_vps_status ON vps_nodes(status);
CREATE INDEX idx_vps_source ON vps_nodes(provisioning_source);
CREATE INDEX idx_vps_capacity ON vps_nodes(current_domain_count, max_domains_per_node)
  WHERE status = 'active';
CREATE INDEX idx_jobs_status ON provisioning_jobs(status);
CREATE INDEX idx_subdomain_job ON subdomain_plans(job_id);
CREATE INDEX idx_subdomain_status ON subdomain_plans(status);
CREATE INDEX idx_mailbox_subdomain ON mailboxes(subdomain_id);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_vps_updated_at
  BEFORE UPDATE ON vps_nodes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_jobs_updated_at
  BEFORE UPDATE ON provisioning_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE vps_nodes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_pool           ENABLE ROW LEVEL SECURITY;
ALTER TABLE provisioning_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE subdomain_plans   ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailboxes         ENABLE ROW LEVEL SECURITY;

-- Service role bypass (backend only, no public access)
CREATE POLICY "service_role_all" ON vps_nodes
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON ip_pool
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON provisioning_jobs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON subdomain_plans
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON mailboxes
  FOR ALL TO service_role USING (true) WITH CHECK (true);
