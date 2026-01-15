// src/app/api/agent/iros/reply/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

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
import { renderGatewayAsReply } from '@/lib/iros/language/renderGateway';

import { applyRulebookCompat } from '@/lib/iros/policy/rulebook';
import { persistAssistantMessageToIrosMessages } from '@/lib/iros/server/persistAssistantMessageToIrosMessages';
import { runNormalBase } from '@/lib/iros/conversation/normalBase';
import { loadIrosMemoryState } from '@/lib/iros/memoryState';

// ✅ rephrase
import {
  extractSlotsForRephrase,
  rephraseSlotsFinal,
} from '@/lib/iros/language/rephraseEngine';

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

// =========================================================
// ✅ UI向け「現在のモード」可視化（NORMAL / IR / SILENCE）
// - silenceReason があっても「本文があるなら SILENCE にしない」
// =========================================================
type ReplyUIMode = 'NORMAL' | 'IR' | 'SILENCE';

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
// ✅ helpers: sanitize / level normalize
// =========================================================
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

/**
 * yLevel / hLevel を “整数に統一” する（DBの int と常に一致させる）
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

// =========================================================
// ✅ Context Pack fetcher（LLM注入用）
// - Evidence Logger の ios_context_pack_latest_conv を呼ぶ
// - 失敗しても null を返す（会話を止めない）
// - historyMessages / historyText を pack に混ぜる（rephraseEngine が拾える形）
// =========================================================
function normalizeHistoryMessages(
  raw: any[] | string | null | undefined,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!raw) return [];

  if (typeof raw === 'string') {
    const lines = String(raw)
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(-24);

    return lines.map((s) => ({ role: 'user' as const, content: s })).slice(-12);
  }

  if (!Array.isArray(raw)) return [];

  return raw
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

async function fetchContextPackForLLM(args: {
  supabase: any;
  userCode: string;
  conversationId: string;
  limit?: number;
  historyMessages?: any[] | string | null;
  memoryState?: any | null;
}): Promise<any | null> {
  const { supabase, userCode, conversationId } = args;
  const pLimit = Number.isFinite(args.limit as any) ? Number(args.limit) : 200;

  // ✅ まず「最低限」パックを組む（mismatch時もこれだけは返す）
  const normalized = normalizeHistoryMessages(args.historyMessages ?? null);
  // =========================================================
// ✅ 前ターン(out) → 今ターン(input) 運搬：history の assistant.meta.extra から拾う
// - クライアントが history に meta を含めて送ってくる前提で効く
// - meta が無い場合は null（何もしない）
// =========================================================
function pickPrevFlagFromRawHistory(
  rawHistory: any[] | string | null | undefined,
): { shouldRaiseFlag?: boolean; flagReasons?: string[]; flagSource?: string } | null {
  if (!rawHistory) return null;
  if (typeof rawHistory === 'string') return null; // 文字列履歴には meta が無い

  if (!Array.isArray(rawHistory)) return null;

  for (let i = rawHistory.length - 1; i >= 0; i--) {
    const m = rawHistory[i];
    if (!m) continue;

    const role = String(m?.role ?? m?.speaker ?? '').toLowerCase();
    if (role !== 'assistant' && role !== 'bot' && !role.startsWith('a')) continue;

    const extra =
      m?.meta?.extra ??
      m?.meta_extra ??
      m?.extra ??
      null;

    const on =
      typeof extra?.shouldRaiseFlag === 'boolean'
        ? extra.shouldRaiseFlag
        : typeof extra?.shouldRaiseFlag_out === 'boolean'
          ? extra.shouldRaiseFlag_out
          : null;

    const reasons =
      Array.isArray(extra?.flagReasons)
        ? extra.flagReasons
        : Array.isArray(extra?.flagReasons_out)
          ? extra.flagReasons_out
          : null;

    if (on === true || (Array.isArray(reasons) && reasons.length > 0)) {
      return {
        ...(on === true ? { shouldRaiseFlag: true } : {}),
        ...(reasons && reasons.length ? { flagReasons: reasons.map((x) => String(x ?? '').trim()).filter(Boolean) } : {}),
        flagSource: 'prev_assistant_meta_extra',
      };
    }
  }

  return null;
}

  const historyText = buildHistoryText(normalized);
  const basePack = {
    conversation_id: String(conversationId),
    last_state: (args.memoryState ?? null) ?? null,
    historyMessages: normalized.length ? normalized : undefined,
    historyText: historyText ? historyText : undefined,
  };

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
      // ✅ RPC失敗でも basePack は返す（会話を止めない / 履歴は拾う）
      return basePack;
    }

    const pack = data ?? null;

    // last_state は「引数 memoryState」を最優先（DBメモリを勝たせる）
    const lastStateFixed = (args.memoryState ?? null) ?? (pack as any)?.last_state ?? null;

    const enriched = {
      ...(pack ?? {}),
      conversation_id: (pack as any)?.conversation_id ?? conversationId,
      last_state: lastStateFixed,
      historyMessages: basePack.historyMessages,
      historyText: basePack.historyText,
    };

    console.log('[IROS/CTX_PACK][OK]', {
      userCode,
      conversationId,
      conv: enriched?.conversation_id ?? null,
      counts: enriched?.counts ?? null,
      hasHistoryMessages: Array.isArray(enriched?.historyMessages),
      historyLen: Array.isArray(enriched?.historyMessages)
        ? enriched.historyMessages.length
        : 0,
      hasHistoryText: typeof enriched?.historyText === 'string',
      historyTextLen:
        typeof enriched?.historyText === 'string' ? enriched.historyText.length : 0,
    });

    // ✅ mismatch は「捨てない」：basePack だけ返して継続
    const packConv = String(enriched?.conversation_id ?? '').trim();
    const curConv = String(conversationId ?? '').trim();
    if (packConv && curConv && packConv !== curConv) {
      console.warn('[IROS/CTX_PACK][MISMATCH_FALLBACK]', {
        userCode,
        conversationId: curConv,
        packConversationId: packConv,
      });

      // enriched を丸ごと返すと別会話の evidence が混入する。
      // ここでは「履歴注入の最低限」だけ返す。
      return {
        ...basePack,
        // 監査だけ残す（userContext内で露出しても害が少ない）
        ctxPackMismatch: { packConversationId: packConv, conversationId: curConv },
      };
    }

    return enriched;
  } catch (e: any) {
    console.warn('[IROS/CTX_PACK][EX]', {
      userCode,
      conversationId,
      message: String(e?.message ?? e),
    });
    // ✅ 例外でも basePack は返す（会話を止めない）
    return basePack;
  }
}


// =========================================================
// ✅ rephrase attach (Render-v2向け)
// - renderEngine=true & IT以外 & SILENCE/FORWARD以外
// - slot抽出できた場合のみ、1回だけ LLM に「表現」を貸す
// =========================================================

type FlagDecision = {
  shouldRaiseFlag: boolean;
  reasons: Array<'POSITION_DRIFT' | 'STALL' | 'SAFETY_OK' | 'SAFETY_BAD'>;
  signals: {
    // 1) drift
    hasWhy: boolean;
    hasDontKnow: boolean;
    hasLoopWords: boolean;
    shortText: boolean;

    // 2) stall
    historyLen: number;
    repeatedLike: boolean;

    // 3) safety
    isSilenceLike: boolean;
    highHeat: boolean;

    // context
    q: string | null;
    depth: string | null;
    spinLoop: string | null;
    phase: string | null;
  };
  version: 'flag-v1';
};

function normForSignal(s: string): string {
  return String(s ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * ✅ 旗印判定（メタ判定）
 * - 意味判断はしない
 * - “位置が揺れている / 進行が止まっている / いま刺しても安全” を見るだけ
 */
