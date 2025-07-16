// /src/lib/supabaseClient.ts

import { createClient } from '@supabase/supabase-js';

// ✅ ログで環境変数を確認！
console.log('✅ NEXT_PUBLIC_SUPABASE_URL:', process.env.NEXT_PUBLIC_SUPABASE_URL);
console.log('✅ NEXT_PUBLIC_SUPABASE_ANON_KEY:', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

// ✅ 必ず NEXT_PUBLIC_ がついていること！
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
