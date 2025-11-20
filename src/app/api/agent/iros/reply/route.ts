// file: src/app/api/agent/iros/reply/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';
import { authorizeChat, captureChat, makeIrosRef } from '@/lib/credits/auto';
import { createClient } from '@supabase/supabase-js';
import { logQFromIros } from '@/lib/q/logFromIros';  // ★ 追加

// ★ 追加：Iros Orchestrator + Memory Adapter
import { runIrosTurn } from '@/lib/iros/orchestrator';
import { loadQTraceForUser, applyQTraceToMeta } from '@/lib/iros/memory.adapter';

/** 共通CORS（/api/me と同等ポリシー + x-credit-cost 追加） */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, x-user-code, x-credit-cost',
} as const;

// 既定：1往復 = 5pt（ENVで上書き可）
const CHAT_CREDIT_AMOUNT = Number(process.env.IROS_CHAT_CREDIT_AMOUNT ?? 5);

// 残高しきい値（ENVで上書き可）
const LOW_BALANCE_THRESHOLD = Number(process.env.IROS_LOW_BALANCE_THRESHOLD ?? 10);

// service-role で現在残高を読むための Supabase クライアント
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

// ★ resolveModeHintFromText を置き換え
function resolveModeHintFromText(input?: {
  modeHint?: string | null;
  hintText?: string | null;
  text?: string | null;
}): 'structured' | 'diagnosis' | 'counsel' | 'auto' {
  const direct = (input?.modeHint ?? '').toLowerCase().trim();
  if (direct === 'structured' || direct === 'diagnosis' || direct === 'counsel') return direct;

  const hint = (input?.hintText ?? '').toLowerCase();
  if (hint.includes('structured')) return 'structured';
  if (hint.includes('diagnosis') || hint.includes('ir診断') || hint.includes('診断')) return 'diagnosis';

  const t = (input?.text ?? '').toLowerCase();

  // ★ 日本語の“構造化/レポート系”キーワードで structured 扱い
  const structuredJa = [
    'レポート形式', 'レポートで', 'レポートを', '構造化', '章立て',
    '箇条書き', '要件をまとめ', '要件整理', '要約して', '表にして',
    '一覧化', '整理して出して', 'レポートとしてまとめ',
  ];
  if (structuredJa.some((k) => t.includes(k))) return 'structured';

  if (t.includes('相談') || t.includes('悩み') || t.includes('困って')) return 'counsel';

  return 'auto';
}

/** auth から最良の userCode を抽出。ヘッダ x-user-code は開発補助として許容 */
function pickUserCode(req: NextRequest, auth: any): string | null {
  const h = req.headers.get('x-user-code');
  const fromHeader = h && h.trim() ? h.trim() : null;
  return (
    (auth?.userCode && String(auth.userCode)) ||
    (auth?.user_code && String(auth.user_code)) ||
    fromHeader ||
    null
  );
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
        { ok: false, error: 'bad_request', detail: 'conversationId and text are required' },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    // 3) mode 推定
    const mode = resolveModeHintFromText({ modeHint: modeHintInput, hintText, text });

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
      traceId,
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
    const CREDIT_AMOUNT = Number.isFinite(parsed) && parsed > 0 ? Number(parsed) : CHAT_CREDIT_AMOUNT;

    console.log('[IROS/Reply] credit', {
      userCode,
      CREDIT_AMOUNT,
    });

    // 6) クレジット参照キー生成（authorize / capture 共通）
    const creditRef = makeIrosRef(conversationId, startedAt);

    // 7) authorize（不足時はここで 402。auto 側で precheck + authorize_simple を実行）
    const authRes = await authorizeChat(req, userCode, CREDIT_AMOUNT, creditRef, conversationId);

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
    let lowWarn: null | { code: 'low_balance'; balance: number; threshold: number } = null;
    if (Number.isFinite(LOW_BALANCE_THRESHOLD) && LOW_BALANCE_THRESHOLD > 0) {
      const { data: balRow, error: balErr } = await supabase
        .from('users')
        .select('sofia_credit')
        .eq('user_code', userCode)
        .maybeSingle();

      if (!balErr && balRow && balRow.sofia_credit != null) {
        const balance = Number(balRow.sofia_credit) || 0;
        if (balance < LOW_BALANCE_THRESHOLD) {
          lowWarn = { code: 'low_balance', balance, threshold: LOW_BALANCE_THRESHOLD };
        }
      }
    }

    // 8) Qコードメモリ読み込み → Orchestrator 呼び出し
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

      console.log('[IROS/Orchestrator] runIrosTurn args', {
        conversationId,
        mode,
        baseMetaFromQ,
      });

      // mode === 'auto' のときは requestedMode は渡さない（オーケストレータ側に任せる）
      const requestedMode = mode === 'auto' ? undefined : (mode as any);

      result = await runIrosTurn({
        conversationId,
        text,
        requestedMode,
        requestedDepth: baseMetaFromQ.depth as any,
        requestedQCode: baseMetaFromQ.qCode as any,
        baseMeta: {
          ...baseMetaFromQ,
          // ここに将来、ユーザー情報などを足す余地あり
        },
      });

      console.log('[IROS/Orchestrator] result.meta', result?.meta);
    } catch (e: any) {
      console.error('[IROS/Reply] generation_failed (orchestrator/memory)', e);
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

    // 9) capture（authorize 成功時のみ実施：credit_capture_safe を内部で実行）
    const capRes = await captureChat(req, userCode, CREDIT_AMOUNT, creditRef);

    // 10) meta を統一し、credit情報を付与して返却
    const finalMode =
      result && typeof result === 'object' && typeof (result as any).mode === 'string'
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
          ...((result as any).meta?.extra ?? {}),
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
      console.log('[IROS/Reply] response (string result)', { userCode, mode: finalMode });

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
      { ok: false, error: 'internal_error', detail: err?.message ?? String(err) },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
