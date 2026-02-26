// src/lib/iros/cards/card180.ts
// iros — 180 state card system (v0 scaffold)
// 目的:
// - 現状カード（検出できれば） + 未来カード（ランダム）を生成
// - LLMへ渡すための「座標 + 意味 + 補正（sa / ゆらぎ / 余白）」を整形
// - まずは e1 の base meaning を実装（e2〜e5 は後で増やす）
//
// 方針メモ:
// - e_turn は "今ターンの反応（instant）"
// - stage は "構造の柱（depthStage）"
// - polarity は "意識の向き（yin=ネガ版 / yang=ポジ版）" ※Inner/Outerとは別
// - 検出不能は許可（現状カード=null）
// - 未来カードはランダム重視（S1〜I3 を既定プール）
//
// 注意:
// - このファイルは単体で使えるようにしています（既存配線を決め打ちしません）
// - 次に配線する時は、このファイルを import する箇所だけ確認して差し込みます

export const STAGES = [
  'S1', 'S2', 'S3',
  'F1', 'F2', 'F3',
  'R1', 'R2', 'R3',
  'C1', 'C2', 'C3',
  'I1', 'I2', 'I3',
  'T1', 'T2', 'T3',
] as const;

export type DepthStage = (typeof STAGES)[number];
export type Band = 'S' | 'F' | 'R' | 'C' | 'I' | 'T';

export const E_TURNS = ['e1', 'e2', 'e3', 'e4', 'e5'] as const;
export type ETurn = (typeof E_TURNS)[number];

export const POLARITIES = ['yin', 'yang'] as const;
export type CardPolarity = (typeof POLARITIES)[number];

export type MeaningKey = `${ETurn}:${DepthStage}`;

export type CardSignalInput = {
  e_turn?: ETurn | null;            // 今ターンの感情圧（instant）
  stage?: DepthStage | null;        // 深度（柱）
  polarity?: CardPolarity | null;   // yin/yang（ネガ版/ポジ版の選択）
  sa?: number | null;               // self-acceptance 的な受け取り傾向（0..1 想定）
  fluctuation?: number | null;      // ゆらぎ（0..1 推奨）
  margin?: number | null;           // 余白（0..1 推奨）
  confidence?: number | null;       // 検出信頼度（0..1）
  basedOn?: string | null;          // 根拠1点（ログ/文の要約など）
};

export type DualCardInput = {
  current: CardSignalInput;
  previous?: CardSignalInput | null; // 現状カード検出不能時の参考（任意）
  randomSeed?: number | null;        // テスト再現用
};

export type CardStageMeta = {
  stage: DepthStage;
  band: Band;
  stageIndex: number; // 1..18
};

export type EMeta = {
  e_turn: ETurn;
  label: string;
  core: string;
};

export type CardResolved = {
  source: 'detected' | 'fallback_previous' | 'random';
  detectable: boolean;
  meaningKey: MeaningKey;
  cardId: `${ETurn}-${DepthStage}-${CardPolarity}`;
  e_turn: ETurn;
  e_meta: EMeta;
  stage: DepthStage;
  stageMeta: CardStageMeta;
  polarity: CardPolarity;
  polarityVariant: 'negative' | 'positive';
  baseMeaning: string;          // 極性なしの核意味
  polarizedMeaning: string;     // yin/yang 適用後
  llmHintLine: string;          // LLM向け圧縮1行
  basedOn: string | null;
  confidence: number | null;
  sa: number | null;
  saBias: {
    label: 'low' | 'mid' | 'high' | 'unknown';
    note: string;
  };
  fluctuation: number | null;
  fluctuationBand: 'low' | 'mid' | 'high' | 'unknown';
  margin: number | null;
  marginBand: 'low' | 'mid' | 'high' | 'unknown';
};

