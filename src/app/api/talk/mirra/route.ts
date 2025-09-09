// /app/api/talk/mirra/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { generateMirraReply, inferQCode } from '@/lib/mirra';

export const runtime = 'nodejs';

export async function GET() {
  return new Response(JSON.stringify({ ok: true, service: 'mirra' }), {
    headers: { 'content-type': 'application/json' },
  });
}

// 課金・監視が未実装なら一旦スタブ（後で差し替えOK）
async function chargeCredits(_user_code: string, _amount: number, _meta?: any) {
  return;
}
async function recordMuTextTurn(_payload: any) {
  return;
}

// 認証ヘルパが無ければ簡易スタブ（本番は必ず差し替え）
async function getUserFromRequest(_req: NextRequest) {
  // 例：ヘッダやcookieから取り出す。今は開発用にダミー
  return { user_code: 'dev-user' };
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user?.user_code) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const text: string = String(body?.text ?? '');
    const thread_id: string = String(body?.thread_id ?? '');

    if (!text.trim() || !thread_id) {
      return NextResponse.json({ error: 'bad_request', detail: 'text and thread_id are required' }, { status: 400 });
    }

    const out = await generateMirraReply(text);
    const qres = await inferQCode(text);

    await chargeCredits(user.user_code, out.cost, { agent: 'mirra', thread_id }).catch(() => {});
    await recordMuTextTurn({
      agent: 'mirra',
      user_code: user.user_code,
      thread_id,
      input_text: text,
      output_text: out.text,
      used_credits: out.cost,
      meta: { ...out.meta, q_code: qres.q, q_confidence: qres.confidence, q_color: qres.color_hex },
    }).catch(() => {});

    return NextResponse.json({
      ok: true,
      reply: out.text,
      cost: out.cost,
      meta: { ...out.meta, q_code: qres.q, q_confidence: qres.confidence, q_color: qres.color_hex },
    });
  } catch (e: any) {
    console.error('mirra POST error:', e);
    return NextResponse.json({ error: 'internal_error', detail: String(e?.message ?? e) }, { status: 500 });
  }
}
