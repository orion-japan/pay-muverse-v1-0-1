// /src/lib/credits/db.ts
import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  '';

export const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE ||           // 本来名
  process.env.SUPABASE_SERVICE_ROLE_KEY || '';   // 互換名も許容

function ensureEnv() {
  const miss: string[] = [];
  if (!SUPABASE_URL) miss.push('NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)');
  if (!SUPABASE_SERVICE_ROLE) miss.push('SUPABASE_SERVICE_ROLE (or SUPABASE_SERVICE_ROLE_KEY)');
  if (miss.length) throw new Error('[credits/db] Missing env: ' + miss.join(', '));
}

export function adminClient() {
  ensureEnv();
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
}
