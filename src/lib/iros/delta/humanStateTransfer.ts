// src/lib/iros/delta/humanStateTransfer.ts
//
// iros — Human State Transfer Engine v1
//
// 役割:
// - currentFlow → secondFlow の「状態移管」を読む
// - SA / 陰陽 / 揺れ / 余白 / 発話整合を、Writerに渡す前のSEEDへ圧縮する
//
// 方針:
// - 真実/嘘は断定しない
// - 見るのは「内的整合」「未確定領域」「発話と状態のズレ」
// - Writerには判断ではなく、返答焦点だけを渡す

import {
  FLOW_STAGE_ORDER,
  getFlowState,
  parseFlowStateId,
  type FlowEnergy,
  type FlowPolarity,
  type FlowStage,
  type FlowStateId,
} from '../flow/flow180';
import { getHumanFlowState180 } from '../flow/humanFlowState180';

export type SaLevel = 'low' | 'mid' | 'high';
export type SaPolarity = 'pos' | 'neg' | 'neutral';

export type YinYangSide = 'yin' | 'yang';
export type YinYangShift =
  | 'yin_to_yin'
  | 'yin_to_yang'
  | 'yang_to_yin'
  | 'yang_to_yang';

export type FluctuationLevel = 'none' | 'soft' | 'strong' | 'split';
export type MarginLevel = 'none' | 'small' | 'open' | 'wide';

export type UtteranceAlignment =
  | 'aligned'
  | 'partially_aligned'
  | 'misaligned'
  | 'overstated'
  | 'understated';

export type PolarityShift =
  | 'neg_to_neg'
  | 'neg_to_pos'
  | 'pos_to_neg'
  | 'pos_to_pos';

export type TransferClass =
  | 'maintain'
  | 'deepen'
  | 'surface'
  | 'expand'
  | 'contract'
  | 'positiveShift'
  | 'negativeShift'
  | 'energyShift'
  | 'stageJump'
  | 'close'
  | 'split'
  | 'conceal'
  | 'overstate'
  | 'understate'
  | 'openMargin';

export type HumanStateTransferInput = {
  currentFlow: string | null | undefined;
  secondFlow: string | null | undefined;

  sa?: number | null;
  saPolarity?: SaPolarity | null;

  yuragi?: number | null;
  yohaku?: number | null;

  utteranceAlignment?: UtteranceAlignment | null;
};

export type HumanStateTransferSeed = {
  ok: boolean;
  reason: string | null;

  fromFlow: FlowStateId | null;
  toFlow: FlowStateId | null;

  fromLabel: string | null;
  toLabel: string | null;

  fromInnerState: string | null;
  toInnerState: string | null;
  fromReplyFocus: string | null;
  toReplyFocus: string | null;
  humanStateReplyFocus: string | null;

  stageShift: string | null;
  energyShift: string | null;
  polarityShift: PolarityShift | null;

  sa: {
    level: SaLevel | null;
    polarity: SaPolarity | null;
    meaning: string | null;
    replyEffect: string | null;
  };

  yinyang: {
    from: YinYangSide | null;
    to: YinYangSide | null;
    shift: YinYangShift | null;
    meaning: string | null;
  };

  fluctuation: {
    level: FluctuationLevel | null;
    meaning: string | null;
  };

  margin: {
    level: MarginLevel | null;
    meaning: string | null;
  };

  utteranceAlignment: {
    type: UtteranceAlignment | null;
    meaning: string | null;
  };

  transferClass: TransferClass | null;

  transferMeaning: string | null;
  likelyProblem: string | null;
  replyFocus: string | null;
  avoidReply: string | null;

  seedText: string | null;
};

function clamp01(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function saLevelFromNumber(sa: number | null): SaLevel | null {
  if (sa == null) return null;
  if (sa < 0.34) return 'low';
  if (sa < 0.67) return 'mid';
  return 'high';
}

function levelFromMetric(value: number | null): 'none' | 'soft' | 'strong' {
  if (value == null) return 'none';
  if (value < 0.34) return 'none';
  if (value < 0.67) return 'soft';
  return 'strong';
}

function marginFromMetric(value: number | null): MarginLevel {
  if (value == null) return 'open';
  if (value < 0.2) return 'none';
  if (value < 0.45) return 'small';
  if (value < 0.75) return 'open';
  return 'wide';
}

function parseFlow(value: string | null | undefined): FlowStateId | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const parsed = parseFlowStateId(raw);
  return parsed ? raw as FlowStateId : null;
}

