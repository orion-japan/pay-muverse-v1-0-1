// src/lib/mu/generate.ts
import { buildMuSystemPrompt } from './buildSystemPrompt';
import { MU_AGENT, MU_CONFIG } from './config'; // ← MU_DEBUG は不要
import { detectExplicitImageRequest, buildImageStyleAsk } from './imageHook';
import { runImageGeneration } from './imageFlow';
import { buildMuMeta, wrapMuResponse } from './meta';
import { MuTrace } from './trace'; // ← Iros互換のliteトレース（サニタイズ付）

// 環境変数でデバッグ出力を制御（MU_DEBUG_LOG_CONFIG=1/true/yes/on）
const LOG_CFG =
  typeof process !== 'undefined' &&
  /^(1|true|yes|on)$/i.test(String((process as any)?.env?.MU_DEBUG_LOG_CONFIG || ''));

// 必要時のみ設定ダンプ（本番では MU_DEBUG_LOG_CONFIG を未設定に）
if (LOG_CFG) {
  // eslint-disable-next-line no-console
  console.log('[MU_CONFIG]', MU_CONFIG);
}

export type MuContext = {
  user_code: string;
  master_id: string;
  sub_id: string;
  thread_id?: string | null;
  board_id?: string | null;
  source_type?: string | null;

  q_code?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  /** Iros互換の深度ラベル（S1..I3..T3など）。未提供なら null でOK */
  stage?: string | null;
  phase?: 'Inner' | 'Outer';
  idle?: boolean;

  image_style?: '写実' | 'シンプル' | '手描き風';
};

function envNumAny(def: number, ...names: string[]): number {
  for (const n of names) {
    const raw = (typeof process !== 'undefined' ? (process as any).env?.[n] : undefined);
    if (raw != null) {
      const v = Number(raw);
      if (Number.isFinite(v)) return v;
    }
  }
  return def;
}
function envStr(def: string, ...names: string[]): string {
  for (const n of names) {
    const raw = (typeof process !== 'undefined' ? (process as any).env?.[n] : undefined);
    if (typeof raw === 'string' && raw.trim() !== '') return raw;
  }
  return def;
}

function tuneTemperature(base: number, q?: MuContext['q_code'], phase?: MuContext['phase']) {
  let t = base;
  if (q === 'Q5') t += 0.10;
  if (q === 'Q2') t += 0.05;
  if (q === 'Q3') t -= 0.10;
  if (q === 'Q4') t -= 0.05;
  if (phase === 'Inner') t -= 0.05;
  if (phase === 'Outer') t += 0.05;
  return Math.max(0.1, Math.min(0.9, t));
}

function maybeHint(opts: { q?: MuContext['q_code']; phase?: MuContext['phase']; idle?: boolean }) {
  let p = opts.idle ? 0.7 : 0.25;
  if (opts.q === 'Q3') p -= 0.15;
  if (opts.q === 'Q4') p -= 0.10;
  if (opts.q === 'Q5') p += 0.10;
  if (opts.q === 'Q2') p += 0.05;
  p = Math.max(0.05, Math.min(0.9, p));
  if (Math.random() > p) return null;

  const hints = [
    '🌱Self に一言だけ残すと流れがつながります。',
    '📖Vision は続けるほど効きます。今日の一行をどうぞ。',
    '🎨Create でそのイメージを形にしておきましょう。',
    '🌐IBoard は創造の舞台。1枚だけでも出してみますか？',
    '📅Event は習慣と学びの場所。参加チェックが助けになります。',
    '💭mTalk に出すとモヤモヤが整います。',
  ];
  return hints[Math.floor(Math.random() * hints.length)];
}

/** ---- MU 読み込み確認用：meta へ _debug を挿入（MU_DEBUG 依存を排除） ---- */
function attachDebug(meta: any, extra?: Record<string, any>) {
  meta._debug = {
    ...(meta._debug || {}),
    mu_loaded: true,
    mu_config_version: (MU_CONFIG as any)?.version ?? 'unknown',
    mu_logging: (MU_CONFIG as any)?.logging ?? null,
    mu_debug_enabled: !!LOG_CFG, // 代替（環境でログ中か）
    mu_debug_stamp: LOG_CFG ? new Date().toISOString() : '',
    agent_id: (MU_CONFIG as any)?.agent?.ID ?? 'mu',
    model_in_agent: (MU_AGENT as any)?.model ?? null,
    ...extra,
  };
}