function inferFlagDecision(args: {
  userText: string;
  historyMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  metaLike?: any;
  memoryState?: any | null;
}): FlagDecision {
  const userText = normForSignal(args.userText);
  const hm = Array.isArray(args.historyMessages) ? args.historyMessages : [];

  const metaLike = args.metaLike ?? {};
  const ms = args.memoryState ?? null;

  const q =
    (typeof metaLike?.unified?.q?.current === 'string' && metaLike.unified.q.current) ||
    (typeof metaLike?.qCode === 'string' && metaLike.qCode) ||
    (typeof metaLike?.q_code === 'string' && metaLike.q_code) ||
    (typeof ms?.q_primary === 'string' && ms.q_primary) ||
    null;

  const depth =
    (typeof metaLike?.unified?.depth?.stage === 'string' && metaLike.unified.depth.stage) ||
    (typeof metaLike?.depthStage === 'string' && metaLike.depthStage) ||
    (typeof metaLike?.depth_stage === 'string' && metaLike.depth_stage) ||
    (typeof metaLike?.depth === 'string' && metaLike.depth) ||
    (typeof ms?.depth_stage === 'string' && ms.depth_stage) ||
    null;

  const spinLoop =
    (typeof metaLike?.spinLoop === 'string' && metaLike.spinLoop) ||
    (typeof metaLike?.spin_loop === 'string' && metaLike.spin_loop) ||
    (typeof ms?.spin_loop === 'string' && ms.spin_loop) ||
    null;

  const phase =
    (typeof metaLike?.phase === 'string' && metaLike.phase) ||
    (typeof metaLike?.unified?.phase === 'string' && metaLike.unified.phase) ||
    (typeof ms?.phase === 'string' && ms.phase) ||
    null;

  // ---------------------------
  // 1) Position Drift
  // ---------------------------
  const hasWhy = /なんで|なぜ|理由|意味|どうして/.test(userText);
  const hasDontKnow = /わからない|分からない|どうしたら|どうすれば|どうすんの/.test(userText);
  const hasLoopWords = /同じ|また|さっき|ループ|変わらない|もう一回/.test(userText);
  const shortText = userText.replace(/\s+/g, '').length <= 12;

  const positionDrift = hasWhy || hasDontKnow || hasLoopWords || shortText;

  // ---------------------------
  // 2) Stall（進行停滞のシグナル）
  // - “同じ種類のユーザー文が続く” を簡易に見る
  // ---------------------------
  const historyLen = hm.length;

  const lastUserLines = hm
    .filter((m) => m.role === 'user')
    .slice(-4)
    .map((m) => normForSignal(m.content))
    .filter(Boolean);

  const tail2 = lastUserLines.slice(-2);
  const repeatedLike =
    tail2.length === 2 &&
    tail2[0].length > 0 &&
    tail2[1].length > 0 &&
    (tail2[0] === tail2[1] ||
      (tail2[0].length >= 8 &&
        tail2[1].length >= 8 &&
        (tail2[0].includes(tail2[1]) || tail2[1].includes(tail2[0]))));

  const stall = hasLoopWords || repeatedLike || historyLen >= 8;

  // ---------------------------
  // 3) Safety（いま刺しても受け取れるか）
  // - 強い怒り/罵倒/攻撃が強いときは “旗印” を控える（圧になる）
  // - SILENCE っぽい（空）も控える
  // ---------------------------
  const isSilenceLike = userText.length === 0 || isEffectivelyEmptyText(userText);
  const highHeat =
    /死ね|消えろ|ふざけるな|最悪|クソ|殺す|ぶっ殺/.test(userText) ||
    /!{3,}|！{3,}/.test(userText);

  const safetyOk = !isSilenceLike && !highHeat;

  const reasons: FlagDecision['reasons'] = [];
  if (positionDrift) reasons.push('POSITION_DRIFT');
  if (stall) reasons.push('STALL');
  reasons.push(safetyOk ? 'SAFETY_OK' : 'SAFETY_BAD');

// ✅ 旗印介入：安全なら「停滞」または「位置揺れ」があれば raise
// - STALL 単体でも介入する（現状ログのズレを解消）
const shouldRaiseFlag = Boolean(safetyOk && (stall || positionDrift));


  return {
    shouldRaiseFlag,
    reasons,
    signals: {
      hasWhy,
      hasDontKnow,
      hasLoopWords,
      shortText,
      historyLen,
      repeatedLike,
      isSilenceLike,
      highHeat,
      q,
      depth,
      spinLoop,
      phase,
    },
    version: 'flag-v1',
  };
}