function stageIndex(stage: FlowStage): number {
  return FLOW_STAGE_ORDER.indexOf(stage);
}

function stageBand(stage: FlowStage): 'S' | 'F' | 'R' | 'C' | 'I' | 'T' {
  return stage.slice(0, 1) as 'S' | 'F' | 'R' | 'C' | 'I' | 'T';
}

function yinyangFromPolarity(polarity: FlowPolarity): YinYangSide {
  return polarity === 'pos' ? 'yang' : 'yin';
}

function buildPolarityShift(from: FlowPolarity, to: FlowPolarity): PolarityShift {
  return `${from}_to_${to}` as PolarityShift;
}

function buildYinYangShift(from: YinYangSide, to: YinYangSide): YinYangShift {
  return `${from}_to_${to}` as YinYangShift;
}

function describeSa(level: SaLevel | null, polarity: SaPolarity | null) {
  if (!level || !polarity) {
    return {
      meaning: null,
      replyEffect: null,
    };
  }

  if (polarity === 'neutral') {
    if (level === 'low') {
      return {
        meaning:
          '自分側へ戻る力はまだ弱いが、ポジティブにもネガティブにも確定していない。外側の反応に左右されやすい余白が残っている。',
        replyEffect:
          '断定せず、今わかっている範囲へ戻す。強い励ましや悪い意味づけに寄せない。',
      };
    }

    if (level === 'mid') {
      return {
        meaning:
          '自分側へ戻る力は中間にあり、統合方向にも防衛方向にもまだ振れ切っていない。受け取り方が決まりきっていない。',
        replyEffect:
          '事実と受け取りを分け、どちらにも決めつけずに扱う。',
      };
    }

    return {
      meaning:
        '自分側で受け止める力はあるが、向きはまだ確定していない。選択や判断へ進める前に、どちらへ使われているかを見る必要がある。',
      replyEffect:
        '強い結論に進めず、本人の受け取りがどちらへ向くかの余白を残す。',
    };
  }

  if (level === 'low' && polarity === 'neg') {
    return {
      meaning:
        '自分側へ戻る力が弱く、外側の反応に安心を預けやすい。未確認のことを悪い意味として受け取りやすい。',
      replyEffect:
        '相手・出来事・未来を断定せず、今わかっている事実へ戻す。',
    };
  }

  if (level === 'low' && polarity === 'pos') {
    return {
      meaning:
        '自分側へ戻る力は弱いが、戻ろうとする芽がある。完全には閉じていない。',
      replyEffect:
        '不安を受けつつ、小さく戻れる方向を示す。強い決断には進めない。',
    };
  }

  if (level === 'mid' && polarity === 'neg') {
    return {
      meaning:
        '自分側へ戻る力はあるが、悪い意味づけに引っ張られやすい。',
      replyEffect:
        '事実と解釈を分け、自分の受け取り方へ少し戻す。',
    };
  }

  if (level === 'mid' && polarity === 'pos') {
    return {
      meaning:
        '揺れはあるが、自分側で受け取り直せる。出来事を材料として扱える。',
      replyEffect:
        '受け止めた上で、次の見方へ少し進める。',
    };
  }

  if (level === 'high' && polarity === 'neg') {
    return {
      meaning:
        '自己受容の力はあるが、ネガティブ方向に固定されている。拒絶・切断・自己正当化にもなりやすい。',
      replyEffect:
        '感覚は否定せず、結論の固定や切断へ進ませすぎない。まだ見えていない部分を残す。',
    };
  }

  return {
    meaning:
      '自分側で受け止める力があり、統合方向へ使えている。出来事を選択・意図・行動へ変換できる。',
    replyEffect:
      '共感だけで止めず、選択・意図・行動へ進めてもよい。',
  };
}

function describeYinYang(shift: YinYangShift) {
  switch (shift) {
    case 'yin_to_yin':
      return '未統合状態のまま、別の未統合状態へ移る。問題が別の形で深まりやすい。';
    case 'yin_to_yang':
      return '未統合状態から、扱える方向へ移り始めている。反応の奥に使える方向が出ている。';
    case 'yang_to_yin':
      return '保てていたものが、出来事や相手の反応で揺れている。失敗扱いせず、何が揺れたのかを見る。';
    case 'yang_to_yang':
      return '統合状態から、次の統合状態へ展開している。不要に問題化せず、次の形へ接続する。';
  }
}

