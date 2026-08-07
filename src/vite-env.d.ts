/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL. Omit to run the game fully offline. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon (publishable) key. Safe to ship; RLS is what protects data. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** AdSense client id, e.g. "ca-pub-...". Omit to use house ads only. */
  readonly VITE_ADSENSE_CLIENT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