export async function generateMuReply(message: string, ctx: MuContext) {
  const trace = new MuTrace(); // lite / off は config/env 側で切替
  // Iros互換の指標セット
  const g = 0.5;
  const stochastic = false;
  const noiseAmp = 0.15;
  const seed = Math.floor(Math.random() * 1e11); // Irosと似た桁

  // 0) 画像フロー: 明示的リクエスト
  if (detectExplicitImageRequest(message)) {
    trace.add('detect_mode', { mode: 'image_request', trigger: 'explicit' });
    trace.add('state_infer', {
      phase: ctx.phase ?? null,
      depth_raw: null,
      depth_final: ctx.stage ?? null, // S系が無ければ null
      q_code: ctx.q_code ?? null,
      signals: { from: 'context' },
    });
    trace.add('indicators', { g, stochastic, noiseAmp, seed });
    trace.add('retrieve', { hits: 0, epsilon: 0.4 });

    const reply = buildImageStyleAsk();
    const meta: any = buildMuMeta({
      model: envStr('gpt-4o-mini', 'MU_MODEL'),
      temperature: envNumAny(0.6, 'MU_TEMPERATURE'),
      top_p: envNumAny(1, 'MU_TOP_P'),
      frequency_penalty: envNumAny(0, 'MU_FREQ_PENALTY'),
      presence_penalty: envNumAny(0, 'MU_PRES_PENALTY'),
      user_code: ctx.user_code,
      master_id: ctx.master_id,
      sub_id: ctx.sub_id,
      thread_id: ctx.thread_id ?? null,
      board_id: ctx.board_id ?? null,
      source_type: ctx.source_type ?? 'chat',
      phase: ctx.phase ?? null,
      q_code: ctx.q_code ?? null,
      hits: 0,
      epsilon: 0.4,
      noiseAmp,
      stochastic,
      g,
      seed,
    });
    augmentIrosCompatibleMeta(meta, {
      phase: ctx.phase ?? 'Inner',
      g, stochastic, noiseAmp, seed,
      q_code: ctx.q_code ?? null,
    });
    meta.dialogue_trace = trace.dump();
    meta.versions = {
      mu_prompt: meta.mu_prompt_version ?? 'mu.v2.1.0',
      q_mapper: 'qmap.v0.3.2',
      schema: 'mu.log.v1',
    };
    attachDebug(meta, { path: 'image_request' });
    return wrapMuResponse({
      conversation_code: ctx.master_id,
      reply,
      meta,
      agent: 'mu',
    });
  }

  // 1) 画像スタイル指定あり → 実生成
  if (ctx.image_style) {
    trace.add('detect_mode', { mode: 'image_generate', trigger: 'style_set' });
    trace.add('state_infer', {
      phase: ctx.phase ?? null,
      depth_raw: null,
      depth_final: ctx.stage ?? null,
      q_code: ctx.q_code ?? null,
      signals: { from: 'context' },
    });
    trace.add('indicators', { g, stochastic, noiseAmp, seed });
    trace.add('retrieve', { hits: 0, epsilon: 0.4 });

    const reply = await runImageGeneration({ prompt: message, style: ctx.image_style });
    const meta: any = buildMuMeta({
      model: envStr('gpt-4o-mini', 'MU_MODEL'),
      temperature: envNumAny(0.6, 'MU_TEMPERATURE'),
      top_p: envNumAny(1, 'MU_TOP_P'),
      frequency_penalty: envNumAny(0, 'MU_FREQ_PENALTY'),
      presence_penalty: envNumAny(0, 'MU_PRES_PENALTY'),
      user_code: ctx.user_code,
      master_id: ctx.master_id,
      sub_id: ctx.sub_id,
      thread_id: ctx.thread_id ?? null,
      board_id: ctx.board_id ?? null,
      source_type: ctx.source_type ?? 'chat',
      phase: ctx.phase ?? null,
      q_code: ctx.q_code ?? null,
      hits: 0,
      epsilon: 0.4,
      noiseAmp,
      stochastic,
      g,
      seed,
    });
    augmentIrosCompatibleMeta(meta, {
      phase: ctx.phase ?? 'Inner',
      g, stochastic, noiseAmp, seed,
      q_code: ctx.q_code ?? null,
    });
    meta.dialogue_trace = trace.dump();
    meta.versions = {
      mu_prompt: meta.mu_prompt_version ?? 'mu.v2.1.0',
      q_mapper: 'qmap.v0.3.2',
      schema: 'mu.log.v1',
    };
    attachDebug(meta, { path: 'image_generate' });
    return wrapMuResponse({
      conversation_code: ctx.master_id,
      reply,
      meta,
      agent: 'mu',
    });
  }

  // 2) 通常テキスト返信
  trace.add('detect_mode', { mode: 'normal', trigger: 'none' });

  const system = buildMuSystemPrompt({});
  const model = (MU_AGENT as any)?.model ?? envStr('gpt-4o-mini', 'MU_MODEL');
  const baseTemp = (MU_AGENT as any)?.temperature ?? envNumAny(0.6, 'MU_TEMPERATURE');
  const temperature = tuneTemperature(baseTemp, ctx.q_code, ctx.phase);
  const top_p = envNumAny(1, 'MU_TOP_P');
  const frequency_penalty = envNumAny(0, 'MU_FREQ_PENALTY');
  const presence_penalty = envNumAny(0, 'MU_PRES_PENALTY');

  trace.add('state_infer', {
    signals: { from: 'context' },
    phase: ctx.phase ?? null,
    depth_raw: null,
    depth_final: ctx.stage ?? null,
    q_code: ctx.q_code ?? null,
  });

  const key = (typeof process !== 'undefined' ? (process as any).env?.OPENAI_API_KEY : undefined);

  if (!key) {
    trace.add('indicators', { g, stochastic, noiseAmp, seed });
    trace.add('retrieve', { hits: 0, epsilon: 0.4 });
    trace.add('openai_reply', { model, temperature, top_p, seed });

    const mock = `（mock）${message}`;
    const hint = maybeHint({ q: ctx.q_code, phase: ctx.phase, idle: ctx.idle });
    const reply = hint ? `${mock}\n\n${hint}` : mock;

    const meta: any = buildMuMeta({
      model,
      temperature,
      top_p,
      frequency_penalty,
      presence_penalty,
      user_code: ctx.user_code,
      master_id: ctx.master_id,
      sub_id: ctx.sub_id,
      thread_id: ctx.thread_id ?? null,
      board_id: ctx.board_id ?? null,
      source_type: ctx.source_type ?? 'chat',
      phase: ctx.phase ?? null,
      q_code: ctx.q_code ?? null,
      hits: 0,
      epsilon: 0.4,
      noiseAmp,
      stochastic,
      g,
      seed,
    });
    augmentIrosCompatibleMeta(meta, {
      phase: ctx.phase ?? 'Inner',
      g, stochastic, noiseAmp, seed,
      q_code: ctx.q_code ?? null,
    });
    meta.dialogue_trace = trace.dump();
    meta.versions = {
      mu_prompt: meta.mu_prompt_version ?? 'mu.v2.1.0',
      q_mapper: 'qmap.v0.3.2',
      schema: 'mu.log.v1',
    };
    attachDebug(meta, { path: 'text_mock' });

    return wrapMuResponse({
      conversation_code: ctx.master_id,
      reply,
      meta,
      agent: 'mu',
    });
  }

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature,
      top_p,
      frequency_penalty,
      presence_penalty,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: message },
      ],
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`OpenAI error: ${resp.status} ${detail}`);
  }

  const data = await resp.json();
  const text: string = data?.choices?.[0]?.message?.content ?? '';
  const hint = maybeHint({ q: ctx.q_code, phase: ctx.phase, idle: ctx.idle });
  const reply = hint ? `${text.trim()}\n\n${hint}` : text.trim();

  trace.add('indicators', { g, stochastic, noiseAmp, seed });
  trace.add('retrieve', { hits: 0, epsilon: 0.4 });
  trace.add('openai_reply', { model, temperature, top_p, seed });

  const meta: any = buildMuMeta({
    model,
    temperature,
    top_p,
    frequency_penalty,
    presence_penalty,
    user_code: ctx.user_code,
    master_id: ctx.master_id,
    sub_id: ctx.sub_id,
    thread_id: ctx.thread_id ?? null,
    board_id: ctx.board_id ?? null,
    source_type: ctx.source_type ?? 'chat',
    phase: ctx.phase ?? null,
    q_code: ctx.q_code ?? null,
    hits: 0,
    epsilon: 0.4,
    noiseAmp,
    stochastic,
    g,
    seed,
  });
  augmentIrosCompatibleMeta(meta, {
    phase: ctx.phase ?? 'Inner',
    g, stochastic, noiseAmp, seed,
    q_code: ctx.q_code ?? null,
  });
  meta.dialogue_trace = trace.dump();
  meta.versions = {
    mu_prompt: meta.mu_prompt_version ?? 'mu.v2.1.0',
    q_mapper: 'qmap.v0.3.2',
    schema: 'mu.log.v1',
  };
  attachDebug(meta, { path: 'text_openai' });

  return wrapMuResponse({
    conversation_code: ctx.master_id,
    reply,
    meta,
    agent: 'mu',
  });
}

