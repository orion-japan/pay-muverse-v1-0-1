// src/app/api/agent/muai/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

// Mu 本体 / ログ
import { generateMuReply } from '@/lib/mu';
import { recordMuTextTurn } from '@/lib/mu';

// ★ プロンプト可視化用（既存）
import { buildMuSystemPrompt, MU_PROMPT_VERSION } from '@/lib/mu/buildSystemPrompt';
import { MU_CONFIG } from '@/lib/mu/config';

// ★ Sofia互換: Q→色
import { mapQToColor } from '@/lib/sofia/qcolor';

// ★ Sofia由来の軽量状態推定（返却メタ用だけに利用）
import {
  inferPhase,
  estimateSelfAcceptance,
  relationQualityFrom,
} from '@/lib/sofia/analyze';

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

    // 可視化用（generateMuReply の引数は維持）
    const sys = buildMuSystemPrompt({
      personaKey: 'base',
      mode: 'normal',
      tone: 'compassion_calm',
    });
    const promptMeta = {
      mu_prompt_version: MU_PROMPT_VERSION,
      mu_persona: 'base',
      mu_mode: 'normal',
      mu_tone: 'compassion_calm',
      mu_config_version: MU_CONFIG.version,
      mu_prompt_hash: String(sys).slice(0, 24),
    };

    // クレジット承認
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

    // 返信生成
    const mu = await generateMuReply(message, {
      user_code: userCode,
      master_id,
      sub_id,
      thread_id: thread_id ?? null,
      board_id: board_id ?? null,
      source_type: source_type ?? 'chat',
    });

    const replyText: string = String(mu?.reply ?? '');

    // 可能なら Mu からの q 情報を拾う
    const q_code: string | null =
      (mu as any)?.q_code ??
      (mu as any)?.current_q ??
      (mu as any)?.meta?.currentQ ??
      (mu as any)?.meta?.current_q ??
      null;
    
    const depth_stage: string | null =
      (mu as any)?.depth_stage ??
      (mu as any)?.meta?.depthStage ??
      null;
    
    const confidence: number | null =
      typeof (mu as any)?.confidence === 'number'
        ? (mu as any).confidence
        : typeof (mu as any)?.meta?.relation?.confidence === 'number'
          ? (mu as any).meta.relation.confidence
          : null;

    // --- Mu 返却メタ用の軽量状態推定（Sofia 互換の項目名）
    const lastUserText = typeof message === 'string' ? message : '';
    const mu_phase = inferPhase(lastUserText || '');
    const mu_self  = estimateSelfAcceptance(lastUserText || '');
    const mu_relation = relationQualityFrom(mu_phase, mu_self.band);

    // ★ フォールバック（Mu が q_code/depth_stage を返さない場合、既存ビューから推定）
    let fb_code: string | null = null;
    let fb_stage: string | null = null;

    if (!q_code && !depth_stage) {
      try {
        const sb = sbService();

        // 第一候補: v_user_q_unified2
        let qv = await sb
          .from('v_user_q_unified2')
          .select('current_q, depth_stage')
          .eq('user_code', userCode)
          .single();

        // 次候補: v_user_q_unified
        if (qv.error || !qv.data) {
          qv = await sb
            .from('v_user_q_unified')
            .select('current_q, depth_stage')
            .eq('user_code', userCode)
            .single();
        }

        // さらに保険: v_user_q_latest2
        if (qv.error || !qv.data) {
          const qv2 = await sb
            .from('v_user_q_latest2')
            .select('current_q, depth_stage')
            .eq('user_code', userCode)
            .single();
          if (!qv2.error && qv2.data) qv = qv2;
        }

        if (!qv.error && qv.data) {
          fb_code = (qv.data as any)?.current_q ?? null;
          fb_stage = (qv.data as any)?.depth_stage ?? null;
        }

        // 追加：ヒントビュー v_user_q_hint2（current_q が取れない時の補助）
        if (!fb_code && !fb_stage) {
          const hv = await sb
            .from('v_user_q_hint2')
            .select('q_hint')
            .eq('user_code', userCode)
            .single();
          if (!hv.error && hv.data) {
            fb_code = (hv.data as any)?.q_hint ?? null; // Q1〜Q5 想定
          }
        }

        // 追加：最終保険 q_code_logs の最新
        if (!fb_code && !fb_stage) {
          const lg = await sb
            .from('q_code_logs')
            .select('current_q, depth_stage')
            .eq('user_code', userCode)
            .order('ts', { ascending: false })
            .limit(1);

          if (!lg.error && Array.isArray(lg.data) && lg.data.length > 0) {
            const last = lg.data[0] as any;
            fb_code = last?.current_q ?? null;
            fb_stage = last?.depth_stage ?? null;
          }
        }
      } catch {}
    }

    // ★ 最終値を確定（Sofia互換カラー算出を含む）
    let final_code2 = (q_code ?? fb_code ?? null) as 'Q1'|'Q2'|'Q3'|'Q4'|'Q5' | null;
    let final_stage2 = (depth_stage ?? fb_stage ?? null) as 'S1'|'S2'|'S3' | null;

    // ---- 最終手当て（DBにも無い場合の軽推定）：selfAcceptance.band を目安に補完
    if (!final_code2) {
      const band = (typeof mu_self?.band === 'string' ? mu_self.band : '40_70') as
        | 'lt20' | '20_40' | '40_70' | '70_90' | 'gt90';

      if (band === 'lt20' || band === '20_40')      final_code2 = 'Q1';
      else if (band === '40_70')                    final_code2 = 'Q2';
      else /* '70_90' | 'gt90' */                   final_code2 = 'Q3';
    }
    if (!final_stage2) {
      // 深掘りなしのデフォルト段（安全に S1 固定）
      final_stage2 = 'S1';
    }

    const q_color = final_code2 ? mapQToColor(final_code2) : null;

    if (!replyText) {
      await voidCreditByKey(authKey);
      await recordMuTextTurn({
        user_code: userCode,
        status: 'fail',
        chargeOnFailure: false,
        conversation_id: master_id,
        message_id: sub_id,
        meta: { reason: 'generation_failed', authKey, thread_id: thread_id ?? null, board_id: board_id ?? null, ...promptMeta },
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
        q_code: final_code2,
        depth_stage: final_stage2,
        confidence,
        // --- Mu 状態推定（Sofia 互換の項目名で格納）
        phase: mu_phase,
        selfAcceptance: mu_self,
        relation: mu_relation,

        charge: { amount: COST_PER_TURN, aiId: 'mu', model: 'gpt-4.1-mini' },
        source_type: source_type ?? 'chat',
        thread_id: thread_id ?? null,
        board_id: board_id ?? null,
        ...promptMeta,
      },
    });

    /* ===== 会話ヘッダ & 一覧用ログ ===== */
    try {
      const sb = sbService();
      const nowIso = new Date().toISOString();

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
        meta: { source: 'mu', kind: 'user', ...promptMeta },
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
        meta: { model: 'gpt-4.1-mini', ...promptMeta },
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

    // ★ 返信（最小改修：q.color を含める / 互換）
    return json({
      agent: 'Mu',
      reply: replyText,
      meta: {
        agent: 'Mu',
        source_type: source_type ?? 'chat',
        confidence,
        // --- Mu 状態推定（Sofia 互換の項目名で返却）
        phase: mu_phase,
        selfAcceptance: mu_self,
        relation: mu_relation,

        charge: { amount: COST_PER_TURN, aiId: 'mu', model: 'gpt-4.1-mini' },
        master_id,
        sub_id,
        thread_id: thread_id ?? null,
        board_id: board_id ?? null,
        ...promptMeta,
      },
      q: final_code2 || final_stage2
        ? {
            code: final_code2,
            stage: final_stage2,
            color: q_color
              ? { base: q_color.base, mix: q_color.mix, hex: q_color.hex }
              : null,
          }
        : null,
      credit_balance,
      charge: { amount: COST_PER_TURN, aiId: 'mu', model: 'gpt-4.1-mini' },
      master_id,
      sub_id,
      conversation_id: master_id,
      title: body.message?.trim()?.slice(0, 20) ?? 'Mu 会話',
    });
  } catch (e: any) {
    console.error('[MuAI API] Error:', e);
    return json({ error: 'Unhandled error', detail: String(e?.message ?? e) }, 500);
  }
}
