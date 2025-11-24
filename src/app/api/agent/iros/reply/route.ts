// file: src/app/api/agent/iros/reply/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';
import { authorizeChat, captureChat, makeIrosRef } from '@/lib/credits/auto';
import { createClient } from '@supabase/supabase-js';
import { logQFromIros } from '@/lib/q/logFromIros'; // ★ 追加（※現時点では未使用。Qメモリ配線時に利用予定）
import { updateUserQNowFromMeta } from '@/lib/iros/qSnapshot';

// ★ 追加：Iros Orchestrator + Memory Adapter
import { runIrosTurn } from '@/lib/iros/orchestrator';
import { loadQTraceForUser, applyQTraceToMeta } from '@/lib/iros/memory.adapter';

// ★ 追加：Rememberモード（期間バンドルRAG）
import {
  resolveRememberBundle,
  type RememberScopeKind,
} from '@/lib/iros/remember/resolveRememberBundle';

// ★ 追加：モード判定（外出し）
import { resolveModeHintFromText, resolveRememberScope } from './_mode';

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

// ★ I層100%モードのフラグ（ENVベース）
const FORCE_I_LAYER = process.env.IROS_FORCE_I_LAYER === '1';

// service-role で現在残高を読むための Supabase クライアント
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

// ---------- UnifiedAnalysis 専用ロジック（このファイル内だけで完結） ----------

type UnifiedAnalysis = {
  q_code: string | null;
  depth_stage: string | null;
  phase: string | null;
  self_acceptance: number | null;
  relation_tone: string | null;
  keywords: string[];
  summary: string | null;
  raw: any;
};

function buildUnifiedAnalysis(params: {
  userText: string;
  assistantText: string;
  meta: any;
}): UnifiedAnalysis {
  const { userText, assistantText, meta } = params;
  const safeMeta = meta ?? {};
  const safeAssistant =
    typeof assistantText === 'string'
      ? assistantText
      : String(assistantText ?? '');

  return {
    q_code: safeMeta.qCode ?? safeMeta.q_code ?? null,
    depth_stage: safeMeta.depth ?? safeMeta.depth_stage ?? null,
    phase: safeMeta.phase ?? null,
    self_acceptance:
      typeof safeMeta.self_acceptance === 'number'
        ? safeMeta.self_acceptance
        : null,
    relation_tone: safeMeta.relation_tone ?? null,
    keywords: Array.isArray(safeMeta.keywords) ? safeMeta.keywords : [],
    summary:
      typeof safeMeta.summary === 'string' &&
      safeMeta.summary.trim().length > 0
        ? safeMeta.summary
        : safeAssistant
        ? safeAssistant.slice(0, 60)
        : null,
    raw: {
      user_text: userText,
      assistant_text: safeAssistant,
      meta: safeMeta,
    },
  };
}

async function saveUnifiedAnalysisInline(
  analysis: UnifiedAnalysis,
  context: {
    userCode: string;
    tenantId: string;
    agent: string;
  },
) {
  // 1) unified_resonance_logs へ INSERT
  const { error: logErr } = await supabase
    .from('unified_resonance_logs')
    .insert({
      tenant_id: context.tenantId,
      user_code: context.userCode,
      agent: context.agent,
      q_code: analysis.q_code,
      depth_stage: analysis.depth_stage,
      phase: analysis.phase,
      self_acceptance: analysis.self_acceptance,
      relation_tone: analysis.relation_tone,
      keywords: analysis.keywords,
      summary: analysis.summary,
      raw: analysis.raw,
    });

  if (logErr) {
    console.error('[UnifiedAnalysis] log insert failed', logErr);
    return;
  }

  // 2) user_resonance_state を UPSERT（Qストリーク管理）
  const { data: prev, error: prevErr } = await supabase
    .from('user_resonance_state')
    .select('*')
    .eq('user_code', context.userCode)
    .eq('tenant_id', context.tenantId)
    .maybeSingle();

  if (prevErr) {
    console.error('[UnifiedAnalysis] state load failed', prevErr);
    return;
  }

  const isSameQ = prev?.last_q === analysis.q_code;
  const streak = isSameQ ? (prev?.streak_count ?? 0) + 1 : 1;

  const { error: stateErr } = await supabase
    .from('user_resonance_state')
    .upsert({
      user_code: context.userCode,
      tenant_id: context.tenantId,
      last_q: analysis.q_code,
      last_depth: analysis.depth_stage,
      last_phase: analysis.phase,
      last_self_acceptance: analysis.self_acceptance,
      streak_q: analysis.q_code,
      streak_count: streak,
      updated_at: new Date().toISOString(),
    });

  if (stateErr) {
    console.error('[UnifiedAnalysis] state upsert failed', stateErr);
    return;
  }
}

