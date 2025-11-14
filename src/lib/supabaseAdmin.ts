// src/lib/supabaseAdmin.ts
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Server-only: .env / .env.local に設定必須
const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined;

// 誤 import ガード（クライアントから読み込まれないように）
if (typeof window !== 'undefined') {
  throw new Error('supabaseAdmin must only be imported on the server.');
}
if (!url) throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL');
if (!serviceRoleKey) throw new Error('Missing env: SUPABASE_SERVICE_ROLE_KEY');

// Next.js HMRでも単一インスタンスを再利用
declare global {
  // eslint-disable-next-line no-var
  var __supabaseAdmin__: SupabaseClient | undefined;
}

export const supabaseAdmin: SupabaseClient =
  global.__supabaseAdmin__ ??
  createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
    db: { schema: 'public' },
    global: { headers: { 'X-Client-Info': 'muverse-admin' } },
  });

if (!global.__supabaseAdmin__) {
  global.__supabaseAdmin__ = supabaseAdmin;
}