export type DualCardPacket = {
  currentCard: CardResolved | null;
  futureCard: CardResolved;
  llmPacket: {
    current: ReturnType<typeof toLlmCardPayload> | null;
    future: ReturnType<typeof toLlmCardPayload>;
    systemNotes: string[];
  };
};

export type CardBuildOptions = {
  currentUndetectablePolicy?: 'null' | 'use_previous'; // 既定:null
  allowGenericFallbackMeaning?: boolean;               // 既定:true（e2..e5 未定義時の仮文）
  futureStagePool?: DepthStage[];                      // 既定:S1..I3
  futureETurnPool?: ETurn[];                           // 既定:e1..e5
  futurePolarityPool?: CardPolarity[];                 // 既定:yin/yang
};

const DEFAULT_OPTIONS: Required<CardBuildOptions> = {
  currentUndetectablePolicy: 'null',
  allowGenericFallbackMeaning: true,
  futureStagePool: STAGES.filter((s) => !s.startsWith('T')) as DepthStage[], // S1..I3
  futureETurnPool: [...E_TURNS],
  futurePolarityPool: [...POLARITIES],
};

const E_META: Record<ETurn, EMeta> = {
  e1: { e_turn: 'e1', label: '秩序/我慢', core: '保つ・整える・崩さない・飲み込む' },
  e2: { e_turn: 'e2', label: '成長/怒り', core: '伸びる・押し返す・境界を作る・突破する' },
  e3: { e_turn: 'e3', label: '安定/不安', core: '支える・固める・確かめる・揺れを止めたい' },
  e4: { e_turn: 'e4', label: '流動/恐れ', core: '流す・避ける・ほどく・離脱/浄化したい' },
  e5: { e_turn: 'e5', label: '情熱/空虚', core: '灯す・燃やす・惹かれる・空きを埋めたい' },
};

const STAGE_META: Record<DepthStage, CardStageMeta> = Object.fromEntries(
  STAGES.map((stage, idx) => {
    const band = stage[0] as Band;
    return [stage, { stage, band, stageIndex: idx + 1 }];
  }),
) as Record<DepthStage, CardStageMeta>;

/* =========================================================
   e1 base meanings（極性なし）
   ========================================================= */

const E1_BASE: Record<DepthStage, string> = {
  S1: '外界の刺激から自分を守るために、反応を小さくして保つ。',
  S2: '安心できる形を作るために、繰り返し・一定・いつもの流れを求める。',
  S3: '言葉や記憶を受け取るとき、崩れないように内側で整列して保持する。',

  F1: '他者との差を感じたとき、揺れを抑えるために“ちゃんとする”方向へ寄る。',
  F2: '自分の位置を失わないために、役割・基準・手順で自分を保つ。',
  F3: '評価や視線の中で崩れないよう、感情より先に振る舞いを制御する。',

  R1: '関係を壊さないために、衝突や本音を一度飲み込み、場の安定を優先する。',
  R2: '相手や場の流れに合わせながら、自分の輪郭を秩序的に残そうとする。',
  R3: '関係の中で生じる緊張を、言葉・距離・順番の調整で静かに管理する。',

  C1: '成果を出すために、行動を整理し、優先順位と再現性を作る。',
  C2: '責任や期待に応えるために、負荷を抱えながらも構造で持ちこたえる。',
  C3: '自分の創造を継続可能にするために、ルール・型・配線を整える。',

  I1: '本来の方向へ進むために、不要な反応を抑え、意図に沿って整列し直す。',
  I2: '意図を守るために、感情や対人反応を構造の中に置き直して扱う。',
  I3: '自分の核を生きるために、秩序そのものを“自分の意思”として持つ。',

  T1: '未来の像に触れたとき、暴走しないように意味と順序を与えて受け止める。',
  T2: '複数の可能性が開いたとき、軸を保つために選択条件を静かに定める。',
  T3: '未来から来る感覚を、現実で扱える形に落とし込み、継続可能な構造にする。',
};

