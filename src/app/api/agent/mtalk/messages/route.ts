// src/app/api/agent/mtalk/messages/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

function json(data: any, init?: number | ResponseInit) {
  const status = typeof init === 'number' ? init : (init as ResponseInit | undefined)?.['status'] ?? 200;
  const headers = new Headers(typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

export async function GET(req: NextRequest) {
  try {
    const conversation_id = req.nextUrl.searchParams.get('conversation_id') || '';
    if (!conversation_id) return json({ ok: false, error: 'conversation_id_required' }, 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // conversations.messages(JSONB) を最優先
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('title, messages')
      .eq('id', conversation_id)
      .single();

    if (!convErr && conv) {
      const arr = Array.isArray((conv as any).messages) ? (conv as any).messages : [];
      if (arr.length > 0) return json({ ok: true, title: (conv as any).title || '', messages: arr });
    }

    // フォールバック：行テーブル
    const tables = ['messages', 'talk_messages', 'mtalk_turns'] as const;
    for (const t of tables) {
      const { data, error } = await supabase
        .from(t as any)
        .select('role, content, created_at')
        .eq('conversation_id', conversation_id)
        .order('created_at', { ascending: true });
      if (!error && Array.isArray(data) && data.length > 0) {
        return json({ ok: true, title: (conv as any)?.title || '', messages: data });
      }
    }

    return json({ ok: true, title: (conv as any)?.title || '', messages: [] });
  } catch (e: any) {
    return json({ ok: false, error: 'internal_error', detail: String(e?.message || e) }, 500);
  }
}
