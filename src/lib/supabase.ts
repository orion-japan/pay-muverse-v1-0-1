// src/lib/supabase.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// 環境変数から柔軟に読む
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
// Service Role / Server 専用
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.supabaseKey || // 小文字でも読めるように
  '';

// --- Browser: Singleton with custom storageKey ---
declare global {
  var __supabase_browser__: SupabaseClient | undefined;
}

function createBrowserClient() {
  if (!url || !anonKey) {
    throw new Error('Supabase URL or Anon Key is missing (browser)');
  }
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'muverse-auth', // ← 競合回避
    },
  });
}

export const supabase =
  typeof window === 'undefined'
    ? // --- Server: service role / no session persistence ---
      (() => {
        if (!url || !serviceKey) {
          throw new Error('Supabase URL or Service Key is missing (server)');
        }
        return createClient(url, serviceKey, {
          auth: { persistSession: false },
        });
      })()
    : // --- Browser singleton ---
      (globalThis.__supabase_browser__ ||= createBrowserClient());
