// src/app/api/agent/iros/reply/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { verifyFirebaseAndAuthorize } from '@/lib/authz';
import { authorizeChat, captureChat, makeIrosRef } from '@/lib/credits/auto';

import { loadIrosUserProfile } from '@/lib/iros/server/loadUserProfile';
import { saveIrosTrainingSample } from '@/lib/iros/server/saveTrainingSample';

import {
  handleIrosReply,
  type HandleIrosReplyOutput,
} from '@/lib/iros/server/handleIrosReply';

import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';
import { resolveModeHintFromText, resolveRememberScope } from './_mode';

import {
  attachNextStepMeta,
  extractNextStepChoiceFromText,
  findNextStepOptionById,
} from '@/lib/iros/nextStepOptions';

// ★★★ 文章エンジン（レンダリング層）
import { buildResonanceVector } from '@lib/iros/language/resonanceVector';
import { renderReply } from '@/lib/iros/language/renderReply';

import { applyRulebookCompat } from '@/lib/iros/policy/rulebook';

import { persistAssistantMessageToIrosMessages } from '@/lib/iros/server/persistAssistantMessageToIrosMessages';
import { renderGatewayAsReply } from '@/lib/iros/language/renderGateway';
import { runNormalBase } from '@/lib/iros/conversation/normalBase';
import crypto from 'crypto';

// ✅ 1) import を追加（既存 import 群の近くでOK）
import {
  extractSlotsForRephrase,
  rephraseSlotsFinal,
} from '@/lib/iros/language/rephraseEngine';



/**
 * [choiceId] 形式のタグを除去したい場合のパーサ（保険）
 * ※ 今は extractNextStepChoiceFromText を使ってるので未使用でもOK
 */
function parseChoiceTag(input: string): {
  choiceId: string | null;
  cleanText: string;
} {
  const s = String(input ?? '').trim();
  const m = s.match(/^\[([a-zA-Z0-9_-]+)\]\s*(.*)$/s);
  if (!m) return { choiceId: null, cleanText: s };
  const choiceId = m[1] || null;
  const cleanText = (m[2] ?? '').trim();
  return { choiceId, cleanText };
}

// NOTE:
// route.ts では IT強制（it_* choice / forceIT / renderMode 注入 等）を一切扱わない。
// ITは 4軸（handleIrosReply → metaForSave.renderMode 等）だけで確定させる。
// it_* choiceId は「選択ログ」扱い（IT確定には使わない）。

/** 共通CORS（/api/me と同等ポリシー + x-credit-cost 追加） */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'Content-Type, Authorization, x-user-code, x-credit-cost',
} as const;

// 既定：1往復 = 5pt（ENVで上書き可）
const CHAT_CREDIT_AMOUNT = Number(process.env.IROS_CHAT_CREDIT_AMOUNT ?? 5);

// 残高しきい値（ENVで上書き可）
const LOW_BALANCE_THRESHOLD = Number(
  process.env.IROS_LOW_BALANCE_THRESHOLD ?? 10,
);

// =========================================================
// ✅ single-writer: assistant 保存は route.ts が唯一
// =========================================================
const PERSIST_POLICY = 'REPLY_SINGLE_WRITER' as const;

// service-role で現在残高を読むための Supabase クライアント（残高チェック + 訓練用保存など）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * auth から最良の userCode を抽出。
 * - 開発補助：ヘッダ x-user-code を許容
 * - auth の返りがどの形でも拾えるように「取りうるキー」を全部見る
 */
function pickUserCode(req: NextRequest, auth: any): string | null {
  const h = req.headers.get('x-user-code');
  const fromHeader = h && h.trim() ? h.trim() : null;

  const candidates = [
    auth?.userCode,
    auth?.user_code,
    auth?.me?.user_code,
    auth?.me?.userCode,
    auth?.user?.user_code,
    auth?.user?.userCode,
    auth?.profile?.user_code,
    auth?.profile?.userCode,
  ]
    .map((v: any) => (v != null ? String(v) : ''))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return (candidates[0] ?? null) || fromHeader || null;
}

/** auth から uid をできるだけ抽出（ログ用） */
function pickUid(auth: any): string | null {
  return (
    (auth?.uid && String(auth.uid)) ||
    (auth?.firebase_uid && String(auth.firebase_uid)) ||
    (auth?.user?.id && String(auth.user.id)) ||
    (auth?.me?.id && String(auth.me.id)) ||
    null
  );
}

/** qTrace / qTraceUpdated は metaForSave の確定値を最優先で勝たせる（streak巻き戻り防止） */
function finalizeQTrace(meta: any, metaForSave: any): any {
  const m = meta ?? {};

  const fromSave =
    metaForSave?.qTraceUpdated ??
    metaForSave?.qTrace ??
    metaForSave?.unified?.qTraceUpdated ??
    metaForSave?.unified?.qTrace ??
    null;

  if (!fromSave || typeof fromSave !== 'object') return m;

  const streak = Number((fromSave as any).streakLength ?? 0);
  const streakSafe = Number.isFinite(streak) ? streak : 0;

  m.qTrace = {
    ...(m.qTrace ?? {}),
    ...fromSave,
    streakLength: streakSafe,
  };

  m.qTraceUpdated = {
    ...(m.qTraceUpdated ?? {}),
    ...fromSave,
    streakLength: streakSafe,
  };

  if (streakSafe > 0) {
    m.uncoverStreak = Math.max(Number(m.uncoverStreak ?? 0), streakSafe);
  }

  return m;
}

// =========================================================
// ✅ UI向け「現在のモード」可視化（NORMAL / IR / SILENCE）
// - silenceReason があっても「本文があるなら SILENCE にしない」
// =========================================================
type ReplyUIMode = 'NORMAL' | 'IR' | 'SILENCE';

function pickSpeechAct(meta: any): string | null {
  return (
    meta?.speechAct ??
    meta?.extra?.speechAct ??
    meta?.speech_act ??
    meta?.extra?.speech_act ??
    null
  );
}

function isEffectivelyEmptyText(text: any): boolean {
  const s = String(text ?? '').trim();
  if (!s) return true;

  // FAILSAFE/プレースホルダは「空」と同等扱い
  const t = s.replace(/\s+/g, '');
  return t === '…' || t === '…。🪔' || t === '...' || t === '....';
}

function pickSilenceReason(meta: any): string | null {
  return (
    meta?.silencePatchedReason ??
    meta?.extra?.silencePatchedReason ??
    meta?.silenceReason ??
    meta?.extra?.silenceReason ??
    null
  );
}

function inferUIMode(args: {
  modeHint?: string | null;
  effectiveMode?: string | null;
  meta?: any;
  finalText?: string | null;
}): ReplyUIMode {
  const { modeHint, effectiveMode, meta, finalText } = args;

  const hint = String(modeHint ?? '').toUpperCase();
  if (hint.includes('IR')) return 'IR';

  const eff = String(effectiveMode ?? '').toUpperCase();
  if (eff.includes('IR')) return 'IR';

  const speechAct = String(pickSpeechAct(meta) ?? '').toUpperCase();
  const empty = isEffectivelyEmptyText(finalText);

  // ✅ SILENCE は speechAct が SILENCE かつ “最終本文が空” の時だけ
  if (speechAct === 'SILENCE' && empty) return 'SILENCE';

  return 'NORMAL';
}

