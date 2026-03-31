// src/lib/iros/diagnosis/buildDiagnosisMeaning.ts
//
// ir診断専用の意味エンジン
//
// 役割：
// - FLOW180 の now / future 2点から
//   「いま何が起きているか」
//   「どこへ動いているか」
//   「今回の診断の核は何か」
//   「次にどう動くとよいか」
//   「何に注意すべきか」
//   を診断用の意味オブジェクトとして返す
//
// 注意：
// - ここでは本文テンプレは作らない
// - buildDiagnosisText.ts 側は「表現」だけを担う
// - 通常ターン用の意味エンジンとは分ける

import {
  buildFlowDelta,
  parseFlowStateId,
  type FlowStateId,
} from '../flow/flow180';

export type DiagnosisMeaning = {
  currentState: string;
  movement: string;
  diagnosisFocus: string;
  recommendation: string;
  caution: string | null;
  stageShift: string;
  emotionShift: string;
  polarityShift: string;
  deltaType: string | null;
  deltaShort: string;
  deltaSentence: string;
};

type StageBand = 'S' | 'R' | 'C' | 'I' | 'T';
type EmotionBand = 'e1' | 'e2' | 'e3' | 'e4' | 'e5';
type Polarity = 'pos' | 'neg';

function getStageBand(flowId: FlowStateId): StageBand {
  const parsed = parseFlowStateId(flowId) as any;
  const stage = String(parsed?.stage ?? parsed?.depthStage ?? '')
    .trim()
    .toUpperCase();

  if (stage.startsWith('S')) return 'S';
  if (stage.startsWith('R')) return 'R';
  if (stage.startsWith('C')) return 'C';
  if (stage.startsWith('I')) return 'I';
  return 'T';
}

function getEmotionBand(flowId: FlowStateId): EmotionBand {
  const parsed = parseFlowStateId(flowId) as any;
  const emotion = String(
    parsed?.emotion ?? parsed?.eTurn ?? parsed?.e_turn ?? '',
  )
    .trim()
    .toLowerCase();

  if (emotion === 'e1') return 'e1';
  if (emotion === 'e2') return 'e2';
  if (emotion === 'e3') return 'e3';
  if (emotion === 'e4') return 'e4';
  return 'e5';
}

function getPolarity(flowId: FlowStateId): Polarity {
  const parsed = parseFlowStateId(flowId) as any;
  return String(parsed?.polarity ?? '').trim().toLowerCase() === 'neg'
    ? 'neg'
    : 'pos';
}

function stageLabel(stage: StageBand): string {
  if (stage === 'S') return '足元や土台を整える段階';
  if (stage === 'R') return '関係や周囲とのつながりを見直す段階';
  if (stage === 'C') return '形にする・進める段階';
  if (stage === 'I') return '意味や方向をはっきりさせる段階';
  return '境目を越えて切り替わる段階';
}

function stageShiftLabel(nowStage: StageBand, futureStage: StageBand): string {
  if (nowStage === futureStage) {
    return `${stageLabel(nowStage)}をそのまま深めていく流れ`;
  }
  return `${stageLabel(nowStage)}から${stageLabel(futureStage)}へ移る流れ`;
}

function emotionShiftLabel(
  nowEmotion: EmotionBand,
  futureEmotion: EmotionBand,
): string {
  if (nowEmotion === futureEmotion) {
    return `${nowEmotion}の感情帯が継続している状態`;
  }
  return `${nowEmotion}から${futureEmotion}へ感情の重心が移っている状態`;
}

function polarityShiftLabel(
  nowPolarity: Polarity,
  futurePolarity: Polarity,
): string {
  if (nowPolarity === futurePolarity) {
    return nowPolarity === 'pos'
      ? '前向きな向きが継続している状態'
      : '内向き・慎重な向きが継続している状態';
  }

  if (nowPolarity === 'neg' && futurePolarity === 'pos') {
    return '慎重さや閉じ気味の向きから、前に進む向きへ移っている状態';
  }

  return '前に進む向きから、いったん見直しや慎重さへ戻る状態';
}

function buildCurrentState(nowStage: StageBand, nowPolarity: Polarity): string {
  const base = stageLabel(nowStage);

  if (nowPolarity === 'neg') {
    return `今は${base}にあり、外へ広げるよりも、内側を整えながら様子を見やすい状態です。`;
  }

  return `今は${base}にあり、動きながら形を見ていきやすい状態です。`;
}

