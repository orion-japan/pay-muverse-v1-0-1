// src/lib/iros/slotPlans/counsel.ts
// iros — counsel slot plan (FINAL-only, stage-driven, loop-resistant)
//
// 目的：
// - counsel（相談）を「進行段階 stage」で前へ進める
// - 相談 → 共感 → 質問 → 共感 → 質問… のループを構造で遮断する
// - ただし “箱テンプレ / A/B/C / 口癖テンプレ” を出さず、通常会話（GPTっぽい）で進める
//
// 設計ルール（更新）
// - stage: OPEN → CLARIFY → OPTIONS → NEXT
// - OPEN/CLARIFY は「? / ？」を使わない（質問記号は禁止）
// - 質問は最大1つ（出す場合は OPTIONS でのみ）
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
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
}

function clamp(s: string, n: number) {
  const t = norm(s);
  if (t.length <= n) return t;
  return t.slice(0, Math.max(0, n - 1)) + '…';
}

// OPEN/CLARIFY で「？」を出さない（禁止を破ると stage 設計が崩れる）
function noQM(s: string) {
  return norm(s).replace(/[？\?]/g, '');
}

function isShortOrThin(t: string) {
  const s = norm(t);
  if (!s) return true;
  if (s.length <= 8) return true;
  return /^(うん|はい|そう|なるほど|わかった|OK|了解|たしかに|えー|まじ)+[。！？!?…]*$/.test(s);
}

function looksLikeQuestion(t: string) {
  const s = norm(t);
  if (!s) return false;
  return /[？?]/.test(s) || /(どう(すれば|したら)|なぜ|なんで|何が|何を|どこ|いつ|どれ)/.test(s);
}

function softAnchorLine(args: { intentLocked: boolean; intentAnchorKey?: string | null }) {
  if (!args.intentLocked) return null;
  const k = norm(args.intentAnchorKey);
  if (!k) return '芯は保持して進める。';
  return `芯（${clamp(k, 10)}）は保ったまま進める。`;
}

function topicLine(topic?: string | null) {
  const t = norm(topic);
  return t ? `話題は「${clamp(t, 18)}」として扱う。` : '';
}

function lastLine(lastSummary?: string | null, userText?: string | null) {
  const last = norm(lastSummary);
  const now = norm(userText);
  if (!last) return '';
  if (now && last === now) return '';
  return `前回の要約：${clamp(last, 64)}`;
}

// ---- slot builders ----
//
// ここでは「箱」や「A/B/C」などの固定テンプレを出さない。
// GPTっぽく：拾う → 置く → 次に渡す（必要なら1問）
// ただし質問ループを避けるため、OPEN/CLARIFY は “促し” で止める（?は使わない）。

function buildOpenSlots(input: {
  userText: string;
  intentLocked: boolean;
  intentAnchorKey?: string | null;
  topic?: string | null;
  lastSummary?: string | null;
}): CounselSlot[] {
  const t = norm(input.userText);
  const a = softAnchorLine({ intentLocked: input.intentLocked, intentAnchorKey: input.intentAnchorKey });
  const tp = topicLine(input.topic);
  const ls = lastLine(input.lastSummary, t);

  // OPEN：共感テンプレに逃げない（「消耗してるんだね」等の固定句を置かない）
  // 代わりに：いま出ている言葉をそのまま拾って「続けていい」を渡す
  const obs = [
    t ? `いま出ている言葉：${clamp(t, 70)}` : 'まだ言葉になっていない感じも含めて大丈夫。',
    a ?? '',
    tp,
    ls,
  ]
    .filter(Boolean)
    .join('\n');

  const shift = isShortOrThin(t)
    ? '短い一言でも足りる。続きだけ、そのまま投げて。'
    : 'うまくまとめなくていい。出ている順で、そのまま続けて。';

  const safe = '急がない。ここはまず、状況が見えるところまで並べる。';

  return [
    { key: 'OBS', role: 'assistant', style: 'soft', content: noQM(obs) },
    { key: 'SHIFT', role: 'assistant', style: 'neutral', content: noQM(shift) },
    { key: 'SAFE', role: 'assistant', style: 'soft', content: noQM(safe) },
  ];
}