const BASE_MEANINGS: Partial<Record<ETurn, Partial<Record<DepthStage, string>>>> = {
  e1: E1_BASE,
  // e2〜e5 はあとで追加
};

/* =========================================================
   Public API
   ========================================================= */

export function buildDualCardPacket(
  input: DualCardInput,
  options?: CardBuildOptions,
): DualCardPacket {
  const opt = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  const rng = createRng(input.randomSeed ?? null);

  const currentCard = resolveCurrentCard(input.current, {
    previous: input.previous ?? null,
    opt,
    rng,
  });

  const futureCard = resolveFutureRandomCard({
    baseInput: input.current,
    opt,
    rng,
  });

  return {
    currentCard,
    futureCard,
    llmPacket: {
      current: currentCard ? toLlmCardPayload(currentCard) : null,
      future: toLlmCardPayload(futureCard),
      systemNotes: [
        'currentCard は「現状の観測」。検出不能なら null を許可する。',
        'futureCard は「ランダム候補」。制御しすぎず、次の返信で一瞬で変化しうる前提で扱う。',
        'e_turn は今ターンの圧（instant）。stage は柱（構造）。両方を分けて扱う。',
        'polarity は yin=ネガ版 / yang=ポジ版（Inner/Outerとは別軸）。',
        'sa は受け取り傾向の補正。低いほど否定/過剰適応（いい子）寄りとして読む。',
      ],
    },
  };
}

export function toLlmCardPayload(card: CardResolved) {
  return {
    cardId: card.cardId,
    source: card.source,
    meaningKey: card.meaningKey,
    e_turn: card.e_turn,
    e_label: card.e_meta.label,
    stage: card.stage,
    band: card.stageMeta.band,
    stageIndex: card.stageMeta.stageIndex,
    polarity: card.polarity,
    polarityVariant: card.polarityVariant,
    baseMeaning: card.baseMeaning,
    polarizedMeaning: card.polarizedMeaning,
    llmHintLine: card.llmHintLine,
    basedOn: card.basedOn,
    confidence: card.confidence,
    sa: card.sa,
    saBias: card.saBias,
    fluctuation: card.fluctuation,
    fluctuationBand: card.fluctuationBand,
    margin: card.margin,
    marginBand: card.marginBand,
  };
}

/** LLM にそのまま渡しやすい文字列（system/userContext用） */
export function formatDualCardPacketForLLM(packet: DualCardPacket): string {
  const lines: string[] = [
    'CARD_PACKET (DO NOT OUTPUT):',
    '',
    'CURRENT_CARD:',
    packet.currentCard ? formatOneCardForLLM(packet.currentCard) : '(null)',
    '',
    'FUTURE_CARD_RANDOM_CANDIDATE:',
    formatOneCardForLLM(packet.futureCard),
    '',
    'CARD_RULES:',
    ...packet.llmPacket.systemNotes.map((s) => `- ${s}`),
  ];
  return lines.join('\n');
}

/* =========================================================
   Resolver
   ========================================================= */

function resolveCurrentCard(
  current: CardSignalInput,
  ctx: { previous: CardSignalInput | null; opt: Required<CardBuildOptions>; rng: () => number },
): CardResolved | null {
  const normalized = normalizeSignal(current);

  // 検出条件（現状カード）
  const hasCore =
    normalized.e_turn != null &&
    normalized.stage != null &&
    normalized.polarity != null;

  if (hasCore) {
    return buildResolvedCard({
      source: 'detected',
      e_turn: normalized.e_turn!,
      stage: normalized.stage!,
      polarity: normalized.polarity!,
      basedOn: normalized.basedOn ?? null,
      confidence: normalized.confidence ?? null,
      sa: normalized.sa ?? null,
      fluctuation: normalized.fluctuation ?? null,
      margin: normalized.margin ?? null,
      allowGenericFallbackMeaning: ctx.opt.allowGenericFallbackMeaning,
    });
  }

  // 検出不能ポリシー
  if (ctx.opt.currentUndetectablePolicy === 'use_previous' && ctx.previous) {
    const prev = normalizeSignal(ctx.previous);
    if (prev.e_turn && prev.stage && prev.polarity) {
      return buildResolvedCard({
        source: 'fallback_previous',
        e_turn: prev.e_turn,
        stage: prev.stage,
        polarity: prev.polarity,
        basedOn: normalized.basedOn ?? prev.basedOn ?? 'previous_state_fallback',
        confidence: normalized.confidence ?? prev.confidence ?? null,
        sa: normalized.sa ?? prev.sa ?? null,
        fluctuation: normalized.fluctuation ?? prev.fluctuation ?? null,
        margin: normalized.margin ?? prev.margin ?? null,
        allowGenericFallbackMeaning: ctx.opt.allowGenericFallbackMeaning,
      });
    }
  }

  return null;
}

