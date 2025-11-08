// /src/lib/iros/memory.ts
import { createClient } from '@supabase/supabase-js';
import type { IrosMemory } from './types';
import { SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

// テーブル名を環境変数で差し替え可能に
const MEMORY_TABLE = process.env.MUV_MEMORY_THREADS_TABLE || 'memory_threads';

export async function saveIrosMemory(args: {
  conversationId: string;
  user_code: string;
  mem: IrosMemory;
}) {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const row = {
    conversation_id: args.conversationId,
    user_code: args.user_code,
    depth: args.mem.depth,
    tone: args.mem.tone,
    theme: args.mem.theme,
    summary: args.mem.summary,
    last_keyword: args.mem.last_keyword,
    updated_at: new Date().toISOString(),
  };

  const { error } = await sb.from(MEMORY_TABLE).upsert(row, {
    onConflict: 'conversation_id',
  });
  if (error) throw error;
}
