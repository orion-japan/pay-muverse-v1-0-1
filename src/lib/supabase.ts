// src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // ★サーバ専用

// サーバ環境（API Route 等）では Service Role を優先
export const supabase =
  typeof window === 'undefined' && serviceKey
    ? createClient(url, serviceKey, {
        auth: { persistSession: false }, // サーバなのでセッション保持しない
      })
    : createClient(url, anonKey);
