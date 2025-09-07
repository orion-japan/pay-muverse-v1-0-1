// src/app/api/agent/mtalk/analyze/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  verifyFirebaseAndAuthorize,
  SUPABASE_URL,
  SERVICE_ROLE,
} from '@/lib/authz';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

// ---------- utils ----------
function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : (init as ResponseInit | undefined)?.['status'] ?? 200;
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

type Body = {
  agent: 'mu' | 'iros';
  texts: string[];
  session_id?: string | null;
};

// ---------- credits ----------
async function getBalance(supabase: any, user_code: string): Promise<number> {
  // 1) users.sofia_credit を優先
  const { data: u, error: uErr } = await supabase
    .from('users')
    .select('sofia_credit')
    .eq('user_code', user_code)
    .maybeSingle();
  if (!uErr && u && typeof u.sofia_credit === 'number') {
    return Number(u.sofia_credit);
  }

  // 2) フォールバック：台帳合計
  const { data, error } = await supabase
    .from('credits_ledger')
    .select('amount')
    .eq('user_code', user_code);
  if (error) throw error;
  return (data ?? []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
}

/**
 * sofia_credit をコスト分だけ減算し、credits_ledger にも -cost を記録。
 * 可能なら RPC (fn_charge_credits) を使い、無ければ手動で実行。
 * 戻り値: 減算後の残高
 */
async function chargeCredits(
  supabase: any,
  user_code: string,
  cost: number,
  reason: string,
  meta?: Record<string, any>,
): Promise<number> {
  // 1) まずは RPC を試す（用意していれば原子的）
  try {
    const { data: rpc, error: rpcErr } = await supabase.rpc('fn_charge_credits', {
      p_user_code: user_code,
      p_cost: cost,
      p_reason: reason,
      p_meta: meta ?? null,
    });
    if (!rpcErr && typeof rpc === 'number') {
      return Number(rpc);
    }
  } catch {
    // RPC 未定義などは無視して手動にフォールバック
  }

  // 2) 手動実行（簡易、一時的運用向け）
  // 現残高
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

  // 減算
  const { data: upd, error: updErr } = await supabase
    .from('users')
    .update({ sofia_credit: current - cost })
    .eq('user_code', user_code)
    .select('sofia_credit')
    .single();
  if (updErr) throw updErr;

  // 台帳へも記録
  const { error: ledErr } = await supabase.from('credits_ledger').insert({
    user_code,
    amount: -cost,
    reason,
    meta: meta ?? null,
  });
  if (ledErr) throw ledErr;

  return Number(upd.sofia_credit);
}

// ---------- light heuristics ----------
function fallbackPhaseAndDepth(text: string) {
  const lower = text.toLowerCase();
  const inner = /(私|自分|怖|不安|できない|失敗|恥|無理)/.test(text);
  const phase = inner ? 'Inner' : 'Outer';
  const depth =
    lower.length < 80 ? 'S1' : /(したい|目標|計画|期限|要件|進捗)/.test(text) ? 'S2' : 'S1';
  return { phase, depth_stage: depth };
}

// ---------- LLM helpers ----------
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
  agent: 'mu' | 'iros',
  text: string,
  q: string,
  phase: string,
  depth: string,
) {
  const sys_mu =
    'あなたは実務寄りの診断レポートライター。600字前後で日本語。構成は【要約】【観測】【背景仮説】【繰り返しがちな出来事】【小さな解決策】【再配置の合言葉】。読みやすく、実行可能な提案を入れてください。';
  const sys_iros =
    'あなたは象徴と余白を扱う深度レポーター。800字以上で日本語。序-観-罠-解-余白の流れ。未消化の核を静かに指し示し、「ここを解けばマインドトークは止む」と明言。詩的すぎず可読性を保つ。';

  const sys = agent === 'mu' ? sys_mu : sys_iros;
  const user =
    `セルフトーク候補:\n${text}\n\n` +
    `推定: Q=${q}, 位相=${phase}, 深度=${depth}\n` +
    (agent === 'mu'
      ? '診断書テンプレに沿って、見出しを【】で明記して出力。'
      : '序-観-罠-解-余白の順で、見出しをつけて出力。');

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: agent === 'mu' ? 'gpt-4.1-mini' : 'gpt-4o-mini',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      temperature: agent === 'mu' ? 0.5 : 0.7,
    }),
  });
  if (!res.ok) throw new Error(`LLM report failed: ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

// ---------- main ----------
export async function POST(req: NextRequest) {
  try {
    // 認証
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);
    const user_code = (auth as any).userCode ?? (auth as any).user_code ?? null;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 入力
    const body = (await req.json()) as Body;
    const agent = body.agent;
    const texts = (body.texts || []).map(String).map((s) => s.trim()).filter(Boolean);
    if (!['mu', 'iros'].includes(agent)) {
      return json({ ok: false, error: 'agent must be mu|iros' }, 400);
    }
    if (!texts.length) return json({ ok: false, error: 'texts is empty' }, 400);

    const cost = agent === 'iros' ? 5 : 2;

    // 残高チェック
    const balance = await getBalance(supabase, user_code);
    if (balance < cost) {
      return json({ ok: false, error: 'insufficient_balance', balance }, 402);
    }

    // セッション確保
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

    // テキスト結合（上限保護）
    const joined = texts.join('\n').slice(0, 2000);

    // ざっくり推定（フォールバック）
    const fb = fallbackPhaseAndDepth(joined);
    let phase = fb.phase;
    let depth_stage = fb.depth_stage;

    // Q/位相/深度（LLMで最終確定）
    const cls = await llmClassifyQPhaseDepth(joined);
    const q_emotion = (cls.q_emotion || 'Q3') as 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
    phase = cls.phase || phase;
    depth_stage = cls.depth_stage || depth_stage;

    // レポート生成（Mu=600字 / iros=800字+）
    const reply_text = await llmMakeReport(agent, joined, q_emotion, phase, depth_stage);

    // クレジット消費（users.sofia_credit 減算 + 台帳記録）
    const balance_after = await chargeCredits(supabase, user_code, cost, 'mtalk_analyze', {
      agent,
      session_id,
    });

    // 保存
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
      .select('id, created_at')
      .single();
    if (repErr) throw repErr;

    // 応答
    return json({
      ok: true,
      session_id,
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
    // 残高不足を throw した場合のハンドリング
    if (String(err?.code || err?.message).includes('insufficient_balance')) {
      return json({ ok: false, error: 'insufficient_balance' }, 402);
    }
    return json(
      { ok: false, error: 'internal_error', detail: String(err?.message || err) },
      500,
    );
  }
}
