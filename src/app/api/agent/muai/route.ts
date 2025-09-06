// src/app/api/agent/muai/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

// Mu 本体 / ログ
import { generateMuReply } from '@/lib/mu';
import { recordMuTextTurn } from '@/lib/mu';

const COST_PER_TURN = 0.5; // Mu は1往復 0.5 クレジット

/* ========= 共通ユーティリティ ========= */
function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : (init as ResponseInit | undefined)?.['status'] ?? 200;

  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');

  return new NextResponse(JSON.stringify(data), { status, headers });
}
const bad = (msg: string, code = 400) => json({ error: msg }, code);

/* ========= Supabase Service ========= */
function sbService() {
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('Supabase env missing');
  return createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
}

/* ========= Mu 専用IDユーティリティ ========= */
function newMuMasterId() {
  return `MU-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
function ensureMuMasterId(input?: string | null) {
  const s = (input ?? '').trim();
  return s && /^MU[-_]/i.test(s) ? s : newMuMasterId();
}
function newMuSubId() {
  return `mu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/* ========= 承認キー抽出ヘルパ ========= */
function pickAuthKey(data: any): string | null {
  if (!data) return null;
  if (typeof data === 'string' && data.trim()) return data.trim();

  if (Array.isArray(data)) {
    for (const item of data) {
      const k = pickAuthKey(item);
      if (k) return k;
    }
    return null;
  }

  if (typeof data === 'object') {
    const candidates = ['key', 'auth_key', 'authKey', 'authorize_credit_by_user_code'] as const;
    for (const c of candidates) {
      const v = (data as any)[c];
      if (typeof v === 'string' && v) return v;
    }
    for (const v of Object.values(data)) {
      if (typeof v === 'string' && v) return v;
    }
  }
  return null;
}

/* ========= クレジット RPC（理由フォールバック内蔵・堅牢版） ========= */
type AuthResult =
  | string
  | { error: 'insufficient_credit' }
  | { error: 'authorize_failed'; detail?: string; tried?: string[] };

async function authorizeCredit(userCode: string, amount: number, reason: string): Promise<AuthResult> {
  const supa = sbService();
  const amt = Number(Number(amount).toFixed(2));

  // できるだけ広くヒットさせる（先頭が最優先）
  const reasons = Array.from(
    new Set([
      reason, // 'mu_chat_turn'
      'mu_text_turn',
      'mu_turn',
      'mu',
      'sofia_chat_turn',
      'sofia_turn',
      'chat_turn',
      'ai_chat_turn',
      'gpt-4o_chat_turn',
      'gpt_chat_turn',
      'generic_chat_turn',
    ]),
  );

  let lastDetail = 'no_auth_key';
  for (const r of reasons) {
    const { data, error } = await supa.rpc('authorize_credit_by_user_code', {
      p_amount: amt,
      p_reason: r,
      p_user_code: userCode,
    });

    if (error) {
      const msg = String(error.message ?? error);
      if (msg.includes('insufficient_credit')) {
        return { error: 'insufficient_credit' } as const;
      }
      lastDetail = msg;
      continue;
    }

    const key = pickAuthKey(data);
    if (key) return key;
  }

  // どれも key が返らない → 残高を確認
  try {
    const { data: row } = await supa
      .from('users')
      .select('sofia_credit')
      .eq('user_code', userCode)
      .single();
    const bal = Number(row?.sofia_credit ?? 0);
    if (bal < amt) return { error: 'insufficient_credit' } as const;
  } catch {
    // 読み取り失敗は無視
  }

  return { error: 'authorize_failed', detail: lastDetail, tried: reasons } as const;
}

/* 返金（void）フォールバック付き */
async function voidCreditByKey(key: string) {
  const supa = sbService();
  // p_key 版 → key 版の順に試す（環境差吸収）
  try {
    const { error } = await supa.rpc('void_credit_by_key', { p_key: key });
    if (!error) return true;
  } catch {}
  try {
    const { error } = await supa.rpc('void_credit_by_key', { key });
    if (!error) return true;
  } catch {}
  return false;
}

/* ========= OPTIONS ========= */
export async function OPTIONS() {
  return json({ ok: true });
}

/* ========= POST ========= */
export async function POST(req: NextRequest) {
  try {
    const z = await verifyFirebaseAndAuthorize(req);
    if (!z.ok) return json({ error: z.error }, z.status);
    if (!z.allowed) return json({ error: 'forbidden' }, 403);
    const userCode = z.userCode!;

    const body = await req.json().catch(() => ({}));
    // 受け取りはするが、Mu 専用IDに正規化して混在を防止
    const {
      message,
      master_id: inMaster,
      sub_id: inSub,
      thread_id,
      board_id,
      source_type,
    } = body || {};

    // ★ Mu専用の master_id / sub_id を強制（Sofia 等のIDが来ても新規発行）
    const master_id = ensureMuMasterId(inMaster);
    const sub_id = (typeof inSub === 'string' && inSub.trim()) ? inSub.trim() : newMuSubId();

    // ▼ クレジット承認
    const auth = await authorizeCredit(userCode, COST_PER_TURN, 'mu_chat_turn');
    if (auth && typeof auth === 'object' && 'error' in auth) {
      if (auth.error === 'insufficient_credit') {
        return json({ error: 'insufficient_credit' }, 402);
      }
      return json(
        { error: 'authorize_failed', detail: (auth as any).detail ?? 'unknown', tried: (auth as any).tried ?? [] },
        500,
      );
    }
    const authKey = String(auth);

    // ▼ Mu 生成
    const mu = await generateMuReply(message, {
      user_code: userCode,
      master_id,                       // ← Mu専用IDで固定
      sub_id,
      thread_id: thread_id ?? null,
      board_id: board_id ?? null,
      source_type: source_type ?? 'chat',
    });

    const replyText: string = String(mu?.reply ?? '');
    const q_code: string | null = mu?.q_code ?? null;
    const depth_stage: string | null = mu?.depth_stage ?? null;
    const confidence: number | null =
      typeof mu?.confidence === 'number' ? mu.confidence : null;

    if (!replyText) {
      await voidCreditByKey(authKey);
      await recordMuTextTurn({
        user_code: userCode,
        status: 'fail',
        chargeOnFailure: false,
        conversation_id: master_id,
        message_id: sub_id,
        meta: {
          reason: 'generation_failed',
          authKey,
          thread_id: thread_id ?? null,
          board_id: board_id ?? null,
        },
      });
      return json({ error: 'generation_failed' }, 502);
    }

    // 成功ログ
    await recordMuTextTurn({
      user_code: userCode,
      status: 'success',
      conversation_id: master_id,
      message_id: sub_id,
      meta: {
        q_code,
        depth_stage,
        confidence,
        charge: { amount: COST_PER_TURN, authKey },
        source_type: source_type ?? 'chat',
        thread_id: thread_id ?? null,
        board_id: board_id ?? null,
      },
    });

    // 最新残高を返す
    const sb = sbService();
    const { data: balanceRow } = await sb
      .from('users')
      .select('sofia_credit')
      .eq('user_code', userCode)
      .single();

    const credit_balance =
      balanceRow && balanceRow.sofia_credit != null ? Number(balanceRow.sofia_credit) : null;

    // ★ Mu 専用の master_id / sub_id を必ず返す。UI 側で agent ラベルも明示。
    return json({
      agent: 'mu',
      reply: replyText,
      q_code,
      depth_stage,
      confidence,
      credit_balance,
      charge: { amount: COST_PER_TURN, aiId: 'mu' },
      master_id,                 // Mu専用 親ID
      sub_id,                    // 子ID
      conversation_id: master_id // 互換用
    });
  } catch (e: any) {
    console.error('[MuAI API] Error:', e);
    return json({ error: 'Unhandled error', detail: String(e?.message ?? e) }, 500);
  }
}
