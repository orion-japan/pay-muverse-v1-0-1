// src/lib/mu/generate.ts
import { buildMuSystemPrompt } from './buildSystemPrompt';
import { MU_AGENT, MU_CONFIG } from './config';
import { detectExplicitImageRequest, buildImageStyleAsk } from './imageHook';
import { runImageGeneration } from './imageFlow';
import { buildMuMeta, wrapMuResponse } from './meta';
import { MuTrace } from './trace';

// ▼ 共有Qコード推定（mirra と同じ実装を共用）
//   ※ 将来は '@/lib/qcode/infer' に移設するとより綺麗です
import { inferQCode } from '@/lib/mirra/qcode';

// ===== デバッグ制御 =====
const LOG_CFG =
  typeof process !== 'undefined' &&
  /^(1|true|yes|on)$/i.test(String((process as any)?.env?.MU_DEBUG_LOG_CONFIG || ''));

if (LOG_CFG) {
  // eslint-disable-next-line no-console
  console.log('[MU_CONFIG]', MU_CONFIG);
}

// ===== 型 =====
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

type SelfBand = '0_40' | '40_70' | '70_100';
type RelationLabel = 'tension' | 'harmony' | 'neutral';

// ===== env helpers =====
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

/** ---- MU 読み込み確認用：meta へ _debug を挿入 ---- */
function attachDebug(meta: any, extra?: Record<string, any>) {
  meta._debug = {
    ...(meta._debug || {}),
    mu_loaded: true,
    mu_config_version: (MU_CONFIG as any)?.version ?? 'unknown',
    mu_logging: (MU_CONFIG as any)?.logging ?? null,
    mu_debug_enabled: !!LOG_CFG,
    mu_debug_stamp: LOG_CFG ? new Date().toISOString() : '',
    agent_id: (MU_CONFIG as any)?.agent?.ID ?? 'mu',
    model_in_agent: (MU_AGENT as any)?.model ?? null,
    ...extra,
  };
}

// ===== 軽い推定（phase/self/relation） =====
function inferPhase(text: string): 'Inner' | 'Outer' {
  const t = (text || '').toLowerCase();
  const innerKeys = ['気持ち','感情','不安','イライラ','怖','心','胸','わたし','私'];
  const outerKeys = ['上司','相手','会議','職場','メール','チーム','外部','環境'];
  const innerHit = innerKeys.some(k => t.includes(k));
  const outerHit = outerKeys.some(k => t.includes(k));
  if (innerHit && !outerHit) return 'Inner';
  if (outerHit && !innerHit) return 'Outer';
  return 'Inner';
}
function inferSelfAcceptance(text: string): { score: number; band: SelfBand } {
  const t = (text || '').toLowerCase();
  let score = 50;
  if (/(できない|無理|最悪|ダメ|嫌い|消えたい)/.test(t)) score -= 10;
  if (/(大丈夫|できた|よかった|助かった|嬉しい|安心)/.test(t)) score += 10;
  score = Math.max(0, Math.min(100, score));
  const band: SelfBand = score < 40 ? '0_40' : score <= 70 ? '40_70' : '70_100';
  return { score, band };
}
function inferRelation(text: string): { label: RelationLabel; confidence: number } {
  const t = (text || '').toLowerCase();
  if (/(上司|相手|部下|顧客|家族|友人)/.test(t)) {
    if (/(対立|怒|苛立|もめ|争)/.test(t)) return { label: 'tension', confidence: 0.7 };
    return { label: 'harmony', confidence: 0.6 };
  }
  return { label: 'neutral', confidence: 0.5 };
}

