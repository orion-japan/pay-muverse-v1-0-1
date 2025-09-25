// src/app/api/agent/mtalk/history/route.ts
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
  const status = typeof init === 'number' ? init : (init as ResponseInit | undefined)?.['status'] ?? 200;
  const headers = new Headers(typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

/** GET /api/agent/mtalk/history?agent=mirra|iros */
export async function GET(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);

    const user_code =
      (auth as any).userCode ?? (auth as any).user_code ?? (auth as any).uid ?? null;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const url = new URL(req.url);
    const agentParam = (url.searchParams.get('agent') ?? 'mirra').toLowerCase();
    const agent = agentParam === 'iros' ? 'iros' : 'mirra';

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    type ReportRow = {
      conversation_id: string | null;
      input_text?: string | null;
      reply_text?: string | null;
      created_at?: string | null;
    };

    const rep = await supabase
      .from('mtalk_reports')
      .select('conversation_id, input_text, reply_text, created_at')
      .eq('user_code', user_code)
      .eq('agent', agent)
      .not('conversation_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(120);

    if (rep.error) {
      console.error('[mtalk/history] mtalk_reports select error', rep.error);
    }

    const seen = new Set<string>();
    const pool: { conversation_id: string; title?: string | null; updated_at?: string | null }[] = [];

    for (const r of (rep.data ?? []) as ReportRow[]) {
      const cid = String(r.conversation_id ?? '').trim();
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);

      // 最新行を採用。input が空なら reply を使う
      const raw = (r?.input_text ?? '') || (r?.reply_text ?? '') || '';
      const base = raw.replace(/\s+/g, ' ').trim();
      const title = (base.split('\n')[0] || '').slice(0, 48) || `${agent} 会話`;

      pool.push({
        conversation_id: cid,
        title,
        updated_at: r.created_at ?? null,
      });
    }

    // ここで overrides を一括取得して適用
    if (pool.length) {
      const ids = pool.map(p => p.conversation_id);
      const ov = await supabase
        .from('mtalk_overrides')
        .select('session_id, title, archived')
        .eq('user_code', user_code)
        .in('session_id', ids);

      if (!ov.error && ov.data?.length) {
        const map = new Map(ov.data.map(o => [String(o.session_id), o]));
        // archived は除外、title があれば上書き
        for (let i = pool.length - 1; i >= 0; i--) {
          const row = map.get(pool[i].conversation_id);
          if (!row) continue;
          if (row.archived) {
            pool.splice(i, 1);
            continue;
          }
          if (row.title && row.title.trim()) {
            pool[i].title = row.title.trim().slice(0, 100); // 任意の上限
          }
        }
      }
    }

    // 追加フォールバック（任意）：talk_threads から補完
    // ...（必要なら以前のまま残してOK）

    const items = pool
      .map(x => ({
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
    console.error('[mtalk/history] fatal', e);
    return json({ ok: false, error: 'internal_error' }, 500);
  }
}
