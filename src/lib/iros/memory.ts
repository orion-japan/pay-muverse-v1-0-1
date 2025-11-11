// /src/lib/iros/memory.ts
import { createClient } from '@supabase/supabase-js';
import type { IrosMemory } from './types';
import { SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

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

  const { error } = await sb.from(MEMORY_TABLE).upsert(row, { onConflict: 'conversation_id' });
  if (error) throw error;
}

/** 追加：会話メモリをロード（会話ごとに1行運用を想定。無ければ null） */
export async function getIrosMemory(conversationId: string): Promise<IrosMemory | null> {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const { data, error } = await sb
    .from(MEMORY_TABLE)
    .select('depth, tone, theme, summary, last_keyword, updated_at')
    .eq('conversation_id', conversationId)
    .order('updated_at', { ascending: false })
    .limit(1);

  if (error) throw error;
  if (!data || data.length === 0) return null;

  const r = data[0] as any;
  const mem: IrosMemory = {
    depth: r.depth ?? undefined,
    tone: r.tone ?? undefined,
    theme: r.theme ?? undefined,
    summary: r.summary ?? undefined,
    last_keyword: r.last_keyword ?? undefined,
  };
  return mem;
}
