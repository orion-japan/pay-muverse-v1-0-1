// /src/lib/supabaseAdmin.ts
import 'server-only';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Server-only: 必ず .env.local に設定してください
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 実行環境ガード（誤ってクライアントで import された場合に気づけるように）
if (typeof window !== 'undefined') {
  throw new Error('supabaseAdmin must only be imported on the server.');
}

if (!SUPABASE_URL) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL');
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing env: SUPABASE_SERVICE_ROLE_KEY');
}

// Next.js dev(HMR) でも単一インスタンスを再利用してコネクション増殖を防ぐ
// （構造はそのまま export const supabaseAdmin を維持）
const globalForSupabase = globalThis as unknown as {
  __supabaseAdmin?: SupabaseClient;
};

export const supabaseAdmin: SupabaseClient =
  globalForSupabase.__supabaseAdmin ??
  createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

if (!globalForSupabase.__supabaseAdmin) {
  globalForSupabase.__supabaseAdmin = supabaseAdmin;
}
