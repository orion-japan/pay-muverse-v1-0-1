// src/lib/supabaseServer.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';

const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SERVICE_ROLE_KEY || // ← よくある別名
  '';

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('[ENV CHECK] supabaseServer.ts:', {
    hasUrl: !!SUPABASE_URL,
    hasServiceRole: !!SERVICE_ROLE,
    serviceRoleLength: SERVICE_ROLE.length,
  });
  throw new Error('Supabase env is missing (URL or SERVICE_ROLE)');
}

export const supabaseServer: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});
