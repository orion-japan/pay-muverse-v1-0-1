// src/lib/iros/seed/humanContextOrchestrator.ts
//
// iros — Human Context Orchestrator v1
//
// 役割:
// - 180状態 / 3軸 / Qコード / questionType / futureRandom を、Writer向けの返答軸へ翻訳する
// - Writerが「現在状態」と「未来候補」を混ぜないようにする
// - 本文は作らず、Writerに渡す司令塔SEEDだけを作る

import { parseFlowStateId } from '../flow/flow180';

export type HumanReplyAxis = 'S' | 'R' | 'C' | 'I' | 'T' | 'F';
export type HumanTrustLevel = 'low' | 'medium' | 'high';

export type HumanContextOrchestratorInput = {
  userText?: string | null;

  currentFlow?: string | null;
  futureFlowRandom?: string | null;

  qCode?: string | null;
  depthStage?: string | null;
  phase?: string | null;

  questionType?: string | null;
  spinLoop?: string | null;
  spinStep?: number | null;

  returnStreak?: number | null;
  confidence?: number | null;

  currentMeaning?: string | null;
  transferMeaning?: string | null;
  currentReplyFocus?: string | null;
  futureReplyFocus?: string | null;
};

export type HumanContextOrchestratorResult = {
  ok: boolean;
  replyAxisPrimary: HumanReplyAxis;
  replyAxisSecondary: HumanReplyAxis | null;
  avoidAxis: string[];

  currentMeaning: string | null;
  futureMeaning: string | null;
  qContext: string | null;

  trustLevel: HumanTrustLevel;
  replyFocus: string;
  avoidReply: string[];
  writerDirective: string;

  seedText: string;
};

function norm(value: unknown): string {
  return String(value ?? '').trim();
}

function compact(value: unknown): string {
  return norm(value).replace(/\s+/g, ' ');
}

function axisFromDepthStage(depthStage: string | null | undefined): HumanReplyAxis | null {
  const s = norm(depthStage).toUpperCase();
  const head = s.charAt(0);
  if (head === 'S') return 'S';
  if (head === 'R') return 'R';
  if (head === 'C') return 'C';
  if (head === 'I') return 'I';
  if (head === 'T') return 'T';
  if (head === 'F') return 'F';
  return null;
}

function axisFromFlow(flow: string | null | undefined): HumanReplyAxis | null {
  const parsed = parseFlowStateId(norm(flow));
  return axisFromDepthStage(parsed?.stage ?? null);
}

function axisFromSpin(spinLoop: string | null | undefined, spinStep: number | null | undefined): HumanReplyAxis | null {
  const loop = norm(spinLoop).toUpperCase();
  const step = typeof spinStep === 'number' && Number.isFinite(spinStep) ? spinStep : null;

  if (loop === 'SRI') {
    if (step === 0) return 'S';
    if (step === 1) return 'R';
    if (step === 2) return 'I';
  }

  if (loop === 'TCF') {
    if (step === 0) return 'T';
    if (step === 1) return 'C';
    if (step === 2) return 'F';
  }

  return null;
}

function detectQuestionAxis(userText: string, questionType: string | null | undefined): HumanReplyAxis | null {
  const qt = norm(questionType).toLowerCase();
  const t = compact(userText);

  if (
    qt === 'future_design' ||
    qt === 'intent' ||
    qt === 'meaning' ||
    /(目的|意味|意図|未来|この先|見据える|方向性|展望|何を大事|何を中心)/.test(t)
  ) {
    return 'I';
  }

  if (/(どう送|なんて送|どう伝え|何をすれば|どう動|実装|作る|形にする|手順|具体)/.test(t)) {
    return 'C';
  }

  if (/(彼|彼女|相手|関係|恋愛|連絡|返信|既読|未読|どう思って|気持ち)/.test(t)) {
    return 'R';
  }

  if (/(心理状態|今の状態|現在地|自分の状態|気持ち|内面)/.test(t)) {
    return 'S';
  }

  return null;
}

function secondaryFor(primary: HumanReplyAxis): HumanReplyAxis | null {
  if (primary === 'S') return 'I';
  if (primary === 'R') return 'S';
  if (primary === 'I') return 'C';
  if (primary === 'C') return 'F';
  if (primary === 'T') return 'I';
  if (primary === 'F') return 'C';
  return null;
}

function buildAvoidAxis(primary: HumanReplyAxis, userText: string): string[] {
  const t = compact(userText);
  const avoid: string[] = [];

  if (primary === 'I') {
    avoid.push('S_only');
    avoid.push('unsupported_conflict_story');
  }

  if (primary === 'S') {
    avoid.push('C_too_early');
  }

  if (primary === 'R') {
    avoid.push('R_guess');
    avoid.push('mind_reading');
  }

  if (primary === 'C') {
    avoid.push('I_overreach');
    avoid.push('abstract_only');
  }

  if (/(未来|この先|見据える|展望)/.test(t)) {
    avoid.push('mix_future_random_into_current_state');
  }

  return Array.from(new Set(avoid));
}

function buildQContext(qCode: string | null | undefined): string | null {
  const q = norm(qCode).toUpperCase();

  if (q === 'Q1') return '整理し、納得できる形で未来や目的を見たい傾向。勢いより、崩れない順番を重視する。';
  if (q === 'Q2') return '成長や突破の方向を求めやすい傾向。止まるより、動かす理由を見つけたい。';
  if (q === 'Q3') return '安心できる中心や基盤を求めやすい傾向。落ち着いて受け取れる形が重要になる。';
  if (q === 'Q4') return '流れや関係の通り道を感じ取りやすい傾向。受け取りすぎず、自分の流れも保つ必要がある。';
  if (q === 'Q5') return '熱や表現、喜びの回復を求めやすい傾向。自分の反応が戻る方向が重要になる。';

  return null;
}

