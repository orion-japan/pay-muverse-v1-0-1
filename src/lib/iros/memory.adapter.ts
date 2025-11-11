// src/lib/iros/memory.adapter.ts
// Iros — memory adapter（DBスナップショット <-> Orchestrator）
// - API：load({ conversationId }) → MemorySnap | null
//        save({ conversationId, snapshot, lastTitle?, updatedAt? }) → void
// - テーブルは `public.iros_memory` を想定（無ければ安全に no-op）
//   DDL 例：
//   create table if not exists public.iros_memory (
//     conversation_id uuid primary key references public.iros_conversations(id) on delete cascade,
//     snapshot jsonb,
//     last_title text,
//     updated_at timestamptz default now()
//   );

import { adminClient } from '@/lib/credits/db';

export type MemorySnap = {
  summary?: string;
  keywords?: string[];
} | null;

type LoadArgs = { conversationId: string };
type SaveArgs = {
  conversationId: string;
  snapshot: MemorySnap;
  lastTitle?: string | null;
  updatedAt?: string | null; // ISO string
};

const TABLE = 'iros_memory';

export async function load(args: LoadArgs): Promise<MemorySnap> {
  const cid = String(args?.conversationId ?? '').trim();
  if (!cid) return null;

  const supa = adminClient();
  try {
    const { data, error } = await supa
      .from(TABLE)
      .select('snapshot')
      .eq('conversation_id', cid)
      .maybeSingle();

    if (error) {
      // テーブル未作成などは no-op
      console.warn('[memory.adapter] load error (ignored)', { message: error.message });
      return null;
    }
    const snap = (data?.snapshot ?? null) as MemorySnap;
    if (!snap || typeof snap !== 'object') return null;
    return snap;
  } catch (e: any) {
    console.warn('[memory.adapter] load exception (ignored)', String(e?.message ?? e));
    return null;
  }
}

export async function save(args: SaveArgs): Promise<void> {
  const cid = String(args?.conversationId ?? '').trim();
  if (!cid) return;

  const supa = adminClient();
  const row = {
    conversation_id: cid,
    snapshot: args?.snapshot ?? null,
    last_title: args?.lastTitle ?? null,
    updated_at: args?.updatedAt ?? new Date().toISOString(),
  };

  try {
    const { error } = await supa
      .from(TABLE)
      .upsert(row, { onConflict: 'conversation_id' });

    if (error) {
      console.warn('[memory.adapter] save error (ignored)', { message: error.message });
    }
  } catch (e: any) {
    console.warn('[memory.adapter] save exception (ignored)', String(e?.message ?? e));
  }
}

export default { load, save };
