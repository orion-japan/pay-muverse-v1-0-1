// src/lib/iros/diagnosis/buildDiagnosisCore.ts
//
// ir診断専用コア
//
// 目的：
// - FLOW180 の now / future から
//   「何がズレたか」
//   「どこが動いたか」
//   「どこが止まっているか」
//   「今回の診断で何を言い切るべきか」
//   を診断専用のコアとして返す
//
// 方針：
// - 段階説明を主役にしない
// - 差分の意味をそのまま診断核に変換する
// - buildDiagnosisText.ts は後でこのコアを文章化するだけにする

import {
  buildFlowDelta,
  parseFlowStateId,
  type FlowStateId,
} from '../flow/flow180';

type StageBand = 'S' | 'R' | 'C' | 'I' | 'T';
type EmotionBand = 'e1' | 'e2' | 'e3' | 'e4' | 'e5';
type Polarity = 'pos' | 'neg';

export type DiagnosisCore = {
  nowStage: StageBand;
  futureStage: StageBand;
  nowEmotion: EmotionBand;
  futureEmotion: EmotionBand;
  nowPolarity: Polarity;
  futurePolarity: Polarity;

  deltaType: string | null;
  deltaShort: string;
  deltaSentence: string;

  stageMoved: boolean;
  emotionMoved: boolean;
  polarityMoved: boolean;

  driftKind:
    | 'hold'
    | 'stage_shift'
    | 'emotion_shift'
    | 'polarity_shift'
    | 'compound_shift';

  coreState: string;
  coreMovement: string;
  coreTension: string;
  coreDecision: string;
};

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

function stageAxisLabel(stage: StageBand): string {
  if (stage === 'S') return '足元や基盤';
  if (stage === 'R') return '関係や周囲とのつながり';
  if (stage === 'C') return '実行や具体化';
  if (stage === 'I') return '意味や方向';
  return '境目を越える切り替え';
}

function emotionAxisLabel(emotion: EmotionBand): string {
  if (emotion === 'e1') return '張りつめた維持';
  if (emotion === 'e2') return '前へ伸びる力';
  if (emotion === 'e3') return '安定を求める重さ';
  if (emotion === 'e4') return '慎重さと揺れ';
  return '強い熱量';
}

function driftKindOf(input: {
  stageMoved: boolean;
  emotionMoved: boolean;
  polarityMoved: boolean;
}): DiagnosisCore['driftKind'] {
  const movedCount = [input.stageMoved, input.emotionMoved, input.polarityMoved]
    .filter(Boolean).length;

  if (movedCount === 0) return 'hold';
  if (movedCount >= 2) return 'compound_shift';
  if (input.stageMoved) return 'stage_shift';
  if (input.emotionMoved) return 'emotion_shift';
  return 'polarity_shift';
}