function describeFluctuation(level: FluctuationLevel) {
  switch (level) {
    case 'none':
      return '言葉・状態・移管先が大きくはズレていない。そのまま受け取れる可能性が高い。';
    case 'soft':
      return '言葉はまとまっているが、内側に少し別方向の反応が残っている。';
    case 'strong':
      return '言葉で言っていることと、状態移管が違う方向を向きやすい。発話だけで判断しない。';
    case 'split':
      return '表向きの答えと内的反応が割れている。真偽ではなく内的不整合として扱う。';
  }
}

function describeMargin(level: MarginLevel) {
  switch (level) {
    case 'none':
      return '本人の中で意味がかなり固定されている。SA高×negでは悪い確信に注意する。';
    case 'small':
      return '方向はあるが、少し未確定が残っている。断定しすぎない。';
    case 'open':
      return 'まだ決めきっていない。本音や意味が出てくる可能性がある。';
    case 'wide':
      return '言葉よりも、まだ出ていない内的情報が多い。深読みせず、観測できる範囲だけ返す。';
  }
}

function describeAlignment(type: UtteranceAlignment | null) {
  switch (type) {
    case 'aligned':
      return '発話と内的状態が大きく一致している。本人の中では自然に出ている可能性が高い。';
    case 'partially_aligned':
      return '発話と内的状態は一部一致しているが、まだ別方向の反応が残っている。';
    case 'misaligned':
      return '発話と内的状態がズレている。真偽ではなく内的不整合として扱う。';
    case 'overstated':
      return '言葉では強く言い切っているが、内側には未確定領域が残っている可能性がある。';
    case 'understated':
      return '発話は軽いが、内側ではより深い反応が起きている可能性がある。';
    default:
      return null;
  }
}

function classifyTransfer(args: {
  fromStage: FlowStage;
  toStage: FlowStage;
  fromEnergy: FlowEnergy;
  toEnergy: FlowEnergy;
  polarityShift: PolarityShift;
  fluctuation: FluctuationLevel;
  margin: MarginLevel;
  alignment: UtteranceAlignment | null;
}): TransferClass {
  if (args.alignment === 'overstated') return 'overstate';
  if (args.alignment === 'understated') return 'understate';
  if (args.alignment === 'misaligned' || args.fluctuation === 'split') return 'split';
  if (args.margin === 'wide') return 'openMargin';

  const fromIndex = stageIndex(args.fromStage);
  const toIndex = stageIndex(args.toStage);
  const stageDistance = Math.abs(toIndex - fromIndex);

  if (
    args.fromStage === args.toStage &&
    args.fromEnergy === args.toEnergy &&
    args.polarityShift === 'neg_to_neg'
  ) {
    return 'maintain';
  }

  if (args.polarityShift === 'neg_to_pos') return 'positiveShift';
  if (args.polarityShift === 'pos_to_neg') return 'negativeShift';

  if (stageDistance >= 5) return 'stageJump';

  if (args.fromEnergy !== args.toEnergy) {
    if (
      args.toEnergy === 'e4' ||
      (args.toEnergy === 'e5' && args.polarityShift.endsWith('_to_neg'))
    ) {
      return 'close';
    }
    return 'energyShift';
  }

  const fromBand = stageBand(args.fromStage);
  const toBand = stageBand(args.toStage);

  if ((fromBand === 'S' || fromBand === 'F') && !['S', 'F'].includes(toBand)) {
    return 'expand';
  }

  if (!['S', 'F'].includes(fromBand) && (toBand === 'S' || toBand === 'F')) {
    return 'contract';
  }

  if (toIndex > fromIndex) return 'deepen';
  if (toIndex < fromIndex) return 'surface';

  return 'maintain';
}

function buildStageShift(from: FlowStage, to: FlowStage): string {
  if (from === to) return `${from}の中で留まっている`;
  const fromIndex = stageIndex(from);
  const toIndex = stageIndex(to);
  const direction = toIndex > fromIndex ? '深い階層へ進んでいる' : '浅い反応へ表面化している';
  return `${from}から${to}へ、${direction}`;
}

