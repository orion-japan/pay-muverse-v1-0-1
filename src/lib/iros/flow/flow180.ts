// src/lib/iros/flow/flow180.ts
// iros — Flow180 state catalog
//
// 役割:
// - 180状態（e1〜e5 × 18段階 × pos/neg）の short ラベル正本
// - stateId の生成 / 分解
// - stateId から short を引く
// - prev / now から最小差分を作る
//
// 方針:
// - runtime では「短い状態エネルギーラベル」だけを使う
// - 長い説明文はここには持たない
// - LLM には stateId + short を渡せばよい

export type FlowEnergy = 'e1' | 'e2' | 'e3' | 'e4' | 'e5';
export type FlowPolarity = 'pos' | 'neg';

export type FlowStage =
  | 'S1' | 'S2' | 'S3'
  | 'F1' | 'F2' | 'F3'
  | 'R1' | 'R2' | 'R3'
  | 'C1' | 'C2' | 'C3'
  | 'I1' | 'I2' | 'I3'
  | 'T1' | 'T2' | 'T3';

export type FlowStateId = `${FlowEnergy}-${FlowStage}-${FlowPolarity}`;

export type FlowStateEntry = {
  id: FlowStateId;
  energy: FlowEnergy;
  stage: FlowStage;
  polarity: FlowPolarity;
  short: string;
};

export type FlowDeltaType =
  | 'same'
  | 'stage_only'
  | 'energy_only'
  | 'polarity_only'
  | 'stage_energy'
  | 'stage_polarity'
  | 'energy_polarity'
  | 'all_changed';

export type FlowDelta = {
  prev: FlowStateId | null;
  now: FlowStateId;
  prevLabel: string | null;
  nowLabel: string;
  deltaType: FlowDeltaType;
  changed: boolean;
  energyChanged: boolean;
  stageChanged: boolean;
  polarityChanged: boolean;
  short: string;
  sentence: string;
};

export const FLOW_STAGE_ORDER: FlowStage[] = [
  'S1', 'S2', 'S3',
  'F1', 'F2', 'F3',
  'R1', 'R2', 'R3',
  'C1', 'C2', 'C3',
  'I1', 'I2', 'I3',
  'T1', 'T2', 'T3',
];

type StageLabelMap = Record<FlowStage, { pos: string; neg: string }>;

