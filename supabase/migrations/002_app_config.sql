-- App configuration (Cloudflare, Contabo, etc.)
-- Only ever one row, keyed by a fixed ID.
CREATE TABLE app_config (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  updated_at   TIMESTAMPTZ DEFAULT now(),

  -- Cloudflare
  cloudflare_api_token        TEXT,
  cloudflare_zone_id          TEXT,

  -- Contabo
  contabo_client_id           TEXT,
  contabo_client_secret       TEXT,
  contabo_api_user            TEXT,
  contabo_api_password        TEXT,
  contabo_api_base            TEXT NOT NULL DEFAULT 'https://api.contabo.com/v1',
  contabo_auth_url            TEXT NOT NULL DEFAULT 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token',
  contabo_default_product_id  TEXT NOT NULL DEFAULT 'V45',
  contabo_default_region      TEXT NOT NULL DEFAULT 'EU',
  contabo_default_image       TEXT NOT NULL DEFAULT 'ubuntu-22.04',
  contabo_max_domains_per_node INTEGER NOT NULL DEFAULT 1
);

-- Seed the single config row so we can always UPSERT
INSERT INTO app_config (id, cloudflare_api_token, cloudflare_zone_id)
VALUES ('00000000-0000-0000-0000-000000000001', NULL, NULL);

ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON app_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);