function buildEnergyShift(from: FlowEnergy, to: FlowEnergy): string {
  if (from === to) return `${from}のエネルギー内で推移している`;

  const pair = `${from}->${to}`;

  const map: Record<string, string> = {
    'e1->e2': '我慢・違和感・意思の圧縮から、怒り・疑い・成長欲求へ移っている',
    'e2->e3': '怒り・疑い・進みたい力から、安心・基盤・考えすぎへ移っている',
    'e3->e4': '安心の揺れ・考えすぎから、恐れ・孤独・詰まりへ移っている',
    'e4->e5': '恐れ・詰まり・孤独から、空虚・存在感の揺れへ移っている',
    'e5->e1': '空虚・熱の消失から、意思・境界・我慢へ戻っている',
    'e4->e3': '恐れや詰まりから、安心や基盤を取り戻そうとしている',
    'e3->e2': '不安や考えすぎが、疑い・怒りとして外に向かい始めている',
    'e2->e1': '怒りや疑いが、我慢・境界・意思の問題へ戻っている',
    'e1->e5': '我慢や意思の圧縮が、存在感や熱の消失へ移っている',
  };

  return map[pair] ?? `${from}から${to}へ、感情エネルギーが切り替わっている`;
}

function buildTransferMeaning(args: {
  fromLabel: string;
  toLabel: string;
  transferClass: TransferClass;
  yinyangMeaning: string;
}): string {
  switch (args.transferClass) {
    case 'maintain':
      return `${args.fromLabel}が繰り返されている。新しい出来事というより、同じ受け取り方が再発している。`;
    case 'deepen':
      return `${args.fromLabel}が、より深い${args.toLabel}へ移りかけている。`;
    case 'surface':
      return `内側の${args.fromLabel}が、表側の${args.toLabel}として出てきている。`;
    case 'expand':
      return `自分の内側の${args.fromLabel}が、外側や関係の${args.toLabel}へ広がっている。`;
    case 'contract':
      return `外側や意味の問題として見えていたものが、自分の内側の${args.toLabel}へ戻っている。`;
    case 'positiveShift':
      return `${args.fromLabel}が、扱える方向の${args.toLabel}へ移り始めている。`;
    case 'negativeShift':
      return `保てていた${args.fromLabel}が揺れ、${args.toLabel}へ落ちやすくなっている。`;
    case 'energyShift':
      return `${args.fromLabel}から${args.toLabel}へ、感情エネルギーの質が変わっている。`;
    case 'stageJump':
      return `${args.fromLabel}から${args.toLabel}へ一気に飛んでいる。まだ見えていない過程が残っている。`;
    case 'close':
      return `${args.fromLabel}が、${args.toLabel}へ移り、流れが閉じやすくなっている。`;
    case 'split':
      return `発話と内側の流れが割れている。${args.fromLabel}から${args.toLabel}への移管は、真偽ではなく内的不整合として扱う。`;
    case 'conceal':
      return `表では軽く見えているが、内側では${args.toLabel}へ深く触れている。`;
    case 'overstate':
      return `言葉では強く言い切っているが、内側には${args.toLabel}へ向かう未確定の動きが残っている。`;
    case 'understate':
      return `軽く言っているが、内側では${args.fromLabel}から${args.toLabel}へ大きく動いている。`;
    case 'openMargin':
      return `${args.fromLabel}から${args.toLabel}へ動いているが、まだ確定していない余白が残っている。`;
  }
}

function buildLikelyProblem(args: {
  transferClass: TransferClass;
  saReplyEffect: string | null;
  marginLevel: MarginLevel;
}): string {
  if (args.transferClass === 'close') {
    return '確認前に、自分の中で関係や可能性を閉じやすい。';
  }

  if (args.transferClass === 'split') {
    return '表の言葉だけで扱うと、本当に動いている感情を外しやすい。';
  }

  if (args.transferClass === 'overstate') {
    return '強い言い切りに合わせると、まだ残っている余白を潰しやすい。';
  }

  if (args.transferClass === 'understate') {
    return '軽く扱うと、内側で起きている反応の深さを取り逃がしやすい。';
  }

  if (args.marginLevel === 'wide') {
    return '未確定の領域が大きく、ここで断定すると見えていない本音を潰しやすい。';
  }

  return args.saReplyEffect ?? '状態移管を広げすぎず、今回扱う一点へ戻す。';
}

function buildReplyFocus(args: {
  transferClass: TransferClass;
  saReplyEffect: string | null;
  yinyangShift: YinYangShift;
  marginLevel: MarginLevel;
}): string {
  if (args.marginLevel === 'wide') {
    return '断定せず、今観測できる範囲だけを返す。';
  }

  if (args.transferClass === 'positiveShift') {
    return '問題を否定せず、出始めている統合方向を支える。';
  }

  if (args.transferClass === 'negativeShift') {
    return '何が揺れたのかを見て、元の統合方向へ戻す。';
  }

  if (args.transferClass === 'split') {
    return '発話を嘘扱いせず、内側に残っている揺れとして扱う。';
  }

  if (args.yinyangShift === 'yin_to_yin') {
    return '未統合のまま広げず、今回の一点へ戻す。';
  }

  return args.saReplyEffect ?? '状態移管の意味を、今回返す一点に圧縮する。';
}

