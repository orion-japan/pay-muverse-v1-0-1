// src/lib/supabase.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // サーバ専用

// --- Browser: Singleton with custom storageKey ---
declare global {
  // eslint-disable-next-line no-var
  var __supabase_browser__: SupabaseClient | undefined;
}

function createBrowserClient() {
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'muverse-auth', // ← 既定キーの競合を避ける
    },
  });
}

export const supabase =
  typeof window === 'undefined'
    // --- Server: service role / no session persistence ---
    ? createClient(url, serviceKey || anonKey, { auth: { persistSession: false } })
    // --- Browser singleton ---
    : (globalThis.__supabase_browser__ ||= createBrowserClient());
