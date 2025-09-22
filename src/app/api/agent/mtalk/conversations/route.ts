// src/app/api/agent/mtalk/conversations/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

// 先頭行～最大48文字でタイトル化
const makeTitle = (s?: string | null) =>
  (String(s ?? '').split('\n')[0].trim() || 'mirra 会話').slice(0, 48);

function json(data: any, init?: number | ResponseInit) {
  const status = typeof init === 'number' ? init : (init as any)?.status ?? 200;
  const headers = new Headers(typeof init === 'number' ? undefined : (init as any)?.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

export async function GET(req: NextRequest) {
  try {
    // 認可
    const auth = await verifyFirebaseAndAuthorize(req as any);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);
    const user_code = (auth as any).userCode ?? (auth as any).user_code ?? null;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE!);

    // talk_threads を “履歴” として取得しつつ、各スレの最新メッセージを1件だけ同時取得
    // Supabase の foreignTable オプションで埋め込みに order/limit を適用
    const q = supabase
      .from('talk_threads')
      .select(`
        id,
        title,
        updated_at,
        last_message_at,
        messages:talk_messages ( id, role, content, created_at )
      `)
      .eq('agent', 'mirra')
      .eq('user_a_code', user_code)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false })
      .limit(100)
      .order('created_at', { foreignTable: 'talk_messages', ascending: false })
      .limit(1, { foreignTable: 'talk_messages' });

    const { data, error } = await q;
    if (error) throw error;

    const items = (data ?? []).map((t: any) => {
      const msgs: Array<{ role: 'system'|'user'|'assistant'; content: string; created_at: string }> = t.messages ?? [];
      // 最新メッセージ（まず assistant を優先。なければ先頭=最新）
      const lastAssistant = msgs.find(m => m.role === 'assistant');
      const latest = lastAssistant ?? msgs[0];
      const computedTitle =
        t.title && t.title.trim().length > 0
          ? t.title
          : makeTitle(latest?.content);

      return {
        id: t.id,
        conversation_id: t.id,
        title: computedTitle || 'mirra 会話',
        updated_at: t.last_message_at ?? t.updated_at,
        last_message_preview: latest?.content?.slice(0, 120) ?? null, // UIで使いたければ
        unread_count: 0,
      };
    });

    return json({ ok: true, items });
  } catch (e: any) {
    console.error('[mirra/conversations] error', e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}