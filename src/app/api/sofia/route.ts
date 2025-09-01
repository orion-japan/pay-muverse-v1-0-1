// src/app/api/sofia/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { buildSofiaSystemPrompt } from '@/lib/sofia/buildSystemPrompt';
import { retrieveKnowledge } from '@/lib/sofia/retrieve';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';
import { SOFIA_CONFIG } from '@/lib/sofia/config';

// ★ 追加：状態推定ユーティリティ（Inner/Outer・自己肯定率・関係性質・次Q）
import {
  inferPhase,
  estimateSelfAcceptance,
  relationQualityFrom,
  nextQFrom,
} from '@/lib/sofia/analyze';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/* =========================
   設定ラッパ（型安全にフォールバック）
========================= */
const CFG: any = SOFIA_CONFIG ?? {};
const CFG_OPENAI = CFG.openai ?? {};
const CFG_RETR = CFG.retrieve ?? {};

const DEFAULT_TEMP: number =
  typeof CFG_OPENAI.temperature === 'number' ? CFG_OPENAI.temperature : 0.8;

const DEFAULT_MAXTOKENS: number | undefined =
  typeof CFG_OPENAI.maxTokens === 'number' ? CFG_OPENAI.maxTokens : undefined;

const RETRIEVE_LIMIT: number =
  typeof CFG_RETR.limit === 'number' ? CFG_RETR.limit : 4;

const RETRIEVE_EPS: number =
  typeof CFG_RETR.epsilon === 'number' ? CFG_RETR.epsilon : 0.3;

const RETRIEVE_NOISE: number =
  typeof CFG_RETR.noiseAmp === 'number' ? CFG_RETR.noiseAmp : 0.15;

/* =========================
   型・ユーティリティ
========================= */
type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
const newConvCode = () => `Q${Date.now()}`;

function json(data: any, init?: number | ResponseInit) {
  const status = typeof init === 'number' ? init : (init as ResponseInit | undefined)?.['status'] ?? 200;
  const headers = new Headers(typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  return new NextResponse(JSON.stringify(data), { status, headers });
}
const bad = (msg: string, code = 400) => json({ error: msg }, code);

function safeParseJson(text: string) { try { return JSON.parse(text); } catch { return null; } }
function getLastText(messages: Msg[] | null | undefined) {
  if (!messages?.length) return null;
  const last = messages[messages.length - 1];
  return last?.content ?? null;
}
function getLastUserText(messages: Msg[] | null | undefined) {
  if (!messages?.length) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return m.content;
    }
  }
  return '';
}
function makeTitleFromMessages(msgs: Msg[]): string | null {
  const firstUser = msgs.find(m => m.role === 'user')?.content?.trim();
  if (!firstUser) return null;
  const t = firstUser.replace(/\s+/g, ' ').slice(0, 20);
  return t.length ? t : null;
}
function sbService() {
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('Supabase env is missing');
  return createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
}
function ensureArray<T = any>(v: any): T[] { return Array.isArray(v) ? v : []; }
function sanitizeBody(raw: any) {
  const allowModels = new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini']);
  return {
    conversation_code: typeof raw?.conversation_code === 'string' ? raw.conversation_code : '',
    mode: ['normal','diagnosis','meaning','intent','dark','remake'].includes(raw?.mode) ? raw.mode : 'normal',
    promptKey: raw?.promptKey ?? 'base',
    vars: typeof raw?.vars === 'object' && raw?.vars ? raw.vars : {},
    messages: ensureArray<Msg>(raw?.messages).slice(-50),
    model: allowModels.has(raw?.model) ? raw.model : 'gpt-4o',
    temperature: typeof raw?.temperature === 'number'
      ? Math.min(Math.max(raw.temperature, 0), 1)
      : DEFAULT_TEMP,
    max_tokens: typeof raw?.max_tokens === 'number'
      ? raw.max_tokens
      : DEFAULT_MAXTOKENS,
    top_p: typeof raw?.top_p === 'number' ? raw.top_p : undefined,
    frequency_penalty: typeof raw?.frequency_penalty === 'number' ? raw.frequency_penalty : undefined,
    presence_penalty: typeof raw?.presence_penalty === 'number' ? raw.presence_penalty : undefined,
    response_format: raw?.response_format ?? undefined,
  };
}

