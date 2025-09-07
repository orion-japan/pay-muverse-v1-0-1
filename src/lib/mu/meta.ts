// src/lib/mu/meta.ts
export type MuPhase = 'Inner' | 'Outer' | null;
export type MuQ = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | null;

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

  // retrieval (optional)
  hits?: number;
  epsilon?: number;
  noiseAmp?: number;

  // stochastic (optional)
  stochastic?: boolean;
  g?: number;           // 任意の指標
  seed?: number;        // 乱数種
};

export function buildMuMeta(i: MuMetaInput) {
  const nowModel = i.model;
  const charge = {
    model: nowModel,
    aiId: nowModel,
    amount: 1,
  };

  const dialogue_trace = [
    {
      step: 'detect_mode',
      data: {
        detectedTarget: null,
        mode: 'normal',
      },
    },
    {
      step: 'state_infer',
      data: {
        phase: i.phase ?? null,
        self: { score: 50, band: '40_70' }, // ダミー（必要なら後で接続）
        relation: { label: 'harmony', confidence: 0.6 }, // ダミー
        currentQ: i.q_code ?? null,
        nextQ: null,
      },
    },
    {
      step: 'indicators',
      data: {
        g: i.g ?? 0.5,
        stochastic: i.stochastic ?? false,
        noiseAmp: i.noiseAmp ?? 0.15,
        seed: i.seed ?? Math.floor(Math.random() * 1e10),
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

  const meta = {
    stochastic: i.stochastic ?? false,
    g: i.g ?? 0.5,
    seed: i.seed ?? 0,
    noiseAmp: i.noiseAmp ?? 0.15,
    phase: i.phase ?? null,
    selfAcceptance: { score: 50, band: '40_70' }, // ダミー
    relation: { label: 'harmony', confidence: 0.6 }, // ダミー
    nextQ: null,
    currentQ: i.q_code ?? null,
    used_knowledge: [] as any[],
    personaTone: 'gentle_guide',
    dialogue_trace,
    stochastic_params: {
      epsilon: i.epsilon ?? 0.4,
      retrNoise: i.noiseAmp ?? 0.15,
      retrSeed: i.seed ?? 0,
    },
    credit_auth_key: null as any, // 必要なら差す
    charge,
    master_id: i.master_id,
    sub_id: i.sub_id,
    thread_id: i.thread_id ?? null,
    board_id: i.board_id ?? null,
    source_type: i.source_type ?? 'chat',
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
  return {
    conversation_code: params.conversation_code,
    reply: params.reply,
    meta: params.meta,
    credit_balance: params.credit_balance ?? null,
    charge: params.meta.charge,
    q: params.meta.currentQ
      ? {
          code: params.meta.currentQ,
          stage: 'S3',
          color: { base: 'Green', hex: '#22A559' },
        }
      : null,
    master_id: params.meta.master_id,
    sub_id: params.meta.sub_id,
    conversation_id: params.meta.master_id,
    agent: params.agent ?? 'mu',
    warning: null,
  };
}