async function maybeAttachRephraseForRenderV2(args: {
  supabase: any;
  conversationId: string;
  userCode: string;
  meta: any;
  extraMerged: Record<string, any>;
  userText: string;
  historyMessages?: any[] | string | null;
  memoryStateForCtx?: any | null;
  traceId?: string | null;
  reqId?: string | null;
}) {
  const {
    supabase,
    conversationId,
    userCode,
    meta,
    extraMerged,
    userText,
    historyMessages,
    memoryStateForCtx,
    traceId,
    reqId,
  } = args;

  // idempotent guard
  {
    const already =
      Array.isArray((extraMerged as any)?.rephraseBlocks) &&
      (extraMerged as any).rephraseBlocks.length > 0;

    const reqKey = `${reqId ?? 'no-reqId'}|${traceId ?? 'no-traceId'}|${conversationId}|${userCode}`;
    const g = globalThis as any;
    g.__IROS_REPHRASE_CALLCOUNT = g.__IROS_REPHRASE_CALLCOUNT ?? new Map();

    // ✅ leak防止：Mapが増えすぎたら古いものから間引く（順序は保証されないので簡易）
    if (g.__IROS_REPHRASE_CALLCOUNT.size > 2000) {
      let dropped = 0;
      for (const k of g.__IROS_REPHRASE_CALLCOUNT.keys()) {
        g.__IROS_REPHRASE_CALLCOUNT.delete(k);
        dropped++;
        if (dropped >= 500) break;
      }
      console.warn('[IROS/rephrase][CALLCOUNT_PRUNE]', {
        conversationId,
        userCode,
        sizeAfter: g.__IROS_REPHRASE_CALLCOUNT.size,
        dropped,
      });
    }

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

  const enabled = String(process.env.IROS_REPHRASE_FINAL_ENABLED ?? '1').trim() !== '0';
  if (!enabled) return;
  if ((extraMerged as any)?.renderEngine !== true) return;

  const hintedRenderMode =
    (typeof meta?.renderMode === 'string' && meta.renderMode) ||
    (typeof meta?.extra?.renderMode === 'string' && meta.extra.renderMode) ||
    (typeof meta?.extra?.renderedMode === 'string' && meta.extra.renderedMode) ||
    '';
  if (String(hintedRenderMode).toUpperCase() === 'IT') return;

  const speechAct = String(meta?.extra?.speechAct ?? meta?.speechAct ?? '').toUpperCase();
  if (speechAct === 'SILENCE' || speechAct === 'FORWARD') return;

  const extraForRender = {
    ...(meta?.extra ?? {}),
    ...(extraMerged ?? {}),

    // ✅ renderGateway が参照できる “確定値” をここで一本化して載せる
    slotPlanPolicy:
      (meta as any)?.framePlan?.slotPlanPolicy ??
      (meta as any)?.slotPlanPolicy ??
      (meta as any)?.extra?.slotPlanPolicy ??
      null,

    framePlan: (meta as any)?.framePlan ?? null,
    slotPlan: (meta as any)?.slotPlan ?? null,
  };

  const extracted = extractSlotsForRephrase(extraForRender);
  if (!extracted?.slots?.length) return;

  const model = process.env.IROS_REPHRASE_MODEL ?? process.env.IROS_MODEL ?? 'gpt-4.1';

  const traceIdFinal =
    traceId && String(traceId).trim() ? String(traceId).trim() : reqId ?? null;

  // =========================================================
  // ✅ ここが今回の1点目：normalizedHistory をこの関数内で必ず作る
  // - ContextPack fetch / inferFlagDecision が参照しているので必須
  // =========================================================
  const normalizedHistory = normalizeHistoryMessages(historyMessages ?? null);

  // =========================================================
  // ✅ ここが今回の2点目：前ターン(out)を raw history から拾って input(userContext) に運ぶ
  // - historyMessages が string の場合は拾えない（null）
  // - 配線が効く条件：クライアント/サーバが history に assistant.meta.extra を含めて渡していること
  // =========================================================
  const pickPrevFlagFromRawHistory = (
    rawHistory: any[] | string | null | undefined,
  ): { shouldRaiseFlag?: boolean; flagReasons?: string[]; flagSource?: string } | null => {
    if (!rawHistory) return null;
    if (typeof rawHistory === 'string') return null;
    if (!Array.isArray(rawHistory)) return null;

    for (let i = rawHistory.length - 1; i >= 0; i--) {
      const m = rawHistory[i];
      if (!m) continue;

      const role = String(m?.role ?? m?.speaker ?? '').toLowerCase();
      if (role !== 'assistant' && role !== 'bot' && !role.startsWith('a')) continue;

      const extra =
        m?.meta?.extra ??
        m?.meta_extra ??
        m?.extra ??
        null;

      const on =
        typeof extra?.shouldRaiseFlag === 'boolean'
          ? extra.shouldRaiseFlag
          : typeof extra?.shouldRaiseFlag_out === 'boolean'
            ? extra.shouldRaiseFlag_out
            : null;

      const reasons =
        Array.isArray(extra?.flagReasons)
          ? extra.flagReasons
          : Array.isArray(extra?.flagReasons_out)
            ? extra.flagReasons_out
            : null;

      const rs = Array.isArray(reasons)
        ? reasons.map((x: any) => String(x ?? '').trim()).filter(Boolean)
        : null;

      if (on === true || (rs && rs.length > 0)) {
        return {
          ...(on === true ? { shouldRaiseFlag: true } : {}),
          ...(rs && rs.length ? { flagReasons: rs } : {}),
          flagSource: 'prev_assistant_meta_extra',
        };
      }
    }
    return null;
  };

  const prevFlagCarry = pickPrevFlagFromRawHistory(historyMessages ?? null);

  // ✅ ContextPack fetch
  const contextPack = await fetchContextPackForLLM({
    supabase,
    userCode,
    conversationId,
    limit: 200,
    historyMessages: normalizedHistory,
    memoryState: memoryStateForCtx ?? null,
  });

  // ✅ 旗印判定（メタ判定）を作成して userContext に混ぜる
  const flagDecision = inferFlagDecision({
    userText: userText ?? '',
    historyMessages: normalizedHistory,
    metaLike: meta ?? null,
    memoryState: memoryStateForCtx ?? null,
  });

  // audit
  meta.extra = {
    ...(meta.extra ?? {}),
    hasContextPackForLLM: !!contextPack,
    contextPackCounts: contextPack?.counts ?? null,
    contextPackLastState: contextPack?.last_state ?? null,

    // ✅ flag audit（signals由来）
    flagDecision,
    shouldRaiseFlag: flagDecision.shouldRaiseFlag,

    // ✅ 次ターン input 用の運搬が入ったか（デバッグ）
    prevFlagCarry: prevFlagCarry ?? null,
  };

  // ✅ attach to extraMerged.userContext (merge; do not overwrite)
  const baseUserContext =
    typeof (extraMerged as any)?.userContext === 'object'
      ? ((extraMerged as any).userContext ?? {})
      : {};

  // ✅ 前ターン(out)を meta.extra に注入（次ターンで readShouldRaiseFlagFromContext が拾える形）
  const baseMeta = typeof (baseUserContext as any)?.meta === 'object' ? (baseUserContext as any).meta : {};
  const baseExtra = typeof (baseMeta as any)?.extra === 'object' ? (baseMeta as any).extra : {};

  const mergedUserContext = {
    ...baseUserContext,
    ...(contextPack ?? {}),
    flagDecision,

    ...(prevFlagCarry
      ? {
          meta: {
            ...baseMeta,
            extra: {
              ...baseExtra,
              ...(prevFlagCarry.shouldRaiseFlag === true ? { shouldRaiseFlag: true } : {}),
              ...(Array.isArray(prevFlagCarry.flagReasons) && prevFlagCarry.flagReasons.length
                ? { flagReasons: prevFlagCarry.flagReasons }
                : {}),
              ...(prevFlagCarry.flagSource ? { flagSource: prevFlagCarry.flagSource } : {}),
            },
          },
        }
      : {}),
  };

  (extraMerged as any).userContext = mergedUserContext;

  meta.extra = {
    ...(meta.extra ?? {}),
    userContextInjected: true,
    userContextInjectedKeys: mergedUserContext ? Object.keys(mergedUserContext) : null,
  };

  const res = await rephraseSlotsFinal(extracted, {
    model,
    temperature: 0.2,
    maxLinesHint: Number.isFinite(Number(process.env.IROS_RENDER_DEFAULT_MAXLINES))
      ? Number(process.env.IROS_RENDER_DEFAULT_MAXLINES)
      : 8,
    userText: userText ?? null,
    userContext: mergedUserContext ?? null,
    debug: {
      traceId: traceIdFinal ?? null,
      conversationId: conversationId ?? null,
      userCode: userCode ?? null,
      renderEngine: true,
    },
  });
  // =========================================================
  // ✅ 介入（このターンで発火させる）
  // - flagDecision が POSITION_DRIFT / STALL を立てたら
  //   LLM生成に行かず “seed（slotPlan）へ戻す”
  // - これで「崩れ検出が生成に反映されない」問題が消える
  // =========================================================
  if (flagDecision?.shouldRaiseFlag === true) {
    // ✅ seed(raw slot) を renderGateway に渡すと "@OBS ..." が剥がれて空になりやすい。
    // なので「このターンに出す短文」を確定で1つ作る（=落ちない）
    const safeText =
      `今日はここまででOK。\n` +
`いま残ってるのは「${String(userText ?? '').slice(0, 40)}」という感触。\n` +
      `次は “どこが一番変わってないと感じるか” だけ、1点だけ拾えば続きが動く。`;

    // ✅ renderGateway は rephraseBlocks を優先して拾うので、ここに「文章」を入れる
    (extraMerged as any).rephraseBlocks = [{ text: safeText }];

    // ✅ 監査ログ（DB meta.extra）にも刻む
    meta.extra = {
      ...(meta.extra ?? {}),
      rephraseApplied: true,
      rephraseModel: '(raise-to-seed)',
      shouldRaiseFlag: true,
      flagDecision,
      flagIntervene: { kind: 'RAISE_TO_SAFE_TEXT', source: 'flagDecision' },
    };

    console.warn('[IROS/FLAGSHIP][RAISE_TO_SEED]', {
      conversationId,
      userCode,
      reasons: Array.isArray(flagDecision?.reasons) ? flagDecision.reasons : [],
    });

    return;
  }



  // =========================================================
  // ✅ rephrase 結果の「崩れ検出（flagshipGuard側）」を確定値として回収
  // - flagDecision（signals由来）とは別系統
  // - 次ターンで拾えるように meta.extra / userContext の両方へ同期
  // =========================================================
  const pickBool = (...vals: any[]): boolean | null => {
    for (const v of vals) {
      if (typeof v === 'boolean') return v;
    }
    return null;
  };

  const pickReasons = (...vals: any[]): string[] | null => {
    for (const v of vals) {
      if (Array.isArray(v)) {
        const xs = v.map((x) => String(x ?? '').trim()).filter(Boolean);
        if (xs.length) return xs;
      }
    }
    return null;
  };

  // rephrase(=flagshipGuard) の “出力側” を最優先で拾う
  const shouldRaiseFlag_out =
    pickBool(
      (res as any)?.shouldRaiseFlag,
      (res as any)?.meta?.shouldRaiseFlag,
      (res as any)?.meta?.extra?.shouldRaiseFlag,
      (res as any)?.meta?.flag?.shouldRaiseFlag,
      (res as any)?.meta?.flags?.shouldRaiseFlag,
    ) ?? null;

  const flagReasons_out =
    pickReasons(
      (res as any)?.flagReasons,
      (res as any)?.meta?.flagReasons,
      (res as any)?.meta?.extra?.flagReasons,
      (res as any)?.meta?.flag?.reasons,
      (res as any)?.meta?.flags?.reasons,
    ) ?? null;

  if (!res.ok) {
    console.warn('[IROS/rephrase][SKIP]', {
      conversationId,
      userCode,
      reason: res.reason,
      inKeys: res.meta?.inKeys ?? [],
      rawLen: res.meta?.rawLen ?? 0,
      rawHead: res.meta?.rawHead ?? '',
      // signals由来（入力側の暫定判定）
      shouldRaiseFlag: flagDecision.shouldRaiseFlag,
      flagReasons: flagDecision.reasons,
      // rephrase(出力側) 由来（拾えた場合）
      shouldRaiseFlag_out,
      flagReasons_out,
    });

    // ✅ “失敗ターン”でも out が拾えていたら meta.extra にだけ残す（次ターン拾いの保険）
    if (shouldRaiseFlag_out != null || (flagReasons_out && flagReasons_out.length > 0)) {
      meta.extra = {
        ...(meta.extra ?? {}),
        shouldRaiseFlag_out: shouldRaiseFlag_out ?? undefined,
        flagReasons_out: flagReasons_out ?? undefined,
        flagSource: 'rephrase_meta',
        flagOutCapturedEvenWhenSkip: true,
      };
    }

    return;
  }

  // attach
  (extraMerged as any).rephraseBlocks = res.slots.map((s) => ({ text: s.text }));

  // ✅ ここが “配線の本体”
  const flagOut = {
    shouldRaiseFlag: shouldRaiseFlag_out,
    flagReasons: flagReasons_out,
    source: 'rephrase_meta' as const,
  };

  meta.extra = {
    ...(meta.extra ?? {}),
    rephraseApplied: true,
    rephraseModel: model,
    rephraseKeys: res.meta.outKeys,
    rephraseRawLen: res.meta.rawLen,
    rephraseRawHead: res.meta.rawHead,

    // ✅ signals由来（入力側）も残す：比較用
    flagDecision,
    shouldRaiseFlag: flagDecision.shouldRaiseFlag,

    // ✅ rephrase由来（出力側）を保持
    shouldRaiseFlag_out: shouldRaiseFlag_out ?? undefined,
    flagReasons_out: flagReasons_out ?? undefined,
    flagOut,
  };

  // ✅ 次の rephrase 入力で拾える形に寄せる（meta.extra 経由）
  (extraMerged as any).userContext = {
    ...(mergedUserContext ?? {}),
    meta: {
      ...(typeof (mergedUserContext as any)?.meta === 'object'
        ? ((mergedUserContext as any).meta ?? {})
        : {}),
      extra: {
        ...(typeof (mergedUserContext as any)?.meta?.extra === 'object'
          ? ((mergedUserContext as any).meta.extra ?? {})
          : {}),
        // ✅ 次ターン用の“運搬データ”
        ...(shouldRaiseFlag_out === true ? { shouldRaiseFlag: true } : {}),
        ...(flagReasons_out && flagReasons_out.length ? { flagReasons: flagReasons_out } : {}),
        flagSource: 'rephrase_meta',
      },
    },
  };

  console.warn('[IROS/rephrase][OK]', {
    conversationId,
    userCode,
    keys: res.meta.outKeys,
    rawLen: res.meta.rawLen,
    rawHead: res.meta.rawHead,
    // signals（入力側）
    shouldRaiseFlag: flagDecision.shouldRaiseFlag,
    flagReasons: flagDecision.reasons,
    // rephrase（出力側）
    shouldRaiseFlag_out,
    flagReasons_out,
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
    // rephrase（出力側）を明示
    shouldRaiseFlag_out,
    flagReasons_out,
  });
}



/** NORMAL / IR / SILENCE の OPTIONS */
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
      Number.isFinite(parsed) && parsed > 0 ? Number(parsed) : CHAT_CREDIT_AMOUNT;

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
          lowWarn = { code: 'low_balance', balance, threshold: LOW_BALANCE_THRESHOLD };
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

    // --- NextStep: ボタン押下タグの除去（保険） ---
    const rawText = String(text ?? '');
    const extracted = extractNextStepChoiceFromText(rawText);

    const choiceIdFromExtra =
      extra && typeof (extra as any).choiceId === 'string'
        ? String((extra as any).choiceId).trim()
        : null;

    const extractedChoiceId =
      extracted?.choiceId && String(extracted.choiceId).trim().length > 0
        ? String(extracted.choiceId).trim()
        : null;

    const effectiveChoiceId = choiceIdFromExtra || extractedChoiceId || null;

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
    // ✅ route.ts 側の IT強制を完全停止（extra を sanitize）
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
      choiceId: effectiveChoiceId,
      extractedChoiceId,
    };

    // ✅ origin
    const reqOrigin =
      req.headers.get('origin') ??
      req.headers.get('x-forwarded-origin') ??
      req.nextUrl?.origin ??
      '';

