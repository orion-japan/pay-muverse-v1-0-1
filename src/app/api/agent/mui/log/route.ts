// src/app/api/agent/mui/log/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';

type InMsg = { role: 'user' | 'assistant'; content: string; ocr?: boolean; media_urls?: string[] };
type Body = { conversation_code?: string | null; messages: InMsg[] };

export async function POST(req: NextRequest) {
  try {
    // ★ ここがポイント：関数そのものを渡す（await しない）
    //    auth-helpers 側が Promise<ReadonlyRequestCookies> を期待しているため。
    const supabase = createRouteHandlerClient({ cookies });

    // RLS 前提：本番は認証必須、開発は未認証なら no-op で 200 返す
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();
    const isDev = process.env.NODE_ENV !== 'production';
    if (userErr) throw userErr;
    if (!user) {
      if (isDev) {
        const bodyDev = await req.json().catch(() => ({ messages: [] }) as Body);
        if (Array.isArray(bodyDev.messages) && bodyDev.messages.length) {
          console.log('[mui/log][dev-noauth]', {
            count: bodyDev.messages.length,
            conv: bodyDev.conversation_code ?? null,
          });
        }
        return NextResponse.json({
          ok: true,
          dev_noauth: true,
          count: Array.isArray(bodyDev.messages) ? bodyDev.messages.length : 0,
        });
      }
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) as Body;
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return NextResponse.json({ ok: false, error: 'messages required' }, { status: 400 });
    }

    const MAX_LEN = 8000;
    const rows = body.messages.map((m) => ({
      user_id: user.id,
      conversation_code: body.conversation_code ?? null,
      role: m.role,
      content: String(m.content ?? '').slice(0, MAX_LEN),
      ocr: !!m.ocr,
      media_urls: Array.isArray(m.media_urls) ? m.media_urls.slice(0, 8) : null,
    }));

    const { error } = await supabase.from('mui_chat_logs').insert(rows);
    if (error) throw error;

    return NextResponse.json({ ok: true, count: rows.length });
  } catch (e: any) {
    console.error('[agent/mui/log]', e);
    // 観測用途なので落とさない
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 200 });
  }
}