function resolveFutureRandomCard(args: {
  baseInput: CardSignalInput;
  opt: Required<CardBuildOptions>;
  rng: () => number;
}): CardResolved {
  const n = normalizeSignal(args.baseInput);

  // 現状カードが「検出できる入力だったか」で basedOn を切り替える
  // （e_turn + stage + polarity が揃っていれば “currentCard 相当” とみなす）
  const hasCurrentCore = n.e_turn != null && n.stage != null && n.polarity != null;

  // 未来カードはランダム重視（ここが大事）
  const e_turn = pickRandom(args.opt.futureETurnPool, args.rng);
  const stage = pickRandom(args.opt.futureStagePool, args.rng);
  const polarity = pickRandom(args.opt.futurePolarityPool, args.rng);

  return buildResolvedCard({
    source: 'random',
    e_turn,
    stage,
    polarity,
    basedOn: hasCurrentCore ? 'future_from_current' : 'future_pool_pick',
    confidence: n.confidence ?? null,
    sa: n.sa ?? null,
    fluctuation: n.fluctuation ?? null,
    margin: n.margin ?? null,
    allowGenericFallbackMeaning: args.opt.allowGenericFallbackMeaning,
  });
}
/* =========================================================
   Card builder
   ========================================================= */

function buildResolvedCard(args: {
  source: CardResolved['source'];
  e_turn: ETurn;
  stage: DepthStage;
  polarity: CardPolarity;
  basedOn: string | null;
  confidence: number | null;
  sa: number | null;
  fluctuation: number | null;
  margin: number | null;
  allowGenericFallbackMeaning: boolean;
}): CardResolved {
  const eMeta = E_META[args.e_turn];
  const stageMeta = STAGE_META[args.stage];
  const baseMeaning = getBaseMeaning(args.e_turn, args.stage, args.allowGenericFallbackMeaning);

  const polarityVariant = args.polarity === 'yin' ? 'negative' : 'positive';

  const sa = norm01(args.sa);
  const fluctuation = norm01(args.fluctuation);
  const margin = norm01(args.margin);

  const saBias = classifySaBias(sa);
  const fluctuationBand = classifyBand01(fluctuation);
  const marginBand = classifyBand01(margin);

  const polarizedMeaning = buildPolarizedMeaning({
    baseMeaning,
    polarity: args.polarity,
    eMeta,
    stageMeta,
    saBias,
    fluctuationBand,
    marginBand,
  });

  const llmHintLine = buildLlmHintLine({
    eMeta,
    stageMeta,
    polarity: args.polarity,
    baseMeaning,
    saBias,
    basedOn: args.basedOn,
  });

  return {
    source: args.source,
    detectable: args.source !== 'random',
    meaningKey: `${args.e_turn}:${args.stage}`,
    cardId: `${args.e_turn}-${args.stage}-${args.polarity}`,
    e_turn: args.e_turn,
    e_meta: eMeta,
    stage: args.stage,
    stageMeta,
    polarity: args.polarity,
    polarityVariant,
    baseMeaning,
    polarizedMeaning,
    llmHintLine,
    basedOn: args.basedOn ?? null,
    confidence: norm01(args.confidence),
    sa,
    saBias,
    fluctuation,
    fluctuationBand,
    margin,
    marginBand,
  };
}

