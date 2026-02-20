// src/app/api/sofia/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { buildSofiaSystemPrompt } from '@/lib/sofia/buildSystemPrompt';
import { retrieveKnowledge } from '@/lib/sofia/retrieve';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';
import { SOFIA_CONFIG } from '@/lib/sofia/config';
import { recordQFromSofia } from '@/lib/recordQ';
import { inferPhase, estimateSelfAcceptance, relationQualityFrom, nextQFrom } from '@/lib/sofia/analyze';
import { mapQToColor } from '@/lib/sofia/qcolor';

/* ===== OpenAI ===== */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/* ===== 課金フラグ（Iros と共通の挙動） ===== */
const CREDITS_BYPASS = (process.env.CREDITS_BYPASS || '0') === '1';       // 1: 課金バイパス
const CAPTURE_SOFT_FAIL = (process.env.CAPTURE_SOFT_FAIL || '1') === '1'; // 1: 失敗でも落とさない

/* ===== 設定 ===== */
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
  Number(process.env.SOFIA_EPSILON ?? CFG_RETR.epsilon ?? 0.3);
const RETRIEVE_NOISE: number =
  Number(process.env.SOFIA_NOISEAMP ?? CFG_RETR.noiseAmp ?? 0.15);
const RETRIEVE_DEEPEN: number =
  Number(process.env.SOFIA_DEEPEN_MULT ?? CFG_RETR.deepenMultiplier ?? CFG_RETR.deepenMult ?? 1.4);

/* ===== 型/ユーティリティ ===== */
type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
type SofiaMode = 'normal' | 'diagnosis' | 'meaning' | 'intent' | 'dark' | 'remake';

type AICatalogItem = {
  id: string; label: string; model: string; costPerTurn: number; maxTokens?: number; notes?: string;
};
const AI_CATALOG: ReadonlyArray<AICatalogItem> = [
  { id: 'gpt-5',      label: 'GPT-5',      model: 'gpt-5',      costPerTurn: 1,   maxTokens: 8192, notes: '標準' },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', model: 'gpt-5-mini', costPerTurn: 0.5, maxTokens: 8192, notes: '軽量' },
];

// ★ 追加: retrieveKnowledge のゆるい返却型
type KBItem = {
  id?: string;
  title?: string;
  content?: string;
  url?: string;
  tags?: string[];
};

function resolveAIByModel(modelIn?: string) {
  const m = (modelIn || '').trim();
  const hit = AI_CATALOG.find(x => x.model === m || x.id === m);
  return hit ?? { id: m || 'gpt-5', label: m || 'GPT-4o', model: m || 'gpt-5', costPerTurn: 1 };
}
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
    if (m?.role === 'user' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return '';
}
function makeTitleFromMessages(msgs: Msg[]): string | null {
  const firstUser = msgs.find((m) => m.role === 'user')?.content?.trim();
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
  const allowModels = new Set(AI_CATALOG.map(x => x.model).concat(AI_CATALOG.map(x => x.id)));
  const modelRaw = typeof raw?.model === 'string' ? raw.model : 'gpt-5';

  return {
    conversation_code: typeof raw?.conversation_code === 'string' ? raw.conversation_code : '',
    master_id:         typeof raw?.master_id === 'string' ? raw.master_id : '',
    sub_id:            typeof raw?.sub_id === 'string' ? raw.sub_id : '',
    thread_id:         typeof raw?.thread_id === 'string' ? raw.thread_id : null,
    board_id:          typeof raw?.board_id === 'string' ? raw.board_id : null,
    source_type:       typeof raw?.source_type === 'string' ? raw.source_type : 'chat',

    // ★ ref を追加（任意受け取り）
    ref:               typeof raw?.ref === 'string' ? raw.ref : '',

    mode: (['normal','diagnosis','meaning','intent','dark','remake'] as SofiaMode[]).includes(raw?.mode) ? raw.mode : 'normal',
    promptKey: raw?.promptKey ?? 'base',
    vars: typeof raw?.vars === 'object' && raw?.vars ? raw.vars : {},
    messages: ensureArray<Msg>(raw?.messages).slice(-50),

    model: allowModels.has(modelRaw) ? modelRaw : 'gpt-5',
    temperature: typeof raw?.temperature === 'number' ? Math.min(Math.max(raw.temperature, 0), 1) : DEFAULT_TEMP,
    max_tokens: typeof raw?.max_tokens === 'number' ? raw.max_tokens : DEFAULT_MAXTOKENS,
    top_p: typeof raw?.top_p === 'number' ? raw.top_p : undefined,
    frequency_penalty: typeof raw?.frequency_penalty === 'number' ? raw.frequency_penalty : undefined,
    presence_penalty: typeof raw?.presence_penalty === 'number' ? raw.presence_penalty : undefined,
    response_format: raw?.response_format ?? undefined,
    cfg: typeof raw?.cfg === 'object' && raw?.cfg ? raw.cfg : undefined,

    // KB
    use_kb: raw?.use_kb !== false,
    kb_limit: Number.isFinite(raw?.kb_limit) ? Math.max(1, Math.min(8, Number(raw.kb_limit))) : undefined,
  };
}