function trustFrom(confidence: number | null | undefined, returnStreak: number | null | undefined): HumanTrustLevel {
  const c = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : null;
  const r = typeof returnStreak === 'number' && Number.isFinite(returnStreak) ? returnStreak : 0;

  if (c != null && c >= 0.72 && r <= 1) return 'high';
  if (c != null && c < 0.45) return 'low';
  return 'medium';
}

function buildReplyFocus(primary: HumanReplyAxis, secondary: HumanReplyAxis | null): string {
  if (primary === 'S') return secondary === 'I' ? '現在地を受け取り、その先の方向へつなげる。' : '現在地を中心に返す。';
  if (primary === 'R') return '関係や相手とのズレを扱う。ただし相手の本心は断定しない。';
  if (primary === 'I') return '目的・意味・未来の方向を主軸に返す。心理状態の説明だけで閉じない。';
  if (primary === 'C') return '現実の一歩や形にする方向を返す。抽象論だけで終わらせない。';
  if (primary === 'T') return '全体視点で統合する。ただし飛躍した断定は避ける。';
  if (primary === 'F') return '外に出す形、伝え方、輪郭を整える。';
  return '今回の主軸に沿って返す。';
}

function buildWriterDirective(args: {
  primary: HumanReplyAxis;
  secondary: HumanReplyAxis | null;
  currentFlow: string | null;
  futureFlowRandom: string | null;
  currentMeaning: string | null;
  transferMeaning: string | null;
}): string {
  const { primary, secondary, currentFlow, futureFlowRandom, currentMeaning, transferMeaning } = args;

  const parts = [
    `本文は${primary}${secondary ? `→${secondary}` : ''}の視点を主軸にする。`,
    currentFlow ? `currentFlow=${currentFlow} は現在状態としてだけ扱う。` : '',
    futureFlowRandom ? `futureFlowRandom=${futureFlowRandom} は未来候補としてだけ扱い、現在の心理状態へ混ぜない。` : '',
    currentMeaning ? `現在意味: ${currentMeaning}` : '',
    transferMeaning ? `移管意味: ${transferMeaning}` : '',
    primary === 'I' ? '目的・意味・未来を中心に返し、ユーザー発話にない対立構造を足さない。' : '',
    primary === 'R' ? '相手の本心断定を避け、関係の受け取り方として返す。' : '',
    primary === 'C' ? '具体へ落とすが、手順を増やしすぎない。' : '',
  ].filter(Boolean);

  return parts.join(' ');
}

export function buildHumanContextOrchestration(
  input: HumanContextOrchestratorInput,
): HumanContextOrchestratorResult {
  const userText = norm(input.userText);

  const questionAxis = detectQuestionAxis(userText, input.questionType);
  const flowAxis = axisFromFlow(input.currentFlow);
  const depthAxis = axisFromDepthStage(input.depthStage);
  const spinAxis = axisFromSpin(input.spinLoop, input.spinStep);

  const replyAxisPrimary =
    questionAxis ??
    flowAxis ??
    depthAxis ??
    spinAxis ??
    'S';

  const replyAxisSecondary = secondaryFor(replyAxisPrimary);
  const avoidAxis = buildAvoidAxis(replyAxisPrimary, userText);
  const qContext = buildQContext(input.qCode);
  const trustLevel = trustFrom(input.confidence, input.returnStreak);
  const replyFocus = buildReplyFocus(replyAxisPrimary, replyAxisSecondary);

  const avoidReply = [
    ...avoidAxis,
    'do_not_expose_internal_codes',
    'do_not_invent_unprovided_story',
  ];

  const currentMeaning = norm(input.currentMeaning) || null;
  const futureMeaning =
    norm(input.transferMeaning) ||
    (norm(input.futureFlowRandom)
      ? 'futureFlowRandom は未来候補としてのみ扱う。現在状態とは分ける。'
      : null);

  const writerDirective = buildWriterDirective({
    primary: replyAxisPrimary,
    secondary: replyAxisSecondary,
    currentFlow: norm(input.currentFlow) || null,
    futureFlowRandom: norm(input.futureFlowRandom) || null,
    currentMeaning,
    transferMeaning: norm(input.transferMeaning) || null,
  });

  const lines = [
    'HUMAN_CONTEXT_ORCHESTRATION (DO NOT OUTPUT):',
    `REPLY_AXIS_PRIMARY=${replyAxisPrimary}`,
    replyAxisSecondary ? `REPLY_AXIS_SECONDARY=${replyAxisSecondary}` : null,
    avoidAxis.length ? `AVOID_AXIS=${avoidAxis.join(', ')}` : null,
    currentMeaning ? `CURRENT_MEANING=${currentMeaning}` : null,
    futureMeaning ? `FUTURE_MEANING=${futureMeaning}` : null,
    qContext ? `Q_CONTEXT=${qContext}` : null,
    `TRUST_LEVEL=${trustLevel}`,
    `REPLY_FOCUS=${replyFocus}`,
    avoidReply.length ? `AVOID_REPLY=${avoidReply.join(' / ')}` : null,
    `WRITER_DIRECTIVE=${writerDirective}`,
  ].filter((v): v is string => Boolean(v));

  return {
    ok: true,
    replyAxisPrimary,
    replyAxisSecondary,
    avoidAxis,
    currentMeaning,
    futureMeaning,
    qContext,
    trustLevel,
    replyFocus,
    avoidReply,
    writerDirective,
    seedText: lines.join('\n').trim(),
  };
}
