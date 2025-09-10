export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  verifyFirebaseAndAuthorize,
  SUPABASE_URL,
  SERVICE_ROLE,
} from '@/lib/authz';

/* ====== OpenAI ====== */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/* ====== helpers ====== */
function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : (init as ResponseInit | undefined)?.['status'] ?? 200;
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

type Agent = 'mirra' | 'iros';
type Body = {
  agent: Agent;
  texts: string[];
  session_id?: string | null;
};

/* ====== credits ====== */
async function getBalance(supabase: any, user_code: string): Promise<number> {
  const { data: u, error: uErr } = await supabase
    .from('users')
    .select('sofia_credit')
    .eq('user_code', user_code)
    .maybeSingle();
  if (!uErr && u && typeof u.sofia_credit === 'number') return Number(u.sofia_credit);

  const { data, error } = await supabase
    .from('credits_ledger')
    .select('amount')
    .eq('user_code', user_code);
  if (error) throw error;
  return (data ?? []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
}

async function chargeCredits(
  supabase: any,
  user_code: string,
  cost: number,
  reason: string,
  meta?: Record<string, any>,
): Promise<number> {
  try {
    const { data: rpc, error: rpcErr } = await supabase.rpc('fn_charge_credits', {
      p_user_code: user_code,
      p_cost: cost,
      p_reason: reason,
      p_meta: meta ?? null,
    });
    if (!rpcErr && typeof rpc === 'number') return Number(rpc);
  } catch {}

  const { data: u, error: uErr } = await supabase
    .from('users')
    .select('sofia_credit')
    .eq('user_code', user_code)
    .maybeSingle();
  if (uErr) throw uErr;

  const current = Number(u?.sofia_credit ?? 0);
  if (current < cost) {
    const err: any = new Error('insufficient_balance');
    err.code = 'insufficient_balance';
    throw err;
  }

  const { data: upd, error: updErr } = await supabase
    .from('users')
    .update({ sofia_credit: current - cost })
    .eq('user_code', user_code)
    .select('sofia_credit')
    .single();
  if (updErr) throw updErr;

  const { error: ledErr } = await supabase.from('credits_ledger').insert({
    user_code,
    amount: -cost,
    reason,
    meta: meta ?? null,
  });
  if (ledErr) throw ledErr;

  return Number(upd.sofia_credit);
}

/* ====== heuristics ====== */
function fallbackPhaseAndDepth(text: string) {
  const lower = text.toLowerCase();
  const inner = /(私|自分|怖|不安|できない|失敗|恥|無理)/.test(text);
  const phase: 'Inner' | 'Outer' = inner ? 'Inner' : 'Outer';
  const depth = lower.length < 80 ? 'S1' : /(したい|目標|計画|期限|要件|進捗)/.test(text) ? 'S2' : 'S1';
  return { phase, depth_stage: depth };
}

/* ====== LLM ====== */
async function llmClassifyQPhaseDepth(text: string): Promise<{
  q_emotion: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  phase: 'Inner' | 'Outer';
  depth_stage: string;
}> {
  const sys =
    'あなたはテキストから情動コード(Q1=秩序/我慢, Q2=怒り/成長, Q3=不安/安定, Q4=恐怖/浄化, Q5=空虚/情熱)と位相(Inner/Outer)、深度(S1..I3)を一つずつ推定する分類器です。日本語で、必ずJSONのみを出力してください。';
  const user =
    `入力:\n${text}\n\n` +
    `出力フォーマット:\n{"q_emotion":"Q1|Q2|Q3|Q4|Q5","phase":"Inner|Outer","depth_stage":"S1..I3"}`;

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`LLM classify failed: ${res.status}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim() || '{}';
  try {
    const parsed = JSON.parse(content);
    return {
      q_emotion: parsed.q_emotion || 'Q3',
      phase: parsed.phase || 'Inner',
      depth_stage: parsed.depth_stage || 'S1',
    };
  } catch {
    return { q_emotion: 'Q3', phase: 'Inner', depth_stage: 'S1' };
  }
}

async function llmMakeReport(
  agent: Agent,
  text: string,
  q: string,
  phase: string,
  depth: string,
) {
  const sys_mirra =
    'あなたは実務寄りの診断レポートライター。600字前後で日本語。構成は【要約】【観測】【背景仮説】【繰り返しがちな出来事】【小さな解決策】【再配置の合言葉】。読みやすく、実行可能な提案を入れてください。';
  const sys_iros =
    'あなたは象徴と余白を扱う深度レポーター。800字以上で日本語。序-観-罠-解-余白の流れ。未消化の核を静かに指し示し、「ここを解けばマインドトークは止む」と明言。詩的すぎず可読性を保つ。';

  const sys = agent === 'mirra' ? sys_mirra : sys_iros;
  const user =
    `セルフトーク候補:\n${text}\n\n` +
    `推定: Q=${q}, 位相=${phase}, 深度=${depth}\n` +
    (agent === 'mirra'
      ? '診断書テンプレに沿って、見出しを【】で明記して出力。'
      : '序-観-罠-解-余白の順で、見出しをつけて出力。');

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: agent === 'mirra' ? 'gpt-4.1-mini' : 'gpt-4o-mini',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      temperature: agent === 'mirra' ? 0.5 : 0.7,
    }),
  });
  if (!res.ok) throw new Error(`LLM report failed: ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

/* ====== DB: users.supabase_uid を取得（owner_uid 用） ====== */
async function getOwnerUidByUserCode(supabase: any, user_code: string): Promise<string> {
  const { data, error } = await supabase
    .from('users')
    .select('supabase_uid')
    .eq('user_code', user_code)
    .maybeSingle();

  if (error) throw error;
  const uid = data?.supabase_uid as string | null;

  const isUuid =
    !!uid &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uid);

  if (!isUuid) {
    throw new Error('owner_uid_not_found_or_not_uuid');
  }
  return uid!;
}

/* ====== conversations を作成（messages: jsonb に seed） ====== */
async function ensureConversationAndSeed(
  supabase: any,
  owner_uid: string,            // 必須: conversations.owner_uid（uuid）
  user_code: string,
  title: string,
  userSeedText: string,
  assistantSeedText: string,
  existingConversationId?: string | null,
): Promise<string> {
  if (existingConversationId) return existingConversationId;

  const now = new Date().toISOString();
  const seedMessages = [
    { role: 'user', content: userSeedText, created_at: now, meta: { source: 'mtalk', seed: true } },
    { role: 'assistant', content: assistantSeedText, created_at: now, meta: { source: 'mtalk', seed_reply: true } },
  ];

  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .insert({
      owner_uid,            // ← NOT NULL & FK(users.supabase_uid)
      user_code,
      title,
      messages: seedMessages,
    })
    .select('id')
    .single();

  if (convErr) throw convErr;
  return conv.id as string;
}

/* ====== main ====== */
export async function POST(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);

    const user_code = (auth as any).userCode ?? (auth as any).user_code ?? null;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const body = (await req.json()) as Body;
    const agent = body.agent;
    const texts = (body.texts || []).map(String).map((s) => s.trim()).filter(Boolean);

    if (!['mirra', 'iros'].includes(agent)) {
      return json({ ok: false, error: 'agent must be mirra|iros' }, 400);
    }
    if (!texts.length) return json({ ok: false, error: 'texts is empty' }, 400);

    const cost = agent === 'iros' ? 5 : 2;

    const balance = await getBalance(supabase, user_code);
    if (balance < cost) return json({ ok: false, error: 'insufficient_balance', balance }, 402);

    // セッション作成（mtalk_sessions.agent は mirra|iros）
    let session_id = body.session_id || null;
    if (!session_id) {
      const { data: sessIns, error: sessErr } = await supabase
        .from('mtalk_sessions')
        .insert({ user_code, agent })
        .select('id')
        .single();
      if (sessErr) throw sessErr;
      session_id = sessIns.id as string;
    }

    const joined = texts.join('\n').slice(0, 2000);

    const fb = fallbackPhaseAndDepth(joined);
    let phase = fb.phase;
    let depth_stage = fb.depth_stage;

    const cls = await llmClassifyQPhaseDepth(joined);
    const q_emotion = (cls.q_emotion || 'Q3') as 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
    phase = (cls.phase || phase) as 'Inner' | 'Outer';
    depth_stage = cls.depth_stage || depth_stage;

    const reply_text = await llmMakeReport(agent, joined, q_emotion, phase, depth_stage);

    const balance_after = await chargeCredits(supabase, user_code, cost, 'mtalk_analyze', {
      agent,
      session_id,
    });

    const { data: repIns, error: repErr } = await supabase
      .from('mtalk_reports')
      .insert({
        session_id,
        user_code,
        agent,
        input_text: joined,
        reply_text,
        q_emotion,
        phase,
        depth_stage,
        credit_charged: cost,
      })
      .select('id, created_at, conversation_id')
      .single();
    if (repErr) throw repErr;

    // conversations.owner_uid を users.supabase_uid から取得
    const owner_uid = await getOwnerUidByUserCode(supabase, user_code);

    const title = `mTalk: ${texts[0]?.slice(0, 48) || '最初のマインドトーク'}`;
    const conversation_id = await ensureConversationAndSeed(
      supabase,
      owner_uid,
      user_code,
      title,
      joined,
      reply_text,
      repIns.conversation_id ?? null,
    );

    if (!repIns.conversation_id) {
      const { error: updErr } = await supabase
        .from('mtalk_reports')
        .update({ conversation_id })
        .eq('id', repIns.id);
      if (updErr) throw updErr;
    }

    return json({
      ok: true,
      session_id,
      conversation_id,
      report: {
        id: repIns.id,
        q_emotion,
        phase,
        depth_stage,
        reply_text,
        created_at: repIns.created_at,
      },
      balance_after,
    });
  } catch (err: any) {
    console.error('[mtalk/analyze] error', err);
    const msg = String(err?.message || err);
    if (msg.includes('insufficient_balance')) {
      return json({ ok: false, error: 'insufficient_balance' }, 402);
    }
    if (msg.includes('owner_uid_not_found_or_not_uuid')) {
      // users.supabase_uid が未設定 or 不正（uuid でない）
      return json({ ok: false, error: 'owner_uid_not_found' }, 500);
    }
    return json({ ok: false, error: 'internal_error', detail: msg }, 500);
  }
}
