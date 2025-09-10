// /app/api/talk/mirra/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { generateMirraReply, inferQCode } from '@/lib/mirra';

export const runtime = 'nodejs';

export async function GET() {
  return new Response(JSON.stringify({ ok: true, service: 'mirra' }), {
    headers: { 'content-type': 'application/json' },
  });
}

// --- 課金・記録（必要なら本実装に差し替え） ---
async function chargeCredits(_user_code: string, _amount: number, _meta?: any) { return; }
async function recordMuTextTurn(_payload: any) { return; }

// --- 開発用の簡易ユーザー取得（本番は必ず差し替え） ---
async function getUserFromRequest(_req: NextRequest) {
  return { user_code: 'dev-user' };
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user?.user_code) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({} as any));

    // ★ 入力互換：text / message / content すべて受ける
    const text: string = String(body?.text ?? body?.message ?? body?.content ?? '').trim();

    // ★ thread_id 互換：thread_id / threadId / thread のどれでもOK
    const thread_id: string = String(
      body?.thread_id ?? body?.threadId ?? body?.thread ?? ''
    ).trim();

    if (!text || !thread_id) {
      return NextResponse.json(
        { error: 'bad_request', detail: 'text and thread_id are required' },
        { status: 400 }
      );
    }

    // 生成
    const out = await generateMirraReply(text); // { text, cost, meta? }
    const qres = await inferQCode(text);       // { q, confidence, color_hex }

    // 課金・記録は失敗してもチャットは続行
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
      thread_id,
      meta: { ...out.meta, q_code: qres.q, q_confidence: qres.confidence, q_color: qres.color_hex },
    });
  } catch (e: any) {
    console.error('[mirra] POST error:', e);
    return NextResponse.json(
      { error: 'internal_error', detail: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}
