// src/lib/iros/cards/cardEngine.ts
// iros — Card Engine v1 (pure)
//
// 目的（責務を混ぜない）:
// - A) cardEngine.ts は「選定ロジック」＋「辞書から引いて seed を組み立てる」だけ
// - B) card180.ts は「辞書（ID→短文 yin/yang）」だけ
//
// 方針:
// - 現状カード: (e_turn, depthStage, polarity) が揃えば detected。揃わなければ previous を薄く継承（任意）。
//   それも無理なら null。
// - 未来カード: 常に random（S1〜I3 推奨プール）
// - sa / yuragi / yohaku / phase は「カード選択」ではなく LLM渡しメタ（IDを変えない）
// - 180本文はここに持たない（lookup 関数を注入）
//
// NOTE:
// - e_turn は instant（今ターンの反応）
// - depthStage は柱（構造）
// - polarity は向き（yin=ネガ版 / yang=ポジ版）※ Inner/Outer とは別軸

export type ETurn = 'e1' | 'e2' | 'e3' | 'e4' | 'e5';
export type Polarity = 'yin' | 'yang';
export type Phase = 'Inner' | 'Outer';

export type Band = 'S' | 'F' | 'R' | 'C' | 'I' | 'T';
export type DepthStage =
  | 'S1' | 'S2' | 'S3'
  | 'F1' | 'F2' | 'F3'
  | 'R1' | 'R2' | 'R3'
  | 'C1' | 'C2' | 'C3'
  | 'I1' | 'I2' | 'I3'
  | 'T1' | 'T2' | 'T3';

export type CardId = `${DepthStage}-${ETurn}-${Polarity}`;
export type CardSource = 'detected' | 'fallback_previous' | 'random';

export interface CurrentSignalsInput {
  e_turn?: ETurn | null;
  depthStage?: DepthStage | null;
  polarity?: Polarity | null;
  confidence?: number | null;

  // 別軸メタ（LLMに渡す・カードIDは変えない）
  phase?: Phase | null;
  sa?: number | null;
  yuragi?: number | null;
  yohaku?: number | null;

  basedOn?: string | null; // 根拠1点（短く）
}

export interface CardTextLookup {
  (args: {
    depthStage: DepthStage;
    e_turn: ETurn;
    polarity: Polarity;
    sa?: number | null; // 語尾補正用（辞書本文は変えない）
  }): { id: CardId; text: string; fromDict: boolean };
}

export interface BuildCardEngineInput {
  current: CurrentSignalsInput;

  // optional: 前回検出済みの now（薄く継承したい場合）
  previousNow?: {
    e_turn: ETurn;
    depthStage: DepthStage;
    polarity: Polarity;
  } | null;

  // 辞書（card180.ts）の lookup を注入
  lookupText: CardTextLookup;

  // テスト/再現用
  rng?: () => number;

  // 未来カードのstage範囲（既定: S1〜I3）
  futureStagePool?: DepthStage[];

  // 未来カードのpolarity（既定: yin/yang ランダム）
  futurePolarityPool?: Polarity[];

  // 未来カードのe_turn（既定: e1..e5 ランダム）
  futureETurnPool?: ETurn[];
}

export interface CardPick {
  source: CardSource;
  id: CardId;
  depthStage: DepthStage;
  e_turn: ETurn;
  polarity: Polarity;
  text: string;
  fromDict: boolean;
  confidence: number | null;
  basedOn: string | null;
}

export interface CardEngineResult {
  currentCard: CardPick | null;
  futureCard: CardPick;

  // LLMへ渡す最小 seed（10〜15行想定）
  seedText: string;

  // 機械用の補助（ctxPackへ入れやすい）
  pack: {
    version: 'card_engine_v1';
    current: {
      detected: boolean;
      fromPrev: boolean;
      missing: Array<'e_turn' | 'depthStage' | 'polarity'>;
      confidence: number | null;
    };
    future: {
      mode: 'random';
      note: string;
    };
    context: {
      phase: Phase | null;
      sa: number | null;
      yuragi: number | null;
      yohaku: number | null;
      saBiasHint: 'negative_risk' | 'neutral' | 'positive_capacity' | null;
      confidenceHint: 'low' | 'mid' | 'high' | null;
    };
  };

  debug: {
    futureStagePoolSize: number;
  };
}

