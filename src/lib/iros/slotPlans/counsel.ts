// src/lib/iros/slotPlans/counsel.ts
// iros — counsel slot plan (FINAL-only, stage-driven, loop-resistant)
//
// 目的：
// - counsel（相談）を「進行段階 stage」で前へ進める
// - 相談 → 共感 → 質問 → 共感 → 質問… のループを構造で遮断する
// - 3軸（S/R/I）や intent_anchor は “判断” ではなく “語り” の入力として受け取る（表現層で使う）
//
// 設計ルール（レポート準拠）
// - stage: OPEN → CLARIFY → OPTIONS → NEXT
// - 1 stage は最大2ターン（stage遷移ガードは orchestrator 側）
// - OPEN/CLARIFY は「質問記号（? / ？）」を使わない（質問は OPTIONS まで禁止）
// - slotPlanPolicy は常に FINAL
//
// このファイルは「話し方（slot配置）」のみ。
// stage更新 / IntentLock 判定 / topic抽出は orchestrator で行う。

import type { SlotPlanPolicy } from '../server/llmGate';

export type ConsultStage = 'OPEN' | 'CLARIFY' | 'OPTIONS' | 'NEXT';

export type CounselSlot = {
  key: string;
  role: 'assistant';
  style: 'neutral' | 'soft' | 'firm';
  content: string;
};

export type CounselSlotPlan = {
  kind: 'counsel';
  stamp: string;
  reason: string;
  slotPlanPolicy: SlotPlanPolicy; // 'FINAL'
  stage: ConsultStage;
  intentLocked: boolean;
  slots: CounselSlot[];
};

// ---- helpers ----

