import { createClient, SupabaseClient } from '@supabase/supabase-js'

const CONFIG_ROW_ID = '00000000-0000-0000-0000-000000000001'

export interface AppConfig {
  cloudflare_api_token: string | null
  cloudflare_zone_id: string | null

  contabo_client_id: string | null
  contabo_client_secret: string | null
  contabo_api_user: string | null
  contabo_api_password: string | null
  contabo_api_base: string
  contabo_auth_url: string
  contabo_default_product_id: string
  contabo_default_region: string
  contabo_default_image: string
  contabo_max_domains_per_node: number
}

let cachedConfig: AppConfig | null = null

function makeSupabase(): SupabaseClient {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

export async function getAppConfig(): Promise<AppConfig> {
  if (cachedConfig) return cachedConfig

  const supabase = makeSupabase()
  const { data, error } = await supabase
    .from('app_config')
    .select('*')
    .eq('id', CONFIG_ROW_ID)
    .single()

  if (error || !data) {
    throw new Error(`Failed to load app config: ${error?.message ?? 'no row'}`)
  }

  cachedConfig = data as AppConfig
  return cachedConfig!
}

export function invalidateConfigCache(): void {
  cachedConfig = null
}

export async function updateAppConfig(
  patch: Partial<Omit<AppConfig, 'id' | 'updated_at'>>
): Promise<AppConfig> {
  const supabase = makeSupabase()
  const { data, error } = await supabase
    .from('app_config')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', CONFIG_ROW_ID)
    .select('*')
    .single()

  if (error || !data) {
    throw new Error(`Failed to update app config: ${error?.message ?? 'no row'}`)
  }

  cachedConfig = data as AppConfig
  return cachedConfig!
}