/* ===== ▼ 追加：ir診断トリガー検出（観測対象ラベル抽出） ===== */
function detectDiagnosisTarget(text: string) {
  const t = (text || '').trim();

  // 既存: ir/IR/ｉｒ
  const m1 = t.match(/^(?:ir\s*診断|ir|IR|ｉｒ)(?:[:：\s]+)?(.+)?$/);
  if (m1?.[1]?.trim()) return m1[1].trim();

  // 追加: 「◯◯を見て/観て」「◯◯の状態」「◯◯を診断」「◯◯の様子」
  const m2 = t.match(/(.+?)(?:を?見て|を?観て|の状態|の様子|を診断)/);
  if (m2?.[1]?.trim()) return m2[1].trim();

  return null;
}

/* ===== ▼ 追加：インジケータ/ペルソナ派生 ===== */
function deriveIndicators(userText: string, phase: 'Inner'|'Outer', selfBand: 'lt20'|'20_40'|'40_70'|'70_90'|'gt90', relationLabel: 'harmony'|'discord') {
  const g = Number(((estimateSelfAcceptance(userText).score ?? 50) / 100).toFixed(2));
  const stochastic = relationLabel === 'discord' || selfBand === 'lt20' || selfBand === '20_40';
  const baseNoise = relationLabel === 'discord' ? 0.35 : 0.15;
  const noiseAmp = Number((baseNoise + (phase === 'Outer' ? 0.05 : 0)).toFixed(2));
  const seed = Math.abs(((userText?.length ?? 0) * 2654435761 + (Date.now() & 0xffff)));
  return { g, stochastic, noiseAmp, seed };
}
function derivePersonaTone(phase: 'Inner'|'Outer', selfBand: string, relationLabel: 'harmony'|'discord') {
  // 語りの“人格”傾向（Systemへヒントとして渡す）
  if (phase === 'Inner' && (selfBand === 'lt20' || selfBand === '20_40')) return 'compassion_calm';     // やわらかく、静けさ重視
  if (phase === 'Outer' && relationLabel === 'discord')                return 'mediator_grounded';      // 仲裁・合意形成寄り
  if (selfBand === '70_90' || selfBand === 'gt90')                     return 'co_creator_clear';       // 共創・明晰
  return 'gentle_guide'; // 中庸
}

/* =========================
   フェッチ制御（タイムアウト＆簡易リトライ）
========================= */
const FETCH_TIMEOUT_MS = 25_000;
async function fetchWithTimeout(url: string, init: RequestInit, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort('timeout'), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}
async function callOpenAI(payload: any) {
  let lastErr: any;
  for (const attempt of [1, 2]) {
    try {
      const r = await fetchWithTimeout(CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        return { ok: false as const, status: r.status, detail: safeParseJson(text) ?? text };
      }
      const data = await r.json();
      return { ok: true as const, data };
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, 300 * attempt));
    }
  }
  return { ok: false as const, status: 499, detail: String(lastErr ?? 'unknown') };
}

/* ====== CORS ====== */
export async function OPTIONS() { return json({ ok: true }); }

/* ====== GET ====== */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const qUser = searchParams.get('user_code') || '';
  const conversation_code = searchParams.get('conversation_code') || '';

  if (!qUser) {
    return json({
      ok: true,
      service: 'Sofia API',
      time: new Date().toISOString(),
      model_hint: 'gpt-4o',
    });
  }

  const z = await verifyFirebaseAndAuthorize(req);
  if (!z.ok) return json({ error: z.error }, z.status);
  if (!z.allowed) return json({ error: 'forbidden' }, 403);
  const userCode = z.userCode!;

  const sb = sbService();

  if (!conversation_code) {
    const { data, error } = await sb
      .from('sofia_conversations')
      .select('conversation_code, title, updated_at, messages')
      .eq('user_code', userCode)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (error) return bad(`DB error: ${error.message}`, 500);

    const items = (data ?? []).map((row) => ({
      conversation_code: row.conversation_code as string,
      title: (row.title as string | null) ?? null,
      updated_at: (row.updated_at as string | null) ?? null,
      last_text: getLastText((row.messages as Msg[]) ?? []),
    }));

    return json({ items });
  }

  const { data, error } = await sb
    .from('sofia_conversations')
    .select('messages')
    .eq('user_code', userCode)
    .eq('conversation_code', conversation_code)
    .maybeSingle();

  if (error) return bad(`DB error: ${error.message}`, 500);

  const messages: Msg[] = (data?.messages as Msg[]) ?? [];
  return json({ messages });
}