function buildAvoidReply(args: {
  marginLevel: MarginLevel;
  alignment: UtteranceAlignment | null;
}): string {
  const items = [
    '真実/嘘の断定',
    '相手の本心の断定',
    '未確認の結論',
  ];

  if (args.marginLevel === 'wide') {
    items.push('深読みのしすぎ');
  }

  if (args.alignment === 'overstated') {
    items.push('強い言い切りへの同調');
  }

  if (args.alignment === 'understated') {
    items.push('反応の軽視');
  }

  return items.join('、');
}

function buildSeedText(seed: Omit<HumanStateTransferSeed, 'seedText'>): string | null {
  if (!seed.ok) return null;

  const lines = [
    'HUMAN_STATE_TRANSFER (DO NOT OUTPUT):',
    seed.fromFlow ? `from=${seed.fromFlow}` : null,
    seed.toFlow ? `to=${seed.toFlow}` : null,
    seed.transferClass ? `class=${seed.transferClass}` : null,
    seed.fromInnerState ? `FROM_INNER_STATE=${seed.fromInnerState}` : null,
    seed.toInnerState ? `TO_INNER_STATE=${seed.toInnerState}` : null,
    seed.fromReplyFocus ? `FROM_REPLY_FOCUS=${seed.fromReplyFocus}` : null,
    seed.toReplyFocus ? `TO_REPLY_FOCUS=${seed.toReplyFocus}` : null,
    seed.humanStateReplyFocus ? `HUMAN_STATE_REPLY_FOCUS=${seed.humanStateReplyFocus}` : null,
    seed.transferMeaning ? `STATE_TRANSFER=${seed.transferMeaning}` : null,
    seed.sa.meaning ? `SA_EFFECT=${seed.sa.meaning}` : null,
    seed.yinyang.meaning ? `YINYANG_EFFECT=${seed.yinyang.meaning}` : null,
    seed.fluctuation.meaning ? `FLUCTUATION=${seed.fluctuation.meaning}` : null,
    seed.margin.meaning ? `MARGIN=${seed.margin.meaning}` : null,
    seed.utteranceAlignment.meaning ? `UTTERANCE_ALIGNMENT=${seed.utteranceAlignment.meaning}` : null,
    seed.likelyProblem ? `LIKELY_PROBLEM=${seed.likelyProblem}` : null,
    seed.replyFocus ? `REPLY_FOCUS=${seed.replyFocus}` : null,
    seed.avoidReply ? `AVOID_REPLY=${seed.avoidReply}` : null,
  ].filter((v): v is string => Boolean(v));

  return lines.join('\n').trim();
}