function inferUIModeReason(args: {
  modeHint?: string | null;
  effectiveMode?: string | null;
  meta?: any;
  finalText?: string | null;
}): string | null {
  const { modeHint, effectiveMode, meta, finalText } = args;

  const speechAct = String(pickSpeechAct(meta) ?? '').toUpperCase();
  const empty = isEffectivelyEmptyText(finalText);

  if (speechAct === 'SILENCE' && empty) {
    return pickSilenceReason(meta) ?? 'SILENCE';
  }

  const hint = String(modeHint ?? '').trim();
  if (hint.length > 0) return `MODE_HINT:${hint}`;

  const eff = String(effectiveMode ?? '').trim();
  if (eff.length > 0) return `EFFECTIVE_MODE:${eff}`;

  return null;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();

  const reqId = crypto.randomUUID();


  try {
    // 1) Bearer/Firebase 検証 → 認可（DEV_BYPASS は x-user-code がある時だけ発動）
    const DEV_BYPASS = process.env.IROS_DEV_BYPASS_AUTH === '1';

    let auth: any = null;

    const hUserCode = req.headers.get('x-user-code');
    const bypassUserCode =
      hUserCode && hUserCode.trim().length > 0 ? hUserCode.trim() : null;

    if (DEV_BYPASS && bypassUserCode) {
      auth = { ok: true, userCode: bypassUserCode, uid: 'dev-bypass' };

      console.warn('[IROS/Reply] DEV_BYPASS_AUTH used', {
        userCode: bypassUserCode,
      });
    } else {
      auth = await verifyFirebaseAndAuthorize(req);
      if (!auth?.ok) {
        return NextResponse.json(
          { ok: false, error: 'unauthorized' },
          { status: 401, headers: CORS_HEADERS },
        );
      }
    }

    // 2) 入力を取得
    const body = await req.json().catch(() => ({} as any));
    const conversationId: string | undefined = body?.conversationId;
    const text: string | undefined = body?.text;
    const hintText: string | undefined = body?.hintText ?? body?.modeHintText; // 後方互換
    const modeHintInput: string | undefined = body?.modeHint;
    const extra: Record<string, any> | undefined = body?.extra;

    // ✅ 会話履歴（LLMに渡す）
    const chatHistory: unknown[] | undefined = Array.isArray(body?.history)
      ? (body.history as unknown[])
      : undefined;

    // ★ 口調スタイル（client から style または styleHint で飛んでくる想定）
    const styleInput: string | undefined =
      typeof body?.style === 'string'
        ? body.style
        : typeof body?.styleHint === 'string'
        ? body.styleHint
        : undefined;

    if (!conversationId || !text) {
      return NextResponse.json(
        {
          ok: false,
          error: 'bad_request',
          detail: 'conversationId and text are required',
        },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    // tenant_id（未指定なら 'default'）
    const tenantId: string =
      typeof body?.tenant_id === 'string' && body.tenant_id.trim().length > 0
        ? body.tenant_id.trim()
        : typeof body?.tenantId === 'string' && body.tenantId.trim().length > 0
        ? body.tenantId.trim()
        : 'default';

    // 3) mode 推定
    const mode = resolveModeHintFromText({
      modeHint: modeHintInput,
      hintText,
      text,
    });

    // 3.5) Rememberモードのスコープ推定
    const rememberScope: RememberScopeKind | null = resolveRememberScope({
      modeHint: modeHintInput,
      hintText,
      text,
    });

    // 4) userCode / uid を抽出（ログ用 & meta.extra 用）
    const userCode = pickUserCode(req, auth);
    const uid = pickUid(auth);
    const traceId = extra?.traceId ?? extra?.trace_id ?? null;

    if (!userCode) {
      return NextResponse.json(
        { ok: false, error: 'unauthorized_user_code_missing' },
        { status: 401, headers: CORS_HEADERS },
      );
    }

    console.log('[IROS/REQ] in', {
      reqId,
      conversationId,
      userCode,
      uid,
      modeHint: mode,
      rememberScope,
      traceId,
      style: styleInput,
      history_len: chatHistory?.length ?? 0,
      textHead: String(text ?? '').slice(0, 80),
    });


    // 5) credit amount 決定（body.cost → header → 既定）
    const headerCost = req.headers.get('x-credit-cost');
    const bodyCost = body?.cost;
    const parsed =
      typeof bodyCost === 'number'
        ? bodyCost
        : typeof bodyCost === 'string'
        ? Number(bodyCost)
        : headerCost
        ? Number(headerCost)
        : NaN;

    const CREDIT_AMOUNT =
      Number.isFinite(parsed) && parsed > 0
        ? Number(parsed)
        : CHAT_CREDIT_AMOUNT;

    console.log('[IROS/Reply] credit', { userCode, CREDIT_AMOUNT });

    // 6) クレジット参照キー生成（authorize / capture 共通）
    const creditRef = makeIrosRef(conversationId, startedAt);

    // 7) authorize（不足時はここで 402）
    const authRes = await authorizeChat(
      req,
      userCode,
      CREDIT_AMOUNT,
      creditRef,
      conversationId,
    );

    if (!authRes.ok) {
      const errCode = (authRes as any).error ?? 'credit_authorize_failed';
      const res = NextResponse.json(
        {
          ok: false,
          error: errCode,
          credit: { ref: creditRef, amount: CREDIT_AMOUNT, authorize: authRes },
        },
        { status: 402, headers: CORS_HEADERS },
      );
      res.headers.set('x-reason', String(errCode));
      res.headers.set('x-user-code', userCode);
      res.headers.set('x-credit-ref', creditRef);
      res.headers.set('x-credit-amount', String(CREDIT_AMOUNT));
      if (traceId) res.headers.set('x-trace-id', String(traceId));
      return res;
    }

    // 7.5) 残高しきい値チェック
    let lowWarn:
      | null
      | { code: 'low_balance'; balance: number; threshold: number } = null;

    if (Number.isFinite(LOW_BALANCE_THRESHOLD) && LOW_BALANCE_THRESHOLD > 0) {
      const { data: balRow, error: balErr } = await supabase
        .from('users')
        .select('sofia_credit')
        .eq('user_code', userCode)
        .maybeSingle();

      if (!balErr && balRow && balRow.sofia_credit != null) {
        const balance = Number(balRow.sofia_credit) || 0;
        if (balance < LOW_BALANCE_THRESHOLD) {
          lowWarn = {
            code: 'low_balance',
            balance,
            threshold: LOW_BALANCE_THRESHOLD,
          };
        }
      }
    }

    // 7.6) ユーザープロファイルを取得（任意）
    let userProfile: any | null = null;
    try {
      userProfile = await loadIrosUserProfile(supabase, userCode);
    } catch (e) {
      console.warn('[IROS/Reply] userProfile fetch failed', {
        userCode,
        error: String(e),
      });
    }

    // =========================================================
    // 8) Iros 共通本体処理へ委譲
    // ★ NextStep choiceId はログとして渡す（本文にタグは混ぜない）
    // =========================================================

    // --- NextStep: ボタン押下タグの除去（保険） ---
    const rawText = String(text ?? '');
    const extracted = extractNextStepChoiceFromText(rawText);

    // ✅ UIが extra.choiceId を送ってくる前提に切り替える（本文にタグを混ぜない）
    const choiceIdFromExtra =
      extra && typeof (extra as any).choiceId === 'string'
        ? String((extra as any).choiceId).trim()
        : null;

    const extractedChoiceId =
      extracted?.choiceId && String(extracted.choiceId).trim().length > 0
        ? String(extracted.choiceId).trim()
        : null;

    const effectiveChoiceId = choiceIdFromExtra || extractedChoiceId || null;

    // ✅ 本文は「タグ除去済み」を優先（UIがタグ無しでも安全）
    const cleanText =
      extracted?.cleanText && String(extracted.cleanText).trim().length > 0
        ? String(extracted.cleanText).trim()
        : '';

    const userTextClean = cleanText.length ? cleanText : rawText;

    // option（将来の意図ログ用：今は必須ではない）
    const picked = effectiveChoiceId
      ? findNextStepOptionById(effectiveChoiceId)
      : null;

    // =========================================================
    // ✅ route.ts 側の IT強制を完全停止
    // - extra.forceIT / renderMode / spinLoop / descentGate / tLayer* は必ず無効化
    // - it_* choiceId は「選択ログ」扱い（IT確定には使わない）
    // =========================================================
    const rawExtra: Record<string, any> = (extra ?? {}) as any;
    const sanitizedExtra: Record<string, any> = { ...rawExtra };

    delete (sanitizedExtra as any).forceIT;
    delete (sanitizedExtra as any).renderMode;
    delete (sanitizedExtra as any).spinLoop;
    delete (sanitizedExtra as any).descentGate;
    delete (sanitizedExtra as any).tLayerModeActive;
    delete (sanitizedExtra as any).tLayerHint;

    // ✅ 重要：renderEngine は delete しない（gateで確定して使うため）

    let extraMerged: Record<string, any> = {
      ...sanitizedExtra,
      choiceId: effectiveChoiceId, // ✅ 下流は常にこれを見る
      extractedChoiceId, // ✅ デバッグ用
    };

    const modeForHandle = mode;
    const hintTextForHandle = hintText;

    // ✅ 追加：Node では origin が未定義なので、リクエストから取る
    const reqOrigin =
      req.headers.get('origin') ??
      req.headers.get('x-forwarded-origin') ??
      req.nextUrl?.origin ??
      '';

    // =========================================================
    // ✅ RenderEngine gate（single source）を handleIrosReply の「前」で確定する
    // - env: IROS_ENABLE_RENDER_ENGINE === '1' が許可スイッチ
    // - default ON: extra.renderEngine が false の時だけOFF（undefined/null/true はON）
    // =========================================================
    {
      const extraRenderEngine = (extraMerged as any).renderEngine; // true/false/undefined
      const envAllows = process.env.IROS_ENABLE_RENDER_ENGINE === '1';

      // ✅ default ON（明示 false の時だけ落とす）
      const enableRenderEngine = envAllows && extraRenderEngine !== false;

      extraMerged = {
        ...extraMerged,
        renderEngine: enableRenderEngine,
      };

      console.log('[IROS/Reply] renderEngine gate (PRE-HANDLE)', {
        conversationId,
        userCode,
        enableRenderEngine,
        envAllows: process.env.IROS_ENABLE_RENDER_ENGINE ?? null,
        extraRenderEngine,
        extraKeys: Object.keys(extraMerged ?? {}),
      });
    }

    // =========================================================
    // ✅ persist gate（single source）を handleIrosReply の「前」で確定する
    // - route.ts が唯一の保存者であることを extra にも明示
    // =========================================================
    {
      extraMerged = {
        ...extraMerged,
        persistedByRoute: true,
        persistAssistantMessage: false, // ✅ 下流が勝手に保存しないための宣言
      };

      console.log('[IROS/Reply] persist gate (PRE-HANDLE)', {
        conversationId,
        userCode,
        persistedByRoute: true,
        persistAssistantMessage: false,
      });
    }

    const irosResult: HandleIrosReplyOutput = await handleIrosReply({
      conversationId,
      text: userTextClean,
      hintText: hintTextForHandle,
      mode: modeForHandle,

      userCode,
      tenantId,
      rememberScope,
      reqOrigin,
      authorizationHeader: req.headers.get('authorization'),
      traceId,
      userProfile,
      style: styleInput ?? (userProfile?.style ?? null),
      history: chatHistory,

      extra: extraMerged,
    });

// =========================================================
// ✅ NORMAL BASE fallback（slotPlanExpected ガード付き）
// - SILENCE / FORWARD ではない
// - 本文が生成されていない（"…" も空扱い）
// - ただし「slotPlanExpected（slots がある/len>0）」なら絶対に fallback しない
// =========================================================
if (irosResult.ok) {
  const r: any = irosResult as any;

  const metaAny = r?.metaForSave ?? r?.meta ?? {};
  const extraAny = metaAny?.extra ?? {};

  const speechAct = extraAny?.speechAct ?? metaAny?.speechAct ?? null;

  const allowLLM =
    extraAny?.speechAllowLLM ?? metaAny?.speechAllowLLM ?? true;

  const candidateText = String(r?.assistantText ?? r?.content ?? '').trim();

  const isSilenceOrForward =
    speechAct === 'SILENCE' || speechAct === 'FORWARD';

  // ✅ "…" / "…。🪔" も「空」と同等にして fallback 対象にする
  const isEmptyLike = isEffectivelyEmptyText(candidateText);

  // ---------------------------------------------------------
  // ✅ slotPlanExpected 判定（fallback 誤発火を防ぐ）
  // - postprocess 側が extra.hasSlots_detected / extra.slotPlanLen_detected を入れているなら最優先
  // - 無ければ meta.framePlan.slots の「存在」と「長さ」から推定
  // ---------------------------------------------------------
  const hasSlotsDetected =
    typeof extraAny?.hasSlots_detected === 'boolean'
      ? extraAny.hasSlots_detected
      : null;

  const slotPlanLenDetected =
    typeof extraAny?.slotPlanLen_detected === 'number' &&
    Number.isFinite(extraAny.slotPlanLen_detected)
      ? extraAny.slotPlanLen_detected
      : null;

  // slots の「存在」を見る（[] でも true 扱いにする）
  const hasSlotsFromMeta =
    (metaAny?.framePlan &&
      Object.prototype.hasOwnProperty.call(metaAny.framePlan, 'slots')) ||
    (extraAny?.framePlan &&
      Object.prototype.hasOwnProperty.call(extraAny.framePlan, 'slots'));

  // slots の「長さ」を見る（無ければ 0）
  const slotLenFromMeta = Math.max(
    Array.isArray(metaAny?.framePlan?.slots) ? metaAny.framePlan.slots.length : 0,
    Array.isArray(extraAny?.framePlan?.slots) ? extraAny.framePlan.slots.length : 0,
  );

  const slotPlanExpected =
    (hasSlotsDetected ?? hasSlotsFromMeta) === true ||
    (slotPlanLenDetected ?? slotLenFromMeta) > 0;

  // ✅ 「適用した時だけ」ログを出す（このスコープで存在する変数だけを使う）
  const isNonSilenceButEmpty =
    !isSilenceOrForward &&
    allowLLM !== false &&
    String(userTextClean ?? '').trim().length > 0 &&
    isEmptyLike;

  // ✅ slot（FINAL）を守る：slot の気配が1つでもあれば NormalBase fallback を禁止
  const hasAnySlotsSignal =
    Boolean(slotPlanExpected) ||
    Boolean(hasSlotsDetected) ||
    Boolean(hasSlotsFromMeta) ||
    Number(slotPlanLenDetected ?? 0) > 0 ||
    Number(slotLenFromMeta ?? 0) > 0;

  if (isNonSilenceButEmpty && hasAnySlotsSignal) {
    console.log(
      '[IROS/Reply] NORMAL_BASE_FALLBACK_SKIPPED__SLOTS_PRESENT',
      {
        conversationId,
        userCode,
        speechAct,
        allowLLM,
        isEmptyLike,
        candidateTextHead: String(candidateText ?? '').slice(0, 80),
        hasSlotsDetected,
        slotPlanLenDetected,
        hasSlotsFromMeta,
        slotLenFromMeta,
        extra_finalTextPolicy: metaAny?.extra?.finalTextPolicy ?? null,
      },
    );
  } else if (isNonSilenceButEmpty) {
    console.log('[IROS/Reply] NORMAL_BASE_FALLBACK_APPLIED', {
      conversationId,
      userCode,
      speechAct,
      allowLLM,
      isEmptyLike,
      candidateTextHead: String(candidateText ?? '').slice(0, 80),
    });

    const normal = await runNormalBase({
      userText: userTextClean,
    });

    // 単一ソースで同期
    r.assistantText = normal.text;
    r.content = normal.text;
    r.text = normal.text;

    r.metaForSave = r.metaForSave ?? {};
    r.metaForSave.extra = {
      ...(r.metaForSave.extra ?? {}),
      normalBaseApplied: true,
      normalBaseSource: normal.meta.source,
      normalBaseReason: 'EMPTY_LIKE_TEXT',
    };
  }
}


    if (!irosResult.ok) {
      const headers: Record<string, string> = {
        ...CORS_HEADERS,
        'x-credit-ref': creditRef,
        'x-credit-amount': String(CREDIT_AMOUNT),
      };
      if (traceId) headers['x-trace-id'] = String(traceId);

      // ✅ 決定(Orchestrator)直後の「空」発生箇所を特定するための確定ログ
      try {
        const a: any = irosResult as any;
        const metaAny: any = a?.meta ?? {};
        const extraAny: any = metaAny?.extra ?? {};
        console.log('[IROS/Reply][POST-HANDLE_SNAPSHOT]', {
          conversationId,
          userCode,
          iros_ok: a?.ok,
          out_assistantText_len: String(a?.assistantText ?? '').length,
          out_content_len: String(a?.content ?? '').length,
          speechAct: extraAny?.speechAct ?? metaAny?.speechAct ?? null,
          speechAllowLLM: extraAny?.speechAllowLLM ?? metaAny?.speechAllowLLM ?? null,
          brakeReleaseReason:
            extraAny?.brakeReleaseReason ?? metaAny?.brakeReleaseReason ?? null,
          generalBrake: extraAny?.generalBrake ?? metaAny?.generalBrake ?? null,
          renderEngine: extraAny?.renderEngine ?? metaAny?.renderEngine ?? null,
          silencePatchedReason:
            extraAny?.silencePatchedReason ?? metaAny?.silencePatchedReason ?? null,
        });
      } catch {}

      return NextResponse.json(
        {
          ok: false,
          error: irosResult.error,
          detail: irosResult.detail,
          credit: {
            ref: creditRef,
            amount: CREDIT_AMOUNT,
            authorize: authRes,
          },
        },
        { status: 500, headers },
      );
    }

// ★ assistantText は後から補正するので let にする
let { result, finalMode, metaForSave, assistantText } = irosResult as any;

// =========================================================
// ✅ SpeechPolicy: SILENCE/FORWARD は “ここで即 return” して下流を通さない
// - ただし credit capture と headers は必ず付けて返す（authorize済みなので）
// =========================================================
{
  const metaAny: any = metaForSave ?? (result as any)?.meta ?? {};
  const extraAny: any = metaAny?.extra ?? {};

  const speechAct = String(
    extraAny?.speechAct ?? metaAny?.speechAct ?? '',
  ).toUpperCase();

  const allowLLM = extraAny?.speechAllowLLM ?? metaAny?.speechAllowLLM ?? true;

  const shouldEarlyReturn = speechAct === 'SILENCE' || speechAct === 'FORWARD';


  if (shouldEarlyReturn) {
    const finalTextRaw =
      typeof (result as any)?.content === 'string'
        ? (result as any).content
        : typeof assistantText === 'string'
        ? assistantText
        : '';

    const finalText = String(finalTextRaw ?? '').trimEnd();

    metaAny.extra = {
      ...(metaAny.extra ?? {}),
      speechEarlyReturned: true,
      speechEarlyReturnAct: speechAct,
    };

    // ✅ credit capture（authorize 済みのためここで確実に同期）
    const capRes = await captureChat(req, userCode, CREDIT_AMOUNT, creditRef);

    // ✅ headers をここで確定（通常returnと同等）
    const headers: Record<string, string> = {
      ...CORS_HEADERS,
      'x-handler': 'app/api/agent/iros/reply',
      'x-credit-ref': creditRef,
      'x-credit-amount': String(CREDIT_AMOUNT),
    };
    if (lowWarn) headers['x-warning'] = 'low_balance';
    if (traceId) headers['x-trace-id'] = String(traceId);

    console.log('[IROS/Reply] SPEECH_EARLY_RETURN', {
      conversationId,
      userCode,
      speechAct,
      allowLLM,
      finalTextLen: finalText.length,
      captured: capRes?.ok ?? null,
    });

    return NextResponse.json(
      {
        ok: true,
        mode: finalMode ?? 'auto',
        content: finalText,
        assistantText: finalText,
        credit: {
          ref: creditRef,
          amount: CREDIT_AMOUNT,
          authorize: authRes,
          capture: capRes,
          ...(lowWarn ? { warning: lowWarn } : {}),
        },
        ...(lowWarn ? { warning: lowWarn } : {}),
        meta: metaAny,
      },
      { status: 200, headers },
    );
  }
}


    // ✅ まず「本文」を拾う（確定前の irosResult.content は優先しない）
    {
      const pickText = (...vals: any[]) => {
        for (const v of vals) {
          const s = typeof v === 'string' ? v : String(v ?? '');
          // ✅ 先頭の改行や🪔は保持したいので trimEnd のみにする
          const t = s.replace(/\r\n/g, '\n').trimEnd();
          if (t.length > 0) return t;
        }
        return '';
      };

      const r: any = result;

      // ✅ result が object の場合：ここが“候補の正”
      if (r && typeof r === 'object') {
        assistantText = pickText(r.assistantText, r.content, r.text, assistantText);
        r.assistantText = assistantText;
      } else {
        // ✅ result が string の場合だけ：irosResult 側も拾う
        assistantText = pickText(
          assistantText,
          (irosResult as any)?.assistantText,
          (irosResult as any)?.text,
          (irosResult as any)?.resultText,
          typeof result === 'string' ? result : '',
        );
        (irosResult as any).assistantText = assistantText;
      }
    }

    // ✅ FAILSAFE: FORWARD & allowLLM=true なのに本文が空なら “異常” を確定ログ化
    {
      const extraDbg =
        (metaForSave as any)?.extra ??
        (irosResult as any)?.metaForSave?.extra ??
        {};
      const speechAct = extraDbg?.speechAct ?? null;
      const speechAllowLLM = extraDbg?.speechAllowLLM ?? null;

      const len_assistantText = String(assistantText ?? '').trim().length;
      const len_result_content = String((result as any)?.content ?? '').trim().length;
      const len_result_text = String((result as any)?.text ?? '').trim().length;

      const isEmptyButForward =
        speechAct === 'FORWARD' &&
        speechAllowLLM === true &&
        len_assistantText === 0 &&
        len_result_content === 0 &&
        len_result_text === 0;

      if (isEmptyButForward) {
        console.error('[IROS/Reply][BUG] empty-but-forward (allowLLM=true)', {
          conversationId,
          userCode,
          speechAct,
          speechAllowLLM,
          lengths: {
            assistantText: len_assistantText,
            result_content: len_result_content,
            result_text: len_result_text,
          },
          brakeReleaseReason: extraDbg?.brakeReleaseReason ?? null,
          generalBrake: extraDbg?.generalBrake ?? null,
          frame:
            (metaForSave as any)?.frame ??
            (metaForSave as any)?.framePlan_frame ??
            null,
          renderMode:
            (metaForSave as any)?.renderMode ??
            (metaForSave as any)?.extra?.renderMode ??
            null,
        });

        // ★ ここで強制的に本文を補完する（empty-but-forward の安全装置）
        if (!assistantText || assistantText.trim() === '') {
          assistantText = '…。🪔';
          if (result && typeof result === 'object') {
            (result as any).content = assistantText;
            (result as any).assistantText = assistantText;
          }
          (metaForSave as any).extra = {
            ...(((metaForSave as any).extra ?? {}) as any),
            renderEngineApplied: true,
            renderEngineFallbackUsed: true,
          };
        }

        if (process.env.IROS_EMPTY_FORWARD_IS_FATAL === '1') {
          throw new Error('IROS_BUG_EMPTY_BUT_FORWARD_ALLOW_LLM_TRUE');
        }

        // ✅ 本番寄り: とりあえず沈黙を返すが、異常フラグを残す
        assistantText = '…';
        (irosResult as any).assistantText = assistantText;

        // ✅ FIX: empty-but-forward failsafe の metaForSave.extra を破壊しない
        (metaForSave as any).extra = {
          ...(((metaForSave as any).extra ?? {}) as any),
          llmEmptyBug: true,
          silencePatchedReason: 'FAILSAFE_EMPTY_BUT_FORWARD',
        };
      }
    }

    // 9) capture
    const capRes = await captureChat(req, userCode, CREDIT_AMOUNT, creditRef);

    // 10) headers（以後の全 return で使う：ここで確定）
    const headers: Record<string, string> = {
      ...CORS_HEADERS,
      'x-handler': 'app/api/agent/iros/reply',
      'x-credit-ref': creditRef,
      'x-credit-amount': String(CREDIT_AMOUNT),
    };
    if (lowWarn) headers['x-warning'] = 'low_balance';
    if (traceId) headers['x-trace-id'] = String(traceId);

    // =========================================================
    // ✅ route.ts 側で single-writer を宣言（重複防止）
    // =========================================================
    (metaForSave as any).extra = (metaForSave as any).extra ?? {};
    (metaForSave as any).extra.persistedByRoute = true;
    (metaForSave as any).extra.persistAssistantMessage = false;

    // ★ effectiveMode は “metaForSave.renderMode” を最優先
    const effectiveMode =
      (typeof metaForSave?.renderMode === 'string' && metaForSave.renderMode) ||
      (typeof metaForSave?.extra?.renderedMode === 'string' &&
        metaForSave.extra.renderedMode) ||
      finalMode ||
      (result &&
      typeof result === 'object' &&
      typeof (result as any).mode === 'string'
        ? (result as any).mode
        : modeForHandle);

    const basePayload = {
      ok: true,
      mode: effectiveMode,
      credit: {
        ref: creditRef,
        amount: CREDIT_AMOUNT,
        authorize: authRes,
        capture: capRes,
        ...(lowWarn ? { warning: lowWarn } : {}),
      },
      ...(lowWarn ? { warning: lowWarn } : {}),
    };

    // === ここからレスポンス生成 & 訓練サンプル保存 ===
    if (result && typeof result === 'object') {
      // いったんベースの meta を組み立てる（metaForSave を優先）
      let meta: any = {
        ...(metaForSave ?? {}),
        ...(((result as any).meta) ?? {}),

        userProfile:
          (metaForSave as any)?.userProfile ??
          (result as any)?.meta?.userProfile ??
          userProfile ??
          null,

        extra: {
          ...(((metaForSave as any)?.extra) ?? {}),
          ...((((result as any).meta?.extra)) ?? {}),

          userCode: userCode ?? (metaForSave as any)?.extra?.userCode ?? null,

          hintText:
            hintTextForHandle ?? (metaForSave as any)?.extra?.hintText ?? null,
          traceId: traceId ?? (metaForSave as any)?.extra?.traceId ?? null,
          historyLen: Array.isArray(chatHistory) ? chatHistory.length : 0,

          choiceId: extraMerged.choiceId ?? null,
          extractedChoiceId: extraMerged.extractedChoiceId ?? null,
        },
      };

      // qTrace は metaForSave の確定値を勝たせる
      meta = finalizeQTrace(meta, metaForSave);

      // ✅ FINAL SYNC: assistantText が空なら content を採用（single-writer の最終整形）
      {
        const contentRaw = String((result as any)?.content ?? '');
        const assistantRaw = String((result as any)?.assistantText ?? '');

        if (contentRaw.trim().length > 0 && assistantRaw.trim().length === 0) {
          (result as any).assistantText = contentRaw;
        }
      }

      // ★ content は handleIrosReply の assistantText を正にする（ただし空は空のまま）
      if (typeof assistantText === 'string') {
        const at = assistantText.trim();
        if (at.length > 0) (result as any).content = at;
      }

      console.log('[IROS/Reply][after-handle]', {
        hasContent: typeof (result as any)?.content === 'string',
        hasAssistantText: typeof (result as any)?.assistantText === 'string',
        contentLen: String((result as any)?.content ?? '').length,
        assistantTextLen: String((result as any)?.assistantText ?? '').length,
        fallbackApplied: (result as any)?.meta?.extra?.fallbackApplied ?? null,
        fallbackLen: (result as any)?.meta?.extra?.fallbackLen ?? null,
        renderEngineGate: (result as any)?.meta?.extra?.renderEngineGate ?? null,
      });

      // =========================================================
      // ★ 三軸「次の一歩」オプションを meta に付与
      // - qCode/depth は “確定値だけ” を渡す
      // =========================================================
      meta = attachNextStepMeta({
        meta,

        qCode:
          (typeof (meta as any).qCode === 'string' && (meta as any).qCode) ||
          (typeof (meta as any).q_code === 'string' && (meta as any).q_code) ||
          (typeof (meta as any)?.unified?.q?.current === 'string' &&
            (meta as any).unified.q.current) ||
          null,

        depth:
          (typeof (meta as any).depth === 'string' && (meta as any).depth) ||
          (typeof (meta as any).depth_stage === 'string' &&
            (meta as any).depth_stage) ||
          (typeof (meta as any)?.unified?.depth?.stage === 'string' &&
            (meta as any).unified.depth.stage) ||
          null,

        selfAcceptance:
          typeof meta.selfAcceptance === 'number'
            ? meta.selfAcceptance
            : typeof meta.self_acceptance === 'number'
            ? meta.self_acceptance
            : typeof meta.unified?.self_acceptance === 'number'
            ? meta.unified.self_acceptance
            : null,

        hasQ5DepressRisk: false,

        userText: userTextClean,
      });

      // ★ situation_topic を確実に付与
      const rawSituationTopic =
        typeof (meta as any).situationTopic === 'string' &&
        (meta as any).situationTopic.trim().length > 0
          ? (meta as any).situationTopic.trim()
          : typeof (meta as any).situation_topic === 'string' &&
            (meta as any).situation_topic.trim().length > 0
          ? (meta as any).situation_topic.trim()
          : typeof (meta as any)?.unified?.situation_topic === 'string' &&
            (meta as any).unified.situation_topic.trim().length > 0
          ? (meta as any).unified.situation_topic.trim()
          : (() => {
              const note = (meta as any)?.extra?.pastStateNoteText;
              if (typeof note !== 'string' || note.trim().length === 0)
                return null;

              const m1 = note.match(/対象トピック:\s*([^\n\r]+)/);
              const m2 = note.match(/対象トピック\s*([^\n\r]+)/);

              const pickedTopic =
                m1 && m1[1]
                  ? String(m1[1]).trim()
                  : m2 && m2[1]
                  ? String(m2[1]).trim()
                  : null;

              return pickedTopic && pickedTopic.length > 0 ? pickedTopic : null;
            })();

      (meta as any).situationTopic = rawSituationTopic ?? 'その他・ライフ全般';
      (meta as any).situation_topic = (meta as any).situationTopic;

      // ★ target_kind を確実に付与（Training の舵取り）
      const rawTargetKind =
        typeof meta.targetKind === 'string' && meta.targetKind.trim().length > 0
          ? meta.targetKind.trim()
          : typeof meta.target_kind === 'string' &&
            meta.target_kind.trim().length > 0
          ? meta.target_kind.trim()
          : typeof (meta as any)?.goal?.kind === 'string' &&
            (meta as any).goal.kind.trim().length > 0
          ? (meta as any).goal.kind.trim()
          : typeof (meta as any)?.goalKind === 'string' &&
            (meta as any).goalKind.trim().length > 0
          ? (meta as any).goalKind.trim()
          : typeof meta?.intentLine?.direction === 'string' &&
            meta.intentLine.direction.trim().length > 0
          ? meta.intentLine.direction.trim()
          : typeof meta?.intent_line?.direction === 'string' &&
            meta.intent_line.direction.trim().length > 0
          ? meta.intent_line.direction.trim()
          : null;

      const normalizedTargetKind =
        rawTargetKind === 'expand' ||
        rawTargetKind === 'stabilize' ||
        rawTargetKind === 'pierce' ||
        rawTargetKind === 'uncover'
          ? rawTargetKind
          : 'stabilize';

      meta.targetKind = normalizedTargetKind;
      meta.target_kind = normalizedTargetKind;

      // ★★★ y/h を “整数に統一”
      meta = normalizeMetaLevels(meta);

      // ★ unified.intent_anchor を “固定アンカー” に同期
      {
        const fixedText =
          typeof meta?.intent_anchor?.text === 'string' && meta.intent_anchor.text
            ? meta.intent_anchor.text
            : null;

        const fixedPhrase =
          typeof meta?.intent_anchor?.phrase === 'string' &&
          meta.intent_anchor.phrase
            ? meta.intent_anchor.phrase
            : null;

        const fixedStrength =
          meta?.intent_anchor?.strength != null ? meta.intent_anchor.strength : null;

        if (fixedText) {
          meta.unified = meta.unified ?? {};
          meta.unified.intent_anchor = meta.unified.intent_anchor ?? {};
          meta.unified.intent_anchor.text = fixedText;
          if (fixedPhrase) meta.unified.intent_anchor.phrase = fixedPhrase;
          if (fixedStrength != null)
            meta.unified.intent_anchor.strength = fixedStrength;
        }
      }

      // ✅ UI が goal.targetQ を拾って Q3 を表示してしまう事故を防ぐ
      {
        const currentQ =
          (typeof meta?.qCode === 'string' && meta.qCode) ||
          (typeof meta?.q_code === 'string' && meta.q_code) ||
          (typeof meta?.unified?.q?.current === 'string' &&
            meta.unified.q.current) ||
          null;

        if (currentQ) {
          meta.qCode = currentQ;
          meta.q_code = currentQ;
          (meta as any).q = currentQ;
        }

        const goalTargetQ =
          typeof meta?.goal?.targetQ === 'string'
            ? meta.goal.targetQ
            : typeof meta?.priority?.goal?.targetQ === 'string'
            ? meta.priority.goal.targetQ
            : null;

        if (goalTargetQ) {
          (meta as any).goalTargetQ = goalTargetQ;
        }

        if (meta?.goal && typeof meta.goal === 'object') {
          delete meta.goal.targetQ;
        }
        if (meta?.priority?.goal && typeof meta.priority.goal === 'object') {
          delete meta.priority.goal.targetQ;
        }
      }

// =========================================================
// ✅ Context Pack fetcher（LLM注入用）
// - Evidence Logger の ios_context_pack_latest_conv を呼ぶ
// - 失敗しても null を返す（会話を止めない）
// ✅ 追加：historyMessages を pack に混ぜて返す（rephraseEngine が拾える形）
// =========================================================
async function fetchContextPackForLLM(args: {
  supabase: any;
  userCode: string;
  conversationId: string;
  limit?: number;

  // ✅ 追加：直近会話（LLM入力用の現物）
  historyMessages?: any[] | string | null;
}): Promise<any | null> {
  const { supabase, userCode, conversationId } = args;
  const pLimit = Number.isFinite(args.limit as any) ? Number(args.limit) : 200;

  try {
    const { data, error } = await supabase.rpc('ios_context_pack_latest_conv', {
      p_owner_user_code: String(userCode),
      p_limit: pLimit,
    });

    if (error) {
      console.warn('[IROS/CTX_PACK][ERR]', {
        userCode,
        conversationId,
        message: String(error?.message ?? error),
      });
      return null;
    }

    // data が { counts, last_state, pattern_hint, conversation_id } の想定
    const pack = data ?? null;

    // ✅ 履歴を正規化して pack に合成（rephraseEngine が拾えるキーに寄せる）
    const normalized = normalizeHistoryMessages(args.historyMessages);
    const historyText = buildHistoryText(normalized);

    const enriched = {
      ...(pack ?? {}),
      conversation_id: pack?.conversation_id ?? conversationId,

      // rephraseEngine.ts が拾う候補キー
      historyMessages: normalized.length ? normalized : undefined,
      historyText: historyText ? historyText : undefined,
    };

    console.log('[IROS/CTX_PACK][OK]', {
      userCode,
      conversationId,
      conv: enriched?.conversation_id ?? null,
      counts: enriched?.counts ?? null,
      last_state: enriched?.last_state ?? null,
      pattern_hint: enriched?.pattern_hint ?? null,
      hasHistoryMessages: Array.isArray(enriched?.historyMessages),
      historyLen: Array.isArray(enriched?.historyMessages) ? enriched.historyMessages.length : 0,
      hasHistoryText: typeof enriched?.historyText === 'string',
      historyTextLen: typeof enriched?.historyText === 'string' ? enriched.historyText.length : 0,
    });

    return enriched;
  } catch (e: any) {
    console.warn('[IROS/CTX_PACK][EX]', {
      userCode,
      conversationId,
      message: String(e?.message ?? e),
    });
    return null;
  }
}

// ==============================
// ✅ helpers（LLM注入用）
// ==============================
function normalizeHistoryMessages(
  raw: any[] | string | null | undefined,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!raw) return [];

  // string は最小限に分割して user 扱い（保険）
  if (typeof raw === 'string') {
    const lines = String(raw)
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(-24);

    return lines
      .map((s) => ({ role: 'user' as const, content: s }))
      .slice(-12);
  }

  if (!Array.isArray(raw)) return [];

  const mapped = raw
    .filter(Boolean)
    .slice(-24)
    .map((m: any) => {
      const roleRaw = String(m?.role ?? m?.speaker ?? m?.type ?? '').toLowerCase();
      const body = String(m?.content ?? m?.text ?? m?.message ?? '')
        .replace(/\r\n/g, '\n')
        .trim();
      if (!body) return null;

      const isAssistant =
        roleRaw === 'assistant' ||
        roleRaw === 'bot' ||
        roleRaw === 'system' ||
        roleRaw.startsWith('a');

      return {
        role: (isAssistant ? 'assistant' : 'user') as 'assistant' | 'user',
        content: body,
      };
    })
    .filter(
      (x): x is { role: 'user' | 'assistant'; content: string } => x !== null,
    )
    .slice(-12);

  return mapped;
}


function buildHistoryText(
  msgs: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  if (!msgs.length) return '';
  const joined = msgs
    .slice(-12)
    .map((m) => `${m.role === 'assistant' ? 'A' : 'U'}: ${m.content}`)
    .join('\n');

  if (joined.length <= 1800) return joined;
  return joined.slice(0, 1799) + '…';
}




// ★★★ Render Engine の適用（適用箇所をここで固定）
const effectiveStyle =
  typeof styleInput === 'string' && styleInput.trim().length > 0
    ? styleInput
    : typeof meta?.style === 'string' && meta.style.trim().length > 0
      ? meta.style
      : typeof meta?.userProfile?.style === 'string' &&
          meta.userProfile.style.trim().length > 0
        ? meta.userProfile.style
        : typeof userProfile?.style === 'string' &&
            userProfile.style.trim().length > 0
          ? userProfile.style
          : null;

// 1) 呼び出し側：text → userTextClean にする
await maybeAttachRephraseForRenderV2({
  conversationId,
  userCode,
  meta,
  userText: userTextClean,
  extraMerged,
  historyMessages: Array.isArray(chatHistory) ? chatHistory : null,
  traceId,
  reqId,
});


// 2) helper：destructure に userText を含める（args.userText をやめる）
async function maybeAttachRephraseForRenderV2(args: {
  conversationId: string;
  userCode: string;
  meta: any;
  userText?: string;
  extraMerged: Record<string, any>;
  historyMessages?: any[] | string | null; // ✅ 追加
  traceId?: string | null;
  reqId?: string | null;
}) {
  const {
    conversationId,
    userCode,
    meta,
    extraMerged,
    userText,
    historyMessages, // ✅ 追加
    traceId,
    reqId,
  } = args;

  // ✅ ここが「冒頭」：二重実行の確定ログ + idempotent ガード
  {
    const already =
      Array.isArray((extraMerged as any)?.rephraseBlocks) &&
      (extraMerged as any).rephraseBlocks.length > 0;

    const reqKey = `${reqId ?? 'no-reqId'}|${traceId ?? 'no-traceId'}|${conversationId}|${userCode}`;

    const g = globalThis as any;
    g.__IROS_REPHRASE_CALLCOUNT = g.__IROS_REPHRASE_CALLCOUNT ?? new Map();
    const prev = Number(g.__IROS_REPHRASE_CALLCOUNT.get(reqKey) ?? 0);
    const next = prev + 1;
    g.__IROS_REPHRASE_CALLCOUNT.set(reqKey, next);

    console.warn('[IROS/rephrase][ENTER]', {
      reqKey,
      callCount: next,
      alreadyAttached: already,
    });

    if (already) {
      console.warn('[IROS/rephrase][SKIP_ALREADY_ATTACHED]', {
        reqKey,
        rephraseBlocksLen: (extraMerged as any).rephraseBlocks.length,
      });
      return;
    }
  }

  const enabled =
    String(process.env.IROS_REPHRASE_FINAL_ENABLED ?? '1').trim() !== '0';
  if (!enabled) return;
  if (extraMerged?.renderEngine !== true) return;

  const hintedRenderMode =
    (typeof meta?.renderMode === 'string' && meta.renderMode) ||
    (typeof meta?.extra?.renderMode === 'string' && meta.extra.renderMode) ||
    (typeof meta?.extra?.renderedMode === 'string' &&
      meta.extra.renderedMode) ||
    '';
  if (String(hintedRenderMode).toUpperCase() === 'IT') return;

  const speechAct = String(
    meta?.extra?.speechAct ?? meta?.speechAct ?? '',
  ).toUpperCase();
  if (speechAct === 'SILENCE' || speechAct === 'FORWARD') return;

  const extraForRender = {
    ...(meta?.extra ?? {}),
    ...(extraMerged ?? {}),
    framePlan: (meta as any)?.framePlan ?? null,
    slotPlan: (meta as any)?.slotPlan ?? null,
  };

  const extracted = extractSlotsForRephrase(extraForRender);
  if (!extracted?.slots?.length) return;

// ✅ ここは「1回だけ」残す（重複してる方は消す）
const model =
  process.env.IROS_REPHRASE_MODEL ?? process.env.IROS_MODEL ?? 'gpt-4.1';

// traceId は reqId をフォールバックにする
const traceIdFinal =
  traceId && String(traceId).trim()
    ? String(traceId).trim()
    : reqId ?? null;

// =========================================================
// ✅ Context Pack を取得して LLM(userContext) に注入する
// =========================================================
const contextPack = await fetchContextPackForLLM({
  supabase, // ★ route.ts 上部の service-role client を使う
  userCode,
  conversationId,
  limit: 200,
  historyMessages: historyMessages ?? null, // ✅ 追加（ここが本命）
});

// meta にも保持（監査＆後段参照用）
meta.extra = {
  ...(meta.extra ?? {}),
  hasContextPackForLLM: !!contextPack,
  contextPackCounts: contextPack?.counts ?? null,
  contextPackLastState: contextPack?.last_state ?? null,
};

// ✅ ここで「注入される」ことを確定ログ化
console.log('[IROS/rephrase][CTX_INJECT]', {
  conversationId,
  userCode,
  hasContextPack: !!contextPack,
  counts: contextPack?.counts ?? null,
  last_state: contextPack?.last_state ?? null,
});

// ✅ 追加：LLM に渡す userContext に「直近会話」を合成する
// - historyXMerged / mergedHistory / historyMerged 等、ここにある実変数名に合わせて1つだけ使う
// - どれも無ければ `null` のままでもOK（落ちない）

// ✅ 合成：pack が持ってる historyText を “undefined 上書き” で消さない
const contextPackWithHistory = {
  ...(contextPack ?? {}),
  ...(Array.isArray(historyMessages) ? { historyMessages } : {}),
  ...(typeof historyMessages === 'string' ? { historyText: historyMessages } : {}),
};


// ✅ 合成後ログ（ここが true になれば勝ち）
console.log('[IROS/rephrase][CTX_INJECT][WITH_HISTORY]', {
  conversationId,
  userCode,
  hasHistoryMessages: Array.isArray((contextPackWithHistory as any).historyMessages),
  historyLen: Array.isArray((contextPackWithHistory as any).historyMessages)
    ? (contextPackWithHistory as any).historyMessages.length
    : null,
});

console.log('[IROS/rephrase][USERCTX_KEYS]', {
  conversationId,
  userCode,
  userContextType: typeof contextPackWithHistory,
  userContextKeys: contextPackWithHistory ? Object.keys(contextPackWithHistory) : null,
  hasHistoryMessages: Array.isArray((contextPackWithHistory as any)?.historyMessages),
  historyLen: Array.isArray((contextPackWithHistory as any)?.historyMessages)
    ? (contextPackWithHistory as any).historyMessages.length
    : null,
  hasHistoryText: typeof (contextPackWithHistory as any)?.historyText === 'string',
  historyTextLen:
    typeof (contextPackWithHistory as any)?.historyText === 'string'
      ? (contextPackWithHistory as any).historyText.length
      : null,
});

// route.ts（[IROS/rephrase][USERCTX_KEYS] の直後に追加）

const PREVIEW = String(process.env.IROS_REPHRASE_HISTORY_PREVIEW ?? '').trim();
const PREVIEW_ON = PREVIEW === '1' || PREVIEW.toLowerCase() === 'true';

function clamp(s: any, n: number) {
  const t = String(s ?? '');
  return t.length <= n ? t : t.slice(0, n) + '…';
}

function headTail(s: any, head = 240, tail = 240) {
  const t = String(s ?? '');
  if (t.length <= head + tail + 10) return t;
  return t.slice(0, head) + '\n…(snip)…\n' + t.slice(Math.max(0, t.length - tail));
}

if (PREVIEW_ON) {
  // このスコープに userContext / historyText / historyMessages がある前提
  const uc: any = (extraMerged as any)?.userContext ?? null;

  const ht = uc?.historyText;
  const hm = uc?.historyMessages;

  console.log('[IROS/rephrase][HISTORY_PREVIEW]', {
    conversationId,
    userCode,
    hasHistoryText: typeof ht === 'string' && ht.length > 0,
    historyTextLen: typeof ht === 'string' ? ht.length : 0,
    historyMessagesLen: Array.isArray(hm) ? hm.length : 0,
  });

  if (typeof ht === 'string' && ht.length) {
    console.log('[IROS/rephrase][HISTORY_TEXT][HEAD_TAIL]\n' + headTail(ht));
  }

  if (Array.isArray(hm) && hm.length) {
    // 先頭〜末尾の “どの発話が入ったか” を見たいので、最大12件だけ出す
    const max = 12;
    const slice =
      hm.length <= max ? hm : [...hm.slice(0, Math.ceil(max / 2)), ...hm.slice(-Math.floor(max / 2))];

    console.log(
      '[IROS/rephrase][HISTORY_MESSAGES][SAMPLE]',
      slice.map((m: any, i: number) => ({
        i,
        role: m?.role,
        // content/ text どっちでも拾えるように
        head: clamp(m?.content ?? m?.text ?? '', 140),
      }))
    );
  }
}

// =========================================================
// ✅ rephraseSlotsFinal に userContext を渡す（これがLLM注入）
// =========================================================
const res = await rephraseSlotsFinal(extracted, {
  model,
  temperature: 0.2,
  maxLinesHint: Number.isFinite(Number(process.env.IROS_RENDER_DEFAULT_MAXLINES))
    ? Number(process.env.IROS_RENDER_DEFAULT_MAXLINES)
    : 8,
  userText: userText ?? null,

  // ★★★ ここが変更点：null → contextPack
  userContext: contextPackWithHistory,
  debug: {
    traceId: traceIdFinal,
    conversationId: conversationId ?? null,
    userCode: userCode ?? null,
    renderEngine: true,
  },
});


  if (!res.ok) {
    console.warn('[IROS/rephrase][SKIP]', {
      conversationId,
      userCode,
      reason: res.reason,
      inKeys: res.meta?.inKeys ?? [],
      rawLen: res.meta?.rawLen ?? 0,
      rawHead: res.meta?.rawHead ?? '',
    });
    return;
  }

  // attach（mutate）
  (extraMerged as any).rephraseBlocks = res.slots.map((s) => ({ text: s.text }));

  meta.extra = {
    ...(meta.extra ?? {}),
    rephraseApplied: true,
    rephraseModel: model,
    rephraseKeys: res.meta.outKeys,
    rephraseRawLen: res.meta.rawLen,
    rephraseRawHead: res.meta.rawHead,
  };

  console.warn('[IROS/rephrase][OK]', {
    conversationId,
    userCode,
    keys: res.meta.outKeys,
    rawLen: res.meta.rawLen,
    rawHead: res.meta.rawHead,
  });

  console.warn('[IROS/rephrase][AFTER_ATTACH]', {
    conversationId,
    userCode,
    renderEngine: (extraMerged as any)?.renderEngine === true,
    rephraseBlocksLen: Array.isArray((extraMerged as any)?.rephraseBlocks)
      ? (extraMerged as any).rephraseBlocks.length
      : 0,
    rephraseHead: Array.isArray((extraMerged as any)?.rephraseBlocks)
      ? String((extraMerged as any).rephraseBlocks?.[0]?.text ?? '').slice(0, 80)
      : '',
  });
}



const applied = applyRenderEngineIfEnabled({
  conversationId,
  userCode,
  userText: userTextClean,
  styleInput: effectiveStyle,
  extra: extraMerged ?? null,
  meta,
  resultObj: result as any,
});

meta = applied.meta;
extraMerged = applied.extraForHandle;

// ✅ FINAL sanitize: RenderEngine ON/OFF に関係なく「最終本文」から見出しを完全除去
{
  const before = String((result as any)?.content ?? '');
  const sanitized = sanitizeFinalContent(before);

  // ✅ 先頭の改行や🪔は保持したいので trimEnd のみにする
  const next = sanitized.text.trimEnd();
  (result as any).content = next.length > 0 ? next : '';

  meta.extra = {
    ...(meta.extra ?? {}),
    finalHeaderStripped: sanitized.removed.length > 0 ? sanitized.removed : null,
  };
}


      // =========================================================
      // ✅ V2 FINAL確定直前ログ（空になった地点の確定用）
      // =========================================================
      const _s = (v: any) => (typeof v === 'string' ? v : v == null ? '' : String(v));
      const _head = (v: any, n = 64) => {
        const s = _s(v);
        return s.length <= n ? s : s.slice(0, n) + '…';
      };
      const _len = (v: any) => _s(v).length;

      const rObj: any = result && typeof result === 'object' ? (result as any) : null;

      console.log('[IROS/V2][FINAL-PRE]', {
        conversationId,
        userCode,

        resultObj_content_len: _len(rObj?.content),
        resultObj_assistantText_len: _len(rObj?.assistantText),
        resultObj_text_len: _len(rObj?.text),
        local_assistantText_len: _len(assistantText),

        resultObj_content_head: _head(rObj?.content),
        resultObj_assistantText_head: _head(rObj?.assistantText),
        resultObj_text_head: _head(rObj?.text),
        local_assistantText_head: _head(assistantText),

        extra_renderEngineApplied: meta?.extra?.renderEngineApplied ?? null,
        extra_renderEngineBy: meta?.extra?.renderEngineBy ?? null,
        extra_finalTextPolicy: meta?.extra?.finalTextPolicy ?? null,
        extra_emptyFinalPatched: meta?.extra?.emptyFinalPatched ?? null,

        speechAct: meta?.speechAct ?? meta?.extra?.speechAct ?? null,
        speechAllowLLM: meta?.speechAllowLLM ?? meta?.extra?.speechAllowLLM ?? null,
        silencePatched: meta?.silencePatched ?? meta?.extra?.silencePatched ?? null,
        silencePatchedReason:
          meta?.silencePatchedReason ??
          meta?.extra?.silencePatchedReason ??
          null,
      });

// =========================================================
// ✅ FINAL本文の確定（UIに出すもの＝保存するもの）
// - SILENCEは「speechAct=SILENCE」かつ「本文が実質空」の時だけ本文=空
// - 非SILENCEは「…系」を生成しない（空は空）
// - ここで finalText を一度だけ確定し、下流はこれを信じる（single source）
// =========================================================
{
  // ✅ 先頭改行は残しつつ、判定は trim した値で行う
  const curRaw = String((result as any)?.content ?? '');
  const curTrim = curRaw.trim();

  const speechAct = String(
    meta?.extra?.speechAct ?? meta?.speechAct ?? '',
  ).toUpperCase();

  const silenceReason = pickSilenceReason(meta);

  // ✅ SILENCE判定：speechAct=SILENCE かつ “空同等”
  const isSilent = speechAct === 'SILENCE' && isEffectivelyEmptyText(curTrim);

  // ✅ finalText：SILENCEかつ空同等→空 / それ以外→“空同等なら空” / 文字があればそのまま
  // （非SILENCEで '…' を本文として残したくない設計）
  const finalText = isSilent ? '' : isEffectivelyEmptyText(curTrim) ? '' : curRaw.trimEnd();

  // ✅ 統一：result / assistantText を single source で同期
  (result as any).content = finalText;
  (result as any).text = finalText;
  (result as any).assistantText = finalText;
  assistantText = finalText;

  meta.extra = {
    ...(meta.extra ?? {}),
    finalAssistantTextSynced: true,
    finalAssistantTextLen: finalText.length,

    finalTextPolicy: isSilent
      ? 'SILENCE_EMPTY_BODY'
      : meta?.extra?.finalTextPolicy ??
        (finalText.length > 0 ? 'NORMAL_BODY' : 'NORMAL_EMPTY_PASS'),

// ✅ empty系は「既に埋まっていれば尊重」し、なければここで確定
emptyFinalPatched:
  meta?.extra?.emptyFinalPatched ??
  (finalText.length === 0 ? true : undefined),

emptyFinalPatchedReason:
  meta?.extra?.emptyFinalPatchedReason ??
  (finalText.length === 0
    ? isSilent
      ? (silenceReason ? `SILENCE:${silenceReason}` : 'SILENCE_EMPTY_BODY')
      : 'NON_SILENCE_EMPTY_CONTENT'
    : undefined),

    // ✅ UI判定の参考（peek）
    uiModePeek: isSilent ? 'SILENCE' : 'NORMAL',
    uiModePeekReason: isSilent ? silenceReason : null,

    // ✅ デバッグ用（どこで空になったか追える）
    finalTextHead: finalText.length > 0 ? finalText.slice(0, 64) : '',
  };
}



// =========================================================
// ✅ UI MODE をここで確定（可視化の単一ソース）
// - 以後、persist などは meta.mode / meta.modeReason を信じるだけ
// - NOTE: finalText は「確定済みの finalText（single source）」をそのまま使う
// =========================================================
{
  // ✅ 先頭改行は残しつつ、判定は trim でOK（空判定を安定させる）
  const finalTextRaw = String((result as any)?.content ?? '');
  const finalText = finalTextRaw.trim();

  const uiMode = inferUIMode({
    modeHint: modeForHandle,
    effectiveMode,
    meta,
    finalText,
  });

  const uiReason = inferUIModeReason({
    modeHint: modeForHandle,
    effectiveMode,
    meta,
    finalText,
  });

  // ✅ 単一ソース：meta.mode / meta.modeReason を確定
  meta.mode = uiMode;
  meta.modeReason = uiReason;
  meta.persistPolicy = PERSIST_POLICY;

  // ✅ extra にも同期（UI/ログはここだけを見ればいい）
  meta.extra = {
    ...(meta.extra ?? {}),
    uiMode,
    uiModeReason: uiReason,
    persistPolicy: PERSIST_POLICY,

    // ✅ デバッグ用（空判定の根拠を残す）
    uiFinalTextLen: finalText.length,
    uiFinalTextHead:
      finalText.length > 0 ? finalText.slice(0, 64) : '',
  };
}


// =========================================================
// ✅ assistant 保存（single-writer）
// - inferUIMode を再計算しない（meta.mode を単一ソースとして使用）
// - SILENCE は insert しない
// =========================================================
let persistedAssistantMessage: any = null;

try {
  const silenceReason = pickSilenceReason(meta);

  const finalAssistant = String((result as any)?.content ?? '').trim();
  (result as any).assistantText = finalAssistant;

  const uiMode = (meta as any)?.mode as ReplyUIMode | undefined;

// =========================================================
// ✅ persist 用に q_code / depth_stage を “snake_case” に同期してから insert する
// - persistAssistantMessageToIrosMessages は基本 snake_case を読むため
// - ここが single source（assistant insert の直前で確定）
// =========================================================
const qCodeFinal =
  (typeof (meta as any)?.q_code === 'string' && (meta as any).q_code) ||
  (typeof (meta as any)?.qCode === 'string' && (meta as any).qCode) ||
  (typeof (meta as any)?.unified?.q?.current === 'string' && (meta as any).unified.q.current) ||
  null;

// ✅ depth は「meta.depth」(入力/途中値) が残りやすいので “絶対に” 優先しない
const depthStageFinal =
  (typeof (meta as any)?.depth_stage === 'string' && (meta as any).depth_stage) ||
  (typeof (meta as any)?.unified?.depth?.stage === 'string' && (meta as any).unified.depth.stage) ||
  (typeof (meta as any)?.depthStage === 'string' && (meta as any).depthStage) ||
  null;

// snake_case を必ず入れる（DB保存で読む側に合わせる）
(meta as any).q_code = qCodeFinal;
(meta as any).depth_stage = depthStageFinal;

// camel も揃えておく（UI/他処理の一貫性）
// ✅ “depth” は別用途が混ざるので、まず depthStage を正にする
if (qCodeFinal) (meta as any).qCode = qCodeFinal;
if (depthStageFinal) (meta as any).depthStage = depthStageFinal;

console.log('[IROS/reply][persist-assistant] q/depth final', {
  conversationId,
  userCode,
  qCodeFinal,
  depthStageFinal,
  meta_depth_stage: (meta as any)?.depth_stage ?? null,
  meta_depth: (meta as any)?.depth ?? null, // ← 観測用（ここで使わない）
  unified_depth_stage: (meta as any)?.unified?.depth?.stage ?? null,
  uiMode: (meta as any)?.mode ?? null,
  finalAssistantLen: finalAssistant.length,
});


  if (uiMode === 'SILENCE') {
    persistedAssistantMessage = {
      ok: true,
      inserted: false,
      skipped: true,
      len: 0,
      reason: 'UI_MODE_SILENCE_NO_INSERT',
      silenceReason: silenceReason ?? null,
    };

    meta.extra = {
      ...(meta.extra ?? {}),
      persistedAssistantMessage,
      silenceNoInsert: true,
      silenceReason: silenceReason ?? null,
    };

    console.log('[IROS/reply][persist-assistant] skipped (SILENCE=no-insert)', {
      conversationId,
      userCode,
      uiMode,
      silenceReason,
    });
  } else if (finalAssistant.length > 0) {
    const saved = await persistAssistantMessageToIrosMessages({
      supabase,
      conversationId,
      userCode,
      content: finalAssistant,

      // ✅ meta に q_code / depth_stage を同期済みなので、ここは meta だけ渡せばOK
      meta: meta ?? null,
    });


    persistedAssistantMessage = {
      ok: true,
      inserted: true,
      skipped: false,
      len: finalAssistant.length,
      reason: null,
      saved,
    };

    meta.extra = {
      ...(meta.extra ?? {}),
      persistedAssistantMessage,
    };

    console.log('[IROS/reply][persist-assistant] inserted to iros_messages', {
      conversationId,
      userCode,
      len: finalAssistant.length,
    });
  } else {
    persistedAssistantMessage = {
      ok: true,
      inserted: false,
      skipped: true,
      len: 0,
      reason: 'EMPTY_CONTENT',
    };

    meta.extra = {
      ...(meta.extra ?? {}),
      persistedAssistantMessage,
    };

    console.log('[IROS/reply][persist-assistant] skipped', {
      conversationId,
      userCode,
      reason: 'EMPTY_CONTENT',
    });
  }
} catch (e) {
  console.log('[IROS/reply][persist-assistant] error', e);

  persistedAssistantMessage = {
    ok: false,
    inserted: false,
    skipped: true,
    len: 0,
    reason: 'EXCEPTION',
  };

  meta.extra = {
    ...(meta.extra ?? {}),
    persistedAssistantMessage,
  };
}


      // =========================================================
      // ✅ assistant 保存方針（単一責任）
      // =========================================================
      const skipTraining =
        meta?.skipTraining === true ||
        meta?.skip_training === true ||
        meta?.recallOnly === true ||
        meta?.recall_only === true;

      if (!skipTraining) {
        await saveIrosTrainingSample({
          supabase,
          userCode,
          tenantId,
          conversationId,
          messageId: null,

          inputText: userTextClean,
          replyText: (result as any).content ?? '',

          meta,
          tags: ['iros', 'auto'],
        });
      } else {
        meta.extra = {
          ...(meta.extra ?? {}),
          trainingSkipped: true,
          trainingSkipReason:
            meta?.skipTraining === true || meta?.skip_training === true
              ? 'skipTraining'
              : 'recallOnly',
        };
      }

      // ✅ FIX: result 側の衝突キー（mode/meta/ok/credit）を除去してから返す
      const resultObj = { ...(result as any) };
      delete (resultObj as any).mode;
      delete (resultObj as any).meta;
      delete (resultObj as any).ok;
      delete (resultObj as any).credit;

      const payload = {
        ...resultObj,
        ...basePayload,
        mode: effectiveMode,
        meta,
      };

      return NextResponse.json(payload, { status: 200, headers });
    }

    // result が文字列等だった場合
    console.log('[IROS/Reply] response (string result)', {
      userCode,
      mode: effectiveMode,
    });

    // ✅ string result でも UI mode を返す
    const metaString: any = {
      userProfile: userProfile ?? null,
      extra: {
        userCode,
        hintText,
        traceId,
        historyLen: Array.isArray(chatHistory) ? chatHistory.length : 0,
      },
    };

    {
      const finalText = String(result ?? '').trim();

      const uiMode = inferUIMode({
        modeHint: modeForHandle,
        effectiveMode,
        meta: metaString,
        finalText,
      });

      const uiReason = inferUIModeReason({
        modeHint: modeForHandle,
        effectiveMode,
        meta: metaString,
        finalText,
      });

      metaString.mode = uiMode;
      metaString.modeReason = uiReason;
      metaString.persistPolicy = PERSIST_POLICY;
      metaString.extra = {
        ...(metaString.extra ?? {}),
        uiMode,
        uiModeReason: uiReason,
        persistPolicy: PERSIST_POLICY,
      };
    }

    return NextResponse.json(
      {
        ...basePayload,
        content: result,
        meta: metaString,
      },
      { status: 200, headers },
    );
  } catch (err: any) {
    console.error('[iros/reply][POST] fatal', err);
    return NextResponse.json(
      {
        ok: false,
        error: 'internal_error',
        detail: err?.message ?? String(err),
      },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}



function applyRenderEngineIfEnabled(params: {
  conversationId: string;
  userCode: string;
  userText: string;
  styleInput: string | null;
  extra: Record<string, any> | null;
  meta: any;
  resultObj: any; // expects { content?: string }
}): { meta: any; extraForHandle: Record<string, any> } {
  const { conversationId, userCode, userText, extra, meta, resultObj } = params;

  const extraForHandle: Record<string, any> = { ...(extra ?? {}) };

  // ✅ gate は single source：上流で boolean に確定済みの renderEngine をそのまま使う
  const enableRenderEngine = extraForHandle.renderEngine === true;

  // ✅ IT は gate と無関係に “必ず renderReply を通す”（現行維持）
  const hintedRenderMode =
    (typeof (meta as any)?.renderMode === 'string' && (meta as any).renderMode) ||
    (typeof (meta as any)?.extra?.renderMode === 'string' &&
      (meta as any).extra.renderMode) ||
    (typeof (meta as any)?.extra?.renderedMode === 'string' &&
      (meta as any).extra.renderedMode) ||
    '';

  const isIT = String(hintedRenderMode).toUpperCase() === 'IT';

  meta.extra = {
    ...(meta.extra ?? {}),
    renderEngineGate: enableRenderEngine,
    renderReplyForcedIT: isIT,
  };

// =========================================================
// ✅ v2: enableRenderEngine=true の場合は renderV2(format-only) を使う
// =========================================================
if (enableRenderEngine && !isIT) {
  try {
    const extraForRender = {
      ...(meta?.extra ?? {}),
      ...(extraForHandle ?? {}),

      // ✅ これが本命：renderGateway が slotPlan を拾えるように明示的に渡す
      framePlan: (meta as any)?.framePlan ?? null,
      slotPlan: (meta as any)?.slotPlan ?? null,
    };

// ✅ EvidenceLogger 用の最小パックを必ず付与（U!:no_ctx_summary を潰す）
// ※ extraForRender がスコープ内の「ここ」に置く
{
  const ms =
    (extraForHandle as any)?.memoryState ?? (meta as any)?.memoryState ?? null;

  const convId =
    (extraForHandle as any)?.conversationId ??
    (meta as any)?.conversationId ??
    (meta as any)?.extra?.conversationId ??
    null;

  const uCode =
    (extraForHandle as any)?.userCode ??
    (meta as any)?.userCode ??
    (meta as any)?.extra?.userCode ??
    null;

  const uText =
    (extraForHandle as any)?.userText ??
    (meta as any)?.userText ??
    (meta as any)?.extra?.userText ??
    userText ??
    null;

  const shortSummary =
    (ms?.situation_summary ??
      ms?.situationSummary ??
      ms?.summary ??
      (meta as any)?.situationSummary ??
      null) as string | null;

  const topic =
    (ms?.situation_topic ??
      ms?.situationTopic ??
      (meta as any)?.situationTopic ??
      null) as string | null;

  (extraForRender as any).conversationId = convId;
  (extraForRender as any).userCode = uCode;
  (extraForRender as any).userText = typeof uText === 'string' ? uText : null;
  (extraForRender as any).ctxPack = {
    shortSummary: typeof shortSummary === 'string' ? shortSummary : null,
    topic: typeof topic === 'string' ? topic : null,
    lastUser: null,
    lastAssistant: null,
  };
}


    // ✅ 6〜8段化：maxLines は env → 未設定なら 8
    const maxLines =
      Number.isFinite(Number(process.env.IROS_RENDER_DEFAULT_MAXLINES)) &&
      Number(process.env.IROS_RENDER_DEFAULT_MAXLINES) > 0
        ? Number(process.env.IROS_RENDER_DEFAULT_MAXLINES)
        : 8;

    const out = renderGatewayAsReply({
      extra: extraForRender,
      content: (resultObj as any)?.content ?? null,
      assistantText: (resultObj as any)?.assistantText ?? null,
      text: (resultObj as any)?.text ?? null,
      maxLines,
    });

    const nextContent = String(out?.content ?? '').trimEnd();
    resultObj.content = nextContent;
    (resultObj as any).assistantText = nextContent;
    (resultObj as any).text = nextContent;

    meta.extra = {
      ...(meta.extra ?? {}),
      renderEngineApplied: true,
      renderEngineBy: 'render-v2',
      renderV2: out?.meta ?? null,
    };

    return { meta, extraForHandle };
  } catch (e) {
    meta.extra = {
      ...(meta.extra ?? {}),
      renderEngineApplied: false,
      renderEngineBy: 'render-v2',
      renderEngineError: String(e),
    };
    return { meta, extraForHandle };
  }
}


  // =========================================================
  // ✅ IT は現行の renderReply を維持
  // =========================================================
  const shouldRunRenderReply = isIT;

  if (!shouldRunRenderReply) {
    return { meta, extraForHandle };
  }

  try {
    const contentBefore = String(resultObj?.content ?? '').trim();

    const fallbackFacts =
      contentBefore.length > 0
        ? contentBefore
        : String(
            (meta as any)?.situationSummary ??
              (meta as any)?.situation_summary ??
              meta?.unified?.situation?.summary ??
              '',
          ).trim() ||
          String(userText ?? '').trim() ||
          '';

    const vector = buildResonanceVector({
      qCode:
        (meta as any)?.qCode ??
        (meta as any)?.q_code ??
        meta?.unified?.q?.current ??
        null,
      depth:
        (meta as any)?.depth ??
        (meta as any)?.depth_stage ??
        meta?.unified?.depth?.stage ??
        null,
      phase: (meta as any)?.phase ?? meta?.unified?.phase ?? null,
      selfAcceptance:
        (meta as any)?.selfAcceptance ??
        (meta as any)?.self_acceptance ??
        meta?.unified?.selfAcceptance ??
        meta?.unified?.self_acceptance ??
        null,
      yLevel:
        (meta as any)?.yLevel ??
        (meta as any)?.y_level ??
        meta?.unified?.yLevel ??
        meta?.unified?.y_level ??
        null,
      hLevel:
        (meta as any)?.hLevel ??
        (meta as any)?.h_level ??
        meta?.unified?.hLevel ??
        meta?.unified?.h_level ??
        null,
      polarityScore:
        (meta as any)?.polarityScore ??
        (meta as any)?.polarity_score ??
        meta?.unified?.polarityScore ??
        meta?.unified?.polarity_score ??
        null,
      polarityBand:
        (meta as any)?.polarityBand ??
        (meta as any)?.polarity_band ??
        meta?.unified?.polarityBand ??
        meta?.unified?.polarity_band ??
        null,
      stabilityBand:
        (meta as any)?.stabilityBand ??
        (meta as any)?.stability_band ??
        meta?.unified?.stabilityBand ??
        meta?.unified?.stability_band ??
        null,
      situationSummary:
        (meta as any)?.situationSummary ??
        (meta as any)?.situation_summary ??
        meta?.unified?.situation?.summary ??
        null,
      situationTopic:
        (meta as any)?.situationTopic ??
        (meta as any)?.situation_topic ??
        meta?.unified?.situation?.topic ??
        null,
      intentLayer:
        (meta as any)?.intentLayer ??
        (meta as any)?.intent_layer ??
        (meta as any)?.intentLine?.focusLayer ??
        (meta as any)?.intent_line?.focusLayer ??
        meta?.unified?.intentLayer ??
        null,
      intentConfidence:
        (meta as any)?.intentConfidence ??
        (meta as any)?.intent_confidence ??
        (meta as any)?.intentLine?.confidence ??
        (meta as any)?.intent_line?.confidence ??
        null,
    });

    const baseInput = {
      facts: fallbackFacts,
      insight: null,
      nextStep: null,
      userWantsEssence: false,
      highDefensiveness: false,
      seed: String(conversationId),
      userText: String(userText ?? ''),
    } as const;

    const baseOpts = {
      minimalEmoji: false,
      renderMode: 'IT',
      itDensity:
        (meta as any)?.itDensity ??
        (meta as any)?.density ??
        (meta as any)?.extra?.itDensity ??
        (meta as any)?.extra?.density ??
        undefined,
    } as any;

    const patched = applyRulebookCompat({
      vector,
      input: baseInput,
      opts: baseOpts,
      meta,
      extraForHandle,
    });

    const rendered = renderReply(
      (patched.vector ?? vector) as any,
      (patched.input ?? baseInput) as any,
      (patched.opts ?? baseOpts) as any,
    );

    const renderedText =
      typeof rendered === 'string'
        ? rendered
        : (rendered as any)?.text
        ? String((rendered as any).text)
        : String(rendered ?? '');

    const sanitized = sanitizeFinalContent(renderedText);

    const metaAfter = (patched.meta ?? meta) as any;
    const extraForHandleAfter = (patched.extraForHandle ?? extraForHandle) as any;

    const speechActUpper = String(
      metaAfter?.extra?.speechAct ??
        metaAfter?.extra?.speech_act ??
        extraForHandleAfter?.speechAct ??
        extraForHandleAfter?.speech_act ??
        '',
    ).toUpperCase();

    const isSilence = speechActUpper === 'SILENCE';

    const fallbackText =
      contentBefore.length > 0 ? contentBefore : String(fallbackFacts ?? '').trim();

    const nextContent = isSilence
      ? sanitized.text.trimEnd()
      : sanitized.text.trim().length > 0
        ? sanitized.text.trimEnd()
        : fallbackText;

    resultObj.content = nextContent;
    (resultObj as any).assistantText = nextContent;
    (resultObj as any).text = nextContent;

    metaAfter.extra = {
      ...(metaAfter.extra ?? {}),
      renderEngineApplied: nextContent.length > 0,
      headerStripped: sanitized.removed.length > 0 ? sanitized.removed : null,
    };

    return { meta: metaAfter, extraForHandle: extraForHandleAfter };
  } catch (e) {
    meta.extra = {
      ...(meta.extra ?? {}),
      renderEngineApplied: false,
      renderEngineError: String(e),
    };
    return { meta, extraForHandle };
  }
}

// =========================================================
// ✅ 2) helper を追加（POST の外 / helpers領域でOK）
// - FINALでも「表現だけ」を 1回だけ LLMに貸す
// - slot key/順序がズレたら黙って破棄
// - SILENCE/FORWARD は触らない
// =========================================================


// ✅ helpers領域に置く（POSTの外 / applyRenderEngineIfEnabled の外）
function sanitizeFinalContent(input: string): { text: string; removed: string[] } {
  const raw = String(input ?? '');
  const lines = raw.replace(/\r\n/g, '\n').split('\n');

  const headerRe = /^\s*(Iros|IROS|Sofia|SOFIA|IT|✨|Q[1-5])\s*$/;
  const removed: string[] = [];

  while (lines.length > 0) {
    const head = (lines[0] ?? '').trim();
    if (head.length === 0 || headerRe.test(head)) {
      removed.push(lines.shift() ?? '');
      continue;
    }
    break;
  }

  while (lines.length > 0 && String(lines[0] ?? '').trim().length === 0) {
    removed.push(lines.shift() ?? '');
  }

  const text = lines.join('\n').trimEnd();
  return { text, removed };
}

/**
 * yLevel / hLevel を “整数に統一” する（DBの int と常に一致させる）
 * - meta / meta.unified / intent_anchor（camel/snake）まで同期
 * - null は触らない
 */
function normalizeMetaLevels(meta: any): any {
  const m = meta ?? {};
  const u = m.unified ?? {};

  const yRaw = pickNumber(m.yLevel, m.y_level, u.yLevel, u.y_level) ?? null;
  const hRaw = pickNumber(m.hLevel, m.h_level, u.hLevel, u.h_level) ?? null;

  const yInt = yRaw == null ? null : clampInt(Math.round(yRaw), 0, 3);
  const hInt = hRaw == null ? null : clampInt(Math.round(hRaw), 0, 3);

  if (yInt == null && hInt == null) return m;

  if (yInt != null) {
    m.yLevel = yInt;
    m.y_level = yInt;
  }
  if (hInt != null) {
    m.hLevel = hInt;
    m.h_level = hInt;
  }

  m.unified = m.unified ?? {};
  if (yInt != null) {
    m.unified.yLevel = yInt;
    m.unified.y_level = yInt;
  }
  if (hInt != null) {
    m.unified.hLevel = hInt;
    m.unified.h_level = hInt;
  }

  if (m.unified.intent_anchor && typeof m.unified.intent_anchor === 'object') {
    if (yInt != null) m.unified.intent_anchor.y_level = yInt;
    if (hInt != null) m.unified.intent_anchor.h_level = hInt;
  }

  if (m.intent_anchor && typeof m.intent_anchor === 'object') {
    if (yInt != null) m.intent_anchor.y_level = yInt;
    if (hInt != null) m.intent_anchor.h_level = hInt;
  }

  m.extra = {
    ...(m.extra ?? {}),
    normalizedLevels: {
      yLevelRaw: yRaw,
      hLevelRaw: hRaw,
      yLevelInt: yInt,
      hLevelInt: hInt,
    },
  };

  return m;
}

function pickNumber(...vals: any[]): number | null {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim().length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function clampInt(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}