/** auth から最良の userCode を抽出。ヘッダ x-user-code は開発補助として許容 */
function pickUserCode(req: NextRequest, auth: any): string | null {
  const h = req.headers.get('x-user-code');
  const fromHeader = h && h.trim() ? h.trim() : null;
  return (auth?.userCode && String(auth.userCode)) || fromHeader || null;
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

/* =========================================================
   会話履歴ダイジェスト
   - 同じ conversation_id の過去メッセージを読み込み
   - 「あなた:」「Iros:」形式で短くまとめて 1つのテキストにする
========================================================= */

const MAX_HISTORY_ROWS = 30; // 直近何件まで使うか
const MAX_HISTORY_CHARS = 4000; // LLMに渡す履歴部分の最大長

type HistoryRow = {
  role: string | null;
  content: string | null;
  text: string | null;
};

async function buildConversationHistoryDigest(
  conversationId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('iros_messages')
      .select('role, content, text')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[IROS/History] failed to load messages', {
        conversationId,
        error,
      });
      return null;
    }

    if (!data || data.length === 0) return null;

    // 末尾から MAX_HISTORY_ROWS 件だけ使う
    const sliced = data.slice(-MAX_HISTORY_ROWS);

    const lines: string[] = [];
    for (const row of sliced) {
      const rawText = (row.content ?? row.text ?? '') || '';
      const trimmed = rawText.replace(/\s+/g, ' ').trim();
      if (!trimmed) continue;

      const isAssistant = row.role === 'assistant';
      const label = isAssistant ? 'Iros' : 'あなた';

      lines.push(`${label}: ${trimmed}`);
    }

    if (lines.length === 0) return null;

    let joined = lines.join('\n');

    // 長すぎる場合は先頭から削る（直近メインにする）
    if (joined.length > MAX_HISTORY_CHARS) {
      joined = joined.slice(joined.length - MAX_HISTORY_CHARS);
    }

    return joined;
  } catch (e) {
    console.error('[IROS/History] unexpected error', {
      conversationId,
      error: e,
    });
    return null;
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();

  try {
    // 1) Bearer/Firebase 検証 → 認可
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) {
      return NextResponse.json(
        { ok: false, error: 'unauthorized' },
        { status: 401, headers: CORS_HEADERS },
      );
    }

    // 2) 入力を取得
    const body = await req.json().catch(() => ({} as any));
    const conversationId: string | undefined = body?.conversationId;
    const text: string | undefined = body?.text;
    const hintText: string | undefined = body?.hintText ?? body?.modeHintText; // 後方互換
    const modeHintInput: string | undefined = body?.modeHint;
    const extra: Record<string, any> | undefined = body?.extra;

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

    // tenant_id（未指定なら 'default'） — Remember と UnifiedAnalysis 両方で使う
    const tenantId: string =
      typeof body?.tenant_id === 'string' &&
      body.tenant_id.trim().length > 0
        ? body.tenant_id.trim()
        : 'default';

    // 3) mode 推定
    const mode = resolveModeHintFromText({ modeHint: modeHintInput, hintText, text });

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
      FORCE_I_LAYER,
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
      Number.isFinite(parsed) && parsed > 0 ? Number(parsed) : CHAT_CREDIT_AMOUNT;

    console.log('[IROS/Reply] credit', {
      userCode,
      CREDIT_AMOUNT,
    });

    // 6) クレジット参照キー生成（authorize / capture 共通）
    const creditRef = makeIrosRef(conversationId, startedAt);

    // 7) authorize（不足時はここで 402。auto 側で precheck + authorize_simple を実行）
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
        { status: 402, headers: CORS_HEADERS }, // Payment Required
      );
      res.headers.set('x-reason', String(errCode));
      res.headers.set('x-user-code', userCode);
      res.headers.set('x-credit-ref', creditRef);
      res.headers.set('x-credit-amount', String(CREDIT_AMOUNT));
      if (traceId) res.headers.set('x-trace-id', String(traceId));
      return res;
    }

    // 7.5) 残高しきい値チェック（authorize がOK＝残高は >= amount）
    let lowWarn: null | {
      code: 'low_balance';
      balance: number;
      threshold: number;
    } = null;
    if (
      Number.isFinite(LOW_BALANCE_THRESHOLD) &&
      LOW_BALANCE_THRESHOLD > 0
    ) {
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

    // 7.8) isFirstTurn 判定（この conversationId のメッセージ件数を確認）
    let isFirstTurn = false;
    try {
      const { count: messageCount, error: msgErr } = await supabase
        .from('iros_messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', conversationId);

      if (msgErr) {
        console.error(
          '[IROS/Reply] failed to count messages for conversation',
          {
            conversationId,
            error: msgErr,
          },
        );
      } else {
        isFirstTurn = (messageCount ?? 0) === 0;
      }
    } catch (e) {
      console.error(
        '[IROS/Reply] unexpected error when counting messages',
        {
          conversationId,
          error: e,
        },
      );
    }

    console.log('[IROS/Reply] isFirstTurn', {
      conversationId,
      isFirstTurn,
    });

    // 7.9) 会話履歴ダイジェストを取得（1ターン目でなければ）
    let historyDigest: string | null = null;
    if (!isFirstTurn) {
      historyDigest = await buildConversationHistoryDigest(conversationId);
      console.log('[IROS/History] digest length', {
        conversationId,
        hasDigest: !!historyDigest,
        length: historyDigest?.length ?? 0,
      });
    }

    // 8) Qコードメモリ読み込み → Orchestrator 呼び出し（I層100%テスト版）
    console.log('[IROS/Memory] loadQTraceForUser start', { userCode });
    let result: any;

    try {
      const qTrace = await loadQTraceForUser(userCode, { limit: 50 });

      console.log('[IROS/Memory] qTrace', {
        snapshot: qTrace.snapshot,
        counts: qTrace.counts,
        streakQ: qTrace.streakQ,
        streakLength: qTrace.streakLength,
        lastEventAt: qTrace.lastEventAt,
      });

      // QTrace から depth / qCode を meta に反映
      const baseMetaFromQ = applyQTraceToMeta(
        {
          qCode: undefined,
          depth: undefined,
        },
        qTrace,
      );

      // ★ I層100%モード：ENVフラグでON/OFF
      const FORCE_I_LAYER_LOCAL = FORCE_I_LAYER;

      // I層モードでも mirror ベース
      const requestedMode =
        FORCE_I_LAYER_LOCAL
          ? ('mirror' as any)
          : mode === 'auto'
          ? undefined
          : (mode as any);

      // 深度は I2 に固定（テスト用）
      const requestedDepth = FORCE_I_LAYER_LOCAL
        ? ('I2' as any)
        : (baseMetaFromQ.depth as any);

      // ★ baseMeta は any にして型エラーを回避（中身は既存ロジックと同じ）
      const baseMetaForTurn: any = {};

      // I層強制モードのときは、depth は I2 に任せるので Q側の depth は渡さない
      if (!FORCE_I_LAYER_LOCAL && baseMetaFromQ.depth) {
        baseMetaForTurn.depth = baseMetaFromQ.depth as any;
      }
      if (baseMetaFromQ.qCode != null) {
        baseMetaForTurn.qCode = baseMetaFromQ.qCode as any;
      }

      // ★ historyDigest を含めた effectiveText を定義
      const effectiveText =
        historyDigest && historyDigest.trim().length > 0
          ? `【これまでの流れ（要約）】\n${historyDigest}\n\n【今回のユーザー発言】\n${text}`
          : text;

      result = await runIrosTurn({
        conversationId,
        text: effectiveText,
        requestedMode,
        requestedDepth,
        requestedQCode: undefined, // QはIros本体に任せる
        baseMeta: baseMetaForTurn,
        isFirstTurn,
      });

      console.log('[IROS/Orchestrator] result.meta', (result as any)?.meta);
    } catch (e: any) {
      console.error(
        '[IROS/Reply] generation_failed (orchestrator/memory)',
        e,
      );
      const res = NextResponse.json(
        {
          ok: false,
          error: 'generation_failed',
          detail: e?.message ?? String(e),
          credit: {
            ref: creditRef,
            amount: CREDIT_AMOUNT,
            authorize: authRes,
          },
        },
        { status: 500, headers: CORS_HEADERS },
      );
      res.headers.set('x-credit-ref', creditRef);
      res.headers.set('x-credit-amount', String(CREDIT_AMOUNT));
      if (traceId) res.headers.set('x-trace-id', String(traceId));
      return res;
    }

    // ★ Qスナップショット更新：user_q_now を（I層含めて）追従させる
    try {
      await updateUserQNowFromMeta(supabase, userCode, result?.meta);
    } catch (e) {
      console.error(
        '[IROS/Reply] failed to update user_q_now from meta',
        e,
      );
    }

    // 8.5) Orchestratorの結果を /messages API に保存（assistant + meta）
    //      ＋ UnifiedAnalysis を共通テーブルに保存
    try {
      // assistant の本文を抽出
      const assistantText: string =
        result && typeof result === 'object'
          ? (() => {
              const r: any = result;
              if (
                typeof r.content === 'string' &&
                r.content.trim().length > 0
              )
                return r.content;
              if (typeof r.text === 'string' && r.text.trim().length > 0)
                return r.text;
              // content/text が無い場合は JSON 文字列として保存（デバッグ用）
              return JSON.stringify(r);
            })()
          : String(result ?? '');

      // LLM が返した meta を一度受け取り…
      const metaRaw =
        result &&
        typeof result === 'object' &&
        (result as any).meta
          ? (result as any).meta
          : null;

      // 🔧 Qコードまわりだけいったん無効化してから保存・レスポンスに使う
      const metaForSave =
        metaRaw && typeof metaRaw === 'object'
          ? {
              ...metaRaw,
              qCode: undefined,
              q_code: undefined,
            }
          : metaRaw;

      if (assistantText && assistantText.trim().length > 0) {
        // UnifiedAnalysis を構築して保存（失敗してもチャット自体は続行）
        try {
          const analysis = buildUnifiedAnalysis({
            userText: text,
            assistantText,
            meta: metaForSave,
          });

          await saveUnifiedAnalysisInline(analysis, {
            userCode,
            tenantId,
            agent: 'iros',
          });
        } catch (e) {
          console.error(
            '[IROS/Reply] failed to save unified analysis',
            e,
          );
        }

        // 従来通り /messages API にも保存
        const origin = req.nextUrl.origin;
        const msgUrl = new URL('/api/agent/iros/messages', origin);

        await fetch(msgUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // verifyFirebaseAndAuthorize を通すために認証ヘッダをそのまま引き継ぐ
            Authorization: req.headers.get('authorization') ?? '',
            'x-user-code': userCode,
          },
          body: JSON.stringify({
            conversation_id: conversationId,
            role: 'assistant',
            text: assistantText,
            meta: metaForSave,
          }),
        });
      }
    } catch (e) {
      console.error(
        '[IROS/Reply] failed to persist assistant message or unified analysis',
        e,
      );
    }

    // 9) capture（authorize 成功時のみ実施：credit_capture_safe を内部で実行）
    const capRes = await captureChat(
      req,
      userCode,
      CREDIT_AMOUNT,
      creditRef,
    );

    // 10) meta を統一し、credit情報を付与して返却
    const finalMode =
      result &&
      typeof result === 'object' &&
      typeof (result as any).mode === 'string'
        ? (result as any).mode
        : mode;

    const headers: Record<string, string> = {
      ...CORS_HEADERS,
      'x-handler': 'app/api/agent/iros/reply',
      'x-credit-ref': creditRef,
      'x-credit-amount': String(CREDIT_AMOUNT),
    };
    if (lowWarn) headers['x-warning'] = 'low_balance';

    const basePayload = {
      ok: true,
      mode: finalMode,
      credit: {
        ref: creditRef,
        amount: CREDIT_AMOUNT,
        authorize: authRes,
        capture: capRes,
        ...(lowWarn ? { warning: lowWarn } : {}),
      },
      ...(lowWarn ? { warning: lowWarn } : {}),
    };

    if (result && typeof result === 'object') {
      const meta = {
        ...(result as any).meta ?? {},
        extra: {
          ...(((result as any).meta?.extra) ?? {}),
          userCode: userCode ?? (result as any).meta?.extra?.userCode ?? null,
          hintText: hintText ?? (result as any).meta?.extra?.hintText ?? null,
          traceId: traceId ?? (result as any).meta?.extra?.traceId ?? null,
        },
      };

      console.log('[IROS/Reply] response meta', meta);

      return NextResponse.json(
        { ...basePayload, ...(result as any), meta },
        { status: 200, headers },
      );
    } else {
      console.log('[IROS/Reply] response (string result)', {
        userCode,
        mode: finalMode,
      });

      return NextResponse.json(
        {
          ...basePayload,
          content: result,
          meta: { extra: { userCode, hintText, traceId } },
        },
        { status: 200, headers },
      );
    }
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
