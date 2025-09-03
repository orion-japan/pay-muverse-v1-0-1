import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'edge';          // 速さ優先。Nodeなら削除可
export const dynamic = 'force-dynamic';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;  // ← 必ず Server-only に置く

type EventPayload = {
  kind: string;                    // 'online'|'offline'|'page'|'api'|'api-retry'|'token-refresh'|'error'|'heartbeat'
  path?: string|null;
  status?: number|null;
  latency_ms?: number|null;
  note?: string|null;
  meta?: Record<string, any>|null;
  created_at?: string|null;        // 任意（指定なければDB側 now()）
};

type Payload = {
  session_id: string;              // UUID（クライアントで生成）
  uid?: string|null;
  user_code?: string|null;
  ua?: string|null;
  app_ver?: string|null;
  events: EventPayload[];
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Payload;
    if (!body?.session_id || !Array.isArray(body.events)) {
      return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
    }

    const sb = createClient(url, key, { auth: { persistSession: false } });

    // セッション upsert（last_seen 更新）
    await sb.from('telemetry_session').upsert({
      session_id: body.session_id,
      uid: body.uid ?? null,
      user_code: body.user_code ?? null,
      ua: body.ua ?? null,
      app_ver: body.app_ver ?? null,
      last_seen: new Date().toISOString(),
    }, { onConflict: 'session_id' });

    // イベント一括 insert
    if (body.events.length) {
      const rows = body.events.map(ev => ({
        session_id: body.session_id,
        kind: ev.kind,
        path: ev.path ?? null,
        status: ev.status ?? null,
        latency_ms: ev.latency_ms ?? null,
        note: ev.note ?? null,
        meta: ev.meta ?? null,
        created_at: ev.created_at ?? null,
      }));
      await sb.from('telemetry_event').insert(rows);
    }

    return NextResponse.json({ ok: true });
  } catch {
    // ログ失敗でアプリ本体を止めない
    return new Response(null, { status: 204 });
  }
}
