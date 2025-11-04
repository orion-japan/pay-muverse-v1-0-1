// src/app/api/agent/mtalk/messages/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : ((init as ResponseInit | undefined)?.['status'] ?? 200);
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

type Row = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  meta?: any;
  created_at?: string;
};

export async function GET(req: NextRequest) {
  try {
    const conversation_id = req.nextUrl.searchParams.get('conversation_id') || '';
    if (!conversation_id) return json({ ok: false, error: 'conversation_id_required' }, 400);

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // A) conversations.messages(JSONB)
    let convTitle = '';
    let a: Row[] = [];
    try {
      const { data: conv, error } = await sb
        .from('conversations')
        .select('title, messages')
        .eq('id', conversation_id)
        .maybeSingle();
      if (!error && conv) {
        convTitle = (conv as any).title || '';
        if (Array.isArray((conv as any).messages)) a = (conv as any).messages;
      }
    } catch {}

    // B) talk_messages(thread_id=cid) / 互換: conversation_id=cid
    let b: Row[] = [];
    const tryTables: Array<{ table: string; col: string }> = [
      { table: 'talk_messages', col: 'thread_id' },
      { table: 'talk_messages', col: 'conversation_id' },
      { table: 'messages', col: 'conversation_id' }, // 古い互換
      { table: 'mtalk_turns', col: 'conversation_id' },
    ];
    for (const t of tryTables) {
      const { data, error } = await sb
        .from(t.table as any)
        .select('role, content, meta, created_at')
        .eq(t.col, conversation_id)
        .order('created_at', { ascending: true });
      if (!error && Array.isArray(data) && data.length) {
        b = data as any;
        break;
      }
    }

    // C) マージ（created_at で整列、重複は role+content+created_at で除外）
    const merged = [...a, ...b].filter(Boolean);
    merged.sort((x, y) => {
      const tx = x.created_at ? Date.parse(x.created_at) : 0;
      const ty = y.created_at ? Date.parse(y.created_at) : 0;
      return tx - ty;
    });
    const seen = new Set<string>();
    const dedup = merged.filter((m) => {
      const k = `${m.role}|${m.content}|${m.created_at ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return json({ ok: true, title: convTitle, messages: dedup });
  } catch (e: any) {
    return json({ ok: false, error: 'internal_error', detail: String(e?.message || e) }, 500);
  }
}
