import { createClient } from '@supabase/supabase-js';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export type KBItem = { id: string; title: string; content: string; url?: string; tags?: string[] };

export async function retrieveKnowledge(userCode: string | null, limit = 4): Promise<KBItem[]> {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  // まずは app_knowledge を想定：columns: id,title,content,url,tags(optional)
  const { data, error } = await sb
    .from('app_knowledge')
    .select('id,title,content,url,tags')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as KBItem[];
}
