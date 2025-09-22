export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  verifyFirebaseAndAuthorize,
  SUPABASE_URL,
  SERVICE_ROLE,
} from '@/lib/authz';

function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : (init as ResponseInit | undefined)?.['status'] ?? 200;
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

/**
 * 履歴一覧
 * GET /api/talk/history?agent=mirra|iros
 *
 * 返却:
 * { ok:true, items:[{ conversation_id, title, updated_at }] }
 */
export async function GET(req: NextRequest) {
  try {
    // ---- 認証 ----
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);

    const user_code =
      (auth as any).userCode ?? (auth as any).user_code ?? (auth as any).uid ?? null;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    // ---- パラメータ ----
    const url = new URL(req.url);
    const agentParam = (url.searchParams.get('agent') ?? 'mirra').toLowerCase();
    const agent = agentParam === 'iros' ? 'iros' : 'mirra';

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // ---- まずは mtalk_reports から収集（既存仕様） ----
    type ReportRow = {
      conversation_id: string | null;
      input_text?: string | null;
      created_at?: string | null;
    };

    const rep = await supabase
      .from('mtalk_reports')
      .select('conversation_id, input_text, created_at')
      .eq('user_code', user_code)
      .eq('agent', agent)
      .not('conversation_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(60); // 重複除去前に少し多めに取る

    if (rep.error) {
      // エラーはログだけ残して後続のフォールバックに進む
      console.error('[talk/history] mtalk_reports select error', rep.error);
    }

    const seen = new Set<string>();
    const pool: { conversation_id: string; title?: string | null; updated_at?: string | null }[] = [];

    for (const r of (rep.data ?? []) as ReportRow[]) {
      const cid = String(r.conversation_id ?? '').trim();
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);

      // 1行目をタイトルに、なければデフォルト
      const title =
        (r?.input_text ?? '')
          .split('\n')[0]
          .slice(0, 48) || `${agent} 会話`;

      pool.push({
        conversation_id: cid,
        title,
        updated_at: r.created_at ?? null,
      });
    }

    // ---- 追加フォールバック：talk_threads からも補完 ----
    // テーブルがある環境では、同一 agent & user のスレッドを拾って足りない分を補完する
    try {
      if (pool.length < 20) {
        type ThreadRow = {
          id: string;
          last_message_at: string | null;
          created_by?: string | null;
          agent?: string | null;
        };

        const thr = await supabase
          .from('talk_threads')
          .select('id, last_message_at, created_by, agent')
          .eq('created_by', user_code)
          .eq('agent', agent)
          .order('last_message_at', { ascending: false })
          .limit(40);

        if (!thr.error) {
          for (const t of (thr.data ?? []) as ThreadRow[]) {
            const cid = String(t.id ?? '').trim();
            if (!cid || seen.has(cid)) continue;
            seen.add(cid);
            pool.push({
              conversation_id: cid,
              title: `${agent} 会話`,
              updated_at: t.last_message_at ?? null,
            });
            if (pool.length >= 30) break;
          }
        } else {
          // 存在しない・権限などのエラーは無視
          if (thr.error.code !== '42P01') {
            console.warn('[talk/history] talk_threads select warn', thr.error);
          }
        }
      }
    } catch (e) {
      // スキーマ未整備などでも問題なく返すため握りつぶし
      console.warn('[talk/history] talk_threads fallback error', e);
    }

    // ---- 重複排除後に更新日時で整列して最大20件に整形 ----
    const items = pool
      .map((x) => ({
        conversation_id: x.conversation_id,
        title: (x.title ?? `${agent} 会話`).trim() || `${agent} 会話`,
        updated_at: x.updated_at ?? null,
      }))
      .sort((a, b) => {
        const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
        const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
        return tb - ta;
      })
      .slice(0, 20);

    return json({ ok: true, items });
  } catch (e: any) {
    console.error('[talk/history] fatal', e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}