// ===== Iros 風 analysis セクション =====
function buildAnalysis(
  input: string,
  reply: string,
  q: string | null,
  phase: 'Inner' | 'Outer',
  self: { score: number; band: SelfBand },
  relation: { label: RelationLabel; confidence: number }
) {
  const head = input.replace(/\s+/g, ' ').slice(0, 80);
  const qMap: Record<string, string> = {
    Q1: '秩序や境界がテーマ',
    Q2: '突破/怒りのエネルギーがテーマ',
    Q3: '安定欲求と不安のゆらぎがテーマ',
    Q4: '恐れや萎縮の解除がテーマ',
    Q5: '情熱と空虚感のバランスがテーマ',
  };
  const summary = `${head}${head.length === 80 ? '…' : ''}（${q && qMap[q] ? qMap[q] : '内省フェーズ'}）`;

  let background = '自己期待と現実のギャップによるストレス反応が考えられます。';
  if (q === 'Q1') background = '境界や手順への配慮が満たされず、苛立ちや詰まり感が生じている可能性。';
  if (q === 'Q2') background = '成長/裁量を妨げられた感覚が怒りとして表面化している可能性。';
  if (q === 'Q3') background = '不確実さや自己評価の揺らぎが不安として滞留している可能性。';
  if (q === 'Q4') background = '威圧/圧の記憶が再燃し、身体の萎縮が思考を狭めている可能性。';
  if (q === 'Q5') background = '意欲の火種が見えづらく、空虚を埋める行動に流れやすい可能性。';

  const tips = [
    '事実/解釈/願いを3行で分ける',
    '20〜60秒のミニ実験（呼吸・姿勢・1行メモ）',
    '「本当はどうあってほしい？」を1問だけ書く',
    '終わったら気分を1〜5で自己評価'
  ];

  const keyword =
    q === 'Q2' ? '境界が守られると怒りは方向性に変わる' :
    q === 'Q3' ? '小さな安定が次の一歩を呼ぶ' :
    q === 'Q1' ? '秩序は安心の足場' :
    q === 'Q4' ? '圧が抜けると呼吸が戻る' :
    '火種は小さくても前に進む';

  return {
    summary,
    background,
    tips,
    keyword,
    phase,
    selfAcceptance: self,
    relation,
    q
  };
}