const FLOW_STATE_SOURCE: Record<FlowEnergy, StageLabelMap> = {
  e1: {
    S1: { pos: '意志が生まれる', neg: '意志が生まれない' },
    S2: { pos: '方向が見える', neg: '方向を見失う' },
    S3: { pos: '言葉として立ち上がる', neg: '言葉にできない' },

    F1: { pos: '自分の軸が定まる', neg: '自分が保てない' },
    F2: { pos: '関係を受け入れる', neg: '受け入れられない' },
    F3: { pos: '関係の中で自分が立つ', neg: '関係の中で自分が消える' },

    R1: { pos: '他者とつながる', neg: 'つながれない' },
    R2: { pos: '関係が機能する', neg: '関係が噛み合わない' },
    R3: { pos: '関係が成立し実用になる', neg: '関係が成立せず途切れる' },

    C1: { pos: '関係を再配置できる', neg: '関係を切れない' },
    C2: { pos: '関係が外に作用する', neg: '関係が閉じて広がらない' },
    C3: { pos: '関係が新しく生まれる', neg: '関係が消耗する' },

    I1: { pos: '意図として統合される', neg: '意図が持てない' },
    I2: { pos: '意図で関係を選べる', neg: '関係に振り回される' },
    I3: { pos: '意図で関係を生み出す', neg: '関係が空虚になる' },

    T1: { pos: '存在として関係を持つ', neg: '関係が重荷になる' },
    T2: { pos: '関係が自然に流れる', neg: '関係が停滞する' },
    T3: { pos: '関係そのものが場になる', neg: '関係が断絶する' },
  },

  e2: {
    S1: { pos: '芽が出る', neg: '芽が出ない' },
    S2: { pos: '育つ方向が見える', neg: '育つ方向を失う' },
    S3: { pos: '成長を言葉にできる', neg: '怒りで言葉が荒れる' },

    F1: { pos: '自分が育ちはじめる', neg: '育つ前に止まる' },
    F2: { pos: '変化を栄養にできる', neg: '変化を拒んで腐る' },
    F3: { pos: '他者の中で育つ', neg: '他者の中で傷む' },

    R1: { pos: '関係の中で伸びる', neg: '関係の中で怒りが育つ' },
    R2: { pos: '育つ関係を選べる', neg: '関係に消耗する' },
    R3: { pos: '成長が実用になる', neg: '成長が止まり停滞する' },

    C1: { pos: '育つ形に再配置する', neg: '怠さで動けない' },
    C2: { pos: '成長が外に作用する', neg: '怒りが外に漏れる' },
    C3: { pos: '新しい実りが生まれる', neg: '実りになる前に腐る' },

    I1: { pos: '育つ意図に触れる', neg: '意図が枯れる' },
    I2: { pos: '育つ方向を選べる', neg: '怒りで方向を誤る' },
    I3: { pos: '目的を育て続ける', neg: '目的を失い怠ける' },

    T1: { pos: '存在として育みを持つ', neg: '育みが止まる' },
    T2: { pos: '成長が循環になる', neg: '停滞が循環する' },
    T3: { pos: '育つ場そのものになる', neg: '場が枯れる' },
  },

  e3: {
    S1: { pos: '中心が生まれる', neg: '中心が定まらない' },
    S2: { pos: '全体のバランスが見える', neg: 'バランスを見失う' },
    S3: { pos: '考えが整理される', neg: '考えすぎて固まる' },

    F1: { pos: '自分の土台が安定する', neg: '自分が不安定になる' },
    F2: { pos: '現実を受け止められる', neg: '受け止めきれない' },
    F3: { pos: '内側が整い続ける', neg: '内側で詰まり続ける' },

    R1: { pos: '安心できる関係ができる', neg: '不安な関係になる' },
    R2: { pos: '関係の中で安定する', neg: '関係で揺さぶられる' },
    R3: { pos: '安定した基盤になる', neg: '重く停滞する' },

    C1: { pos: '構造を整え直す', neg: '整理できず溜まる' },
    C2: { pos: '安定を広げる', neg: '停滞が広がる' },
    C3: { pos: '土台が循環を生む', neg: '重さが循環する' },

    I1: { pos: '中心の意図に触れる', neg: '思い込みに閉じる' },
    I2: { pos: '安定した選択ができる', neg: '迷い続ける' },
    I3: { pos: '揺れない軸を持つ', neg: '軸が崩れる' },

    T1: { pos: '存在として安定している', neg: '存在が不安定になる' },
    T2: { pos: '安定が循環する', neg: '停滞が循環する' },
    T3: { pos: '場の中心になる', neg: '場が重く沈む' },
  },

  e4: {
    S1: { pos: '動き出す', neg: '動けない' },
    S2: { pos: '流れが見える', neg: '流れが読めない' },
    S3: { pos: '伝わる形になる', neg: '伝わらない' },

    F1: { pos: '自然に動ける', neg: '固まる' },
    F2: { pos: '変化に適応できる', neg: '変化を怖がる' },
    F3: { pos: '関係の中で流れる', neg: '関係で止まる' },

    R1: { pos: 'やり取りが生まれる', neg: 'やり取りが止まる' },
    R2: { pos: 'スムーズに通じる', neg: 'すれ違う' },
    R3: { pos: '流れが現実で機能する', neg: '流れが止まり停滞する' },

    C1: { pos: '流れを作り直す', neg: '流れを断つ' },
    C2: { pos: '動きが広がる', neg: 'プレッシャーが広がる' },
    C3: { pos: '新しい流れが生まれる', neg: '動きが止まり続ける' },

    I1: { pos: '流れの意図に触れる', neg: '恐れに閉じる' },
    I2: { pos: '流れを選べる', neg: '流れに飲まれる' },
    I3: { pos: '流れを生み出す', neg: '流れを止めてしまう' },

    T1: { pos: '存在として流れている', neg: '存在が固まる' },
    T2: { pos: '流れが循環する', neg: '停滞が循環する' },
    T3: { pos: '場そのものが流れる', neg: '場が止まる' },
  },

  e5: {
    S1: { pos: '火が灯る', neg: '火が灯らない' },
    S2: { pos: '未来が見える', neg: '未来が見えない' },
    S3: { pos: '表現が弾ける', neg: '表現が止まる' },

    F1: { pos: '自分が活性する', neg: '自分が沈む' },
    F2: { pos: '楽しめる', neg: '楽しめない' },
    F3: { pos: '内側から湧く', neg: '内側が空になる' },

    R1: { pos: '場が明るくなる', neg: '場が重くなる' },
    R2: { pos: '関係が盛り上がる', neg: '関係が冷える' },
    R3: { pos: '活性が現実で回る', neg: '活力が続かない' },

    C1: { pos: '流れを加速させる', neg: 'エネルギーが落ちる' },
    C2: { pos: '影響が広がる', neg: '無関心が広がる' },
    C3: { pos: '新しい熱が生まれる', neg: '熱が消えていく' },

    I1: { pos: '喜びの意図に触れる', neg: '意味を感じない' },
    I2: { pos: '未来を選べる', neg: '未来を諦める' },
    I3: { pos: '意図が周囲を動かす', neg: '意図が空回る' },

    T1: { pos: '存在が輝いている', neg: '存在がくすむ' },
    T2: { pos: 'エネルギーが循環する', neg: 'エネルギーが枯れる' },
    T3: { pos: '場そのものが光になる', neg: '場が暗く閉じる' },
  },
};