export const STAGES_ALL: readonly DepthStage[] = Object.freeze([
  'S1','S2','S3',
  'F1','F2','F3',
  'R1','R2','R3',
  'C1','C2','C3',
  'I1','I2','I3',
  'T1','T2','T3',
] as const);

export const STAGES_FUTURE_DEFAULT: readonly DepthStage[] = Object.freeze(
  // S1..I3（T除外）
  STAGES_ALL.filter((s) => stageToIndex(s) <= 15) as DepthStage[],
);

const E_TURNS: readonly ETurn[] = Object.freeze(['e1', 'e2', 'e3', 'e4', 'e5'] as const);
const POLARITIES: readonly Polarity[] = Object.freeze(['yin', 'yang'] as const);

function clamp01(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function pickOne<T>(arr: readonly T[], rng: () => number): T {
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('pickOne: empty array');
  const r = rng();
  const x = Number.isFinite(r) ? r : Math.random();
  const i = Math.max(0, Math.min(arr.length - 1, Math.floor(x * arr.length)));
  return arr[i];
}

export function stageToBand(stage: DepthStage): Band {
  return stage[0] as Band;
}

export function stageToIndex(stage: DepthStage): number {
  const band = stageToBand(stage);
  const n = Number(stage[1]); // 1..3 の前提
  const base =
    band === 'S' ? 0 :
    band === 'F' ? 3 :
    band === 'R' ? 6 :
    band === 'C' ? 9 :
    band === 'I' ? 12 :
    band === 'T' ? 15 : 0;
  return base + n;
}

function deriveSaBiasHint(sa: number | null): CardEngineResult['pack']['context']['saBiasHint'] {
  if (sa == null) return null;
  if (sa < 0.35) return 'negative_risk';
  if (sa > 0.7) return 'positive_capacity';
  return 'neutral';
}

function deriveConfidenceHint(confidence: number | null, yuragi: number | null): 'low' | 'mid' | 'high' | null {
  const c0 = clamp01(confidence);
  if (c0 == null) return null;

  const y = clamp01(yuragi);
  let c = c0;
  // ゆらぎが高いと確信度の読みを一段弱める（値は上書きしない）
  if (y != null && y >= 0.7) c = Math.max(0, c - 0.2);
  else if (y != null && y >= 0.45) c = Math.max(0, c - 0.1);

  if (c < 0.35) return 'low';
  if (c < 0.75) return 'mid';
  return 'high';
}

function buildSeedText(args: {
  currentCard: CardPick | null;
  futureCard: CardPick;
  missing: Array<'e_turn' | 'depthStage' | 'polarity'>;
  context: {
    phase: Phase | null;
    sa: number | null;
    yuragi: number | null;
    yohaku: number | null;
    saBiasHint: 'negative_risk' | 'neutral' | 'positive_capacity' | null;
    confidenceHint: 'low' | 'mid' | 'high' | null;
  };
}): string {
  const ctxParts = [
    args.context.phase ? `phase=${args.context.phase}` : null,
    args.context.sa != null ? `sa=${args.context.sa.toFixed(2)}` : null,
    args.context.yuragi != null ? `yuragi=${args.context.yuragi.toFixed(2)}` : null,
    args.context.yohaku != null ? `yohaku=${args.context.yohaku.toFixed(2)}` : null,
    args.context.saBiasHint ? `saBias=${args.context.saBiasHint}` : null,
    args.context.confidenceHint ? `confidence=${args.context.confidenceHint}` : null,
  ].filter(Boolean);

  const lines: string[] = [];
  lines.push('CARD_SEED_V1 (DO NOT OUTPUT)');
  if (ctxParts.length) lines.push(`META: ${ctxParts.join(' / ')}`);

  lines.push('');
  lines.push('CURRENT_CARD:');
  if (args.currentCard) {
    lines.push(`- id=${args.currentCard.id} / src=${args.currentCard.source}`);
    lines.push(`- ${args.currentCard.text}`);
  } else {
    lines.push(`- (null) missing=${args.missing.join(',') || 'none'}`);
  }

  lines.push('');
  lines.push('FUTURE_CARD_RANDOM_CANDIDATE:');
  lines.push(`- id=${args.futureCard.id} / src=random`);
  lines.push(`- ${args.futureCard.text}`);

  lines.push('');
  lines.push('RULES:');
  lines.push('- future は確定ではない（ランダム候補）。予測として扱わない。');
  lines.push('- 応答は現状（CURRENT）優先。future は“次の角度”として添えるだけ。');
  lines.push('- カードIDや辞書本文を改変せず、短く自然な言葉で返す。');

  return lines.join('\n').trim();
}

export function buildCardEngineResult(input: BuildCardEngineInput): CardEngineResult {
  if (!input || typeof input.lookupText !== 'function') {
    throw new Error('buildCardEngineResult: lookupText is required');
  }

  const rng = typeof input.rng === 'function' ? input.rng : Math.random;
  const current = input.current ?? {};

  const missing: Array<'e_turn' | 'depthStage' | 'polarity'> = [];
  const e_turn = current.e_turn ?? null;
  const depthStage = current.depthStage ?? null;
  const polarity = current.polarity ?? null;

  if (!e_turn) missing.push('e_turn');
  if (!depthStage) missing.push('depthStage');
  if (!polarity) missing.push('polarity');

  const confidence = clamp01(current.confidence);
  const sa = clamp01(current.sa);
  const yuragi = clamp01(current.yuragi);
  const yohaku = clamp01(current.yohaku);

  // ---- current (detected | fallback_previous | null) ----
  let currentCard: CardPick | null = null;
  let fromPrev = false;

  if (missing.length === 0) {
    const looked = input.lookupText({ depthStage: depthStage as DepthStage, e_turn: e_turn as ETurn, polarity: polarity as Polarity, sa });
    currentCard = {
      source: 'detected',
      id: looked.id,
      depthStage: depthStage as DepthStage,
      e_turn: e_turn as ETurn,
      polarity: polarity as Polarity,
      text: looked.text,
      fromDict: looked.fromDict,
      confidence,
      basedOn: current.basedOn ?? null,
    };
  } else if (input.previousNow && input.previousNow.e_turn && input.previousNow.depthStage && input.previousNow.polarity) {
    // 薄く継承（任意）
    fromPrev = true;
    const p = input.previousNow;
    const looked = input.lookupText({ depthStage: p.depthStage, e_turn: p.e_turn, polarity: p.polarity, sa });
    currentCard = {
      source: 'fallback_previous',
      id: looked.id,
      depthStage: p.depthStage,
      e_turn: p.e_turn,
      polarity: p.polarity,
      text: looked.text,
      fromDict: looked.fromDict,
      confidence,
      basedOn: current.basedOn ?? 'previous_state_fallback',
    };
  }

  // ---- future (always random) ----
  const stagePool =
    Array.isArray(input.futureStagePool) && input.futureStagePool.length > 0
      ? input.futureStagePool
      : [...STAGES_FUTURE_DEFAULT];

  const ePool =
    Array.isArray(input.futureETurnPool) && input.futureETurnPool.length > 0
      ? input.futureETurnPool
      : [...E_TURNS];

  const pPool =
    Array.isArray(input.futurePolarityPool) && input.futurePolarityPool.length > 0
      ? input.futurePolarityPool
      : [...POLARITIES];

  const fe = pickOne(ePool, rng);
  const fs = pickOne(stagePool, rng);
  const fp = pickOne(pPool, rng);

  const futureLooked = input.lookupText({ depthStage: fs, e_turn: fe, polarity: fp, sa });
  const futureCard: CardPick = {
    source: 'random',
    id: futureLooked.id,
    depthStage: fs,
    e_turn: fe,
    polarity: fp,
    text: futureLooked.text,
    fromDict: futureLooked.fromDict,
    confidence,
    basedOn: 'random_future_candidate',
  };

  const context = {
    phase: current.phase ?? null,
    sa,
    yuragi,
    yohaku,
    saBiasHint: deriveSaBiasHint(sa),
    confidenceHint: deriveConfidenceHint(confidence, yuragi),
  };

  const seedText = buildSeedText({
    currentCard,
    futureCard,
    missing,
    context,
  });

  return {
    currentCard,
    futureCard,
    seedText,
    pack: {
      version: 'card_engine_v1',
      current: {
        detected: currentCard?.source === 'detected',
        fromPrev,
        missing,
        confidence,
      },
      future: {
        mode: 'random',
        note: 'future card is a random candidate; it is not a deterministic prediction',
      },
      context,
    },
    debug: {
      futureStagePoolSize: stagePool.length,
    },
  };
}
