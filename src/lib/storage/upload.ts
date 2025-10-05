import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const BUCKET = process.env.NEXT_PUBLIC_MUI_FSHOT_BUCKET || "mui-fshot";

export async function uploadToSupabase(file: File, userCode = "DEMO") {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  // バケットは事前作成 (public でも private でもOK)
  const filename = `${userCode}/${Date.now()}-${file.name}`.replace(/\s+/g, "_");
  const { data, error } = await sb.storage.from(BUCKET).upload(filename, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type || "image/png",
  });
  if (error) throw new Error(error.message);
  // 公開URL（Private運用ならサインドURLに差し替え）
  const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(data.path);
  return { path: data.path, publicUrl: pub?.publicUrl };
}