export async function generateMuReply(message: string, ctx: MuContext) {
  const trace = new MuTrace(); // lite / off は config/env 側で切替
  // Iros互換の指標セット
  const g = 0.5;
  const stochastic = false;
  const noiseAmp = 0.15;
  const seed = Math.floor(Math.random() * 1e11); // Irosと似た桁

  // 事前の軽推定（Mu は案内役なので常時行う）
  const phase: 'Inner' | 'Outer' = ctx.phase ?? inferPhase(message);
  const self = inferSelfAcceptance(message);
  const relation = inferRelation(message);

  // Qコード推定（信頼度付き）
  let qMeta: { q?: 'Q1'|'Q2'|'Q3'|'Q4'|'Q5'; confidence?: number; hint?: string; color_hex?: string } = {};
  try {
    qMeta = await inferQCode(message);
  } catch {
    // 無視（ネットワーク失敗等）
  }

  // 0) 画像フロー: 明示的リクエスト
  if (detectExplicitImageRequest(message)) {
    trace.add('detect_mode', { mode: 'image_request', trigger: 'explicit' });
    trace.add('state_infer', {
      phase,
      depth_raw: null,
      depth_final: ctx.stage ?? null,
      q_code: qMeta.q ?? ctx.q_code ?? null,
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
      phase,
      q_code: qMeta.q ?? ctx.q_code ?? null,
      hits: 0,
      epsilon: 0.4,
      noiseAmp,
      stochastic,
      g,
      seed,
    });
    augmentIrosCompatibleMeta(meta, { phase, g, stochastic, noiseAmp, seed, q_code: qMeta.q ?? ctx.q_code ?? null });
    meta.analysis = buildAnalysis(message, reply, qMeta.q ?? null, phase, self, relation);
    meta.dialogue_trace = trace.dump();
    meta.versions = { mu_prompt: meta.mu_prompt_version ?? 'mu.v2.1.0', q_mapper: 'qmap.v0.3.2', schema: 'mu.log.v1' };
    attachDebug(meta, { path: 'image_request', q_meta: qMeta });

    // Iros 互換の top-level q も出す
    const qTop = qMeta.q ? {
      code: qMeta.q,
      stage: ctx.stage ?? 'S1',
      color: { base: 'Auto', hex: qMeta.color_hex ?? '#FFD54F' }
    } : undefined;

    return wrapMuResponse({
      conversation_code: ctx.master_id,
      reply,
      meta,
      agent: 'mu',
      q: qTop
    } as any);
  }

  // 1) 画像スタイル指定あり → 実生成
  if (ctx.image_style) {
    trace.add('detect_mode', { mode: 'image_generate', trigger: 'style_set' });
    trace.add('state_infer', {
      phase,
      depth_raw: null,
      depth_final: ctx.stage ?? null,
      q_code: qMeta.q ?? ctx.q_code ?? null,
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
      phase,
      q_code: qMeta.q ?? ctx.q_code ?? null,
      hits: 0,
      epsilon: 0.4,
      noiseAmp,
      stochastic,
      g,
      seed,
    });
    augmentIrosCompatibleMeta(meta, { phase, g, stochastic, noiseAmp, seed, q_code: qMeta.q ?? ctx.q_code ?? null });
    meta.analysis = buildAnalysis(message, reply, qMeta.q ?? null, phase, self, relation);
    meta.dialogue_trace = trace.dump();
    meta.versions = { mu_prompt: meta.mu_prompt_version ?? 'mu.v2.1.0', q_mapper: 'qmap.v0.3.2', schema: 'mu.log.v1' };
    attachDebug(meta, { path: 'image_generate', q_meta: qMeta });

    const qTop = qMeta.q ? {
      code: qMeta.q,
      stage: ctx.stage ?? 'S1',
      color: { base: 'Auto', hex: qMeta.color_hex ?? '#FFD54F' }
    } : undefined;

    return wrapMuResponse({
      conversation_code: ctx.master_id,
      reply,
      meta,
      agent: 'mu',
      q: qTop
    } as any);
  }

  // 2) 通常テキスト返信
  trace.add('detect_mode', { mode: 'normal', trigger: 'none' });

  const system = buildMuSystemPrompt({});
  const model = (MU_AGENT as any)?.model ?? envStr('gpt-4o-mini', 'MU_MODEL');
  const baseTemp = (MU_AGENT as any)?.temperature ?? envNumAny(0.6, 'MU_TEMPERATURE');
  const temperature = tuneTemperature(baseTemp, qMeta.q ?? ctx.q_code, phase);
  const top_p = envNumAny(1, 'MU_TOP_P');
  const frequency_penalty = envNumAny(0, 'MU_FREQ_PENALTY');
  const presence_penalty = envNumAny(0, 'MU_PRES_PENALTY');

  trace.add('state_infer', {
    signals: { from: 'context' },
    phase,
    depth_raw: null,
    depth_final: ctx.stage ?? null,
    q_code: qMeta.q ?? ctx.q_code ?? null,
  });

  const key = (typeof process !== 'undefined' ? (process as any).env?.OPENAI_API_KEY : undefined);

  if (!key) {
    trace.add('indicators', { g, stochastic, noiseAmp, seed });
    trace.add('retrieve', { hits: 0, epsilon: 0.4 });
    trace.add('openai_reply', { model, temperature, top_p, seed });

    const mock = `（mock）${message}`;
    const hint = maybeHint({ q: qMeta.q ?? ctx.q_code, phase, idle: ctx.idle });
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
      phase,
      q_code: qMeta.q ?? ctx.q_code ?? null,
      hits: 0,
      epsilon: 0.4,
      noiseAmp,
      stochastic,
      g,
      seed,
    });
    augmentIrosCompatibleMeta(meta, { phase, g, stochastic, noiseAmp, seed, q_code: qMeta.q ?? ctx.q_code ?? null });
    meta.analysis = buildAnalysis(message, reply, qMeta.q ?? null, phase, self, relation);
    meta.dialogue_trace = trace.dump();
    meta.versions = { mu_prompt: meta.mu_prompt_version ?? 'mu.v2.1.0', q_mapper: 'qmap.v0.3.2', schema: 'mu.log.v1' };
    attachDebug(meta, { path: 'text_mock', q_meta: qMeta });

    const qTop = qMeta.q ? {
      code: qMeta.q,
      stage: ctx.stage ?? 'S1',
      color: { base: 'Auto', hex: qMeta.color_hex ?? '#FFD54F' }
    } : undefined;

    return wrapMuResponse({
      conversation_code: ctx.master_id,
      reply,
      meta,
      agent: 'mu',
      q: qTop
    } as any);
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
  const hint = maybeHint({ q: qMeta.q ?? ctx.q_code, phase, idle: ctx.idle });
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
    phase,
    q_code: qMeta.q ?? ctx.q_code ?? null,
    hits: 0,
    epsilon: 0.4,
    noiseAmp,
    stochastic,
    g,
    seed,
  });
  augmentIrosCompatibleMeta(meta, { phase, g, stochastic, noiseAmp, seed, q_code: qMeta.q ?? ctx.q_code ?? null });
  meta.analysis = buildAnalysis(message, reply, qMeta.q ?? null, phase, self, relation);
  meta.dialogue_trace = trace.dump();
  meta.versions = { mu_prompt: meta.mu_prompt_version ?? 'mu.v2.1.0', q_mapper: 'qmap.v0.3.2', schema: 'mu.log.v1' };
  attachDebug(meta, { path: 'text_openai', q_meta: qMeta });

  const qTop = qMeta.q ? {
    code: qMeta.q,
    stage: ctx.stage ?? 'S1',
    color: { base: 'Auto', hex: qMeta.color_hex ?? '#FFD54F' }
  } : undefined;

  return wrapMuResponse({
    conversation_code: ctx.master_id,
    reply,
    meta,
    agent: 'mu',
    q: qTop
  } as any);
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
  meta.currentQ = meta.currentQ ?? (p.q_code ?? null);
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