function buildClarifySlots(input: {
  userText: string;
  intentLocked: boolean;
  intentAnchorKey?: string | null;
  axis?: { S?: string | null; R?: string | null; I?: string | null } | null;
  topic?: string | null;
  lastSummary?: string | null;
}): CounselSlot[] {
  const t = norm(input.userText);
  const a = softAnchorLine({ intentLocked: input.intentLocked, intentAnchorKey: input.intentAnchorKey });
  const tp = topicLine(input.topic);
  const ls = lastLine(input.lastSummary, t);

  const S = norm(input.axis?.S);
  const R = norm(input.axis?.R);
  const I = norm(input.axis?.I);
  const axisLine = S || R || I ? `メモ：${[S ? `S=${clamp(S, 14)}` : '', R ? `R=${clamp(R, 14)}` : '', I ? `I=${clamp(I, 14)}` : ''].filter(Boolean).join(' ')}` : '';

  // CLARIFY：質問はしない（?禁止）
  // 代わりに：「いま何を先に扱うか」を “選択” ではなく “指差し” で返してもらう
  const obs = [a ?? '', tp, ls, axisLine].filter(Boolean).join('\n');

  const clarify = [
    'いまの相談は、焦点を一つに寄せたほうが早い。',
    '先に触る場所だけ決める。',
  ].join('\n');

  const pick = looksLikeQuestion(t)
    ? 'いまの「どうしたらいい」は、どの種類の困り方に近いかだけ置いて。状況／人／自分の反応／今後の選択'
    : 'いま一番つらいのが「出来事」なのか「反応」なのか「これからの選択」なのかだけ、言葉で置いて。';

  return [
    { key: 'OBS', role: 'assistant', style: 'soft', content: noQM(obs || '整理する。') },
    { key: 'CLARIFY', role: 'assistant', style: 'neutral', content: noQM(clarify) },
    { key: 'PICK', role: 'assistant', style: 'neutral', content: noQM(pick) },
  ];
}

function buildOptionsSlots(input: {
  userText: string;
  intentLocked: boolean;
  intentAnchorKey?: string | null;
  topic?: string | null;
  lastSummary?: string | null;
}): CounselSlot[] {
  const t = norm(input.userText);
  const a = softAnchorLine({ intentLocked: input.intentLocked, intentAnchorKey: input.intentAnchorKey });
  const tp = topicLine(input.topic);
  const ls = lastLine(input.lastSummary, t);

  // OPTIONS：ここでだけ 0-1問まで許可（? OK）
  // A/B/Cの記号は禁止に寄せる（番号はOKだが、強制選択に見えない形で）
  const obs = [a ?? '', tp, ls].filter(Boolean).join('\n');

  const options = [
    'いま取れる手は、大きく3つに分けられる。',
    '1) 現状の中で負荷を減らす（境界線／役割／時間の切り分け）',
    '2) いったん距離を取って回復を優先する（休む／減らす／逃がす）',
    '3) 方向転換の準備に入る（期限／代替案／小さな試し）',
  ].join('\n');

  const pick = 'どれがいまの実感に一番近い？（1/2/3でOK）';

  return [
    { key: 'OBS', role: 'assistant', style: 'soft', content: norm(obs || '選択肢を出す。') },
    { key: 'OPTIONS', role: 'assistant', style: 'neutral', content: norm(options) },
    { key: 'PICK', role: 'assistant', style: 'neutral', content: norm(pick) },
  ];
}

function buildNextSlots(input: {
  userText: string;
  intentLocked: boolean;
  intentAnchorKey?: string | null;
  lastSummary?: string | null;
}): CounselSlot[] {
  const t = norm(input.userText);
  const a = softAnchorLine({
    intentLocked: input.intentLocked,
    intentAnchorKey: input.intentAnchorKey,
  });
  const ls = lastLine(input.lastSummary, t);

  // NEXT：口癖テンプレ禁止（「呼吸を戻す」等は出さない）
  // “命令”ではなく “次に出す材料” を軽く指定する
  const obs = [a ?? '', ls].filter(Boolean).join('\n');

  const next = [
    '次は、材料を一つだけ足す。',
    '・いま一番削られているもの（体力／時間／尊厳／安心／関係）',
    'これが分かると、選ぶ手が決まる。',
  ].join('\n');

  const safe = '無理に整えなくていい。短文で十分。';

  const slots: CounselSlot[] = [
    { key: 'OBS', role: 'assistant', style: 'soft', content: norm(obs || '') },
    { key: 'NEXT', role: 'assistant', style: 'firm', content: norm(next) },
    { key: 'SAFE', role: 'assistant', style: 'soft', content: norm(safe) },
  ];

  // 型を落とさずに空を除去
  return slots.filter((s): s is CounselSlot => !!norm(s.content));
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
  const stamp = 'counsel.ts@2026-01-17#stage-v2-gptlike';

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
        topic: args.topic ?? null,
        lastSummary,
      });
      break;

    case 'OPTIONS':
      reason = 'stage:OPTIONS';
      slots = buildOptionsSlots({
        userText,
        intentLocked,
        intentAnchorKey,
        topic: args.topic ?? null,
        lastSummary,
      });
      break;

    case 'NEXT':
      reason = 'stage:NEXT';
      slots = buildNextSlots({
        userText,
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
