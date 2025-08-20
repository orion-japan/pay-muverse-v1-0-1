// src/lib/supabase-browser.ts
import { createClient } from '@supabase/supabase-js';

let _sb: ReturnType<typeof createClient> | null = null;

export function getSupabaseBrowser() {
  if (_sb) return _sb;
  if (
    typeof window === 'undefined' ||
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) return null;

  _sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
  return _sb;
}
