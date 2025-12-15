// file: src/lib/iros/server/handleIrosReply.supabase.ts
// iros - Supabase admin client (server-only)

import { createClient } from '@supabase/supabase-js';

export function getIrosSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      '[IROS] Missing Supabase env. NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required for server handlers.',
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

// 念のため：このファイルを確実に “module” 扱いにする
export {};
