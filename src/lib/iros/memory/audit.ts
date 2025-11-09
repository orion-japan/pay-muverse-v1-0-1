// src/lib/iros/memory/audit.ts
import { createClient } from '@supabase/supabase-js';
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const sb = createClient(URL, KEY);

export async function auditSemProf(
  event: 'semantic_suggest'|'semantic_approve'|'profile_update',
  user_code: string,
  target_id?: string,
  note?: string
) {
  const { error } = await sb.from('iros_semprof_audit').insert({
    user_code, event, target_id: target_id ?? null, note: note ?? null
  });
  if (error) throw error;
}
