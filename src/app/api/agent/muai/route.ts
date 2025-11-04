// /src/app/api/agent/muai/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';
import { generateMuReply, recordMuTextTurn } from '@/lib/mu';
import { buildMuSystemPrompt, MU_PROMPT_VERSION } from '@/lib/mu/buildSystemPrompt';
import { MU_CONFIG } from '@/lib/mu/config';
import { mapQToColor } from '@/lib/sofia/qcolor';
import { inferPhase, estimateSelfAcceptance, relationQualityFrom } from '@/lib/sofia/analyze';
import { recordQ } from '@/lib/qcode/record'; // ★ 追加：Qコード記録

const COST_PER_TURN = Number(process.env.MU_COST_PER_TURN ?? '0.5'); // 1往復=0.5

/* ---------------- utils ---------------- */
function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : ((init as ResponseInit | undefined)?.['status'] ?? 200);

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

function sbService() {
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('Supabase env missing');
  return createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
}

/* ==== ID utilities ==== */
// サーバ保存・課金用の厳密 UUID
const newUuid = () =>
  globalThis.crypto?.randomUUID?.() ??
  // @ts-ignore - Node.js
  require('crypto').randomUUID();

// 既存IDを尊重（UUID / MU- / 何であれ）。無ければ UUID を採用
function ensureMuMasterId(input?: string | null) {
  const s = (input ?? '').trim();
  return s || newUuid();
}