function norm(s: unknown) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function clamp(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

// OPEN/CLARIFY で「？」を出さない（禁止を破ると stage 設計が崩れる）
function noQM(s: string) {
  return s.replace(/[？\?]/g, '');
}

function softAnchorLine(args: {
  intentLocked: boolean;
  intentAnchorKey?: string | null;
}) {
  if (!args.intentLocked) return null;
  const k = norm(args.intentAnchorKey);
  if (!k) return '芯は保持する。';
  return `芯（${k}）に戻りながら進める。`;
}

// ---- slot builders ----

function buildOpenSlots(input: {
  userText: string;
  intentLocked: boolean;
  intentAnchorKey?: string | null;
  topic?: string | null;
  lastSummary?: string | null;
}): CounselSlot[] {
  const t = norm(input.userText);
  const a = softAnchorLine({
    intentLocked: input.intentLocked,
    intentAnchorKey: input.intentAnchorKey,
  });

  const topic = norm(input.topic);
  const topicLine = topic ? `話題は「${clamp(topic, 14)}」として扱う。` : '';

  const last = norm(input.lastSummary);
  const lastLine =
    last && last !== t ? `前回の要約：${clamp(last, 46)}` : '';

  // 質問禁止なので「教えて」で止める（?を使わない）
  return [
    {
      key: 'OBS',
      role: 'assistant',
      style: 'soft',
      content: noQM(
        `受け取った。${a ? ` ${a}` : ''}\n` +
          `${topicLine ? topicLine + '\n' : ''}` +
          `${lastLine ? lastLine + '\n' : ''}` +
          `いま出ている言葉：${t ? `「${clamp(t, 52)}」` : '（まだ言葉になっていない）'}`,
      ),
    },
    {
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content: noQM('まず整理に入る。材料を3つだけ置いて。事実 / 感情 / 望み（短文でOK）'),
    },
  ];
}

function buildClarifySlots(input: {
  userText: string;
  intentLocked: boolean;
  intentAnchorKey?: string | null;
  axis?: { S?: string | null; R?: string | null; I?: string | null } | null;
  lastSummary?: string | null;
}): CounselSlot[] {
  const a = softAnchorLine({
    intentLocked: input.intentLocked,
    intentAnchorKey: input.intentAnchorKey,
  });

  const S = norm(input.axis?.S);
  const R = norm(input.axis?.R);
  const I = norm(input.axis?.I);

  const axisLine =
    S || R || I
      ? `軸メモ：${S ? `S=${S} ` : ''}${R ? `R=${R} ` : ''}${I ? `I=${I}` : ''}`.trim()
      : '';

  const last = norm(input.lastSummary);
  const lastLine = last ? `前回の要約：${clamp(last, 52)}` : '';

  // ここも質問禁止：選択は「番号で返して」で止める（?を使わない）
  return [
    {
      key: 'OBS',
      role: 'assistant',
      style: 'soft',
      content: noQM(`整理する。${a ? ` ${a}` : ''}${axisLine ? `\n${axisLine}` : ''}${lastLine ? `\n${lastLine}` : ''}`),
    },
    {
      key: 'CLARIFY',
      role: 'assistant',
      style: 'neutral',
      content: noQM(
        `いまの相談は、だいたい3つの束に分かれる。\n` +
          `①状況の事実（何が起きているか）\n` +
          `②心の反応（何が削られているか）\n` +
          `③望み（どう在りたいか）`,
      ),
    },
    {
      key: 'PICK',
      role: 'assistant',
      style: 'neutral',
      content: noQM('いま一番先に扱う束を、①②③の番号で返して。'),
    },
  ];
}

function buildOptionsSlots(input: {
  intentLocked: boolean;
  intentAnchorKey?: string | null;
  topic?: string | null;
  lastSummary?: string | null;
}): CounselSlot[] {
  const a = softAnchorLine({
    intentLocked: input.intentLocked,
    intentAnchorKey: input.intentAnchorKey,
  });

  const topic = norm(input.topic);
  const topicLine = topic ? `（話題：${clamp(topic, 16)}）` : '';

  const last = norm(input.lastSummary);
  const lastLine = last ? `（前回：${clamp(last, 18)}）` : '';

  // OPTIONS から質問解禁（ここで初めて ? を使ってよい）
  return [
    {
      key: 'OBS',
      role: 'assistant',
      style: 'soft',
      content: `選択肢を出す。${a ? ` ${a}` : ''} ${topicLine} ${lastLine}`.trim(),
    },
    {
      key: 'OPTIONS',
      role: 'assistant',
      style: 'neutral',
      content:
        `次は3択で十分。\n` +
        `A) そのまま維持しつつ、条件を1つ変える（役割 / 時間 / 境界線）\n` +
        `B) いったん距離を取り、回復を優先する（休む /切る / 減らす）\n` +
        `C) 方向転換の設計に入る（期限 / 代替案 / 小さな実験）`,
    },
    {
      key: 'PICK',
      role: 'assistant',
      style: 'neutral',
      content: 'A/B/C どれを先にやる？（1文字でOK）',
    },
  ];
}

function buildNextSlots(input: {
  intentLocked: boolean;
  intentAnchorKey?: string | null;
  lastSummary?: string | null;
}): CounselSlot[] {
  const a = softAnchorLine({
    intentLocked: input.intentLocked,
    intentAnchorKey: input.intentAnchorKey,
  });

  const last = norm(input.lastSummary);
  const lastLine = last ? `（前回：${clamp(last, 28)}）` : '';

  // NEXT は「一手に落とす」。ここは “問い” より “宣言+手順” を優先する。
  return [
    {
      key: 'OBS',
      role: 'assistant',
      style: 'soft',
      content: `${a ? a + '\n' : ''}${lastLine ? lastLine + '\n' : ''}次の一手に落とす。`.trim(),
    },
    {
      key: 'NEXT',
      role: 'assistant',
      style: 'firm',
      content:
        `このあとやるのは1つだけ。\n` +
        `- 期限：今日（または24時間以内）\n` +
        `- 行動：メモ1枚に「事実 / 感情 / 望み」を各1行\n` +
        `- 送る文：その3行をそのまま貼る\n` +
        `これで次のターンで決定に入れる。`,
    },
    {
      key: 'SAFE',
      role: 'assistant',
      style: 'soft',
      content: '呼吸を戻す。🪔',
    },
  ];
}

// ---- main ----

export function buildCounselSlotPlan(args: {
  userText: string;
  stage: ConsultStage;

  // Intent Lock（orchestrator で判定して渡す）※任意（未指定でも動く）
  intentLocked?: boolean;
  intentAnchorKey?: string | null;

  // 3軸/話題（orchestrator で推定して渡す。ここでは語りに使うだけ）※任意
  axis?: { S?: string | null; R?: string | null; I?: string | null } | null;
  topic?: string | null;

  // orchestrator から渡す（無ければ null）※任意
  lastSummary?: string | null;
}): CounselSlotPlan {
  const stamp = 'counsel.ts@2026-01-10#stage-v1';

  const userText = norm(args.userText);

  const lastSummary =
    typeof args.lastSummary === 'string' && args.lastSummary.trim().length > 0
      ? args.lastSummary.trim()
      : null;

  const intentLocked = args.intentLocked === true;

  const intentAnchorKey =
    typeof args.intentAnchorKey === 'string' && args.intentAnchorKey.trim().length > 0
      ? args.intentAnchorKey.trim()
      : null;

  let slots: CounselSlot[] = [];
  let reason = 'default';

  switch (args.stage) {
    case 'OPEN':
      reason = 'stage:OPEN';
      slots = buildOpenSlots({
        userText,
        intentLocked,
        intentAnchorKey,
        topic: args.topic ?? null,
        lastSummary,
      });
      break;

    case 'CLARIFY':
      reason = 'stage:CLARIFY';
      slots = buildClarifySlots({
        userText,
        intentLocked,
        intentAnchorKey,
        axis: args.axis ?? null,
        lastSummary,
      });
      break;

    case 'OPTIONS':
      reason = 'stage:OPTIONS';
      slots = buildOptionsSlots({
        intentLocked,
        intentAnchorKey,
        topic: args.topic ?? null,
        lastSummary,
      });
      break;

    case 'NEXT':
      reason = 'stage:NEXT';
      slots = buildNextSlots({
        intentLocked,
        intentAnchorKey,
        lastSummary,
      });
      break;

    default:
      reason = 'stage:fallback->OPEN';
      slots = buildOpenSlots({
        userText,
        intentLocked,
        intentAnchorKey,
        topic: args.topic ?? null,
        lastSummary,
      });
      break;
  }

  return {
    kind: 'counsel',
    stamp,
    reason,
    slotPlanPolicy: 'FINAL',
    stage: args.stage,
    intentLocked,
    slots,
  };
}