// =========================================================
// ✅ RenderEngine gate（single source）を handleIrosReply の「前」で確定する
// =========================================================
{
  const extraIn = extraMerged ?? {};
  const envAllows = process.env.IROS_ENABLE_RENDER_ENGINE === '1';

  // ✅ 入力側が「明示 false」で落としたい場合だけ落とす（true/undefined は許可）
  const extraRenderEngineIn =
    (extraIn as any).renderEngineGate === true ||
    (extraIn as any).renderEngine === true ||
    undefined;

  const enableRenderEngine =
    envAllows && (extraIn as any).renderEngine !== false && (extraIn as any).renderEngineGate !== false;

  // ✅ 観測用：gate と renderEngine を必ず同値で同期して書く
  extraMerged = {
    ...extraIn,
    renderEngineGate: enableRenderEngine,
    renderEngine: enableRenderEngine,
  };

  console.log('[IROS/Reply] renderEngine gate (PRE-HANDLE)', {
    conversationId,
    userCode,
    enableRenderEngine,
    envAllows: process.env.IROS_ENABLE_RENDER_ENGINE ?? null,
    extraRenderEngineIn,
    extraKeys: Object.keys(extraMerged ?? {}),
  });
}


    // =========================================================
    // ✅ persist gate（single source）を handleIrosReply の「前」で確定する
    // =========================================================
    {
      extraMerged = {
        ...extraMerged,
        persistedByRoute: true,
        persistAssistantMessage: false,
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
      hintText,
      mode,

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
    // =========================================================
    if (irosResult.ok) {
      const r: any = irosResult as any;

      const metaAny = r?.metaForSave ?? r?.meta ?? {};
      const extraAny = metaAny?.extra ?? {};

      const speechAct = extraAny?.speechAct ?? metaAny?.speechAct ?? null;
      const allowLLM = extraAny?.speechAllowLLM ?? metaAny?.speechAllowLLM ?? true;
      const candidateText = String(r?.assistantText ?? r?.content ?? '').trim();

      const isSilenceOrForward = speechAct === 'SILENCE' || speechAct === 'FORWARD';
      const isEmptyLike = isEffectivelyEmptyText(candidateText);

      const hasSlotsDetected =
        typeof extraAny?.hasSlots_detected === 'boolean'
          ? extraAny.hasSlots_detected
          : null;

      const slotPlanLenDetected =
        typeof extraAny?.slotPlanLen_detected === 'number' &&
        Number.isFinite(extraAny.slotPlanLen_detected)
          ? extraAny.slotPlanLen_detected
          : null;

      const hasSlotsFromMeta =
        (metaAny?.framePlan &&
          Object.prototype.hasOwnProperty.call(metaAny.framePlan, 'slots')) ||
        (extraAny?.framePlan &&
          Object.prototype.hasOwnProperty.call(extraAny.framePlan, 'slots'));

      const slotLenFromMeta = Math.max(
        Array.isArray(metaAny?.framePlan?.slots) ? metaAny.framePlan.slots.length : 0,
        Array.isArray(extraAny?.framePlan?.slots) ? extraAny.framePlan.slots.length : 0,
      );

      const slotPlanExpected =
        (hasSlotsDetected ?? hasSlotsFromMeta) === true ||
        (slotPlanLenDetected ?? slotLenFromMeta) > 0;

      const isNonSilenceButEmpty =
        !isSilenceOrForward &&
        allowLLM !== false &&
        String(userTextClean ?? '').trim().length > 0 &&
        isEmptyLike;

      const hasAnySlotsSignal =
        Boolean(slotPlanExpected) ||
        Boolean(hasSlotsDetected) ||
        Boolean(hasSlotsFromMeta) ||
        Number(slotPlanLenDetected ?? 0) > 0 ||
        Number(slotLenFromMeta ?? 0) > 0;

      if (isNonSilenceButEmpty && hasAnySlotsSignal) {
        console.log('[IROS/Reply] NORMAL_BASE_FALLBACK_SKIPPED__SLOTS_PRESENT', {
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
        });
      } else if (isNonSilenceButEmpty) {
        console.log('[IROS/Reply] NORMAL_BASE_FALLBACK_APPLIED', {
          conversationId,
          userCode,
          speechAct,
          allowLLM,
          isEmptyLike,
          candidateTextHead: String(candidateText ?? '').slice(0, 80),
        });

        const normal = await runNormalBase({ userText: userTextClean });

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

      // snapshot
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
          credit: { ref: creditRef, amount: CREDIT_AMOUNT, authorize: authRes },
        },
        { status: 500, headers },
      );
    }

    // ★ assistantText は後から補正するので let にする
    let { result, finalMode, metaForSave, assistantText } = irosResult as any;

    // =========================================================
    // ✅ SpeechPolicy: SILENCE/FORWARD は “ここで即 return”
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

        const capRes = await captureChat(req, userCode, CREDIT_AMOUNT, creditRef);

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

    // ✅ 本文を拾う（確定前の irosResult.content は優先しない）
    {
      const pickText = (...vals: any[]) => {
        for (const v of vals) {
          const s = typeof v === 'string' ? v : String(v ?? '');
          const t = s.replace(/\r\n/g, '\n').trimEnd();
          if (t.length > 0) return t;
        }
        return '';
      };

      const r: any = result;

      if (r && typeof r === 'object') {
        assistantText = pickText(r.assistantText, r.content, r.text, assistantText);
        r.assistantText = assistantText;
      } else {
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

    // 9) capture
    const capRes = await captureChat(req, userCode, CREDIT_AMOUNT, creditRef);

    // 10) headers
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

    // === レスポンス生成 & 訓練サンプル保存 ===
    if (result && typeof result === 'object') {
      // meta を組み立てる（metaForSave を優先）
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

          hintText: hintText ?? (metaForSave as any)?.extra?.hintText ?? null,
          traceId: traceId ?? (metaForSave as any)?.extra?.traceId ?? null,
          historyLen: Array.isArray(chatHistory) ? chatHistory.length : 0,

          choiceId: extraMerged.choiceId ?? null,
          extractedChoiceId: extraMerged.extractedChoiceId ?? null,
        },
      };

      // qTrace は metaForSave の確定値を勝たせる
      meta = finalizeQTrace(meta, metaForSave);

      // ✅ FINAL SYNC: assistantText が空なら content を採用
      {
        const contentRaw = String((result as any)?.content ?? '');
        const assistantRaw = String((result as any)?.assistantText ?? '');
        if (contentRaw.trim().length > 0 && assistantRaw.trim().length === 0) {
          (result as any).assistantText = contentRaw;
        }
      }

      // ★ content は handleIrosReply の assistantText を正にする
      if (typeof assistantText === 'string') {
        const at = assistantText.trim();
        if (at.length > 0) (result as any).content = at;
      }

// ✅ renderEngineGate を「確定値」で観測する（このスコープで存在するものだけ使う）
const renderEngineGateFinal =
  (result as any)?.meta?.extra?.renderEngineGate === true ||
  (result as any)?.meta?.extra?.renderEngine === true ||
  (meta as any)?.extra?.renderEngineGate === true ||
  (meta as any)?.extra?.renderEngine === true ||
  false;

console.log('[IROS/Reply][after-handle]', {
  hasContent: typeof (result as any)?.content === 'string',
  hasAssistantText: typeof (result as any)?.assistantText === 'string',
  contentLen: String((result as any)?.content ?? '').length,
  assistantTextLen: String((result as any)?.assistantText ?? '').length,

  // ✅ “最終判定”
  renderEngineGate: renderEngineGateFinal,

  // ✅ どこに入ってるか確認（後で消してOK）
  gate_from_result_meta: (result as any)?.meta?.extra?.renderEngineGate ?? null,
  gate_from_meta: (meta as any)?.extra?.renderEngineGate ?? null,
  renderEngine_from_result_meta: (result as any)?.meta?.extra?.renderEngine ?? null,
  renderEngine_from_meta: (meta as any)?.extra?.renderEngine ?? null,
});


      // =========================================================
      // ★ 三軸「次の一歩」オプションを meta に付与
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
              : null;

      (meta as any).situationTopic = rawSituationTopic ?? 'その他・ライフ全般';
      (meta as any).situation_topic = (meta as any).situationTopic;

      // ★ target_kind を確実に付与
      const rawTargetKind =
        typeof meta.targetKind === 'string' && meta.targetKind.trim().length > 0
          ? meta.targetKind.trim()
          : typeof meta.target_kind === 'string' && meta.target_kind.trim().length > 0
            ? meta.target_kind.trim()
            : typeof (meta as any)?.goal?.kind === 'string' &&
                (meta as any).goal.kind.trim().length > 0
              ? (meta as any).goal.kind.trim()
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

      // ★ y/h 整数化
      meta = normalizeMetaLevels(meta);

      // =========================================================
      // ✅ rephrase (render-v2向け) を “render適用前” に 1回だけ仕込む
      // - memoryState を last_state 補正ソースとして渡す
      // =========================================================
      let memoryStateForCtx: any | null = null;
      try {
        memoryStateForCtx = await loadIrosMemoryState(supabase as any, userCode);
      } catch (e: any) {
        console.warn('[IROS/rephrase][MEMORYSTATE_LOAD_ERR]', {
          conversationId,
          userCode,
          message: String(e?.message ?? e),
        });
        memoryStateForCtx = null;
      }

      await maybeAttachRephraseForRenderV2({
        supabase,
        conversationId,
        userCode,
        meta,
        userText: userTextClean,
        extraMerged,
        historyMessages: Array.isArray(chatHistory) ? (chatHistory as any) : null,
        memoryStateForCtx,
        traceId,
        reqId,
      });

      // =========================================================
      // ✅ RenderEngine の適用（適用箇所をここで固定）
      // =========================================================
      const effectiveStyle =
        typeof styleInput === 'string' && styleInput.trim().length > 0
          ? styleInput
          : typeof meta?.style === 'string' && meta.style.trim().length > 0
            ? meta.style
            : typeof meta?.userProfile?.style === 'string' &&
                meta.userProfile.style.trim().length > 0
              ? meta.userProfile.style
              : typeof userProfile?.style === 'string' && userProfile.style.trim().length > 0
                ? userProfile.style
                : null;

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

      // ✅ FINAL sanitize: 最終本文から見出し除去
      {
        const before = String((result as any)?.content ?? '');
        const sanitized = sanitizeFinalContent(before);
        const next = sanitized.text.trimEnd();
        (result as any).content = next.length > 0 ? next : '';
        meta.extra = {
          ...(meta.extra ?? {}),
          finalHeaderStripped: sanitized.removed.length > 0 ? sanitized.removed : null,
        };
      }

      // =========================================================
      // ✅ FINAL本文の確定（UIに出すもの＝保存するもの）
      // =========================================================
      {
        const curRaw = String((result as any)?.content ?? '');
        const curTrim = curRaw.trim();

        const speechAct = String(
          meta?.extra?.speechAct ?? meta?.speechAct ?? '',
        ).toUpperCase();

        const silenceReason = pickSilenceReason(meta);
        const isSilent = speechAct === 'SILENCE' && isEffectivelyEmptyText(curTrim);
        const finalText = isSilent ? '' : isEffectivelyEmptyText(curTrim) ? '' : curRaw.trimEnd();

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
          emptyFinalPatched:
            meta?.extra?.emptyFinalPatched ?? (finalText.length === 0 ? true : undefined),
          emptyFinalPatchedReason:
            meta?.extra?.emptyFinalPatchedReason ??
            (finalText.length === 0
              ? isSilent
                ? (silenceReason ? `SILENCE:${silenceReason}` : 'SILENCE_EMPTY_BODY')
                : 'NON_SILENCE_EMPTY_CONTENT'
              : undefined),
          uiModePeek: isSilent ? 'SILENCE' : 'NORMAL',
          uiModePeekReason: isSilent ? silenceReason : null,
          finalTextHead: finalText.length > 0 ? finalText.slice(0, 64) : '',
        };
      }

      // =========================================================
      // ✅ UI MODE をここで確定（可視化の単一ソース）
      // =========================================================
      {
        const finalTextRaw = String((result as any)?.content ?? '');
        const finalText = finalTextRaw.trim();

        const uiMode = inferUIMode({
          modeHint: mode,
          effectiveMode,
          meta,
          finalText,
        });

        const uiReason = inferUIModeReason({
          modeHint: mode,
          effectiveMode,
          meta,
          finalText,
        });

        meta.mode = uiMode;
        meta.modeReason = uiReason;
        meta.persistPolicy = PERSIST_POLICY;

        meta.extra = {
          ...(meta.extra ?? {}),
          uiMode,
          uiModeReason: uiReason,
          persistPolicy: PERSIST_POLICY,
          uiFinalTextLen: finalText.length,
          uiFinalTextHead: finalText.length > 0 ? finalText.slice(0, 64) : '',
        };
      }

      // =========================================================
      // ✅ assistant 保存（single-writer）
      // =========================================================
      let persistedAssistantMessage: any = null;
      try {
        const silenceReason = pickSilenceReason(meta);
        const finalAssistant = String((result as any)?.content ?? '').trim();
        (result as any).assistantText = finalAssistant;

        const uiMode = (meta as any)?.mode as ReplyUIMode | undefined;

// ✅ persist 用に q_code / depth_stage を snake_case に同期
// - unified を最優先（meta は古い値が混ざることがあるため）
// - 空文字は null 扱い
const pickString = (v: any): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
};

const qCodeFinal =
  pickString((meta as any)?.unified?.q?.code) ??
  pickString((meta as any)?.unified?.q?.current) ??
  pickString((meta as any)?.q_code) ??
  pickString((meta as any)?.qCode) ??
  null;

const depthStageFinal =
  pickString((meta as any)?.unified?.depth?.stage) ??
  pickString((meta as any)?.depth_stage) ??
  pickString((meta as any)?.depthStage) ??
  pickString((meta as any)?.depth) ??
  null;

(meta as any).q_code = qCodeFinal;
(meta as any).depth_stage = depthStageFinal;
if (qCodeFinal) (meta as any).qCode = qCodeFinal;
if (depthStageFinal) (meta as any).depthStage = depthStageFinal;

        console.log('[IROS/reply][persist-assistant] q/depth final', {
          conversationId,
          userCode,
          qCodeFinal,
          depthStageFinal,
          meta_depth_stage: (meta as any)?.depth_stage ?? null,
          meta_depth: (meta as any)?.depth ?? null,
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

          meta.extra = { ...(meta.extra ?? {}), persistedAssistantMessage };

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

          meta.extra = { ...(meta.extra ?? {}), persistedAssistantMessage };

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
        meta.extra = { ...(meta.extra ?? {}), persistedAssistantMessage };
      }

      // =========================================================
      // ✅ training sample
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

      return NextResponse.json(
        {
          ...resultObj,
          ...basePayload,
          mode: effectiveMode,
          meta,
        },
        { status: 200, headers },
      );
    }

    // result が文字列等だった場合
    console.log('[IROS/Reply] response (string result)', {
      userCode,
      mode: effectiveMode,
    });

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
        modeHint: mode,
        effectiveMode,
        meta: metaString,
        finalText,
      });

      const uiReason = inferUIModeReason({
        modeHint: mode,
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
      { ...basePayload, content: result, meta: metaString },
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

// =========================================================
// ✅ RenderEngine 適用（single entry）
// - enableRenderEngine=true の場合は render-v2 (renderGatewayAsReply)
// - IT の場合のみ renderReply を維持
// =========================================================
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
  const enableRenderEngine = extraForHandle.renderEngine === true;

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

  // ✅ v2: enableRenderEngine=true の場合は renderV2(format-only) を使う
  if (enableRenderEngine && !isIT) {
    try {
      const extraForRender = {
        ...(meta?.extra ?? {}),
        ...(extraForHandle ?? {}),

        // ✅ renderGateway が参照できる“確定値”を一本化
        slotPlanPolicy:
          (meta as any)?.framePlan?.slotPlanPolicy ??
          (meta as any)?.slotPlanPolicy ??
          (meta as any)?.extra?.slotPlanPolicy ??
          null,

        framePlan: (meta as any)?.framePlan ?? null,
        slotPlan: (meta as any)?.slotPlan ?? null,
      };



      // ✅ EvidenceLogger 用の最小パック
      {
        const ms = (extraForHandle as any)?.memoryState ?? (meta as any)?.memoryState ?? null;

        const shortSummary =
          (ms?.situation_summary ??
            ms?.situationSummary ??
            ms?.summary ??
            (meta as any)?.situationSummary ??
            null) as string | null;

        const topic =
          (ms?.situation_topic ?? ms?.situationTopic ?? (meta as any)?.situationTopic ?? null) as
            | string
            | null;

        (extraForRender as any).conversationId = conversationId;
        (extraForRender as any).userCode = userCode;
        (extraForRender as any).userText = typeof userText === 'string' ? userText : null;
        (extraForRender as any).ctxPack = {
          shortSummary: typeof shortSummary === 'string' ? shortSummary : null,
          topic: typeof topic === 'string' ? topic : null,
          lastUser: null,
          lastAssistant: null,
        };
      }

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
  if (!isIT) return { meta, extraForHandle };

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
