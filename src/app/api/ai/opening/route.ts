// src/app/api/ai/opening/route.ts
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { buildSystemPrompt, buildUserPrompt } from '@/lib/mui/buildSystemPrompt';
import { phaseTemplate } from '@/lib/mui/prompt';
import {
  type AiOpening,
  type ConversationStage,
  type AgentMuiPayload,
} from '@/lib/mui/types';
import { callAgentMui, parseAgentTextToUi } from '@/lib/mui/api';

/**
 * Request Body 期待形
 * {
 *   rawText: string;          // OCR整形後の本文（A/B等を含んでOK）
 *   summary?: string;         // 要約（なければサーバ側で空文字）
 *   goal?: string;            // ユーザーの任意目標
 *   conversationId: string;   // 会話スレッドID
 *   userId: string;           // ユーザー識別子
 *   intentCategory?: string;  // ocr-intent の選択（任意）
 * }
 */

export async function POST(req: NextRequest) {
  try {
    const {
      rawText,
      summary = '',
      goal = '',
      conversationId,
      userId,
      intentCategory,
    } = (await req.json()) as {
      rawText: string;
      summary?: string;
      goal?: string;
      conversationId: string;
      userId: string;
      intentCategory?: string;
    };

    if (!rawText || !conversationId || !userId) {
      return NextResponse.json(
        { ok: false, error: 'missing_required_fields' },
        { status: 400 },
      );
    }

    // 開幕は常に Stage=1 を起動（無料フェーズのティザー）
    const stage: ConversationStage = 1;

    // System / User プロンプト生成
    const system = buildSystemPrompt();

    // “言い切り”の種（LLMにヒントとして渡す）
    const t = phaseTemplate(stage);
    const seedHint = [
      '--- seed ---',
      t.seed,
      `chips: ${t.chips.join(' / ')}`,
      `first_question: ${t.question}`,
      intentCategory ? `intent: ${intentCategory}` : '',
      '--- end seed ---',
    ]
      .filter(Boolean)
      .join('\n');

    const user = buildUserPrompt('opening', `${rawText}\n\n${seedHint}`, summary, goal);

    // agent/mui を叩く
    const payload: AgentMuiPayload = { system, user, phase: 'opening' };
    const agentRes = await callAgentMui<any>(payload);

    // agent 出力 → UI スキーマへ
    let message = '';
    let question = '';
    let chips: string[] = [];

    if (typeof agentRes === 'string') {
      const parsed = parseAgentTextToUi(agentRes);
      message = parsed.message;
      question = parsed.question;
      chips = parsed.chips.length ? parsed.chips : t.chips;
    } else if (agentRes?.message || agentRes?.question) {
      // 生成側がJSONで返した場合の緩衝
      message = String(agentRes.message ?? '').trim();
      question = String(agentRes.question ?? '').trim() || t.question;
      chips = Array.isArray(agentRes.chips) ? agentRes.chips : t.chips;
      if (!message) {
        const parsed = parseAgentTextToUi(
          [agentRes.line1, agentRes.line2, agentRes.line3, agentRes.question]
            .filter(Boolean)
            .join('\n'),
        );
        message = parsed.message;
        question = parsed.question || t.question;
        chips = parsed.chips.length ? parsed.chips : t.chips;
      }
    } else {
      // フォールバック（LLM失敗時でもUIが動くように固定文）
      message = [
        'いまの主旋律は不安と悔しさです。',
        'まずは感情の輪郭を言い切って整えます。',
        'ここから不安→信頼へ調律します。',
      ].join('\n');
      question = t.question;
      chips = t.chips;
    }

    const body: AiOpening = {
      opening_message: message,
      focus: '感情整理',
      next_question: question,
      chips,
      risk_level: 0,
    };

    return NextResponse.json(body);
  } catch (e) {
    console.warn('[opening] failed', e);
    // さらに堅いフォールバック
    const t = phaseTemplate(1);
    const body: AiOpening = {
      opening_message:
        'まずは感情の位置を特定します。\n主旋律は不安寄り。ここから整えます。',
      focus: '感情整理',
      next_question: t.question,
      chips: t.chips,
      risk_level: 0,
    };
    return NextResponse.json(body, { status: 200 });
  }
}