/* ===== ir診断トリガー検出 ===== */
function detectDiagnosisTarget(text: string) {
  const t = (text || '').trim();
  const m1 = t.match(/^(?:ir\s*診断|ir|IR|ｉｒ)(?:[:：\s]+)?(.+)?$/);
  if (m1?.[1]?.trim()) return m1[1].trim();
  const m2 = t.match(/(.+?)(?:を?見て|を?観て|の状態|の様子|を診断)/);
  if (m2?.[1]?.trim()) return m2[1].trim();
  return null;
}

/* ===== インジケータ/ペルソナ ===== */
function deriveIndicators(userText: string, phase: 'Inner' | 'Outer',
  selfBand: 'lt20'|'20_40'|'40_70'|'70_90'|'gt90', relationLabel: 'harmony'|'discord') {
  const g = Number(((estimateSelfAcceptance(userText).score ?? 50) / 100).toFixed(2));
  const stochastic = relationLabel === 'discord' || selfBand === 'lt20' || selfBand === '20_40';
  const baseNoise = relationLabel === 'discord' ? 0.35 : 0.15;
  const noiseAmp = Number((baseNoise + (phase === 'Outer' ? 0.05 : 0)).toFixed(2));
  const seed = Math.abs(((userText?.length ?? 0) * 2654435761 + (Date.now() & 0xffff)));
  return { g, stochastic, noiseAmp, seed };
}
function derivePersonaTone(phase: 'Inner'|'Outer', selfBand: string, relationLabel: 'harmony'|'discord') {
  if (phase === 'Inner' && (selfBand === 'lt20' || selfBand === '20_40')) return 'compassion_calm';
  if (phase === 'Outer' && relationLabel === 'discord') return 'mediator_grounded';
  if (selfBand === '70_90' || selfBand === 'gt90') return 'co_creator_clear';
  return 'gentle_guide';
}

/* ===== フェッチ制御 & OpenAI ===== */
const FETCH_TIMEOUT_MS = 25_000;
async function fetchWithTimeout(url: string, init: RequestInit, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort('timeout'), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
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

/* ===== 事前の軽い残高チェック（読むだけ） ===== */
async function getBalanceWarning(userCode: string, expected: number) {
  const sb = sbService();
  const { data, error } = await sb.from('users').select('sofia_credit').eq('user_code', userCode).single();
  if (error) return null;
  const bal = Number(data?.sofia_credit ?? 0);
  const after = bal - expected;
  if (after < 0) return 'NO_BALANCE' as const;
  if (after < 1) return 'LOW_BALANCE' as const;
  return null;
}

/* ====== HTTP 経由の課金API（/api/credits/* を叩く） ====== */
async function creditsAuthorize(baseUrl: string, user_code: string, amount: number, ref: string) {
  if (CREDITS_BYPASS) return true;
  try {
    const r = await fetch(`${baseUrl}/api/credits/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ user_code, amount, ref }),
    });
    return r.ok;
  } catch (e) {
    console.warn('[sofia] authorize error', e);
    return false;
  }
}
async function creditsCapture(baseUrl: string, user_code: string, amount: number, ref: string) {
  if (CREDITS_BYPASS) return true;
  try {
    const r = await fetch(`${baseUrl}/api/credits/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ user_code, amount, ref }),
    });
    return r.ok;
  } catch (e) {
    console.warn('[sofia] capture error', e);
    return false;
  }
}