/** Iros互換メタを後付けで補正（既存キーを壊さず追加） */
function augmentIrosCompatibleMeta(
  meta: any,
  p: {
    phase: 'Inner' | 'Outer';
    g: number; stochastic: boolean; noiseAmp: number; seed: number;
    q_code: MuContext['q_code'] | null;
  }
) {
  meta.stochastic = p.stochastic;
  meta.g = p.g;
  meta.seed = p.seed;
  meta.noiseAmp = p.noiseAmp;
  meta.phase = p.phase;

  meta.selfAcceptance = meta.selfAcceptance ?? { score: 50, band: '40_70' };
  meta.relation = meta.relation ?? { label: 'harmony', confidence: 0.6 };
  meta.nextQ = meta.nextQ ?? null;
  meta.currentQ = meta.currentQ ?? null;
  meta.used_knowledge = Array.isArray(meta.used_knowledge) ? meta.used_knowledge : [];
  meta.personaTone = meta.personaTone ?? (meta.mu_tone ?? 'gentle_guide');

  meta.stochastic_params = {
    epsilon: meta.epsilon ?? 0.4,
    retrNoise: meta.noiseAmp ?? p.noiseAmp,
    retrSeed: 2054827127, // Iros見た目に合わせて固定
  };

  // Iros側に存在するが空でよいもの（保持 or undefined）
  meta.credit_auth_key = meta.credit_auth_key ?? undefined;
}