/* =========================================================
   Meaning synthesis
   ========================================================= */

function getBaseMeaning(
  e_turn: ETurn,
  stage: DepthStage,
  allowGenericFallbackMeaning: boolean,
): string {
  const byE = BASE_MEANINGS[e_turn];
  const hit = byE?.[stage];
  if (typeof hit === 'string' && hit.trim()) return hit.trim();

  if (!allowGenericFallbackMeaning) {
    return '（未定義）';
  }

  // e2〜e5 未実装の暫定フォールバック（構造を壊さないための最小文）
  const e = E_META[e_turn];
  const sm = STAGE_META[stage];
  return `${e.label}の圧が${stage}（${sm.band}帯）で現れ、いまの反応を方向づけている。`;
}

function buildPolarizedMeaning(args: {
  baseMeaning: string;
  polarity: CardPolarity;
  eMeta: EMeta;
  stageMeta: CardStageMeta;
  saBias: ReturnType<typeof classifySaBias>;
  fluctuationBand: ReturnType<typeof classifyBand01>;
  marginBand: ReturnType<typeof classifyBand01>;
}): string {
  const polarityLine =
    args.polarity === 'yin'
      ? 'yin（陰）: 内向き保持・飲み込み・圧縮として出やすい（ネガティブ版を採用）'
      : 'yang（陽）: 外向き表出・活用・整流として出やすい（ポジティブ版を採用）';

  const saLine =
    args.saBias.label === 'unknown'
      ? 'sa補正: (unknown)'
      : `sa補正: ${args.saBias.note}`;

  const swayLine = `ゆらぎ=${args.fluctuationBand} / 余白=${args.marginBand}`;

  // LLM向けには「長文化しすぎない」。核意味 + 向き + 補正だけ
  return [
    args.baseMeaning,
    polarityLine,
    saLine,
    `状態補正: ${swayLine}`,
  ].join(' / ');
}

function buildLlmHintLine(args: {
  eMeta: EMeta;
  stageMeta: CardStageMeta;
  polarity: CardPolarity;
  baseMeaning: string;
  saBias: ReturnType<typeof classifySaBias>;
  basedOn: string | null;
}): string {
  const p = args.polarity === 'yin' ? 'NEG' : 'POS';
  const sa = args.saBias.label === 'unknown' ? 'sa:?' : `sa:${args.saBias.label}`;
  const root = args.basedOn ? ` / root=${truncate(args.basedOn, 42)}` : '';
  return `[${args.eMeta.e_turn}|${args.stageMeta.stage}|${p}|${sa}] ${truncate(args.baseMeaning, 90)}${root}`;
}

function formatOneCardForLLM(card: CardResolved): string {
  const payload = toLlmCardPayload(card);
  return [
    `cardId=${payload.cardId}`,
    `source=${payload.source}`,
    `meaningKey=${payload.meaningKey}`,
    `e_turn=${payload.e_turn} (${payload.e_label})`,
    `stage=${payload.stage} / band=${payload.band} / idx=${payload.stageIndex}`,
    `polarity=${payload.polarity} (${payload.polarityVariant})`,
    `confidence=${payload.confidence ?? '(null)'}`,
    `sa=${payload.sa ?? '(null)'} / saBias=${payload.saBias.label}`,
    `fluctuation=${payload.fluctuation ?? '(null)'} / fluctuationBand=${payload.fluctuationBand}`,
    `margin=${payload.margin ?? '(null)'} / marginBand=${payload.marginBand}`,
    `basedOn=${payload.basedOn ?? '(null)'}`,
    `baseMeaning=${payload.baseMeaning}`,
    `polarizedMeaning=${payload.polarizedMeaning}`,
    `llmHintLine=${payload.llmHintLine}`,
  ].join('\n');
}

