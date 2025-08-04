import { createClient } from "@supabase/supabase-js";

// ✅ フロントエンドで使うので NEXT_PUBLIC を参照
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