function buildCoreState(input: {
  nowStage: StageBand;
  nowEmotion: EmotionBand;
  nowPolarity: Polarity;
}): string {
  const stage = stageAxisLabel(input.nowStage);
  const emotion = emotionAxisLabel(input.nowEmotion);

  if (input.nowStage === 'I') {
    if (input.nowPolarity === 'neg') {
      return `何を意味として取るかをずっと考え続けやすく、外に出すより自分の中で確かめたくなりやすい状態です。気持ちの底には${emotion}が流れています。`;
    }

    return `何を意味として取るかに意識が向いていて、考えるだけで終わるより少し動きながら答えを確かめたくなりやすい状態です。気持ちの底には${emotion}が流れています。`;
  }

  if (input.nowPolarity === 'neg') {
    return `いまは${stage}に意識が残りやすく、外へ広げるより内側で整えたい状態です。気持ちの底には${emotion}が流れています。`;
  }

  return `いまは${stage}に意識が向いており、内側だけで止まるより少し動きながら形を見たい状態です。気持ちの底には${emotion}が流れています。`;
}
function buildCoreMovement(input: {
  nowStage: StageBand;
  futureStage: StageBand;
  nowEmotion: EmotionBand;
  futureEmotion: EmotionBand;
  nowPolarity: Polarity;
  futurePolarity: Polarity;
  driftKind: DiagnosisCore['driftKind'];
}): string {
  const nowStageLabel = stageAxisLabel(input.nowStage);
  const futureStageLabel = stageAxisLabel(input.futureStage);
  const nowEmotionLabel = emotionAxisLabel(input.nowEmotion);
  const futureEmotionLabel = emotionAxisLabel(input.futureEmotion);

  if (input.driftKind === 'hold') {
    return `大きく別方向へ飛ぶというより、${nowStageLabel}の中で同じテーマが続き、その質が変わろうとしています。`;
  }

  if (input.driftKind === 'stage_shift') {
    return `${nowStageLabel}から${futureStageLabel}へ重心が移り始めています。`;
  }

  if (input.driftKind === 'emotion_shift') {
    return `見ている領域は大きく変わらないまま、内側の感情の重さが${nowEmotionLabel}から${futureEmotionLabel}へ移っています。`;
  }

  if (input.driftKind === 'polarity_shift') {
    if (input.nowPolarity === 'neg' && input.futurePolarity === 'pos') {
      return `慎重に留まる向きから、少し前へ出て動く向きへ切り替わり始めています。`;
    }
    return `前へ出る向きから、いったん内側で見直す向きへ戻り始めています。`;
  }

  return `${nowStageLabel}から${futureStageLabel}へ動きながら、感情の底も${nowEmotionLabel}から${futureEmotionLabel}へずれています。`;
}
function buildCoreTension(input: {
  nowStage: StageBand;
  futureStage: StageBand;
  nowEmotion: EmotionBand;
  futureEmotion: EmotionBand;
  nowPolarity: Polarity;
  futurePolarity: Polarity;
  stageMoved: boolean;
  emotionMoved: boolean;
  polarityMoved: boolean;
  driftKind: DiagnosisCore['driftKind'];
}): string {
  const nowStageLabel = stageAxisLabel(input.nowStage);
  const futureStageLabel = stageAxisLabel(input.futureStage);
  const nowEmotionLabel = emotionAxisLabel(input.nowEmotion);
  const futureEmotionLabel = emotionAxisLabel(input.futureEmotion);

  if (input.driftKind === 'hold') {
    return `大きく別方向へ飛んでいるわけではありませんが、${nowStageLabel}に留まったまま質だけが変わっているため、同じ場所にいる感覚なのに噛み合わなさが出やすい状態です。`;
  }

  if (input.driftKind === 'stage_shift') {
    return `${nowStageLabel}に意識を残したまま、流れだけは${futureStageLabel}へ移ろうとしているため、立っている場所と進もうとする先がずれて落ち着きにくい状態です。`;
  }

  if (input.driftKind === 'emotion_shift') {
    return `見ているテーマは同じでも、気持ちの重さが${nowEmotionLabel}から${futureEmotionLabel}へ移っているため、頭では同じことを考えていても内側の反応が前と噛み合いにくい状態です。`;
  }

  if (input.driftKind === 'polarity_shift') {
    if (input.nowPolarity === 'neg' && input.futurePolarity === 'pos') {
      return `意識は内側で整えたいままなのに、流れは外へ動き始めているため、慎重さと前進したさが同時に立って迷いやすい状態です。`;
    }

    return `動きたい向きは残っているのに、流れは内側へ戻って整え直そうとしているため、進みたい気持ちと立ち止まりたい感覚がぶつかりやすい状態です。`;
  }

  return `${nowStageLabel}から${futureStageLabel}への移り変わりに加えて、気持ちの重さも${nowEmotionLabel}から${futureEmotionLabel}へずれ、さらに向きも切り替わっているため、意識の置き場と感情の流れと行動の向きが同時に噛み合いにくくなっています。`;
}

