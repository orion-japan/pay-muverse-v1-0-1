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
  // 既存が MU 以外（Q- や数字など）なら MU を新規発行して“会話を完全分離”
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

/* ========= クレジット RPC ========= */
type AuthResult =
  | string
  | { error: 'insufficient_credit' }
  | { error: 'authorize_failed'; detail?: string; tried?: string[] };

async function authorizeCredit(userCode: string, amount: number, reason: string): Promise<AuthResult> {
  const supa = sbService();
  const amt = Number(Number(amount).toFixed(2));

  const reasons = Array.from(
    new Set([
      reason,
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

  try {
    const { data: row } = await supa
      .from('users')
      .select('sofia_credit')
      .eq('user_code', userCode)
      .single();
    const bal = Number(row?.sofia_credit ?? 0);
    if (bal < amt) return { error: 'insufficient_credit' } as const;
  } catch {}

  return { error: 'authorize_failed', detail: lastDetail, tried: reasons } as const;
}

/* 返金（void） */
async function voidCreditByKey(key: string) {
  const supa = sbService();
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
    const {
      message,
      master_id: inMaster,
      conversation_id: inConv, // 古いクライアント互換
      sub_id: inSub,
      thread_id,
      board_id,
      source_type,
    } = body || {};
    
    // master_id 優先、なければ conversation_id、それでも無ければ新規
    const master_id = ensureMuMasterId(inMaster ?? inConv);
    const sub_id = (typeof inSub === 'string' && inSub.trim()) ? inSub.trim() : newMuSubId();

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

    const mu = await generateMuReply(message, {
      user_code: userCode,
      master_id,
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
        meta: { reason: 'generation_failed', authKey, thread_id: thread_id ?? null, board_id: board_id ?? null },
      });
      return json({ error: 'generation_failed' }, 502);
    }

    // 監査用（既存の lightweight ログ）
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

    /* ===== 会話ヘッダ & 一覧用ログ ===== */
    try {
      const sb = sbService();
      const nowIso = new Date().toISOString();

      // タイトル = 最初のユーザーメッセージ20文字以内
      const title =
        body.message && body.message.trim()
          ? body.message.trim().slice(0, 20)
          : 'Mu 会話';

      // mu_conversations に upsert（タイトル/時刻更新）
      const upConv = await sb
        .from('mu_conversations')
        .upsert(
          {
            id: master_id,            // text（MU-...）
            user_code: userCode,
            title,
            origin_app: 'mu',
            updated_at: nowIso,
            last_turn_at: nowIso,
          },
          { onConflict: 'id' }
        );
      if (upConv.error) console.error('[muai] upsert mu_conversations error:', upConv.error);

      // 旧一覧テーブルの互換ログ（存在する環境向け）
      const upLog = await sb
        .from('mu_conversation_logs')
        .upsert(
          {
            user_code: userCode,
            master_id,
            conversation_id: null,
            updated_at: nowIso,
          },
          { onConflict: 'user_code,master_id' }
        );
      if (upLog.error) console.error('[muai] upsert mu_conversation_logs error:', upLog.error);
    } catch (e) {
      console.error('[muai] upsert conversation thrown:', e);
    }

    /* ===== 永続メッセージ保存（mu_turns に user/assistant 2行） ===== */
    try {
      const sb = sbService();

      // 1) ユーザー発話
      const insUser = await sb.from('mu_turns').insert({
        conv_id: master_id,     // text（MU-...）
        role: 'user',           // chat_role enum
        content: String(message ?? ''),
        meta: { source: 'mu', kind: 'user' },
        used_credits: null,
        source_app: 'mu',
        sub_id: sub_id,         // 同一 sub_id を付ける
      });
      if (insUser.error) console.error('[muai] insert mu_turns (user) error:', insUser.error);

      // 2) アシスタント発話
      const insAssist = await sb.from('mu_turns').insert({
        conv_id: master_id,
        role: 'assistant',
        content: replyText,
        meta: { model: 'gpt-4.1-mini' },
        used_credits: COST_PER_TURN,
        source_app: 'mu',
        sub_id: sub_id,
      });
      if (insAssist.error) console.error('[muai] insert mu_turns (assistant) error:', insAssist.error);
    } catch (e) {
      console.error('[muai] insert mu_turns thrown:', e);
    }

    // 残高取得
    const sb = sbService();
    const { data: balanceRow } = await sb
      .from('users')
      .select('sofia_credit')
      .eq('user_code', userCode)
      .single();

    const credit_balance =
      balanceRow && balanceRow.sofia_credit != null ? Number(balanceRow.sofia_credit) : null;

    return json({
      agent: 'Mu',
      reply: replyText,
      meta: {
        agent: 'Mu',
        source_type: source_type ?? 'chat',
        confidence,
        charge: { amount: COST_PER_TURN, aiId: 'mu' },
        master_id,
        sub_id,
        thread_id: thread_id ?? null,
        board_id: board_id ?? null,
      },
      q: q_code || depth_stage ? { code: q_code ?? null, stage: depth_stage ?? null } : null,
      credit_balance,
      charge: { amount: COST_PER_TURN, aiId: 'mu' },
      master_id,
      sub_id,
      conversation_id: master_id,
      title: body.message?.trim()?.slice(0, 20) ?? 'Mu 会話', // 一覧用に返却
    });
  } catch (e: any) {
    console.error('[MuAI API] Error:', e);
    return json({ error: 'Unhandled error', detail: String(e?.message ?? e) }, 500);
  }
}