/* ====== POST ====== */
export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) return bad('Env OPENAI_API_KEY is missing', 500);

    const z = await verifyFirebaseAndAuthorize(req);
    if (!z.ok) return json({ error: z.error }, z.status);
    if (!z.allowed) return json({ error: 'forbidden' }, 403);
    const userCode = z.userCode!;

    // ---- 受信 & 正規化
    const safe = sanitizeBody((await req.json().catch(() => ({}))) || {});
    let {
      conversation_code: inCode,
      mode,
      promptKey,
      vars,
      messages,
      model,
      temperature,
      max_tokens, top_p, frequency_penalty, presence_penalty, response_format,
    } = safe;

    const conversation_code = inCode || newConvCode();

    /* ===== ▼ 追加：最後のユーザー発話から ir診断 を自動検出し、診断モードを強制 ===== */
    const lastUserMsg = getLastUserText(messages);
    const detectedTarget = lastUserMsg ? detectDiagnosisTarget(lastUserMsg) : null;
    if (detectedTarget) {
      console.log('[SofiaAPI] diagnosis trigger detected:', detectedTarget);
      mode = 'diagnosis';
      vars = { ...(vars || {}), diagnosisTarget: detectedTarget };
    }

    // ★ 解析由来ステート（位相/肯定率/関係性/次Q）→ インジケータ & ペルソナ
    const phase = inferPhase(lastUserMsg || '');
    const self = estimateSelfAcceptance(lastUserMsg || '');
    const relation = relationQualityFrom(phase, self.band);
    const currentQ = (vars as any)?.analysis?.qcodes?.[0]?.code ?? null;
    const nextQ = currentQ ? nextQFrom(currentQ, phase) : null;

    const indicators = deriveIndicators(lastUserMsg || '', phase, self.band, relation.label);
    const personaTone = derivePersonaTone(phase, self.band, relation.label);

    // ===== System Prompt 構築（varsへ“人格ヒント/状態”を注入）=====
    console.time('[SofiaAPI] buildSystemPrompt');
    const system = buildSofiaSystemPrompt({
      promptKey,
      mode,
      vars: {
        ...(vars || {}),
        resonanceState: {
          phase,
          selfAcceptance: self,
          relation,
          nextQ,
          currentQ,
        },
        personaTone, // ← UI/文体の傾きをテンプレ側に渡す（テンプレ側は存在しなくてもOK）
      },
      includeGuard: true,
      enforceResonance: true,
    });
    console.timeEnd('[SofiaAPI] buildSystemPrompt');
    console.log('[SofiaAPI] system prompt summary:', {
      promptKey,
      mode,
      length: system.length,
      head: system.slice(0, 180).replace(/\n/g, ' ⏎ ') + (system.length > 180 ? '…' : ''),
    });

    // ---- 検索リトリーブ
    const seedForRetr = Math.abs(
      [...`${userCode}:${conversation_code}`].reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)
    );
    const analysis = (vars as any)?.analysis || { qcodes: [], layers: [], keywords: [] };

    console.time('[SofiaAPI] retrieveKnowledge');
    const kb = await retrieveKnowledge(analysis, RETRIEVE_LIMIT, lastUserMsg, {
      epsilon: RETRIEVE_EPS,
      noiseAmp: RETRIEVE_NOISE,
      seed: seedForRetr,
    });
    console.timeEnd('[SofiaAPI] retrieveKnowledge');
    console.log('[SofiaAPI] retrieve summary:', {
      lastUser: (lastUserMsg || '').slice(0, 60),
      limit: RETRIEVE_LIMIT,
      epsilon: RETRIEVE_EPS,
      noiseAmp: RETRIEVE_NOISE,
      seed: seedForRetr,
      hits: Array.isArray(kb) ? kb.length : 0,
    });

    // ---- OpenAI 呼び出し
    const payload: any = {
      model,
      messages: [{ role: 'system', content: system }, ...(messages as Msg[])],
      temperature,
    };
    if (typeof max_tokens === 'number') payload.max_tokens = max_tokens;
    if (typeof top_p === 'number') payload.top_p = top_p;
    if (typeof frequency_penalty === 'number') payload.frequency_penalty = frequency_penalty;
    if (typeof presence_penalty === 'number') payload.presence_penalty = presence_penalty;
    if (response_format) payload.response_format = response_format;

    console.log('[SofiaAPI] openai payload summary:', {
      model,
      temperature,
      max_tokens: payload.max_tokens ?? null,
      top_p: payload.top_p ?? null,
      msgs_in: payload.messages?.length ?? 0,
    });

    console.time('[SofiaAPI] openai.chat');
    const result = await callOpenAI(payload);
    console.timeEnd('[SofiaAPI] openai.chat');

    if (!result.ok) {
      console.warn('[SofiaAPI] upstream error:', result.status, result.detail);
      return json({ error: 'Upstream error', status: result.status, detail: result.detail }, result.status);
    }

    const data = result.data;
    const reply: string = data?.choices?.[0]?.message?.content ?? '';

    // ---- 会話の保存（messages）
    const merged: Msg[] = Array.isArray(messages) ? [...messages] : [];
    if (reply) merged.push({ role: 'assistant', content: reply });

    const sb = sbService();
    const title = makeTitleFromMessages(merged);

    // ★ 会話の流れが読めるように：トレースをメタに残す
    const dialogue_trace = [
      { step: 'detect_mode',    data: { detectedTarget, mode } },
      { step: 'state_infer',    data: { phase, self, relation, currentQ, nextQ } },
      { step: 'indicators',     data: indicators },
      { step: 'retrieve',       data: { hits: (Array.isArray(kb) ? kb.length : 0), epsilon: RETRIEVE_EPS, noiseAmp: RETRIEVE_NOISE, seed: seedForRetr } },
      { step: 'build_system',   data: { promptKey, personaTone, length: system.length } },
      { step: 'openai_reply',   data: { model, temperature, hasReply: !!reply } },
    ];

    // ★ 返却・保存用メタ（フロント既存表示の互換を維持）
    const metaPacked: any = {
      // 既存インジケータ互換（トップレベル）
      stochastic: indicators.stochastic,
      g: indicators.g,
      seed: indicators.seed,
      noiseAmp: indicators.noiseAmp,

      // 解析状態
      phase,
      selfAcceptance: self,
      relation,
      nextQ,
      currentQ,

      // 参考（UIに出さなくてもOK）
      used_knowledge: (Array.isArray(kb) ? kb : []).map((k: any, i: number) => ({ id: k.id, key: `K${i + 1}`, title: k.title })),
      personaTone,
      dialogue_trace,
      stochastic_params: { epsilon: RETRIEVE_EPS, retrNoise: RETRIEVE_NOISE, retrSeed: seedForRetr },
      ...(mode === 'diagnosis' ? { diagnosisTarget: detectedTarget ?? null } : {}),
    };

    // ★ 会話スレッド本体に upsert
    const { error: upErr } = await sb.from('sofia_conversations').upsert(
      {
        user_code: userCode,
        conversation_code,
        title: title ?? null,
        messages: merged,
        updated_at: new Date().toISOString(),
        // ★ last_meta が存在する環境では保存される（無ければDBが拒否→握りつぶし）
        last_meta: metaPacked as any,
      } as any,
      { onConflict: 'user_code,conversation_code' }
    );
    if (upErr) console.warn('[sofia_conversations upsert]', upErr?.message || upErr);

    // ★ 1ターンごとのログ（存在すれば書く）
    try {
      const turn_index = merged.filter(m => m.role === 'assistant').length; // 1始まり相当
      await sb.from('sofia_turns').insert({
        user_code: userCode,
        conversation_code,
        turn_index,
        user_text: lastUserMsg ?? '',
        assistant_text: reply ?? '',
        meta: metaPacked,
        created_at: new Date().toISOString(),
      } as any);
    } catch (e) {
      console.warn('[sofia_turns insert] skipped:', String((e as any)?.message ?? e));
    }

    // ---- 応答
    return json({
      conversation_code,
      reply,
      meta: metaPacked,
    });
  } catch (e: any) {
    console.error('[Sofia API] Error:', e);
    return json({ error: 'Unhandled error', detail: String(e?.message ?? e) }, 500);
  }
}