/* =========================================================
   Helpers
   ========================================================= */

function normalizeSignal(v: CardSignalInput): Required<CardSignalInput> {
  return {
    e_turn: normalizeETurn(v.e_turn ?? null),
    stage: normalizeStage(v.stage ?? null),
    polarity: normalizePolarity(v.polarity ?? null),
    sa: norm01(v.sa ?? null),
    fluctuation: norm01(v.fluctuation ?? null),
    margin: norm01(v.margin ?? null),
    confidence: norm01(v.confidence ?? null),
    basedOn: normalizeText(v.basedOn ?? null),
  };
}

function normalizeETurn(v: unknown): ETurn | null {
  const s = String(v ?? '').trim().toLowerCase();
  return (E_TURNS as readonly string[]).includes(s) ? (s as ETurn) : null;
}

function normalizeStage(v: unknown): DepthStage | null {
  const s = String(v ?? '').trim().toUpperCase();
  return (STAGES as readonly string[]).includes(s) ? (s as DepthStage) : null;
}

function normalizePolarity(v: unknown): CardPolarity | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'yin' || s === '陰' || s === 'neg' || s === 'negative') return 'yin';
  if (s === 'yang' || s === '陽' || s === 'pos' || s === 'positive') return 'yang';
  return null;
}

function normalizeText(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

function norm01(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return Math.round(v * 1000) / 1000;
}

function classifyBand01(v: number | null): 'low' | 'mid' | 'high' | 'unknown' {
  if (v == null) return 'unknown';
  if (v < 0.34) return 'low';
  if (v < 0.67) return 'mid';
  return 'high';
}

function classifySaBias(sa: number | null): {
  label: 'low' | 'mid' | 'high' | 'unknown';
  note: string;
} {
  if (sa == null) {
    return { label: 'unknown', note: 'sa未取得のため補正なし' };
  }
  if (sa < 0.34) {
    return {
      label: 'low',
      note: '低sa: 否定的に解釈しやすい / 言うことを聞きすぎる（過剰適応）方向に寄りやすい',
    };
  }
  if (sa < 0.67) {
    return {
      label: 'mid',
      note: '中sa: 文脈依存で揺れる。状況次第で否定/活用の両方に振れうる',
    };
  }
  return {
    label: 'high',
    note: '高sa: 受け取り直し・前向き解釈・自己一致方向に寄せやすい',
  };
}

function truncate(s: string, n: number): string {
  const t = String(s ?? '');
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + '…';
}

function pickRandom<T>(arr: readonly T[], rng: () => number): T {
  if (!arr.length) throw new Error('pickRandom: empty array');
  const idx = Math.floor(rng() * arr.length);
  return arr[Math.max(0, Math.min(arr.length - 1, idx))];
}

function createRng(seed: number | null): () => number {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) return Math.random;
  let a = (seed >>> 0) || 1;
  return () => {
    // mulberry32
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =========================================================
   Example (コメントアウト)
   ========================================================= */
/*
const packet = buildDualCardPacket(
  {
    current: {
      e_turn: 'e2',
      stage: 'R1',
      polarity: 'yin',
      sa: 0.22,
      fluctuation: 0.74,
      margin: 0.18,
      confidence: 0.81,
      basedOn: '「あなただよ！！」で対象を強く外に置いた',
    },
    previous: {
      e_turn: 'e1',
      stage: 'R1',
      polarity: 'yin',
      sa: 0.25,
    },
    randomSeed: 669933,
  },
  {
    currentUndetectablePolicy: 'null',
    // futureStagePool: STAGES.filter(s => !s.startsWith('T')) as DepthStage[],
  },
);

console.log(packet.currentCard);
console.log(packet.futureCard);
console.log(formatDualCardPacketForLLM(packet));
*/
