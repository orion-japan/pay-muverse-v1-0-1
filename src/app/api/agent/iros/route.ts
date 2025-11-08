// /src/app/api/iros/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize, normalizeAuthz } from '@/lib/authz';
import { reserveAndSpendCredit } from '@/lib/mu/credits';
import { runIrosChat } from '@/lib/iros/openai';
import { saveIrosMemory } from '@/lib/iros/memory';
import type { IrosChatRequest, IrosChatResponse, IrosMemory } from '@/lib/iros/types';

const COST_CHAT = 1;

function json<T>(b: T, status = 200) {
  return NextResponse.json(b, { status });
}
function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return (h >>> 0).toString(36);
}
function extractKeyword(s: string) {
  const m = (s.match(/[一-龠々〆ヵヶァ-ヶｦ-ﾝa-zA-Z0-9]{2,}/g) || []).slice(0, 3);
  return m.join(' ').toLowerCase();
}

// ...前略（ファイル冒頭は現状のまま）

export async function POST(req: NextRequest) {
  try {
    // 1) 認証
    const authz = await verifyFirebaseAndAuthorize(req);
    const { user, error: authErr } = normalizeAuthz(authz);
    if (!user) return json<IrosChatResponse>({ ok: false, error: authErr || 'Unauthorized' }, 401);

    // 2) 入力（互換吸収）
    const raw = await req.json();
    const payload = {
      conversationId: raw.conversationId ?? raw.conversation_id,
      userText:       raw.userText ?? raw.user_text,
      mode:           raw.mode ?? raw.payload_mode ?? 'auto',
      idempotencyKey: raw.idempotencyKey ?? raw.idempotency_key,
    } as IrosChatRequest;

    if (!payload.conversationId || !payload.userText) {
      return json<IrosChatResponse>({ ok: false, error: 'INVALID_REQUEST' }, 400);
    }

    // 3) 課金
    const idem = payload.idempotencyKey || `iros:${payload.conversationId}:${hash(payload.userText)}`;
    const credit = await reserveAndSpendCredit({
      user_code: user.user_code,
      amount: COST_CHAT,
      reason: 'iros.chat',
      meta: { conversationId: payload.conversationId, idem },
    });
    if (!credit.ok) {
      return json<IrosChatResponse>({ ok: false, error: credit.error || 'CREDIT_FAILED' }, 402);
    }

    // 4) LLM（runIrosChat は string を返す）
    const replyText: string = await runIrosChat({
      model: process.env.IROS_MODEL || 'gpt-4o-mini',
      system: process.env.IROS_SYSTEM_PROMPT || 'You are Iros, a concise partner AI. Reply briefly and kindly.',
      history: [], // ※必要なら直近履歴を詰める
      user_text: payload.userText,
      temperature: 0.4,
      max_tokens: 420,
    });

    // 4.5) 簡易 layer 推定（後で focusCore に置換）
    const layer: 'Core' | 'Surface' = (replyText?.length || 0) >= 200 ? 'Core' : 'Surface';

    // 5) メモリ（非致命）
    const mem: IrosMemory = {
      depth: layer === 'Core' ? 'I1' : 'S2',
      tone: 'calm',
      theme: 'general',
      summary: replyText.slice(0, 240),
      last_keyword: extractKeyword(payload.userText),
    };
    try {
      await saveIrosMemory({ conversationId: payload.conversationId, user_code: user.user_code, mem });
    } catch (e) {
      console.warn('[iros.memory] non-fatal:', e);
    }

    // 6) 応答（新旧クライアント両対応のキーで返す）
    return json<IrosChatResponse & { assistant: string }>({
      ok: true,
      reply: replyText,         // 新API
      assistant: replyText,     // 旧UIの `assistant` 参照に対応
      layer,
      credit,
      memory: mem,
    });
  } catch (e: any) {
    return json<IrosChatResponse>({ ok: false, error: String(e?.message || e) }, 500);
  }
}

