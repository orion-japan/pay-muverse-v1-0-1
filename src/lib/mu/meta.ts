// src/lib/mu/meta.ts
export type MuPhase = 'Inner' | 'Outer' | null;
export type MuQ = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | null;

/** Iros 互換の dialogue_trace ステップ */
export type MuTraceStep = 'detect_mode' | 'state_infer' | 'indicators' | 'retrieve' | 'openai_reply';
export type MuTraceEntry = { step: MuTraceStep; data: Record<string, any> };
export type MuDialogueTraceLite = MuTraceEntry[];

export type MuMetaInput = {
  model: string;
  temperature: number;
  top_p: number;
  frequency_penalty: number;
  presence_penalty: number;

  // context
  user_code: string;
  master_id: string;
  sub_id: string;
  thread_id?: string | null;
  board_id?: string | null;
  source_type?: string | null;

  // sensed states
  phase?: MuPhase;
  q_code?: MuQ;
  /** Irosの深度（S1..I3..T3）。なければ null */
  stage?: string | null;

  // retrieval (optional)
  hits?: number;
  epsilon?: number;
  noiseAmp?: number;

  // stochastic (optional)
  stochastic?: boolean;
  g?: number;           // 任意指標
  seed?: number;        // 乱数種

  /** すでに生成済みの dialogue_trace を渡す場合（generate.ts 側で構築） */
  dialogue_trace?: MuDialogueTraceLite | undefined;

  /** Mu 側のトーンがあれば受け取り、Irosの personaTone にも転記 */
  personaTone?: string | undefined;
};

/** Iros 互換の既定 trace を（必要時のみ）生成 */
function buildDefaultTrace(i: MuMetaInput): MuDialogueTraceLite {
  return [
    {
      step: 'detect_mode',
      data: { detectedTarget: null, mode: 'normal' },
    },
    {
      step: 'state_infer',
      data: {
        phase: i.phase ?? null,
        self: { score: 50, band: '40_70' },
        relation: { label: 'harmony', confidence: 0.6 },
        currentQ: i.q_code ?? null,
        nextQ: null,
        depth_raw: null,
        depth_final: i.stage ?? null,
        q_code: i.q_code ?? null,
      },
    },
    {
      step: 'indicators',
      data: {
        g: i.g ?? 0.5,
        stochastic: i.stochastic ?? false,
        noiseAmp: i.noiseAmp ?? 0.15,
        seed: i.seed ?? Math.floor(Math.random() * 1e11),
      },
    },
    {
      step: 'retrieve',
      data: {
        hits: i.hits ?? 0,
        epsilon: i.epsilon ?? 0.4,
        noiseAmp: i.noiseAmp ?? 0.15,
        seed: i.seed ?? 0,
      },
    },
    {
      step: 'openai_reply',
      data: {
        model: i.model,
        temperature: i.temperature,
        top_p: i.top_p,
        presence_penalty: i.presence_penalty,
        frequency_penalty: i.frequency_penalty,
        hasReply: true,
      },
    },
  ];
}

export function buildMuMeta(i: MuMetaInput) {
  const nowModel = i.model;
  const charge = {
    model: nowModel,
    aiId: nowModel,
    amount: 1,
  };

  // dialogue_trace は generate.ts 側から供給されればそれを採用。無ければ Iros互換の既定を生成。
  const dialogue_trace: MuDialogueTraceLite | undefined =
    Array.isArray(i.dialogue_trace) ? i.dialogue_trace : buildDefaultTrace(i);

  const meta = {
    stochastic: i.stochastic ?? false,
    g: i.g ?? 0.5,
    seed: i.seed ?? 0,
    noiseAmp: i.noiseAmp ?? 0.15,
    phase: i.phase ?? null,
    selfAcceptance: { score: 50, band: '40_70' }, // ダミー（Iros互換の見た目）
    relation: { label: 'harmony', confidence: 0.6 }, // ダミー
    nextQ: null,
    currentQ: i.q_code ?? null,
    used_knowledge: [] as any[],
    personaTone: i.personaTone ?? 'gentle_guide',
    dialogue_trace,
    stochastic_params: {
      epsilon: i.epsilon ?? 0.4,
      retrNoise: i.noiseAmp ?? 0.15,
      // Iros の見た目に合わせ固定 seed を使用（generate 側で後上書きしてもOK）
      retrSeed: 2054827127,
    },
    credit_auth_key: null as any, // 必要なら差す
    charge,
    master_id: i.master_id,
    sub_id: i.sub_id,
    thread_id: i.thread_id ?? null,
    board_id: i.board_id ?? null,
    source_type: i.source_type ?? 'chat',
    // 追加：Iros 側の q 表示で stage を使いたいケース向け
    stage: i.stage ?? null,
  };

  return meta;
}

export function wrapMuResponse(params: {
  conversation_code: string;   // = master_id でもOK
  reply: string;
  meta: ReturnType<typeof buildMuMeta>;
  credit_balance?: number;
  agent?: 'mu';
}) {
  // 既存の meta をなるべく素通しで返す（Iros 互換の“長いログ”を保つ）
  const m = params.meta as any;

  // q ブロックは Iros 互換。stage は meta.stage があれば採用。
  const q =
    m.currentQ
      ? {
          code: m.currentQ,
          stage: m.stage ?? null,
          color: { base: 'Green', hex: '#22A559' }, // 既定（必要に応じて上位で差し替え）
        }
      : null;

  return {
    conversation_code: params.conversation_code,
    reply: params.reply,
    meta: m, // ← ここを素通し
    credit_balance: params.credit_balance ?? null,
    charge: m.charge,
    q,
    master_id: m.master_id,
    sub_id: m.sub_id,
    conversation_id: m.master_id,
    agent: params.agent ?? 'mu',
    warning: null,
  };
}