function buildCoreDecision(input: {
  deltaType: string | null;
  nowStage: StageBand;
  futureStage: StageBand;
  nowEmotion: EmotionBand;
  futureEmotion: EmotionBand;
  nowPolarity: Polarity;
  futurePolarity: Polarity;
  driftKind: DiagnosisCore['driftKind'];
}): string {
  const nowStageLabel = stageAxisLabel(input.nowStage);
  const futureStageLabel = stageAxisLabel(input.futureStage);
  const nowEmotionLabel = emotionAxisLabel(input.nowEmotion);
  const futureEmotionLabel = emotionAxisLabel(input.futureEmotion);

  if (input.deltaType === 'stabilize') {
    if (input.nowStage === 'R' || input.futureStage === 'R') {
      return 'いまは関係や周囲との距離を広げるより、どのつながりに重心を置くかを一つ決めて固定する局面です。';
    }
    if (input.nowStage === 'C' || input.futureStage === 'C') {
      return 'いまは新しいことを増やすより、すでに動き始めていることを一つ最後まで形にする局面です。';
    }
    return 'いまは広げるより、いま動いている流れを一つ決めて固める局面です。';
  }

  if (input.deltaType === 'expand') {
    if (input.futurePolarity === 'pos') {
      return `いまは閉じたまま整え続けるより、${futureStageLabel}に関わる選択肢を一つ外へ増やして流れを前に出す局面です。`;
    }
    return `いまは一気に広げすぎず、${futureStageLabel}に必要な選択肢だけを一つ足して様子を見る局面です。`;
  }

  if (input.deltaType === 'shift') {
    if (input.nowStage !== input.futureStage) {
      return `いまは${nowStageLabel}を引きずったまま進むより、${futureStageLabel}へ意識の置き場を切り替えると決める局面です。`;
    }
    if (input.nowPolarity === 'neg' && input.futurePolarity === 'pos') {
      return 'いまは考え続けるだけで留まるより、小さくても一度外へ動くと決める局面です。';
    }
    if (input.nowPolarity === 'pos' && input.futurePolarity === 'neg') {
      return 'いまは勢いのまま進むより、いったん内側で整え直すと決める局面です。';
    }
    return 'いまは同じやり方を続けるか、切り替えるかをはっきり決める局面です。';
  }

  if (input.driftKind === 'hold') {
    return `いまは別のことへ飛ぶより、${nowStageLabel}の中で何を残し、何を閉じるかを一つ決める局面です。`;
  }

  if (input.driftKind === 'emotion_shift') {
    return `いまは見ているテーマそのものより、気持ちの重さが${nowEmotionLabel}から${futureEmotionLabel}へ移っていることを優先して扱う局面です。`;
  }

  if (input.driftKind === 'polarity_shift') {
    if (input.nowPolarity === 'neg' && input.futurePolarity === 'pos') {
      return 'いまは慎重さを抱えたままでも、内側で整えるだけで終わらせず、小さく外へ出る一点を決める局面です。';
    }
    return 'いまは前に出続けるより、どこで立ち止まって整え直すかを先に決める局面です。';
  }

  if (input.futureStage === 'C') {
    return 'いまは考え続けるより、何を形にするかを一つ決めて手をつける局面です。';
  }

  if (input.futureStage === 'I') {
    return 'いまは周囲に合わせ続けるより、自分がどの方向で意味を取るかを一つ決める局面です。';
  }

  if (input.futureStage === 'T') {
    return 'いまは今までの延長で収めるより、どの境目を越えるのかを一つ決める局面です。';
  }

  return `いまは${nowStageLabel}に残る感覚をそのまま引きずるより、${futureStageLabel}へ重心を移す一点を決める局面です。`;
}

export function buildDiagnosisCore(args: {
  nowId: FlowStateId;
  futureId: FlowStateId;
}): DiagnosisCore {
  const { nowId, futureId } = args;

  const delta = buildFlowDelta(nowId, futureId);

  const nowStage = getStageBand(nowId);
  const futureStage = getStageBand(futureId);
  const nowEmotion = getEmotionBand(nowId);
  const futureEmotion = getEmotionBand(futureId);
  const nowPolarity = getPolarity(nowId);
  const futurePolarity = getPolarity(futureId);

  const stageMoved = nowStage !== futureStage;
  const emotionMoved = nowEmotion !== futureEmotion;
  const polarityMoved = nowPolarity !== futurePolarity;

  const driftKind = driftKindOf({
    stageMoved,
    emotionMoved,
    polarityMoved,
  });

  return {
    nowStage,
    futureStage,
    nowEmotion,
    futureEmotion,
    nowPolarity,
    futurePolarity,

    deltaType: delta.deltaType ?? null,
    deltaShort: String(delta.short ?? '').trim(),
    deltaSentence: String(delta.sentence ?? '').trim(),

    stageMoved,
    emotionMoved,
    polarityMoved,
    driftKind,

    coreState: buildCoreState({
      nowStage,
      nowEmotion,
      nowPolarity,
    }),
    coreMovement: buildCoreMovement({
      nowStage,
      futureStage,
      nowEmotion,
      futureEmotion,
      nowPolarity,
      futurePolarity,
      driftKind,
    }),
    coreTension: buildCoreTension({
      nowStage,
      futureStage,
      nowEmotion,
      futureEmotion,
      nowPolarity,
      futurePolarity,
      stageMoved,
      emotionMoved,
      polarityMoved,
      driftKind,
    }),
    coreDecision: buildCoreDecision({
      deltaType: delta.deltaType ?? null,
      nowStage,
      futureStage,
      nowEmotion,
      futureEmotion,
      nowPolarity,
      futurePolarity,
      driftKind,
    }),
  };
}
