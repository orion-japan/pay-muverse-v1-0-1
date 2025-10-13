// src/app/api/ai/phase/route.ts
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { buildSystemPrompt, buildUserPrompt } from '@/lib/mui/buildSystemPrompt';
import { phaseTemplate } from '@/lib/mui/prompt';
import { callAgentMui, parseAgentTextToUi, saveStage } from '@/lib/mui/api';
import {
  type ConversationStage,
  type AgentMuiPayload,
  type AiTurn,
} from '@/lib/mui/types';
import { createClient } from '@supabase/supabase-js';

// ───────────────────────────────────────────────────────────────
// Supabase
function must(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
const supa = createClient(
  must('NEXT_PUBLIC_SUPABASE_URL'),
  must('SUPABASE_SERVICE_ROLE_KEY')
);

// 権利チェック（p2/p3/p4 or bundle のどれか）
async function hasEntitlement(userId: string, stage: ConversationStage) {
  const { data, error } = await supa
    .from('mui_entitlements')
    .select('bundle,p2,p3,p4')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return false;
  if (!data) return false;
  if (data.bundle) return true;
  if (stage === 2) return !!data.p2;
  if (stage === 3) return !!data.p3;
  if (stage === 4) return !!data.p4;
  return false;
}

// ───────────────────────────────────────────────────────────────
// Body 期待形：
// {
//   "stage": 2|3|4,          // 2以降は有料
//   "userReply": string,     // 直前ターンのユーザー入力（chipsでも自由文でも）
//   "rawText": string,       // OCR整形本文
//   "summary": string,       // 要約（任意）
//   "goal": string,          // ユーザー目標（任意）
//   "conversationId": string,
//   "userId": string
// }
export async function POST(req: NextRequest) {
  try {
    const {
      stage,
      userReply = '',
      rawText = '',
      summary = '',
      goal = '',
      conversationId,
      userId,
    } = (await req.json()) as {
      stage: ConversationStage;
      userReply?: string;
      rawText?: string;
      summary?: string;
      goal?: string;
      conversationId: string;
      userId: string;
    };

    if (!stage || !conversationId || !userId) {
      return NextResponse.json(
        { ok: false, error: 'missing_required_fields' },
        { status: 400 }
      );
    }

    // ── 課金ガード（Stage 2〜4） ──
    if (stage >= 2) {
      const entitled = await hasEntitlement(userId, stage);
      if (!entitled) {
        // フロントはこれを受けて PAY.JP モーダルを表示 → /api/payjp/charge へ
        return NextResponse.json(
          { ok: false, error: 'payment_required', stage },
          { status: 402 }
        );
      }
    }

    // ── LLM 呼び出し ──
    const system = buildSystemPrompt();
    const t = phaseTemplate(stage);
    const seedHint = [
      '--- seed ---',
      t.seed,
      `chips: ${t.chips.join(' / ')}`,
      `first_question: ${t.question}`,
      '--- end seed ---',
    ].join('\n');

    const user = buildUserPrompt(stage, `${rawText}\n\n${seedHint}`, summary, goal, userReply);
    const payload: AgentMuiPayload = { system, user, phase: stage };
    const agentRes = await callAgentMui<any>(payload);

    // ── 出力整形（テキスト or JSON の両対応）──
    let message = '';
    let question = '';
    let chips: string[] = [];
    let resultForSave: any = null;

    if (typeof agentRes === 'string') {
      const parsed = parseAgentTextToUi(agentRes);
      message = parsed.message;
      question = parsed.question || t.question;
      chips = parsed.chips.length ? parsed.chips : t.chips;
    } else {
      message = String(agentRes.message ?? '').trim();
      question = String(agentRes.question ?? '').trim() || t.question;
      chips = Array.isArray(agentRes.chips) && agentRes.chips.length ? agentRes.chips : t.chips;
      resultForSave = agentRes.resultForSave ?? null;

      if (!message) {
        const parsed = parseAgentTextToUi(
          [agentRes.line1, agentRes.line2, agentRes.line3, agentRes.question]
            .filter(Boolean)
            .join('\n')
        );
        message = parsed.message;
        question = parsed.question || t.question;
        chips = parsed.chips.length ? parsed.chips : t.chips;
      }
    }

    // ── 保存（あなたの stage/save API にそのまま送る）──
    const subId = (`stage${stage}-1`) as
      | 'stage2-1' | 'stage3-1' | 'stage4-1' | 'stage1-1'; // 型満たし用
    await saveStage({
      user_code: userId,
      seed_id: conversationId,
      sub_id: subId,
      phase: 'Mixed',              // Inner/Outer/Bridge/Flow/Calm と併用するならUI側で差し替え
      depth_stage: 'R3',
      q_current: ('Q' + String(stage)) as any,
      next_step: chips.join('/'),
      result: resultForSave ?? {
        stage,
        summary,
        userReply,
        extracted: { chips, question },
      },
      tone: { phase: stage, guardrails: ['3行ルール', '断定調', '非断罪'] },
    });

    const body: AiTurn = {
      message: message || '次の一歩を短く言い切りましょう。',
      next_question: question || t.question,
      chips,
      risk_level: 0,
      phase_done: stage === 4,
    };

    return NextResponse.json(body);
  } catch (e) {
    console.warn('[phase] failed', e);
    // 失敗フォールバック（UIを止めない）
    const t = phaseTemplate(2);
    const body: AiTurn = {
      message: '事実だけを短く並べます。回数とタイミングだけでOKです。',
      next_question: t.question,
      chips: t.chips,
      risk_level: 0,
    };
    return NextResponse.json(body, { status: 200 });
  }
}
