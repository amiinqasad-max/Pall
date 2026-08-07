/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL. Omit to run the game fully offline. */
  readonly VITE_SUPABASE_URL?: string;
  /**
   * Supabase publishable key (`sb_publishable_...`), or the older anon key.
   * Safe to ship — row-level security is what protects the data. Never put a
   * `service_role` key or an `sbp_` personal access token here: VITE_ variables
   * are compiled into the bundle every visitor downloads.
   */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** AdSense client id, e.g. "ca-pub-...". Omit to use house ads only. */
  readonly VITE_ADSENSE_CLIENT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