/* ===== CORS ===== */
export async function OPTIONS() { return json({ ok: true }); }

/* ===== GET（一覧/会話取得/カタログ） ===== */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const qUser = searchParams.get('user_code') || '';
  const conversation_code = searchParams.get('conversation_code') || '';

  // カタログ
  if (searchParams.get('catalog') === '1') {
    return json({ catalog: AI_CATALOG.map(({ id, label, model, costPerTurn, maxTokens, notes }) =>
      ({ id, label, model, costPerTurn, maxTokens, notes })) });
  }

  if (!qUser) {
    return json({ ok: true, service: 'Sofia API (iros)', time: new Date().toISOString(), model_hint: 'gpt-5' });
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

/* ===== POST（生成＋確定課金） ===== */
export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) return bad('Env OPENAI_API_KEY is missing', 500);

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;
    const z = await verifyFirebaseAndAuthorize(req);
    if (!z.ok) return json({ error: z.error }, z.status);
    if (!z.allowed) return json({ error: 'forbidden' }, 403);
    const userCode = z.userCode!;

    // 受信 & 正規化
    const safe = sanitizeBody((await req.json().catch(() => ({}))) || {});
    let {
      conversation_code: inCode,
      sub_id: inSub,
      thread_id, board_id, source_type,
      mode, promptKey, vars, messages,
      model, temperature, max_tokens, top_p, frequency_penalty, presence_penalty, response_format,
    } = safe as any;

    // モデル/料金
    const ai = resolveAIByModel(model);
    const AMOUNT = ai.costPerTurn;

    // 生成パラメータのマッピング（env優先）
    const EPS = Number(process.env.SOFIA_EPSILON ?? CFG_RETR.epsilon ?? 0.25);
    const NOISE = Number(process.env.SOFIA_NOISEAMP ?? CFG_RETR.noiseAmp ?? 0.10);
    const DEEPEN = Number(process.env.SOFIA_DEEPEN_MULT ?? CFG_RETR.deepenMultiplier ?? CFG_RETR.deepenMult ?? 1.4);

    const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
    const mappedTemperature = Math.min(1.3, Math.max(0.0, 0.7 + 0.6 * clamp01(EPS)));
    const mappedTopP        = Math.min(1.0, Math.max(0.0, 0.9 + 0.1 * clamp01(NOISE)));
    const mappedPresence    = Math.min(1.0, Math.max(0.0, 0.6 * clamp01(EPS) + 0.4 * clamp01(NOISE)));
    const mappedFrequency   = Math.min(1.0, Math.max(0.0, 0.3 * clamp01(EPS)));

    // 親子ID（Sofiaは master_id = conversation_code に固定）
    const conversation_code = inCode || newConvCode();
    const master_id = conversation_code;
    const sub_id = inSub || `S${Date.now().toString(36)}`;

    // ir診断検出
    const lastUserMsg = getLastUserText(messages);
    const detectedTarget = lastUserMsg ? detectDiagnosisTarget(lastUserMsg) : null;
    if (detectedTarget) {
      mode = 'diagnosis';
      vars = { ...(vars || {}), diagnosisTarget: detectedTarget };
    }

    // 解析
    const phase = inferPhase(lastUserMsg || '');
    const self = estimateSelfAcceptance(lastUserMsg || '');
    const relation = relationQualityFrom(phase, self.band);
    const currentQ = (vars as any)?.analysis?.qcodes?.[0]?.code ?? null;
    const nextQ = currentQ ? nextQFrom(currentQ, phase) : null;
    const indicators = deriveIndicators(lastUserMsg || '', phase, self.band, relation.label);
    const personaTone = derivePersonaTone(phase, self.band, relation.label);

    // System Prompt
    console.time('[iros] buildSystemPrompt');
    let system = buildSofiaSystemPrompt({
      promptKey,
      mode,
      vars: {
        ...(vars || {}),
        resonanceState: { phase, selfAcceptance: self, relation, nextQ, currentQ },
        personaTone,
      },
      includeGuard: true,
      enforceResonance: true,
    });
    const STYLE_RULES = `
## Color Energy Rules
- 感情・心理の傾向は色で表現する：Blue / Red / Black / Green / Yellow を基本に、必要に応じて Purple / Brown / Silver / White / Teal / Magenta 等の混色も可。
- 次の語は出力に含めない：木 / 火 / 土 / 金 / 水 / 五行（および moku/hi/tsuchi/kin/mizu）。
- 確定ラベリングは避け、「いまは◯◯寄り」「◯◯の色味が少し強い」のように柔らかく示す。
`;
    system += '\n' + STYLE_RULES;
    if (DEEPEN >= 1.8)      system += '\n[深度指示] T層の含意を強めてください。比喩・象徴・静けさを織り込み、2〜3行で改行する詩的リズムを優先。';
    else if (DEEPEN >= 1.5) system += '\n[深度指示] 必要に応じて T層の含意を薄く添えてください。余白と象徴を控えめに。';
    console.timeEnd('[iros] buildSystemPrompt');

    // リトリーブ
    const seedForRetr = Math.abs(
      [...`${userCode}:${conversation_code}`].reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)
    );
    const analysis = (vars as any)?.analysis || { qcodes: [], layers: [], keywords: [] };
    console.time('[iros] retrieveKnowledge');
    const kb = await retrieveKnowledge(analysis, RETRIEVE_LIMIT, lastUserMsg, {
      epsilon: RETRIEVE_EPS, noiseAmp: RETRIEVE_NOISE, seed: seedForRetr,
    });
    console.timeEnd('[iros] retrieveKnowledge');

    // === KB（ナレッジ）を System に注入する準備 ===
    const useKB = safe.use_kb !== false; // デフォルトON
    const kbArr: KBItem[] = Array.isArray(kb)
      ? (kb as KBItem[]).slice(0, safe.kb_limit ?? RETRIEVE_LIMIT)
      : [];
    let kbBlock = '';

    if (useKB && kbArr.length > 0) {
      const lines: string[] = [];
      lines.push('### Knowledge Base (retrieved)');
      for (let i = 0; i < kbArr.length; i++) {
        const k: KBItem = kbArr[i] ?? {};
        const t = String(k.title ?? `K${i + 1}`);
        const c = String(k.content ?? '').replace(/\s+/g, ' ').slice(0, 1200);
        const u = k.url ? `\n- source: ${k.url}` : '';
        const tg = Array.isArray(k.tags) && k.tags.length ? `\n- tags: ${k.tags.join(', ')}` : '';
        lines.push(`- (${i + 1}) ${t}\n  ${c}${u}${tg}`);
      }
      kbBlock = lines.join('\n');
    }

    const KB_GUIDE = `
### Knowledge Use Rules
- まず下の Knowledge Base を読み、回答はその根拠を要約して使うこと。
- 関連が弱い場合は無理に使わず、「一致が弱い」と明記して一般知識で補う。
- 参照した節は (K1)…(K4) のように番号で示すと、後続のロギングが容易になる。
`.trim();

    // OpenAI payload（SystemにKBを差し込む）
    const sysMessages: Msg[] = [{ role: 'system', content: system }];
    if (useKB && kbBlock) {
      sysMessages.push({ role: 'system', content: KB_GUIDE });
      sysMessages.push({ role: 'system', content: kbBlock });
    }

    const payload: any = {
      model: ai.model,
      messages: [...sysMessages, ...(messages as Msg[])],
      temperature: (typeof temperature === 'number') ? temperature : mappedTemperature,
    };
    if (typeof max_tokens === 'number') payload.max_tokens = max_tokens;
    payload.top_p = (typeof top_p === 'number') ? top_p : mappedTopP;
    payload.frequency_penalty = (typeof frequency_penalty === 'number') ? frequency_penalty : mappedFrequency;
    payload.presence_penalty  = (typeof presence_penalty  === 'number') ? presence_penalty  : mappedPresence;
    if (response_format) payload.response_format = response_format;

    // 事前の軽い警告（読むだけ）
    const warning = await getBalanceWarning(userCode, AMOUNT);
    if (warning === 'NO_BALANCE') {
      return json({ error: 'insufficient_credit', warning, master_id, sub_id, conversation_id: master_id, conversation_code }, 402);
    }

    // ====== 【ここから】Authorize → OpenAI → Capture の順で確定課金 ======
    const ref = safe?.ref ? String(safe.ref) : `sofia:${conversation_code}:${Date.now()}`;

    // 1) Authorize（不足やduplicateはAPI側で制御）
    if (!(await creditsAuthorize(baseUrl, userCode, AMOUNT, ref))) {
      return json({ error: 'authorize_failed' }, 402);
    }

    // 2) OpenAI 実行
    console.time('[iros] openai.chat');
    const result = await callOpenAI(payload);
    console.timeEnd('[iros] openai.chat');
    if (!result.ok) {
      return json({ error: 'Upstream error', status: result.status, detail: result.detail }, result.status);
    }
    const data = result.data;
    const reply: string = data?.choices?.[0]?.message?.content ?? '';

    // ====== 会話保存・ログ ======
    const sb = sbService();

    const merged: Msg[] = Array.isArray(messages) ? [...messages] : [];
    if (reply) merged.push({ role: 'assistant', content: reply });

    const title = makeTitleFromMessages(merged);
    const dialogue_trace = [
      { step: 'detect_mode',  data: { detectedTarget, mode } },
      { step: 'state_infer',  data: { phase, self, relation, currentQ, nextQ } },
      { step: 'indicators',   data: indicators },
      { step: 'retrieve',     data: { hits: (Array.isArray(kb) ? kb.length : 0), epsilon: RETRIEVE_EPS, noiseAmp: RETRIEVE_NOISE, seed: seedForRetr } },
      { step: 'openai_reply', data: { model: ai.model, temperature: payload.temperature, top_p: payload.top_p,
        presence_penalty: payload.presence_penalty, frequency_penalty: payload.frequency_penalty, hasReply: !!reply } },
    ];

    const metaPacked: any = {
      stochastic: indicators.stochastic,
      g: indicators.g,
      seed: indicators.seed,
      noiseAmp: indicators.noiseAmp,

      phase, selfAcceptance: self, relation, nextQ, currentQ,
      used_knowledge: (Array.isArray(kb) ? kb : []).map((k: any, i: number) => ({ id: k.id, key: `K${i + 1}`, title: k.title })),
      personaTone,
      dialogue_trace,
      stochastic_params: { epsilon: RETRIEVE_EPS, retrNoise: RETRIEVE_NOISE, retrSeed: seedForRetr },

      // 課金メタ（参考）
      charge: { model: ai.model, aiId: ai.id, amount: AMOUNT },

      // 紐づけ
      master_id, sub_id,
      thread_id: thread_id ?? null,
      board_id: board_id ?? null,
      source_type: source_type ?? 'chat',
      ref, // ★ 使った参照キーを保存
    };

    // 会話スレッド upsert
    try {
      const { error: upErr } = await sb.from('sofia_conversations').upsert(
        {
          user_code: userCode,
          conversation_code,
          title: title ?? null,
          messages: merged,
          updated_at: new Date().toISOString(),
          last_meta: metaPacked as any,
        } as any,
        { onConflict: 'user_code,conversation_code' }
      );
      if (upErr) console.warn('[sofia_conversations upsert]', upErr?.message || upErr);
    } catch (e) {
      console.warn('[sofia_conversations upsert] skipped:', String((e as any)?.message ?? e));
    }

    // ターンログ
    try {
      const turn_index = merged.filter(m => m.role === 'assistant').length;
      await sb.from('sofia_turns').insert({
        user_code: userCode,
        conversation_code,
        turn_index,
        user_text: getLastUserText(messages) ?? '',
        assistant_text: reply ?? '',
        meta: metaPacked,
        created_at: new Date().toISOString(),
      } as any);
    } catch (e) {
      console.warn('[sofia_turns insert] skipped:', String((e as any)?.message ?? e));
    }

    // Qコードログ（AI由来）
    try {
      const qFinal = (metaPacked.currentQ ?? metaPacked.nextQ ?? 'Q2') as 'Q1'|'Q2'|'Q3'|'Q4'|'Q5';
      const stageHint = (vars as any)?.analysis?.qcodes?.[0]?.stage;
      const stageFinal = (
        stageHint === 'S1' || stageHint === 'S2' || stageHint === 'S3'
          ? stageHint
          : (RETRIEVE_DEEPEN >= 1.8 ? 'S3' : (mode === 'diagnosis' ? 'S2' : 'S1'))
      ) as 'S1'|'S2'|'S3';
      const qc = mapQToColor(qFinal);

      await recordQFromSofia({
        user_code: userCode,
        conversation_code,
        intent: mode === 'diagnosis' ? 'diagnosis' : 'normal',
        q: qFinal,
        stage: stageFinal,
        extra: {
          model: ai.model,
          personaTone,
          phase,
          selfBand: self.band,
          relation: relation.label,
          detectedTarget,
          q_color: qc || null,
        },
        post_id: null,
        owner_user_code: userCode,
        actor_user_code: userCode,
        emotion: null,
        level: null,
      });
      metaPacked.currentQ = qFinal;
    } catch (e) {
      console.warn('[q_code_logs insert] skipped:', String((e as any)?.message ?? e));
    }

    // 3) Capture（失敗しても落とさない設定あり）
    const okCap = await creditsCapture(baseUrl, userCode, AMOUNT, ref);
    if (!okCap) {
      console.warn('[sofia] capture_failed', { user: userCode, ref });
      if (!CAPTURE_SOFT_FAIL) {
        return json({ error: 'capture_failed' }, 500);
      }
    }

    // 応答
    const qOut = (metaPacked.currentQ ?? metaPacked.nextQ ?? 'Q2') as 'Q1'|'Q2'|'Q3'|'Q4'|'Q5';
    const stageOut = ((vars as any)?.analysis?.qcodes?.[0]?.stage
      ?? (RETRIEVE_DEEPEN >= 1.8 ? 'S3' : (mode === 'diagnosis' ? 'S2' : 'S1'))) as 'S1'|'S2'|'S3';
    const qColor = mapQToColor(qOut);

    return json({
      conversation_code,
      reply,
      meta: metaPacked,
      charge: { model: ai.model, aiId: ai.id, amount: AMOUNT, ref },
      q: { code: qOut, stage: stageOut, color: qColor },

      master_id,
      sub_id,
      conversation_id: master_id,
      agent: 'sofia',
      warning,
    });
  } catch (e: any) {
    console.error('[Sofia(Iros) API] Error:', e);
    return json({ error: 'Unhandled error', detail: String(e?.message ?? e) }, 500);
  }
}
