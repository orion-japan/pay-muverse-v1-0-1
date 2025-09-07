// src/lib/mu/generate.ts
import { buildMuSystemPrompt } from './buildSystemPrompt';
import { MU_AGENT } from './config';
import { detectExplicitImageRequest, buildImageStyleAsk } from './imageHook';
import { runImageGeneration } from './imageFlow';
import { buildMuMeta, wrapMuResponse } from './meta';

export type MuContext = {
  user_code: string;
  master_id: string;
  sub_id: string;
  thread_id?: string | null;
  board_id?: string | null;
  source_type?: string | null;

  q_code?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  phase?: 'Inner' | 'Outer';
  idle?: boolean;

  image_style?: '写実' | 'シンプル' | '手描き風';
};

function envNumAny(def: number, ...names: string[]): number {
  for (const n of names) {
    const raw = process.env[n];
    if (raw != null) {
      const v = Number(raw);
      if (Number.isFinite(v)) return v;
    }
  }
  return def;
}

function envStr(def: string, ...names: string[]): string {
  for (const n of names) {
    const raw = process.env[n];
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

export async function generateMuReply(
  message: string,
  ctx: MuContext
) {
  // 0) 画像フロー: 明示的リクエスト
  if (detectExplicitImageRequest(message)) {
    const reply = buildImageStyleAsk();
    const meta = buildMuMeta({
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
      noiseAmp: 0.15,
      stochastic: false,
      g: 0.5,
      seed: Math.floor(Math.random() * 1e9),
    });
    return wrapMuResponse({
      conversation_code: ctx.master_id,
      reply,
      meta,
      agent: 'mu',
    });
  }

  // 1) 画像スタイル指定あり → 実生成
  if (ctx.image_style) {
    const reply = await runImageGeneration({ prompt: message, style: ctx.image_style });
    const meta = buildMuMeta({
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
      noiseAmp: 0.15,
      stochastic: false,
      g: 0.5,
      seed: Math.floor(Math.random() * 1e9),
    });
    return wrapMuResponse({
      conversation_code: ctx.master_id,
      reply,
      meta,
      agent: 'mu',
    });
  }

  // 2) 通常テキスト返信
  const system = buildMuSystemPrompt({});
  const model = (MU_AGENT as any)?.model ?? envStr('gpt-4o-mini', 'MU_MODEL');
  const baseTemp = (MU_AGENT as any)?.temperature ?? envNumAny(0.6, 'MU_TEMPERATURE');
  const temperature = tuneTemperature(baseTemp, ctx.q_code, ctx.phase);
  const top_p = envNumAny(1, 'MU_TOP_P');
  const frequency_penalty = envNumAny(0, 'MU_FREQ_PENALTY');
  const presence_penalty = envNumAny(0, 'MU_PRES_PENALTY');

  const key = process.env.OPENAI_API_KEY;

  if (!key) {
    const mock = `（mock）${message}`;
    const hint = maybeHint({ q: ctx.q_code, phase: ctx.phase, idle: ctx.idle });
    const reply = hint ? `${mock}\n\n${hint}` : mock;
    const meta = buildMuMeta({
      model, temperature, top_p, frequency_penalty, presence_penalty,
      user_code: ctx.user_code, master_id: ctx.master_id, sub_id: ctx.sub_id,
      thread_id: ctx.thread_id ?? null, board_id: ctx.board_id ?? null, source_type: ctx.source_type ?? 'chat',
      phase: ctx.phase ?? null, q_code: ctx.q_code ?? null,
      hits: 0, epsilon: 0.4, noiseAmp: 0.15, stochastic: false, g: 0.5, seed: 0,
    });
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

  const meta = buildMuMeta({
    model, temperature, top_p, frequency_penalty, presence_penalty,
    user_code: ctx.user_code, master_id: ctx.master_id, sub_id: ctx.sub_id,
    thread_id: ctx.thread_id ?? null, board_id: ctx.board_id ?? null, source_type: ctx.source_type ?? 'chat',
    phase: ctx.phase ?? null, q_code: ctx.q_code ?? null,
    hits: 0, epsilon: 0.4, noiseAmp: 0.15, stochastic: false, g: 0.5, seed: 0,
  });

  return wrapMuResponse({
    conversation_code: ctx.master_id,
    reply,
    meta,
    agent: 'mu',
  });
}
