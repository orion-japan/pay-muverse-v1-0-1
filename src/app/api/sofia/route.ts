export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { buildSofiaSystemPrompt } from '@/lib/sofia/buildSystemPrompt';
import { retrieveKnowledge } from '@/lib/sofia/retrieve';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

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
  const safe = {
    conversation_code: typeof raw?.conversation_code === 'string' ? raw.conversation_code : '',
    mode: ['normal','diagnosis','meaning','intent','dark','remake'].includes(raw?.mode) ? raw.mode : 'normal',
    promptKey: raw?.promptKey ?? 'base',
    vars: typeof raw?.vars === 'object' && raw?.vars ? raw.vars : {},
    messages: ensureArray<Msg>(raw?.messages).slice(-50), // 直近50件に制限
    model: allowModels.has(raw?.model) ? raw.model : 'gpt-4o',
    temperature: typeof raw?.temperature === 'number' ? Math.min(Math.max(raw.temperature, 0), 1) : 0.8,
    max_tokens: typeof raw?.max_tokens === 'number' ? raw.max_tokens : undefined,
    top_p: typeof raw?.top_p === 'number' ? raw.top_p : undefined,
    frequency_penalty: typeof raw?.frequency_penalty === 'number' ? raw.frequency_penalty : undefined,
    presence_penalty: typeof raw?.presence_penalty === 'number' ? raw.presence_penalty : undefined,
    response_format: raw?.response_format ?? undefined,
  };
  return safe;
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
      await new Promise(res => setTimeout(res, 300 * attempt)); // 短い指数バックオフ
    }
  }
  return { ok: false as const, status: 499, detail: String(lastErr ?? 'unknown') };
}

/* ====== CORS ====== */
export async function OPTIONS() { return json({ ok: true }); }

/* ====== GET ======
 * 1) /api/sofia                         -> health（無認証OK）
 * 2) /api/sofia?user_code=...           -> 会話一覧（要認証）
 * 3) /api/sofia?user_code=...&conversation_code=... -> 会話メッセージ（要認証）
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const qUser = searchParams.get('user_code') || '';
  const conversation_code = searchParams.get('conversation_code') || '';

  // --- ヘルスチェックは無認証で返す ---
  if (!qUser) {
    return json({
      ok: true,
      service: 'Sofia API',
      time: new Date().toISOString(),
      model_hint: 'gpt-4o',
    });
  }

  // --- ここから要認証 ---
  const z = await verifyFirebaseAndAuthorize(req);
  if (!z.ok) return json({ error: z.error }, z.status);
  // ※ master/admin限定を外したい場合は次行をコメントアウト
  if (!z.allowed) return json({ error: 'forbidden' }, 403);
  const userCode = z.userCode!;

  const sb = sbService();

  // 会話一覧
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

  // 会話メッセージ
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

/* ====== POST ======
 * body: {
 *   conversation_code?, mode, promptKey, vars, messages: Msg[], model?, temperature? ...
 * }
 */
export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) return bad('Env OPENAI_API_KEY is missing', 500);

    const z = await verifyFirebaseAndAuthorize(req);
    if (!z.ok) return json({ error: z.error }, z.status);
    // ※ master/admin限定を外したい場合は次行をコメントアウト
    if (!z.allowed) return json({ error: 'forbidden' }, 403);
    const userCode = z.userCode!;

    // 入力の軽バリデーション＆制限
    const safe = sanitizeBody((await req.json().catch(() => ({}))) || {});
    const {
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

    // System プロンプト
    const system = buildSofiaSystemPrompt({ promptKey, mode, vars, includeGuard: true });

    // ナレッジ取得（確率的）
    const lastUser = getLastUserText(messages);
    const seed = Math.abs(
      [...`${userCode}:${conversation_code}`].reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)
    );
    const analysis = (vars as any).analysis || { qcodes: [], layers: [], keywords: [] };
    const epsilon = 0.3;
    const noiseAmp = 0.15;
    const kb = await retrieveKnowledge(analysis, 4, lastUser, { epsilon, noiseAmp, seed });

    // OpenAI呼び出し
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

    const result = await callOpenAI(payload);
    if (!result.ok) {
      return json({ error: 'Upstream error', status: result.status, detail: result.detail }, result.status);
    }

    const data = result.data;
    const reply: string = data?.choices?.[0]?.message?.content ?? '';

    const merged: Msg[] = Array.isArray(messages) ? [...messages] : [];
    if (reply) merged.push({ role: 'assistant', content: reply });

    const sb = sbService();
    const title = makeTitleFromMessages(merged);
    const { error: upErr } = await sb.from('sofia_conversations').upsert(
      {
        user_code: userCode,
        conversation_code,
        title: title ?? null,
        messages: merged,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_code,conversation_code' }
    );
    if (upErr) console.error('[sofia_conversations upsert]', upErr);

    return json({
      conversation_code,
      reply,
      meta: {
        qcodes: analysis.qcodes,
        layers: analysis.layers,
        used_knowledge: kb.map((k: any, i: number) => ({ id: k.id, key: `K${i + 1}`, title: k.title })),
        stochastic: { epsilon, noiseAmp, seed },
      },
    });
  } catch (e: any) {
    console.error('[Sofia API] Error:', e);
    return json({ error: 'Unhandled error', detail: String(e?.message ?? e) }, 500);
  }
}
