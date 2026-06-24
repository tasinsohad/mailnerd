import { createBrowserClient } from "@supabase/ssr";

// Create browser client for Supabase
export function createClientSupabaseBrowser() {
  return createBrowserClient(
    import.meta.env.VITE_SUPABASE_URL ?? "",
    import.meta.env.VITE_SUPABASE_ANON_KEY ?? "",
  );
}