function buildMovement(
  nowStage: StageBand,
  futureStage: StageBand,
  nowPolarity: Polarity,
  futurePolarity: Polarity,
): string {
  if (nowStage === futureStage) {
    if (futurePolarity === 'pos') {
      return `流れは同じ段階のまま、止まるよりも前に進みながら固める方向へ向かっています。`;
    }
    return `流れは同じ段階のまま、広げるよりも内側を整えながら固める方向へ向かっています。`;
  }

  if (nowPolarity === 'neg' && futurePolarity === 'pos') {
    return `いまの流れは、慎重さを保ちながらも、次の段階へ踏み出す方向に切り替わり始めています。`;
  }

  if (nowPolarity === 'pos' && futurePolarity === 'neg') {
    return `いまの流れは、進みながらも、この先へ向けて一度見直しと整え直しを入れる方向に向かっています。`;
  }

  return `いまの流れは、${stageLabel(nowStage)}から${stageLabel(futureStage)}へ重心を移しつつあります。`;
}

function buildDiagnosisFocus(
  nowStage: StageBand,
  futureStage: StageBand,
  deltaType: string | null,
): string {
  if (deltaType === 'expand') {
    return '今は範囲を広げることより、何を広げるかを見極めることが診断の核です。';
  }

  if (deltaType === 'stabilize') {
    return '今は新しいことを増やすことより、いま動いているものを固めることが診断の核です。';
  }

  if (deltaType === 'shift') {
    return '今は同じやり方を続けることより、向きの切り替えを見極めることが診断の核です。';
  }

  if (nowStage === futureStage) {
    return '今は大きく変えることより、同じ段階の中で質を上げることが診断の核です。';
  }

  return '今は次の段階へ移る流れをどう受け取るかが診断の核です。';
}

function buildRecommendation(
  nowStage: StageBand,
  futureStage: StageBand,
  deltaType: string | null,
  futurePolarity: Polarity,
): string {
  if (deltaType === 'stabilize') {
    return '今やっていることを一つ最後までやり切ってください。';
  }

  if (deltaType === 'expand') {
    return futurePolarity === 'pos'
      ? '次につながりそうな選択肢を一つ増やしてください。'
      : '広げすぎず、必要な選択肢だけを一つ増やしてください。';
  }

  if (deltaType === 'shift') {
    return 'いまのやり方をそのまま続けるか、一度切り替えるかをはっきり決めてください。';
  }

  if (nowStage === futureStage) {
    return '今やっていることを一つ最後までやり切ってください。';
  }

  if (futureStage === 'C' || futureStage === 'I' || futureStage === 'T') {
    return '次の段階に合う選択を一つ決めて、そこへ重心を移してください。';
  }

  return '広げる前に、いまの足元を整えることを優先してください。';
}

function buildCaution(
  deltaType: string | null,
  nowPolarity: Polarity,
  futurePolarity: Polarity,
  futureEmotion: EmotionBand,
): string | null {
  if (deltaType === 'expand' && futureEmotion === 'e5') {
    return '勢いで広げすぎると、焦点がぼやけやすい点には注意が必要です。';
  }

  if (deltaType === 'shift') {
    return '流れの切り替わり中なので、中途半端に両方を持ち続けると迷いが残りやすいです。';
  }

  if (nowPolarity === 'pos' && futurePolarity === 'neg') {
    return '前に進む力はありますが、見直しを飛ばすと無理が出やすいです。';
  }

  if (nowPolarity === 'neg' && futurePolarity === 'pos') {
    return '慎重さを抱えたままでも進めますが、準備だけで止まり続けないことが大切です。';
  }

  return null;
}

export function buildDiagnosisMeaning(args: {
  nowId: FlowStateId;
  futureId: FlowStateId;
}): DiagnosisMeaning {
  const { nowId, futureId } = args;

  const delta = buildFlowDelta(nowId, futureId);

  const nowStage = getStageBand(nowId);
  const futureStage = getStageBand(futureId);

  const nowEmotion = getEmotionBand(nowId);
  const futureEmotion = getEmotionBand(futureId);

  const nowPolarity = getPolarity(nowId);
  const futurePolarity = getPolarity(futureId);

  const stageShift = stageShiftLabel(nowStage, futureStage);
  const emotionShift = emotionShiftLabel(nowEmotion, futureEmotion);
  const polarityShift = polarityShiftLabel(nowPolarity, futurePolarity);

  return {
    currentState: buildCurrentState(nowStage, nowPolarity),
    movement: buildMovement(nowStage, futureStage, nowPolarity, futurePolarity),
    diagnosisFocus: buildDiagnosisFocus(nowStage, futureStage, delta.deltaType),
    recommendation: buildRecommendation(
      nowStage,
      futureStage,
      delta.deltaType,
      futurePolarity,
    ),
    caution: buildCaution(
      delta.deltaType,
      nowPolarity,
      futurePolarity,
      futureEmotion,
    ),
    stageShift,
    emotionShift,
    polarityShift,
    deltaType: delta.deltaType ?? null,
    deltaShort: String(delta.short ?? '').trim(),
    deltaSentence: String(delta.sentence ?? '').trim(),
  };
}
