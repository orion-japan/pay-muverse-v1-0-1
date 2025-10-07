export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';

type InMsg = { role: 'user' | 'assistant'; content: string; ocr?: boolean; media_urls?: string[] };
type Body = { conversation_code?: string | null; messages: InMsg[] };

export async function POST(req: NextRequest) {
  try {
    const supabase = createRouteHandlerClient({ cookies: () => cookies() });

    // RLS前提：認証ユーザー必須
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr) throw userErr;
    if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

    const body = (await req.json()) as Body;
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return NextResponse.json({ ok: false, error: 'messages required' }, { status: 400 });
    }

    const rows = body.messages.map((m) => ({
      user_id: user.id,
      conversation_code: body.conversation_code ?? null,
      role: m.role,
      content: m.content,
      ocr: !!m.ocr,
      media_urls: m.media_urls ?? null,
    }));

    const { error } = await supabase.from('mui_chat_logs').insert(rows);
    if (error) throw error;

    return NextResponse.json({ ok: true, count: rows.length });
  } catch (e: any) {
    console.error('[agent/mui/log]', e);
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
