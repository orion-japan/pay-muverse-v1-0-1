// src/app/api/agent/iros/reply/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';
import { authorizeChat, captureChat, makeIrosRef } from '@/lib/credits/auto';
import { createClient } from '@supabase/supabase-js';
import { saveIrosTrainingSample } from '@/lib/iros/server/saveTrainingSample';
import { loadIrosUserProfile } from '@/lib/iros/server/loadUserProfile';

import {
  handleIrosReply,
  type HandleIrosReplyOutput,
} from '@/lib/iros/server/handleIrosReply';

import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';
import { resolveModeHintFromText, resolveRememberScope } from './_mode';

import { attachNextStepMeta } from '@/lib/iros/nextStepOptions';

// ★★★ 文章エンジン（レンダリング層）
import { buildResonanceVector } from '@lib/iros/language/resonanceVector';
import { renderReply } from '@/lib/iros/language/renderReply';

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

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();

  try {
    // 1) Bearer/Firebase 検証 → 認可（DEV_BYPASS は x-user-code がある時だけ発動）
    const DEV_BYPASS = process.env.IROS_DEV_BYPASS_AUTH === '1';

    let auth: any = null;

    const hUserCode = req.headers.get('x-user-code');
    const bypassUserCode =
      hUserCode && hUserCode.trim().length > 0 ? hUserCode.trim() : null;

    if (DEV_BYPASS && bypassUserCode) {
      // ★ DEV専用：curl 等で叩くための認証バイパス（x-user-code 必須）
      auth = { ok: true, userCode: bypassUserCode, uid: 'dev-bypass' };

      console.warn('[IROS/Reply] DEV_BYPASS_AUTH used', {
        userCode: bypassUserCode,
      });
    } else {
      // ★ ブラウザ通常動作：Firebase 認証へフォールバック
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

    // ✅ 追加：会話履歴（LLMに渡す）
    // NOTE: `history` という変数名は window.history と衝突しやすいので避ける
    const chatHistory: unknown[] | undefined = Array.isArray(body?.history)
      ? (body.history as unknown[])
      : undefined;

    // ★ 追加：口調スタイル（client から style または styleHint で飛んでくる想定）
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

    console.log('[IROS/Reply] start', {
      conversationId,
      userCode,
      uid,
      modeHint: mode,
      rememberScope,
      traceId,
      style: styleInput,
      history_len: chatHistory?.length ?? 0,
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

    // 8) Iros 共通本体処理へ委譲
    const origin = req.nextUrl.origin;
    const authHeader = req.headers.get('authorization');

    const irosResult: HandleIrosReplyOutput = await handleIrosReply({
      conversationId,
      text,
      hintText,
      mode,
      userCode,
      tenantId,
      rememberScope,
      reqOrigin: origin,
      authorizationHeader: authHeader,
      traceId,
      userProfile,
      style: styleInput ?? (userProfile?.style ?? null),

      // ✅ 追加：履歴を渡す
      history: chatHistory,
    });

    // 8.x) 生成失敗時
    if (!irosResult.ok) {
      const headers: Record<string, string> = {
        ...CORS_HEADERS,
        'x-credit-ref': creditRef,
        'x-credit-amount': String(CREDIT_AMOUNT),
      };
      if (traceId) headers['x-trace-id'] = String(traceId);

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

    const { result, finalMode, metaForSave, assistantText } =
  irosResult as any;


    // 9) capture
    const capRes = await captureChat(req, userCode, CREDIT_AMOUNT, creditRef);

    // 10) meta を統一し、credit情報を付与して返却
    const headers: Record<string, string> = {
      ...CORS_HEADERS,
      'x-handler': 'app/api/agent/iros/reply',
      'x-credit-ref': creditRef,
      'x-credit-amount': String(CREDIT_AMOUNT),
    };
    if (lowWarn) headers['x-warning'] = 'low_balance';
    if (traceId) headers['x-trace-id'] = String(traceId);

    const effectiveMode =
      finalMode ??
      (result &&
      typeof result === 'object' &&
      typeof (result as any).mode === 'string'
        ? (result as any).mode
        : mode);

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
  // ★ handleIrosReply.postProcess 以降の「確定メタ」を土台にする
  ...(metaForSave ?? {}),

  // （必要なら）orch 側が持っている meta を上書きで重ねる
  ...(((result as any).meta) ?? {}),

  userProfile:
    (metaForSave as any)?.userProfile ??
    (result as any)?.meta?.userProfile ??
    userProfile ??
    null,

  // extra は「metaForSave.extra → result.meta.extra → routeで追加」の順にマージ
  extra: {
    ...(((metaForSave as any)?.extra) ?? {}),
    ...((((result as any).meta?.extra)) ?? {}),

    userCode: userCode ?? (metaForSave as any)?.extra?.userCode ?? null,
    hintText: hintText ?? (metaForSave as any)?.extra?.hintText ?? null,
    traceId: traceId ?? (metaForSave as any)?.extra?.traceId ?? null,

    // ✅ デバッグ用：historyの長さだけ返す
    historyLen: Array.isArray(chatHistory) ? chatHistory.length : 0,
  },
};

// ★ content も handleIrosReply の assistantText を正にする（renderEngine 等の前提が安定）
if (typeof assistantText === 'string' && assistantText.trim().length > 0) {
  (result as any).content = assistantText;
}


      // ★ 三軸「次の一歩」オプションを meta に付与
      meta = attachNextStepMeta({
        meta,
        qCode:
          (meta.qCode as any) ??
          (meta.q_code as any) ??
          (meta.unified?.q?.current as any) ??
          'Q3',
        depth:
          (meta.depth as any) ??
          (meta.depth_stage as any) ??
          (meta.unified?.depth?.stage as any) ??
          'S2',
        selfAcceptance:
          typeof meta.selfAcceptance === 'number'
            ? meta.selfAcceptance
            : typeof meta.self_acceptance === 'number'
            ? meta.self_acceptance
            : typeof meta.unified?.self_acceptance === 'number'
            ? meta.unified.self_acceptance
            : null,
        hasQ5DepressRisk: false,
        userText: text,
      });

      // ★ situation_topic を確実に付与（Training/集計の舵取り）
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

              const picked =
                m1 && m1[1]
                  ? String(m1[1]).trim()
                  : m2 && m2[1]
                  ? String(m2[1]).trim()
                  : null;

              return picked && picked.length > 0 ? picked : null;
            })();

      (meta as any).situationTopic = rawSituationTopic ?? 'その他・ライフ全般';
      (meta as any).situation_topic = (meta as any).situationTopic;

      // ★ target_kind を確実に付与（Training の舵取り）
      // 方針：meta.* が最優先 → goal.kind / goalKind → intentLine.direction（最後のフォールバック）
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

      // ★★★ ここが本丸：返却metaの y/h を “整数に統一” する（DBとUIとTrainingを一致させる）
      meta = normalizeMetaLevels(meta);

// ★ unified.intent_anchor を “固定アンカー” に同期（ブレ防止）
{
  const fixedText =
    typeof meta?.intent_anchor?.text === 'string' && meta.intent_anchor.text
      ? meta.intent_anchor.text
      : null;

  const fixedPhrase =
    typeof meta?.intent_anchor?.phrase === 'string' && meta.intent_anchor.phrase
      ? meta.intent_anchor.phrase
      : null;

  const fixedStrength =
    meta?.intent_anchor?.strength != null ? meta.intent_anchor.strength : null;

  if (fixedText) {
    meta.unified = meta.unified ?? {};
    meta.unified.intent_anchor = meta.unified.intent_anchor ?? {};

    meta.unified.intent_anchor.text = fixedText;
    if (fixedPhrase) meta.unified.intent_anchor.phrase = fixedPhrase;
    if (fixedStrength != null) meta.unified.intent_anchor.strength = fixedStrength;
  }
}



      console.log('[IROS/Reply] response meta', meta);

      // ✅ UI が goal.targetQ を拾って Q3 を表示してしまう事故を防ぐ
      // 方針：表示用は常に「現在Q（meta.qCode / unified.q.current）」
      //       targetQ は UI に返さない（内部的には meta.goalTargetQ に退避だけする）
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

      // ★★★ Render Engine の適用（ここで「適用箇所」を固定）
      const applied = applyRenderEngineIfEnabled({
        conversationId,
        userCode,
        userText: text,
        styleInput: styleInput ?? null,
        extra: extra ?? null,
        meta,
        resultObj: result as any,
      });

      meta = applied.meta;

      // ★ 訓練用サンプルを保存（失敗しても本処理は継続）
      // ✅ skipTraining / recallOnly のときは訓練保存しない（goal recall 等）
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
          inputText: text,
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

      return NextResponse.json(
        { ...basePayload, ...(result as any), meta },
        { status: 200, headers },
      );
    }

    // result が文字列等だった場合
    console.log('[IROS/Reply] response (string result)', {
      userCode,
      mode: effectiveMode,
    });

    return NextResponse.json(
      {
        ...basePayload,
        content: result,
        meta: {
          userProfile: userProfile ?? null,
          extra: {
            userCode,
            hintText,
            traceId,
            historyLen: Array.isArray(chatHistory) ? chatHistory.length : 0,
          },
        },
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

// ===== render engine helper (do not place inside POST) =====

function applyRenderEngineIfEnabled(params: {
  conversationId: string;
  userCode: string;
  userText: string;
  styleInput: string | null;
  extra: Record<string, any> | null;
  meta: any;
  resultObj: any; // expects { content?: string }
}): { meta: any } {
  const {
    conversationId,
    userCode,
    userText,
    styleInput,
    extra,
    meta,
    resultObj,
  } = params;

  // strict gate（extra は boolean true のみ許可）
  const extraRenderEngine = !!extra && (extra as any).renderEngine === true;
  const envRenderEngine = process.env.IROS_ENABLE_RENDER_ENGINE === '1';
  const enableRenderEngine = extraRenderEngine || envRenderEngine;

  // ★ 迷子防止：ゲート根拠を必ず meta に残す（レスポンスだけで原因追跡できる）
  meta.extra = {
    ...(meta.extra ?? {}),
    renderEngineGate: {
      enableRenderEngine,
      extraRenderEngine,
      envRenderEngine,
      envValue: process.env.IROS_ENABLE_RENDER_ENGINE ?? null,
      extraKeys: extra ? Object.keys(extra) : [],
    },
  };

  console.log('[IROS/Reply] renderEngine gate', {
    conversationId,
    userCode,
    enableRenderEngine,
    envEnable: process.env.IROS_ENABLE_RENDER_ENGINE,
    extraRenderEngine: extra ? (extra as any).renderEngine : undefined,
    extraKeys: extra ? Object.keys(extra) : [],
  });

  // OFFなら何もせず帰る（renderEngineApplied も触らない）
  if (!enableRenderEngine) {
    return { meta };
  }

  try {
    const contentBefore = String(resultObj?.content ?? '').trim();
    if (contentBefore.length === 0) {
      meta.extra = {
        ...(meta.extra ?? {}),
        renderEngineApplied: false,
        renderEngineEmptyInput: true,
      };
      return { meta };
    }

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

    const userWantsEssence = /本質|ズバ|はっきり|ハッキリ|意図|核心|要点/.test(
      userText,
    );

    const qNow =
      (meta.qCode as any) ??
      (meta.q_code as any) ??
      (meta.unified?.q?.current as any) ??
      null;

    const highDefensiveness = qNow === 'Q1' || qNow === 'Q4';

    const coreNeed =
      (meta.soulNote?.core_need as string) ??
      (meta.core_need as string) ??
      (meta.unified?.soulNote?.core_need as string) ??
      null;

    const insightCandidate =
      coreNeed && String(coreNeed).trim().length > 0
        ? String(coreNeed).trim()
        : null;

    const nextStepCandidate =
      (meta.nextStep as any)?.text ??
      (meta.next_step as any)?.text ??
      (meta.nextStep as any)?.label ??
      (meta.next_step as any)?.label ??
      (meta.nextStepMeta as any)?.text ??
      null;

    // biz-soft / biz-formal は絵文字抑制
    const minimalEmoji =
      typeof styleInput === 'string' &&
      (styleInput.includes('biz-formal') || styleInput.includes('biz-soft'));

    console.log('[IROS/Reply][renderEngine] inputs', {
      conversationId,
      userCode,
      styleInput,
      minimalEmoji,
      qNow,
      userWantsEssence,
      highDefensiveness,
      insightCandidate,
      nextStepCandidate,
      vector,
    });

    // meta.extra にデバッグ情報
    meta.extra = {
      ...(meta.extra ?? {}),
      resonanceVector: vector,
      renderEngine: {
        userWantsEssence,
        highDefensiveness,
        minimalEmoji,
        insightCandidate,
        nextStepCandidate,
      },
    };

    const rendered = renderReply(
      vector,
      {
        facts: String(resultObj?.content ?? '').trim(),
        insight: insightCandidate,
        nextStep: nextStepCandidate,
        userWantsEssence,
        highDefensiveness,
        seed: String(conversationId),
      },
      {
        minimalEmoji,
        forceExposeInsight:
          !!extra && (extra as any).forceExposeInsight === true,
      },
    );

    const renderedText =
      typeof rendered === 'string'
        ? rendered
        : (rendered as any)?.text
        ? String((rendered as any).text)
        : String(rendered ?? '');

    if (renderedText.trim().length > 0) {
      resultObj.content = renderedText; // ★反映
      meta.extra = {
        ...(meta.extra ?? {}),
        renderEngineApplied: true,
      };
    } else {
      meta.extra = {
        ...(meta.extra ?? {}),
        renderEngineApplied: false,
        renderEngineEmptyOutput: true,
      };
    }

    return { meta };
  } catch (e) {
    console.warn('[IROS/Reply] renderEngine failed (ignored)', {
      conversationId,
      userCode,
      error: String(e),
    });

    meta.extra = {
      ...(meta.extra ?? {}),
      renderEngineApplied: false,
      renderEngineError: String(e),
    };

    return { meta };
  }
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
    if (yInt != null) {
      m.unified.intent_anchor.y_level = yInt;
    }
    if (hInt != null) {
      m.unified.intent_anchor.h_level = hInt;
    }
  }

  if (m.intent_anchor && typeof m.intent_anchor === 'object') {
    if (yInt != null) {
      m.intent_anchor.y_level = yInt;
    }
    if (hInt != null) {
      m.intent_anchor.h_level = hInt;
    }
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