export function makeFlowStateId(
  energy: FlowEnergy,
  stage: FlowStage,
  polarity: FlowPolarity,
): FlowStateId {
  return `${energy}-${stage}-${polarity}`;
}

export function parseFlowStateId(id: string | null | undefined): {
  energy: FlowEnergy;
  stage: FlowStage;
  polarity: FlowPolarity;
} | null {
  const raw = String(id ?? '').trim();
  const m = raw.match(/^(e[1-5])-(S[1-3]|F[1-3]|R[1-3]|C[1-3]|I[1-3]|T[1-3])-(pos|neg)$/);
  if (!m) return null;

  return {
    energy: m[1] as FlowEnergy,
    stage: m[2] as FlowStage,
    polarity: m[3] as FlowPolarity,
  };
}

function buildCatalog(): Record<FlowStateId, FlowStateEntry> {
  const out = {} as Record<FlowStateId, FlowStateEntry>;

  (Object.keys(FLOW_STATE_SOURCE) as FlowEnergy[]).forEach((energy) => {
    FLOW_STAGE_ORDER.forEach((stage) => {
      (['pos', 'neg'] as const).forEach((polarity) => {
        const id = makeFlowStateId(energy, stage, polarity);
        out[id] = {
          id,
          energy,
          stage,
          polarity,
          short: FLOW_STATE_SOURCE[energy][stage][polarity],
        };
      });
    });
  });

  return out;
}

export const FLOW180: Record<FlowStateId, FlowStateEntry> = buildCatalog();

export function getFlowState(id: FlowStateId | null | undefined): FlowStateEntry | null {
  if (!id) return null;
  return FLOW180[id] ?? null;
}

export function getFlowShort(id: FlowStateId | null | undefined): string {
  if (!id) return '';
  return FLOW180[id]?.short ?? '';
}

function pickDeltaType(args: {
  energyChanged: boolean;
  stageChanged: boolean;
  polarityChanged: boolean;
}): FlowDeltaType {
  const { energyChanged, stageChanged, polarityChanged } = args;

  if (!energyChanged && !stageChanged && !polarityChanged) return 'same';
  if (!energyChanged && stageChanged && !polarityChanged) return 'stage_only';
  if (energyChanged && !stageChanged && !polarityChanged) return 'energy_only';
  if (!energyChanged && !stageChanged && polarityChanged) return 'polarity_only';
  if (energyChanged && stageChanged && !polarityChanged) return 'stage_energy';
  if (!energyChanged && stageChanged && polarityChanged) return 'stage_polarity';
  if (energyChanged && !stageChanged && polarityChanged) return 'energy_polarity';
  return 'all_changed';
}

export function buildFlowDelta(
  prev: FlowStateId | null | undefined,
  now: FlowStateId,
): FlowDelta {
  const nowParsed = parseFlowStateId(now);
  if (!nowParsed) {
    throw new Error(`Invalid now flow state id: ${String(now)}`);
  }

  const prevParsed = parseFlowStateId(prev ?? null);
  const prevLabel = prevParsed ? getFlowShort(prev as FlowStateId) : null;
  const nowLabel = getFlowShort(now);

  if (!prevParsed) {
    return {
      prev: null,
      now,
      prevLabel: null,
      nowLabel,
      deltaType: 'same',
      changed: false,
      energyChanged: false,
      stageChanged: false,
      polarityChanged: false,
      short: nowLabel,
      sentence: `${nowLabel}状態です`,
    };
  }

  const energyChanged = prevParsed.energy !== nowParsed.energy;
  const stageChanged = prevParsed.stage !== nowParsed.stage;
  const polarityChanged = prevParsed.polarity !== nowParsed.polarity;
  const changed = energyChanged || stageChanged || polarityChanged;
  const deltaType = pickDeltaType({ energyChanged, stageChanged, polarityChanged });

  const short = changed
    ? `${prevLabel ?? prev} → ${nowLabel}`
    : nowLabel;

  const sentence = changed
    ? `${prevLabel ?? prev}状態から${nowLabel}状態へ移行しています`
    : `${nowLabel}状態を維持しています`;

  return {
    prev: prev as FlowStateId,
    now,
    prevLabel,
    nowLabel,
    deltaType,
    changed,
    energyChanged,
    stageChanged,
    polarityChanged,
    short,
    sentence,
  };
}

export function listFlow180(): FlowStateEntry[] {
  return Object.values(FLOW180);
}
