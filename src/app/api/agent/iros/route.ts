// /src/app/api/agent/iros/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize, normalizeAuthz } from '@/lib/authz';
import { reserveAndSpendCredit } from '@/lib/mu/credits';
import { runIrosChat } from '@/lib/iros/openai';
import { SofiaTriggers } from '@/lib/iros/system';

// ===== 最小ローカル型 =====
type IrosMode = 'counsel' | 'structured' | 'diagnosis' | 'auto';
type IrosChatRequestIn = {
  convo_id?: string;
  conversationId?: string;
  conversation_id?: string;
  text?: string;
  extra?: any;
};

function json<T>(b: T, status = 200) {
  return NextResponse.json(b, { status });
}

// ---- normalizeAuthz の差分吸収（userCode を安全に取り出す）
function getUserCodeFromAuthz(a: any): string | null {
  if (!a) return null;
  // 直接持っている場合
  if (a.userCode) return String(a.userCode);
  if (a.user_code) return String(a.user_code);
  // user 配下の一般的な候補
  const u = a.user ?? a.currentUser ?? null;
  const cand = u?.user_code ?? u?.code ?? u?.id ?? null;
  return cand ? String(cand) : null;
}

// ---- モード検出（LLMを増やさない）
function includesAny(text: string, phrases: readonly string[]) {
  const t = (text || '').trim();
  return phrases.some((p) => t.includes(p));
}
function detectIntentMode(input: string): IrosMode {
  const t = (input || '').trim();
  if (includesAny(t, SofiaTriggers.diagnosis)) return 'diagnosis';
  if (includesAny(t, SofiaTriggers.intent)) return 'counsel';
  if (/(整理|まとめ|レポート|要件|手順|設計|仕様)/.test(t)) return 'structured';
  if (/(相談|悩み|どうしたら|助けて|迷って)/.test(t)) return 'counsel';
  return 'auto';
}

// ---- リクエスト正規化
function parseBody(b: IrosChatRequestIn) {
  const conversationId = b.convo_id || b.conversationId || b.conversation_id || '';
  const text = b.text || '';
  const extra = b.extra ?? null;
  return { conversationId, text, extra };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as IrosChatRequestIn;
    const { conversationId, text, extra } = parseBody(body);
    if (!conversationId || !text) {
      return json({ ok: false, error: 'bad_request' }, 400);
    }

    // 1) 認証
    const auth = await verifyFirebaseAndAuthorize(req);
    const authz = normalizeAuthz(auth);
    const userCode = getUserCodeFromAuthz(authz);
    if (!userCode) return json({ ok: false, error: 'unauthorized' }, 401);

    // 2) クレジット（authorize→capture）
    const credit = await reserveAndSpendCredit({
      user_code: userCode,
      amount: 1,
      ref_conv: conversationId,
    } as any);

    // 3) 軽量モード検出（レスポンス/ヒント用）
    const detected = detectIntentMode(text);
    const finalMode: Exclude<IrosMode, 'auto'> = detected === 'auto' ? 'counsel' : detected;

    // 4) 生成（既存の runIrosChat をそのまま利用）
    const replyText: string = await runIrosChat({
      conversationId,
      userCode,
      text,
      modeHint: finalMode as any,
      extra,
    } as any);

    // ✅ 5) ここでは保存しない（single-writer は /reply に統一）
    // - iros_memory_state / iros_messages 等の保存は /reply 系に集約する
    // - この route.ts は「旧互換の生成ルート」として返すだけにする

    // 6) メタ
    const meta = {
      ts: new Date().toISOString(),
      mode_hint: detected,
      mode: finalMode,
      userCode,
      extra,
    };

    // 7) 応答（新旧互換 + jq用キー）
    return json(
      {
        ok: true,
        reply: replyText, // 新
        assistant: replyText, // 旧UI互換
        text: replyText, // jq '{mode, meta, text}'
        mode: finalMode,
        meta,
        layer: finalMode,
        credit,
      },
      200,
    );
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