export function buildHumanStateTransferSeed(
  input: HumanStateTransferInput,
): HumanStateTransferSeed {
  const fromFlow = parseFlow(input.currentFlow);
  const toFlow = parseFlow(input.secondFlow);

  if (!fromFlow || !toFlow) {
    return {
      ok: false,
      reason: 'missing_or_invalid_flow',
      fromFlow,
      toFlow,
      fromLabel: null,
      toLabel: null,
      fromInnerState: null,
      toInnerState: null,
      fromReplyFocus: null,
      toReplyFocus: null,
      humanStateReplyFocus: null,
      stageShift: null,
      energyShift: null,
      polarityShift: null,
      sa: { level: null, polarity: null, meaning: null, replyEffect: null },
      yinyang: { from: null, to: null, shift: null, meaning: null },
      fluctuation: { level: null, meaning: null },
      margin: { level: null, meaning: null },
      utteranceAlignment: { type: null, meaning: null },
      transferClass: null,
      transferMeaning: null,
      likelyProblem: null,
      replyFocus: null,
      avoidReply: null,
      seedText: null,
    };
  }

  const fromParsed = parseFlowStateId(fromFlow);
  const toParsed = parseFlowStateId(toFlow);

  if (!fromParsed || !toParsed) {
    return {
      ok: false,
      reason: 'parse_failed',
      fromFlow,
      toFlow,
      fromLabel: null,
      toLabel: null,
      fromInnerState: null,
      toInnerState: null,
      fromReplyFocus: null,
      toReplyFocus: null,
      humanStateReplyFocus: null,
      stageShift: null,
      energyShift: null,
      polarityShift: null,
      sa: { level: null, polarity: null, meaning: null, replyEffect: null },
      yinyang: { from: null, to: null, shift: null, meaning: null },
      fluctuation: { level: null, meaning: null },
      margin: { level: null, meaning: null },
      utteranceAlignment: { type: null, meaning: null },
      transferClass: null,
      transferMeaning: null,
      likelyProblem: null,
      replyFocus: null,
      avoidReply: null,
      seedText: null,
    };
  }

  const fromState = getFlowState(fromFlow);
  const toState = getFlowState(toFlow);
  const fromHumanState = getHumanFlowState180(fromFlow);
  const toHumanState = getHumanFlowState180(toFlow);

  const fromLabel = fromState?.resonance ?? fromState?.short ?? fromFlow;
  const toLabel = toState?.resonance ?? toState?.short ?? toFlow;

  const saNumber = clamp01(input.sa);
  const saLevel = saLevelFromNumber(saNumber);
  const saPolarity = input.saPolarity ?? null;
  const sa = describeSa(saLevel, saPolarity);

  const fromYinYang = yinyangFromPolarity(fromParsed.polarity);
  const toYinYang = yinyangFromPolarity(toParsed.polarity);
  const yinyangShift = buildYinYangShift(fromYinYang, toYinYang);
  const yinyangMeaning = describeYinYang(yinyangShift);

  const yuragiNumber = clamp01(input.yuragi);
  const yohakuNumber = clamp01(input.yohaku);
  const fluctuationLevelBase = levelFromMetric(yuragiNumber);
  const marginLevel = marginFromMetric(yohakuNumber);
  const alignment = input.utteranceAlignment ?? null;

  const fluctuationLevel: FluctuationLevel =
    alignment === 'misaligned'
      ? 'split'
      : fluctuationLevelBase;

  const polarityShift = buildPolarityShift(fromParsed.polarity, toParsed.polarity);

  const transferClass = classifyTransfer({
    fromStage: fromParsed.stage,
    toStage: toParsed.stage,
    fromEnergy: fromParsed.energy,
    toEnergy: toParsed.energy,
    polarityShift,
    fluctuation: fluctuationLevel,
    margin: marginLevel,
    alignment,
  });

  const transferMeaning = buildTransferMeaning({
    fromLabel,
    toLabel,
    transferClass,
    yinyangMeaning,
  });

  const likelyProblem = buildLikelyProblem({
    transferClass,
    saReplyEffect: sa.replyEffect,
    marginLevel,
  });

  const replyFocus = buildReplyFocus({
    transferClass,
    saReplyEffect: sa.replyEffect,
    yinyangShift,
    marginLevel,
  });

  const avoidReply = buildAvoidReply({
    marginLevel,
    alignment,
  });

  const seedWithoutText: Omit<HumanStateTransferSeed, 'seedText'> = {
    ok: true,
    reason: null,
    fromFlow,
    toFlow,
    fromLabel,
    toLabel,
    fromInnerState: fromHumanState?.innerState ?? null,
    toInnerState: toHumanState?.innerState ?? null,
    fromReplyFocus: fromHumanState?.replyFocus ?? null,
    toReplyFocus: toHumanState?.replyFocus ?? null,
    humanStateReplyFocus:
      toHumanState?.replyFocus ?? fromHumanState?.replyFocus ?? null,
    stageShift: buildStageShift(fromParsed.stage, toParsed.stage),
    energyShift: buildEnergyShift(fromParsed.energy, toParsed.energy),
    polarityShift,
    sa: {
      level: saLevel,
      polarity: saPolarity,
      meaning: sa.meaning,
      replyEffect: sa.replyEffect,
    },
    yinyang: {
      from: fromYinYang,
      to: toYinYang,
      shift: yinyangShift,
      meaning: yinyangMeaning,
    },
    fluctuation: {
      level: fluctuationLevel,
      meaning: describeFluctuation(fluctuationLevel),
    },
    margin: {
      level: marginLevel,
      meaning: describeMargin(marginLevel),
    },
    utteranceAlignment: {
      type: alignment,
      meaning: describeAlignment(alignment),
    },
    transferClass,
    transferMeaning,
    likelyProblem,
    replyFocus,
    avoidReply,
  };

  return {
    ...seedWithoutText,
    seedText: buildSeedText(seedWithoutText),
  };
}