// クライアント表示用の従来 sub_id（mu-...）
function newClientSubId() {
  return `mu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** supabase_uid が空なら、click_email と Auth を突合せて自動補完（SR 利用） */
async function ensureSupabaseUid(userCode: string) {
  const sb = sbService();

  // users から対象ユーザー取得
  const { data: urow, error: uerr } = await sb
    .from('users')
    .select('user_code, click_email, supabase_uid')
    .eq('user_code', userCode)
    .single();

  if (uerr || !urow) return;

  if (!urow.supabase_uid && urow.click_email) {
    // ✅ v2対応: authスキーマを直接クエリ（SR必須）
    const { data: au, error: aerr } = await sb
      .schema('auth')
      .from('users')
      .select('id')
      .eq('email', urow.click_email)
      .limit(1)
      .single();

    if (!aerr && au?.id) {
      const uid = au.id as string;

      const { error: updErr } = await sb
        .from('users')
        .update({ supabase_uid: uid })
        .eq('user_code', userCode);
      if (updErr) {
        console.error('[ensureSupabaseUid] update users.supabase_uid error:', updErr);
      }

      // 任意: user_auth_map がある場合のみ同期
      const { error: mapErr } = await sb
        .from('user_auth_map')
        .upsert({ user_code: userCode, uid }, { onConflict: 'user_code' });
      if (mapErr) {
        console.warn('[ensureSupabaseUid] upsert user_auth_map warn:', mapErr.message);
      }
    }
  }
}

/* --------------- handlers --------------- */
export async function OPTIONS() {
  return json({ ok: true });
}

export async function POST(req: NextRequest) {
  try {
    /* 0) Firebase 検証・権限確認 */
    const z = await verifyFirebaseAndAuthorize(req);
    if (!z.ok) return json({ error: z.error }, z.status);
    if (!z.allowed) return json({ error: 'forbidden' }, 403);

    /* 入力 */
    const body = await req.json().catch(() => ({}));
    const {
      message, // 新UI
      master_id: inMaster,
      conversation_id: inConv,
      sub_id: inSub,
      thread_id,
      board_id,
      source_type,
      text, // ★ 旧UI互換
      input, // ★ 旧UI互換
      user_code: bodyUserCode, // ★ 保険
    } = body || {};

    // ★ 後方互換メッセージ解決
    const msgRaw = (message ?? text ?? input ?? '') as unknown;
    const msg = typeof msgRaw === 'string' ? msgRaw : String(msgRaw ?? '');
    if (!msg || !msg.trim()) return bad('empty message', 400);

    // ★ user_code の最終決定（認証優先、無ければ body を採用）
    const userCode =
      (z.userCode as string | null) ?? (typeof bodyUserCode === 'string' ? bodyUserCode : null);
    if (!userCode) return bad('user_code required', 400);

    // 会話IDは既存値尊重。無ければ UUID を付与
    const master_id = ensureMuMasterId(inMaster ?? inConv);

    // クライアントへ返す sub_id（従来：mu-...）
    const client_sub_id =
      typeof inSub === 'string' && inSub.trim() ? inSub.trim() : newClientSubId();

    // DB/課金用の厳密 sub_id（UUID）
    const server_sub_id = newUuid();

    /* 表示用メタ */
    const sys = buildMuSystemPrompt({
      personaKey: 'base',
      mode: 'normal',
      tone: 'gentle_guide',
    });
    const promptMeta = {
      mu_prompt_version: MU_PROMPT_VERSION,
      mu_persona: 'base',
      mu_mode: 'normal',
      mu_tone: 'gentle_guide',
      mu_config_version: MU_CONFIG.version,
      mu_prompt_hash: String(sys).slice(0, 24),
    };

    /* 1) 返信生成 */
    let mu: any;
    try {
      mu = await generateMuReply(String(msg), {
        user_code: userCode,
        master_id,
        sub_id: client_sub_id, // 生成側には従来 sub_id を渡す（表示整合）
        thread_id: thread_id ?? null,
        board_id: board_id ?? null,
        source_type: source_type ?? 'chat',
      });
    } catch {
      await recordMuTextTurn({
        user_code: userCode,
        status: 'fail',
        chargeOnFailure: false,
        conversation_id: master_id,
        message_id: client_sub_id,
        meta: {
          reason: 'generation_error',
          thread_id: thread_id ?? null,
          board_id: board_id ?? null,
          ...promptMeta,
        },
      });
      return json({ error: 'generation_failed' }, 502);
    }

    const replyText = String(mu?.reply ?? '');
    if (!replyText) {
      await recordMuTextTurn({
        user_code: userCode,
        status: 'fail',
        chargeOnFailure: false,
        conversation_id: master_id,
        message_id: client_sub_id,
        meta: {
          reason: 'generation_empty',
          thread_id: thread_id ?? null,
          board_id: board_id ?? null,
          ...promptMeta,
        },
      });
      return json({ error: 'generation_failed' }, 502);
    }

    /* 1.5) supabase_uid 自動補完 */
    await ensureSupabaseUid(userCode);

    /* 2) クレジット差し引き（SR） */
    const sb = sbService();
    let credit_balance: number | null = null;
    {
      const capRes = await sb.rpc('mu_capture_credit', {
        p_user_code: userCode,
        p_amount: COST_PER_TURN,
        p_idempotency_key: server_sub_id, // ★ UUID を使う（重複捕捉の精度を担保）
        p_reason: 'mu_chat_turn',
        p_meta: { agent: 'muai', model: 'gpt-4.1-mini' },
        p_ref_conversation_id: master_id,
      });
      if (capRes.error) {
        const msg = String(capRes.error.message || capRes.error);
        if (/insufficient/i.test(msg)) return json({ error: 'insufficient_credit' }, 402);
        return json({ error: 'capture_failed', detail: msg }, 500);
      }
      credit_balance =
        typeof capRes.data === 'number' || typeof capRes.data === 'string'
          ? Number(capRes.data)
          : null;
    }

    /* 2.5) 会話保存（SRで安全に upsert/insert） */
    try {
      const nowIso = new Date().toISOString();
      const title = (String(msg || '').trim() || 'Mu 会話').slice(0, 20);

      const upConv = await sb.from('mu_conversations').upsert(
        {
          id: master_id,
          user_code: userCode,
          title,
          origin_app: 'mu',
          updated_at: nowIso,
          last_turn_at: nowIso,
        },
        { onConflict: 'id' },
      );
      if (upConv.error) console.error('[muai] upsert mu_conversations error:', upConv.error);

      const insUser = await sb.from('mu_turns').insert({
        conv_id: master_id,
        role: 'user',
        content: String(msg ?? ''),
        meta: { source: 'mu', kind: 'user', client_sub_id: client_sub_id }, // ★ クライアント sub_id も残す
        used_credits: null,
        source_app: 'mu',
        sub_id: server_sub_id, // ★ DB は UUID
      });
      if (insUser.error) console.error('[muai] insert mu_turns (user) error:', insUser.error);

      const insAssist = await sb.from('mu_turns').insert({
        conv_id: master_id,
        role: 'assistant',
        content: replyText,
        meta: { model: 'gpt-4.1-mini', client_sub_id: client_sub_id }, // ★
        used_credits: COST_PER_TURN,
        source_app: 'mu',
        sub_id: server_sub_id, // ★ DB は UUID
      });
      if (insAssist.error)
        console.error('[muai] insert mu_turns (assistant) error:', insAssist.error);
    } catch (e) {
      console.error('[muai] persist turns thrown:', e);
    }

    /* 3) メタ推定 */
    const q_code: string | null =
      mu?.q_code ?? mu?.current_q ?? mu?.meta?.currentQ ?? mu?.meta?.current_q ?? null;
    const depth_stage: string | null = mu?.depth_stage ?? mu?.meta?.depthStage ?? null;
    const confidence: number | null =
      typeof mu?.confidence === 'number'
        ? mu.confidence
        : typeof mu?.meta?.relation?.confidence === 'number'
          ? mu.meta.relation.confidence
          : null;

    const lastUserText = String(msg ?? '');
    const mu_phase = inferPhase(lastUserText);
    const mu_self = estimateSelfAcceptance(lastUserText);
    const mu_relation = relationQualityFrom(mu_phase, mu_self.band);

    let final_code2 = (q_code ?? null) as 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | null;
    let final_stage2 = (depth_stage ?? null) as 'S1' | 'S2' | 'S3' | null;
    if (!final_code2) {
      const band = (typeof mu_self?.band === 'string' ? mu_self.band : '40_70') as
        | 'lt20'
        | '20_40'
        | '40_70'
        | '70_90'
        | 'gt90';
      final_code2 = band === 'lt20' || band === '20_40' ? 'Q1' : band === '40_70' ? 'Q2' : 'Q3';
    }
    if (!final_stage2) final_stage2 = 'S1';
    const q_color = final_code2 ? mapQToColor(final_code2) : null;

    /* 4) 外部ログ（従来の sub_id を維持） */
    await recordMuTextTurn({
      user_code: userCode,
      status: 'success',
      conversation_id: master_id,
      message_id: client_sub_id, // ★ 従来 sub_id を外部ログ・レスポンスに採用
      meta: {
        q_code: final_code2,
        depth_stage: final_stage2,
        confidence,
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
    const q = (final_code2 ?? 'Q2') as 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
    const stage = (final_stage2 ?? 'S1') as 'S1' | 'S2' | 'S3';

    try {
      await recordQ({
        user_code: userCode,
        source_type: 'mu',
        intent: 'normal', // ← 'chat' ではなく 'normal' に統一
        q, // Qコード
        stage, // 深度
        conversation_id: master_id,
        post_id: client_sub_id,
        title: 'Mu応答', // 任意
        extra: {
          model: 'gpt-4.1-mini',
          replyText,
          relation: mu_relation,
          confidence,
          phase: mu_phase,
          self: mu_self,
        },
      });
    } catch (e) {
      console.warn('[muai] recordQ skipped:', (e as any)?.message || e);
    }

    /* 5) レスポンス（構造は従来どおり） */
    return json({
      agent: 'Mu',
      reply: replyText,
      meta: {
        agent: 'Mu',
        source_type: source_type ?? 'chat',
        confidence,
        phase: mu_phase,
        selfAcceptance: mu_self,
        relation: mu_relation,
        charge: { amount: COST_PER_TURN, aiId: 'mu', model: 'gpt-4.1-mini' },
        master_id,
        sub_id: client_sub_id, // ここも従来の文字列 ID を返す
        thread_id: thread_id ?? null,
        board_id: board_id ?? null,
        ...promptMeta,
      },
      q:
        final_code2 || final_stage2
          ? {
              code: final_code2,
              stage: final_stage2,
              color: q_color ? { base: q_color.base, mix: q_color.mix, hex: q_color.hex } : null,
            }
          : null,
      credit_balance,
      charge: { amount: COST_PER_TURN, aiId: 'mu', model: 'gpt-4.1-mini' },
      master_id,
      sub_id: client_sub_id, // 従来どおり
      conversation_id: master_id,
      title: msg.trim().slice(0, 20) || 'Mu 会話',
    });
  } catch (e: any) {
    console.error('[MuAI API] Error:', e);
    return json({ error: 'Unhandled error', detail: String(e?.message ?? e) }, 500);
  }
}
