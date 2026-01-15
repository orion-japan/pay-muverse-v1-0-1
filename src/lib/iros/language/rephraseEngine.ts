// src/lib/iros/language/rephraseEngine.ts
// iros — Rephrase/Generate Engine (slot-preserving)
//
// ✅ 追加/変更点：
// - userContext を unknown で受け、JSONでも安全に文字列化
// - opts.debug に traceId / conversationId / userCode を受けて、監査ログに載せる
// - [IROS/rephraseEngine][OK] と [IROS/rephraseEngine][AFTER_ATTACH] をここで確実に出す
// ✅ 追加：
// - userContext から "履歴っぽいもの" を自動抽出して LLM に注入（露出禁止）
//   → LLM が「履歴を感じない」問題の最短改善
//
// ✅ 重要改善（今回の肝）
// - LLMに渡す履歴は「直近2往復」だけ（最大4メッセージ）に固定
//   → 長い履歴を入れると、逆に“流れ”が薄くなる/迷うことが多い
//
// ✅ ITは条件が揃ってから：
// - ここ（writer）は “判断” をしない
// - ただし userContext 側に「ITが成立した証拠（IT_TRIGGER_OK / IT_HOLD / tLayerModeActive 等）」があり、
//   かつ intentBand/tLayerHint が I* のときだけ「Iっぽい文体」を“表現ルールとして”許可（露出禁止）
//
// ✅ 追加（今回の肝2：I-Line 改変禁止）
// - 入力に [[ILINE]]...[[/ILINE]] が含まれている場合、その中身は一字一句改変禁止
// - LLM出力にその固定文が完全一致で含まれない場合、rephrase を破棄（ok=false）
// - 制御マーカー自体は本文に絶対露出させない（混入したら破棄）
//
// ✅ 重要（今回の肝3：traceId 統一）
// - opts.debug.traceId が null でも、このファイル内で traceId を確定する
// - MSG_PACK / chatComplete / VERIFY / OK / AFTER_ATTACH の traceId を必ず一致させる
//
// ✅ 重要（実装上のバグ修正ポイント）
// - ensureDebugFinal で debug の「追加キー」を捨てない（lastUserHead 等の互換フィールドを保持）
//   → recall-check の判定が死なないようにする
//
// ✅ 重要（今回のバグ修正：複数スロット対応）
// - buildSlotsWithFirstText は「先頭スロット1個に全集約」をやめ、段落ブロックを keys に順番に割り当てる
//   → flagReply の “同カテゴリ複数” が UI で消える事故を止める

import crypto from 'node:crypto';
import { chatComplete } from '../../llm/chatComplete';

import {
  recallGuardOk,
  shouldEnforceRecallGuard,
  checkWriterGuardsMinimal,
  type WriterGuardRules,
} from './rephrase/guards';

import { containsForbiddenLeakText, extractDirectTask } from './rephrase/leak';

import {
  ILINE_OPEN,
  ILINE_CLOSE,
  extractLockedILines,
  verifyLockedILinesPreserved,
  buildLockRuleText,
} from './rephrase/ilineLock';

import { stripLampEverywhere, finalizeLamp } from './rephrase/lamp';

import { extractHistoryTextFromContext, extractLastTurnsFromContext } from './rephrase/history';

import { flagshipGuard } from '../quality/flagshipGuard';

export type Slot = { key: string; text: string };

export type ExtractedSlots =
  | {
      slots: Slot[];
      keys: string[];
      source: string;
    }
  | null;

export type RephraseOptions = {
  model: string;
  temperature?: number;
  maxLinesHint?: number;

  /** 直前ユーザー入力（推奨） */
  userText?: string | null;

  /**
   * 3軸メタ/状態など（unknown で受ける）
   * - LLMには見せるが、本文に露出させない（systemで抑制）
   */
  userContext?: unknown | null;

  /** ✅ ログ用（chatComplete の trace に渡す） */
  debug?: {
    traceId?: string | null;
    conversationId?: string | null;
    userCode?: string | null;
    renderEngine?: boolean | null;

    // ✅ 互換/拡張：ここに何が来ても捨てない（recall-check 等が使う）
    [k: string]: any;
  } | null;
};

export type DebugFinal = {
  traceId: string;
  conversationId?: string | null;
  userCode?: string | null;
  renderEngine?: boolean | null;

  // ✅ 互換/拡張：追加キー保持
  [k: string]: any;
};

export type RephraseResult =
  | {
      ok: true;
      slots: Slot[];
      meta: {
        inKeys: string[];
        outKeys: string[];
        rawLen: number;
        rawHead: string;

        // ✅ 追加：FLAGSHIP / RETRY / FALLBACK などの採用メモ
        note?: string;
      };
    }
  | {
      ok: false;
      reason: string;
      meta: {
        inKeys: string[];
        rawLen: number;
        rawHead: string;
      };
    };

// -------------------------------
// basics
// -------------------------------
function norm(s: unknown) {
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
}

// -------------------------------
// tiny normalize (for logs only)
// -------------------------------
function normLiteForLog(s: any): string {
  return String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function safeHead(s: string, n = 80) {
  const t = String(s ?? '');
  return t.length <= n ? t : t.slice(0, n);
}

function clampLines(text: string, maxLines: number): string {
  const t = norm(text);
  if (!t) return '';
  const lines = t
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(0, Math.max(1, maxLines)).join('\n');
}

function clampChars(text: string, maxChars: number): string {
  const t = norm(text);
  if (!t) return '';
  if (t.length <= maxChars) return t;
  return t.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function envFlagEnabled(raw: unknown, defaultEnabled: boolean) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return defaultEnabled;
  if (['0', 'false', 'off', 'no', 'disabled'].includes(v)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(v)) return true;
  return defaultEnabled;
}

function tryGet(obj: any, path: string[]): any {
  let cur = obj;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function safeContextToText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return clampChars(norm(v), 1800);
  try {
    return clampChars(JSON.stringify(v), 1800);
  } catch {
    return clampChars(norm(String(v)), 1800);
  }
}

function ensureDebugFinal(debug?: RephraseOptions['debug'] | null): DebugFinal {
  const base =
    debug && typeof debug === 'object'
      ? { ...(debug as Record<string, any>) }
      : ({} as Record<string, any>);

  const traceIdRaw = String(base.traceId ?? '').trim();
  const traceId = traceIdRaw || crypto.randomUUID(); // ✅ ここで必ず確定

  return {
    ...base,
    traceId,
    conversationId: base.conversationId ?? null,
    userCode: base.userCode ?? null,
    renderEngine: base.renderEngine ?? true,
  };
}

// -------------------------------
// slot extraction (slot-preserving)
// -------------------------------
function stableOrderKeys(keys: string[]) {
  const ORDER = [
    'OBS',
    'SHIFT',
    'NEXT',
    'SAFE',
    'INSIGHT',
    'opener',
    'facts',
    'mirror',
    'elevate',
    'move',
    'ask',
    'core',
    'add',
  ];
  return [...keys].sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

/**
 * extractSlotBlocks() と同じ探索範囲から「key付き slots」を抽出する。
 * ※ここでは key を落とさない（slot-preserving に必須）。
 *
 * ✅ 追加: slots が無い場合でも、content/assistantText から疑似slot(OBS)を作る
 */
export function extractSlotsForRephrase(extra: any): ExtractedSlots {
  const framePlan =
    extra?.framePlan ??
    extra?.meta?.framePlan ??
    extra?.extra?.framePlan ??
    extra?.orch?.framePlan ??
    null;

  const slotsRaw =
    framePlan?.slots ??
    framePlan?.slotPlan?.slots ??
    extra?.slotPlan?.slots ??
    extra?.meta?.slotPlan?.slots ??
    null;

  // ✅ slotsが無いケース（microGenerateなど）を救う：contentから疑似slotを作る
  if (!slotsRaw) {
    const fallbackText = norm(
      extra?.assistantText ??
        extra?.content ??
        extra?.meta?.assistantText ??
        extra?.meta?.content ??
        extra?.text ??
        extra?.meta?.text ??
        '',
    );

    if (!fallbackText) return null;

    return {
      slots: [{ key: 'OBS', text: fallbackText }],
      keys: ['OBS'],
      source: 'fallback:content',
    };
  }

  const out: Slot[] = [];

  if (Array.isArray(slotsRaw)) {
    for (const s of slotsRaw) {
      const key = String(s?.key ?? s?.id ?? s?.slotId ?? s?.name ?? '').trim();
      const text = norm(s?.text ?? s?.value ?? s?.content ?? s?.message ?? s?.out ?? '');
      if (!key || !text) continue;
      out.push({ key, text });
    }
  } else if (typeof slotsRaw === 'object' && slotsRaw) {
    const keys = stableOrderKeys(Object.keys(slotsRaw));
    for (const k of keys) {
      const text = norm((slotsRaw as any)[k]);
      if (!text) continue;
      out.push({ key: String(k), text });
    }
  }

  if (out.length === 0) return null;

  return {
    slots: out,
    keys: out.map((x) => x.key),
    source: 'framePlan.slots',
  };
}

// -------------------------------
// fixed fallback (for FIXED mode)
// -------------------------------
function buildFixedBoxTexts(slotCount: number): string[] {
  const ZWSP = '\u200b';
  const full = [
    'まず整理の箱を3つだけ置く。',
    '事実：何が起きた（誰／どこ／いつ）',
    '感情：いま一番きつい反応',
    '望み：本当はどうなってほしい（短文でOK。うまく書かなくていい。）',
    'ここで止める。',
  ].join('\n');

  if (slotCount <= 0) return [];
  if (slotCount === 1) return [full];

  const out = [full];
  while (out.length < slotCount) out.push(ZWSP);
  return out;
}

/**
 * ✅ “本文を先頭スロット1個に潰す”のをやめる
 * - 空行区切りを「段落ブロック」として keys に順番に割り当てる
 * - 余ったブロックは「最後のキー」に連結して落とさない
 * - 余ったキーは ZWSP で埋める
 */
function buildSlotsWithFirstText(inKeys: string[], firstText: string): Slot[] {
  const ZWSP = '\u200b';
  if (inKeys.length === 0) return [];

  const full = norm(firstText);
  if (!full) {
    return [{ key: inKeys[0], text: '' }, ...inKeys.slice(1).map((k) => ({ key: k, text: ZWSP }))];
  }

  // 2行以上の空行で段落分割（1改行は文中改行として残す）
  const blocks = full
    .split(/\n\s*\n+/)
    .map((b) => norm(b))
    .filter(Boolean);

  // ブロックが1つなら従来互換（先頭に全集約）
  if (blocks.length <= 1) {
    const out: Slot[] = [{ key: inKeys[0], text: full }];
    for (let i = 1; i < inKeys.length; i++) out.push({ key: inKeys[i], text: ZWSP });
    return out;
  }

  const out: Slot[] = [];
  const takeN = Math.min(inKeys.length, blocks.length);

  for (let i = 0; i < takeN; i++) {
    out.push({ key: inKeys[i], text: blocks[i] });
  }

  // blocks が余ったら最後に連結して落とさない
  if (blocks.length > inKeys.length && inKeys.length > 0) {
    const rest = blocks.slice(inKeys.length).join('\n\n');
    const lastIdx = inKeys.length - 1;
    out[lastIdx] = {
      key: inKeys[lastIdx],
      text: norm((out[lastIdx]?.text ?? '') + '\n\n' + rest),
    };
  }

  // keys が余ったらZWSPで埋める
  for (let i = takeN; i < inKeys.length; i++) out.push({ key: inKeys[i], text: ZWSP });

  return out;
}

// -------------------------------
// ✅ recall-guard “must include” 抽出（@RESTORE.last / @Q.ask）
// - LLM に「この文字列を本文にそのまま入れろ」を強制するための素材
// - ここで取れなくても recallGuardOk が最終的に落とす（＝保険ではなく改善）
// -------------------------------
function extractRecallMustIncludeFromSeed(seedDraftRaw: string): {
  restoreNeedle: string | null;
  questionNeedle: string | null;
} {
  const t = String(seedDraftRaw ?? '');

  // @RESTORE {"last":"..."}
  // - JSONが途中で切れても拾えるように、最小の "last":"..."" だけ抜く
  let restoreNeedle: string | null = null;
  {
    const m =
      t.match(/@RESTORE[\s\S]*?"last"\s*:\s*"([^"]+)"/) ||
      t.match(/@RESTORE[\s\S]*?last"\s*:\s*"([^"]+)"/);
    if (m?.[1]) restoreNeedle = String(m[1]).trim();
  }

  // @Q {"ask":"..."}
  let questionNeedle: string | null = null;
  {
    const m =
      t.match(/@Q[\s\S]*?"ask"\s*:\s*"([^"]+)"/) ||
      t.match(/@Q[\s\S]*?ask"\s*:\s*"([^"]+)"/);
    if (m?.[1]) questionNeedle = String(m[1]).trim();
  }

  return { restoreNeedle, questionNeedle };
}

function buildMustIncludeRuleText(args: { restoreNeedle: string | null; questionNeedle: string | null }): string {
  const a = args.restoreNeedle ? `- 次の文を本文に**一字一句そのまま**含める：\n  ${args.restoreNeedle}` : '';
  const b = args.questionNeedle ? `- 次の問い（文）を本文に**一字一句そのまま**含める：\n  ${args.questionNeedle}` : '';
  const body = [a, b].filter(Boolean).join('\n');

  if (!body) return '';
  return ['',
    '【改変禁止（recall-must-include）】',
    '以下は“復元の足場”なので、削除・言い換え・要約は禁止。',
    body,
    '',
  ].join('\n');
}


// -------------------------------
// ✅ IT成立（条件が揃った証拠）を userContext から読む（MemoryState補完あり）
// -------------------------------
function readItOkFromContext(userContext: unknown): boolean {
  if (!userContext || typeof userContext !== 'object') return false;
  const uc: any = userContext as any;

  const reason =
    norm(
      tryGet(uc, ['itxReason']) ??
        tryGet(uc, ['itx_reason']) ??
        tryGet(uc, ['meta', 'itxReason']) ??
        tryGet(uc, ['meta', 'itx_reason']) ??
        tryGet(uc, ['ctxPack', 'itxReason']) ??
        tryGet(uc, ['ctxPack', 'itx_reason']) ??
        tryGet(uc, ['ctx_pack', 'itxReason']) ??
        tryGet(uc, ['ctx_pack', 'itx_reason']) ??
        '',
    ) || '';

  const tLayerModeActive =
    Boolean(
      tryGet(uc, ['tLayerModeActive']) ??
        tryGet(uc, ['meta', 'tLayerModeActive']) ??
        tryGet(uc, ['ctxPack', 'tLayerModeActive']) ??
        tryGet(uc, ['ctx_pack', 'tLayerModeActive']) ??
        false,
    ) === true;

  // ✅ MemoryState / orchestratorState / last_state など “実体” から itxStep を拾う
  const itxStep =
    norm(
      tryGet(uc, ['itxStep']) ??
        tryGet(uc, ['itx_step']) ??
        tryGet(uc, ['meta', 'itxStep']) ??
        tryGet(uc, ['meta', 'itx_step']) ??
        tryGet(uc, ['ctxPack', 'itxStep']) ??
        tryGet(uc, ['ctxPack', 'itx_step']) ??
        tryGet(uc, ['ctx_pack', 'itxStep']) ??
        tryGet(uc, ['ctx_pack', 'itx_step']) ??
        tryGet(uc, ['memoryState', 'itxStep']) ??
        tryGet(uc, ['memoryState', 'itx_step']) ??
        tryGet(uc, ['orchestratorState', 'itxStep']) ??
        tryGet(uc, ['orchestratorState', 'itx_step']) ??
        tryGet(uc, ['last_state', 'itxStep']) ??
        tryGet(uc, ['last_state', 'itx_step']) ??
        '',
    ) || '';

  const itxOk = itxStep ? /^[T][123]$/u.test(itxStep) : false;

  if (reason.includes('IT_TRIGGER_OK')) return true;
  if (reason.includes('IT_HOLD')) return true;
  if (tLayerModeActive) return true;
  if (itxOk) return true;

  return false;
}

// -------------------------------
// ✅ intentBand / tLayerHint を userContext から抽出（MemoryState補完あり）
// -------------------------------
function extractIntentBandFromContext(userContext: unknown): {
  intentBand: string | null;
  tLayerHint: string | null;
} {
  if (!userContext || typeof userContext !== 'object') {
    return { intentBand: null, tLayerHint: null };
  }
  const uc: any = userContext as any;

  const intentBand =
    norm(
      tryGet(uc, ['intentBand']) ??
        tryGet(uc, ['intent_band']) ??
        tryGet(uc, ['ctxPack', 'intentBand']) ??
        tryGet(uc, ['ctxPack', 'intent_band']) ??
        tryGet(uc, ['ctx_pack', 'intentBand']) ??
        tryGet(uc, ['ctx_pack', 'intent_band']) ??
        tryGet(uc, ['memoryState', 'intentBand']) ??
        tryGet(uc, ['memoryState', 'intent_band']) ??
        tryGet(uc, ['orchestratorState', 'intentBand']) ??
        tryGet(uc, ['orchestratorState', 'intent_band']) ??
        tryGet(uc, ['last_state', 'intentBand']) ??
        tryGet(uc, ['last_state', 'intent_band']) ??
        '',
    ) || null;

  // ✅ tLayerHint が無いときは itxStep(T1/T2/T3) を補完として使う
  const tLayerHintRaw =
    norm(
      tryGet(uc, ['tLayerHint']) ??
        tryGet(uc, ['t_layer_hint']) ??
        tryGet(uc, ['ctxPack', 'tLayerHint']) ??
        tryGet(uc, ['ctxPack', 't_layer_hint']) ??
        tryGet(uc, ['ctx_pack', 'tLayerHint']) ??
        tryGet(uc, ['ctx_pack', 't_layer_hint']) ??
        '',
    ) || null;

  const itxStep =
    norm(
      tryGet(uc, ['itxStep']) ??
        tryGet(uc, ['itx_step']) ??
        tryGet(uc, ['meta', 'itxStep']) ??
        tryGet(uc, ['meta', 'itx_step']) ??
        tryGet(uc, ['ctxPack', 'itxStep']) ??
        tryGet(uc, ['ctxPack', 'itx_step']) ??
        tryGet(uc, ['ctx_pack', 'itxStep']) ??
        tryGet(uc, ['ctx_pack', 'itx_step']) ??
        tryGet(uc, ['memoryState', 'itxStep']) ??
        tryGet(uc, ['memoryState', 'itx_step']) ??
        tryGet(uc, ['orchestratorState', 'itxStep']) ??
        tryGet(uc, ['orchestratorState', 'itx_step']) ??
        tryGet(uc, ['last_state', 'itxStep']) ??
        tryGet(uc, ['last_state', 'itx_step']) ??
        '',
    ) || '';

  const tLayerHint = tLayerHintRaw || (itxStep ? itxStep : null);

  const bandOk = intentBand && /^[SRICT][123]$/u.test(intentBand) ? intentBand : null;
  // ✅ tLayerHint は T1/T2/T3 も許可
  const hintOk = tLayerHint && /^(?:[SRICT][123]|T[123])$/u.test(tLayerHint) ? tLayerHint : null;

  return { intentBand: bandOk, tLayerHint: hintOk };
}
// -------------------------------
// ✅ shouldRaiseFlag（POSITION_DRIFT / STALL 等の“介入要求”）を userContext から読む
// - 上位（orchestrator/quality）で立った「介入してほしい」フラグを writer 側で確実に拾う
// - reason は flagReason（単数）よりも flagReasons（配列）を優先して拾う
// -------------------------------
function readShouldRaiseFlagFromContext(
  userContext: unknown,
): { on: boolean; reason: string | null } {
  if (!userContext || typeof userContext !== 'object') return { on: false, reason: null };
  const uc: any = userContext as any;

  // ✅ on: よく入る経路を“深めに”拾う
  const on =
    (Boolean(
      tryGet(uc, ['shouldRaiseFlag']) ??
        tryGet(uc, ['meta', 'shouldRaiseFlag']) ??
        tryGet(uc, ['meta', 'extra', 'shouldRaiseFlag']) ?? // ✅ 追加（ここが多い）
        tryGet(uc, ['extra', 'shouldRaiseFlag']) ??
        tryGet(uc, ['ctxPack', 'shouldRaiseFlag']) ??
        tryGet(uc, ['ctxPack', 'meta', 'extra', 'shouldRaiseFlag']) ?? // ✅ 追加
        tryGet(uc, ['ctx_pack', 'shouldRaiseFlag']) ??
        tryGet(uc, ['ctx_pack', 'meta', 'extra', 'shouldRaiseFlag']) ?? // ✅ 追加
        tryGet(uc, ['memoryState', 'shouldRaiseFlag']) ??
        tryGet(uc, ['orchestratorState', 'shouldRaiseFlag']) ??
        false,
    ) === true);

  // ✅ reasons: まず配列(flagReasons)を拾う → 先頭を reason にする
  const reasonsRaw =
    (tryGet(uc, ['flagReasons']) ??
      tryGet(uc, ['flag_reasons']) ??
      tryGet(uc, ['meta', 'flagReasons']) ??
      tryGet(uc, ['meta', 'flag_reasons']) ??
      tryGet(uc, ['meta', 'extra', 'flagReasons']) ?? // ✅ 追加
      tryGet(uc, ['meta', 'extra', 'flag_reasons']) ?? // ✅ 追加
      tryGet(uc, ['extra', 'flagReasons']) ??
      tryGet(uc, ['extra', 'flag_reasons']) ??
      tryGet(uc, ['ctxPack', 'flagReasons']) ??
      tryGet(uc, ['ctxPack', 'flag_reasons']) ??
      tryGet(uc, ['ctxPack', 'meta', 'extra', 'flagReasons']) ?? // ✅ 追加
      tryGet(uc, ['ctxPack', 'meta', 'extra', 'flag_reasons']) ?? // ✅ 追加
      tryGet(uc, ['ctx_pack', 'flagReasons']) ??
      tryGet(uc, ['ctx_pack', 'flag_reasons']) ??
      tryGet(uc, ['ctx_pack', 'meta', 'extra', 'flagReasons']) ?? // ✅ 追加
      tryGet(uc, ['ctx_pack', 'meta', 'extra', 'flag_reasons']) ?? // ✅ 追加
      null) as any;

  let reasonFromArray: string | null = null;
  if (Array.isArray(reasonsRaw) && reasonsRaw.length > 0) {
    reasonFromArray = norm(String(reasonsRaw[0] ?? '')) || null;
  } else if (typeof reasonsRaw === 'string') {
    // たまに "STALL,SAFETY_OK" みたいに文字列で来るケース
    const first = reasonsRaw.split(/[,\s|]+/).filter(Boolean)[0];
    reasonFromArray = norm(String(first ?? '')) || null;
  }

  // ✅ 単数理由も保険で拾う（配列が無ければこっち）
  const reasonSingle =
    norm(
      String(
        tryGet(uc, ['flagReason']) ??
          tryGet(uc, ['flag_reason']) ??
          tryGet(uc, ['meta', 'flagReason']) ??
          tryGet(uc, ['meta', 'flag_reason']) ??
          tryGet(uc, ['meta', 'extra', 'flagReason']) ?? // ✅ 追加
          tryGet(uc, ['meta', 'extra', 'flag_reason']) ?? // ✅ 追加
          tryGet(uc, ['extra', 'flagReason']) ??
          tryGet(uc, ['extra', 'flag_reason']) ??
          tryGet(uc, ['ctxPack', 'flagReason']) ??
          tryGet(uc, ['ctxPack', 'flag_reason']) ??
          tryGet(uc, ['ctxPack', 'meta', 'extra', 'flagReason']) ?? // ✅ 追加
          tryGet(uc, ['ctxPack', 'meta', 'extra', 'flag_reason']) ?? // ✅ 追加
          tryGet(uc, ['ctx_pack', 'flagReason']) ??
          tryGet(uc, ['ctx_pack', 'flag_reason']) ??
          tryGet(uc, ['ctx_pack', 'meta', 'extra', 'flagReason']) ?? // ✅ 追加
          tryGet(uc, ['ctx_pack', 'meta', 'extra', 'flag_reason']) ?? // ✅ 追加
          '',
      ),
    ) || null;

  const reason = reasonFromArray ?? reasonSingle;

  return { on, reason };
}

// ---------------------------------------------
// meta / inputKind
// ---------------------------------------------
function extractInputKindFromMetaText(metaText: string): string | null {
  const t = String(metaText ?? '');

  {
    const m = t.match(/"inputKind"\s*:\s*"([^"]+)"/);
    if (m?.[1]) return String(m[1]).trim().toLowerCase();
  }

  {
    const m = t.match(/\binputKind\b\s*[:=]\s*([A-Za-z_][A-Za-z0-9_]*)/);
    if (m?.[1]) return String(m[1]).trim().toLowerCase();
  }

  return null;
}

function extractInputKindFromContext(ctx: any): string | null {
  if (!ctx) return null;

  const candidates = [
    ctx.inputKind,
    ctx.kind,
    ctx.framePlan?.inputKind,
    ctx.framePlan?.kind,
    ctx.meta?.inputKind,
    ctx.meta?.kind,
    ctx.ctx?.inputKind,
    ctx.ctx?.framePlan?.inputKind,
  ];

  for (const v of candidates) {
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase();
  }
  return null;
}

function adaptSeedDraftHintForWriter(seedDraft: string, directTask: boolean): string {
  const s = String(seedDraft ?? '').trim();
  if (!s) return '';

  let out = s;

  // ※ seedDraft に find_trigger_point の痕跡が混ざる場合の保険
  if (/find_trigger_point/i.test(out)) {
    out = out.replace(/.*find_trigger_point.*(\n|$)/gi, '');
    out = out.trim();
    const hint = directTask
      ? '（内部ヒント：ユーザーは「具体的なコツ/手順」を求めている。最初に使える具体策を短く出す）'
      : '（内部ヒント：ユーザーが求めている一点を「軸」として置く）';
    return [hint, out].filter(Boolean).join('\n');
  }

  if (directTask) {
    return ['（内部ヒント：具体策を先に。一般論は足さない）', out].join('\n');
  }

  return out;
}

// -------------------------------
// ✅ logs
// -------------------------------
function logRephraseOk(
  debug: DebugFinal | null | undefined,
  outKeys: string[],
  raw: string,
  mode?: string,
) {
  console.log('[IROS/rephraseEngine][OK]', {
    traceId: debug?.traceId ?? null,
    conversationId: debug?.conversationId ?? null,
    userCode: debug?.userCode ?? null,
    mode: mode ?? null,
    keys: outKeys,
    rawLen: String(raw ?? '').length,
    rawHead: safeHead(String(raw ?? ''), 120),
  });
}

function logRephraseAfterAttach(
  debug: DebugFinal | null | undefined,
  outKeys: string[],
  firstText: string,
  mode?: string,
) {
  console.log('[IROS/rephraseEngine][AFTER_ATTACH]', {
    traceId: debug?.traceId ?? null,
    conversationId: debug?.conversationId ?? null,
    userCode: debug?.userCode ?? null,
    mode: mode ?? null,
    renderEngine: debug?.renderEngine ?? true,
    rephraseBlocksLen: outKeys.length,
    rephraseHead: safeHead(String(firstText ?? ''), 120),
  });
}

// -------------------------------
// ✅ system prompt（伸びしろ設計 / “禁止で縛る”ではなく“方向づけ”）
// -------------------------------
function systemPromptForFullReply(args?: {
  directTask?: boolean;
  itOk?: boolean;
  band?: { intentBand: string | null; tLayerHint: string | null } | null;
  lockedILines?: string[] | null;
}): string {
  const directTask = Boolean(args?.directTask);
  const itOk = Boolean(args?.itOk);
  const band = args?.band ?? null;

  const b = band?.intentBand ?? null;
  const h = band?.tLayerHint ?? null;

  const isIRequested = (b && b.startsWith('I')) || (h && h.startsWith('I'));
  const allowIStyle = itOk && isIRequested;

  const base = directTask
    ? [
        'あなたは iros の会話生成（reply）担当です。',
        '',
        '【旗印】',
        '答えを渡さない。判断を急がせない。読み手が自分で答えを出せる場所をつくる。',
        '',
        '【出力ルール（directTask=TRUE）】',
        '- 全体で6〜14行。会話文のみ。',
        '- ユーザーの依頼に対して「そのまま送れる文面」を出す。',
        '- ただし“正解/結論/安心”で閉じない。相手の主権が残る余白で終える。',
        '- 文面は「事実→境界→余白」の順で組む。',
        '',
        '【禁止・注意】',
        '- 命令（〜すべき/必ず/絶対）で相手を動かさない。',
        '- 断言で背中を押し切らない（決めない）。',
        '- テンプレ口癖（受け取った/いま出ている言葉/一手に落とす/呼吸を戻す 等）は使わない。',
        '- A/Bの二択で選ばせない（並べても、選択を迫らない）。',
        '- 入力メタ（phase/depth/q/JSON/キー名）は本文に出さない。',
        '- 「覚えている」「前に言っていた」等の記憶断言はしない。',
        '- 終端記号（🪔など）は出さない（上位レンダーが付ける）。',
        '- 問いは最大1つ。不要なら0。',
      ].join('\n')
    : [
        'あなたは iros の会話生成（reply）担当です。',
        '',
        '【旗印】',
        '答えを渡さない。判断を急がせない。読み手が自分で答えを出せる場所をつくる。',
        '',
        '【出力ルール（directTask=FALSE）】',
        '- 全体で4〜10行。会話文のみ。',
        '- 1段落目：軸を1文（評価せず、決めない）。',
        '- 2段落目：見るポイントを2〜4文（箇条書き記号は使わない）。',
        '- 3段落目：余白を1文（詰めない）。',
        '',
        '【禁止・注意】',
        '- 命令（〜すべき/必ず/絶対）で相手を動かさない。',
        '- テンプレ口癖（受け取った/いま出ている言葉/一手に落とす/呼吸を戻す 等）は使わない。',
        '- A/Bの二択で選ばせない（並べても、選択を迫らない）。',
        '- 質問は最大1つ。不要なら質問は書かない。',
        '- 入力メタ（phase/depth/q/JSON/キー名）は本文に出さない。',
        '- 「覚えている」「前に話したよね」等の記憶断言はしない。',
        '- 終端記号（🪔など）は出さない（上位レンダーが付ける）。',
      ].join('\n');

  // ✅ 旗印ガード：励まし定型/推測逃げを抑える（FATAL回避）
  const flagshipHardNo = [
    '',
    '【禁止（旗印ガード）】',
    '- 次の“励まし定型”は禁止：',
    '  ・「特別ですね」「素敵ですね」「いいですね」',
    '  ・「その気持ちを大切に」「応援してる」「きっと」',
    '  ・「進んでいけるといいですね」「〜できるといい」',
    '- 次の“推測逃げ”は禁止：',
    '  ・「〜かもしれません」「〜のかも」「もしかしたら」',
    '- 代わりに：入力にある事実だけで“見方を一段変える説明”を置き、質問は最大1つ。',
    '',
  ].join('\n');

  const bandInfo = [
    '',
    '【内部制約：帯域ヒント（露出禁止）】',
    `directTask=${directTask ? 'true' : 'false'} / itOk=${itOk ? 'true' : 'false'} / intentBand=${
      b ?? '(null)'
    } / tLayerHint=${h ?? '(null)'}`,
  ].join('\n');

  const directTaskRule = directTask
    ? [
        '',
        '【directTask=TRUE（送れる文面 / 余白あり）】',
        '- 相手の不安を“埋める”文章にしない。',
        '- 決めつけず、境界を置き、余白で終える。',
      ].join('\n')
    : [
        '',
        '【directTask=FALSE】',
        '- 冒頭で「引っかかっている一点」を“軸”として置く。',
      ].join('\n');

  const lockRule = buildLockRuleText(args?.lockedILines ?? []);

  const iStyleRule = allowIStyle
    ? [
        '',
        '【Iっぽい文体（許可）】',
        '短く断定的な文体は使ってよい。',
        'ただし助言/説教で埋めない。置いたら解説を足さない。',
      ].join('\n')
    : [
        '',
        '【Iっぽい文体（自由）】',
        '必要なら短い言い切りを1つ置いてよいが、押し切らない。',
      ].join('\n');

  return base + flagshipHardNo + bandInfo + directTaskRule + lockRule + iStyleRule;
}

// ✅ internal pack（露出禁止の情報を system で渡す）
function buildInternalPackText(args: {
  metaText: string;
  historyText: string;
  seedDraftHint: string;
  lastTurnsCount: number;
  itOk: boolean;
  band: { intentBand: string | null; tLayerHint: string | null };
  directTask: boolean;
  inputKind: string | null;
  lockedCount: number;
}): string {
  return [
    'INTERNAL PACK (DO NOT OUTPUT)',
    '',
    `lastTurnsCount=${args.lastTurnsCount}`,
    `directTask=${args.directTask}`,
    `inputKind=${args.inputKind ?? '(null)'}`,
    `itOk=${args.itOk}`,
    `intentBand=${args.band.intentBand ?? '(null)'}`,
    `tLayerHint=${args.band.tLayerHint ?? '(null)'}`,
    `lockedILines=${args.lockedCount}`,
    '',
    'META (DO NOT OUTPUT):',
    args.metaText || '(none)',
    '',
    'HISTORY_HINT (DO NOT OUTPUT):',
    args.lastTurnsCount > 0 ? '(lastTurns already provided above)' : args.historyText || '(none)',
    '',
    'SEED_DRAFT_HINT (DO NOT OUTPUT):',
    args.seedDraftHint || '(none)',
  ].join('\n');
}

// ---------------------------------------------
// ✅ FINAL用：slotを保ったまま “会話本文” を作る
// ---------------------------------------------
export async function rephraseSlotsFinal(
  extracted: ExtractedSlots,
  opts: RephraseOptions,
): Promise<RephraseResult> {
  // ✅ traceId をこのファイルで確定（統一）
  const debug = ensureDebugFinal(opts.debug);

  if (!extracted) {
    logRephraseOk(debug, [], '', 'NO_SLOTS');
    return {
      ok: false,
      reason: 'NO_SLOTS',
      meta: { inKeys: [], rawLen: 0, rawHead: '' },
    };
  }

  const rawFlag = process.env.IROS_REPHRASE_FINAL_ENABLED;
  const enabled = envFlagEnabled(rawFlag, true);
  console.log('[IROS/REPHRASE_FLAG]', { raw: rawFlag, enabled });

  if (!enabled) {
    logRephraseOk(debug, extracted.keys, '', 'DISABLED');
    return {
      ok: false,
      reason: 'REPHRASE_DISABLED_BY_ENV',
      meta: { inKeys: extracted.keys, rawLen: 0, rawHead: '' },
    };
  }

  const mode = String(process.env.IROS_REPHRASE_FINAL_MODE ?? 'LLM')
    .trim()
    .toUpperCase();

  const maxLines =
    Number(process.env.IROS_REPHRASE_FINAL_MAXLINES) > 0
      ? Math.floor(Number(process.env.IROS_REPHRASE_FINAL_MAXLINES))
      : Math.max(4, Math.min(12, Math.floor(opts.maxLinesHint ?? 8)));

  const inKeys = extracted.keys;

  // (A) FIXED
  if (mode === 'FIXED') {
    const fixedTexts = buildFixedBoxTexts(inKeys.length);
    const out: Slot[] = inKeys.map((k, i) => ({
      key: k,
      text: fixedTexts[i] ?? 'ここで止める。',
    }));

    logRephraseOk(debug, out.map((x) => x.key), out[0]?.text ?? '', 'FIXED');
    logRephraseAfterAttach(debug, out.map((x) => x.key), out[0]?.text ?? '', 'FIXED');

    return {
      ok: true,
      slots: out,
      meta: {
        inKeys,
        outKeys: out.map((x) => x.key),
        rawLen: 0,
        rawHead: '',
      },
    };
  }

  // (B) LLM
  const userText = norm(opts?.userText ?? '');
  const metaText = safeContextToText(opts?.userContext ?? null);

  const inputKindFromCtx = extractInputKindFromContext(opts?.userContext ?? null);
  const inputKindFromMeta = extractInputKindFromMetaText(metaText);
  const inputKind = inputKindFromCtx ?? inputKindFromMeta;

  const isDirectTask = extractDirectTask(userText, inputKind);

  const historyText = extractHistoryTextFromContext(opts?.userContext ?? null);
  const lastTurns = extractLastTurnsFromContext(opts?.userContext ?? null);

  // slot由来の下書き（露出禁止）
  const seedDraftRaw = extracted.slots.map((s) => s.text).filter(Boolean).join('\n');
  // ✅ recall-guard の “必須文字列” を seedDraft から抽出して system に強制する
  const recallMust = extractRecallMustIncludeFromSeed(seedDraftRaw);
  const mustIncludeRuleText = buildMustIncludeRuleText(recallMust);

  // ✅ ILINE抽出（穴塞ぎ）
  // - ロック対象は「slot由来 + userText」両方から拾う（将来 userText 側に ILINE が来ても守る）
  // - ただし LLM に渡す “素材” は slot由来のみ（ユーザー入力を素材に混ぜると二重化しやすい）
  const lockSourceRaw = [seedDraftRaw, userText].filter(Boolean).join('\n');

  const { locked: lockedFromAll } = extractLockedILines(lockSourceRaw);
  const { cleanedForModel: seedDraft } = extractLockedILines(seedDraftRaw);

  // ✅ 重複除去（同一ILINEが両側にあっても1回扱い）
  const lockedILines = Array.from(new Set(lockedFromAll));


  // ✅ SHIFT(kind=find_trigger_point) を “読める内部ヒント” に変換（露出禁止）
  const seedDraftHint = adaptSeedDraftHintForWriter(seedDraft, isDirectTask);

  // ✅ ITは条件が揃ってから（証拠があるときだけI文体を許可）
  const itOk = readItOkFromContext(opts?.userContext ?? null);
  const band = extractIntentBandFromContext(opts?.userContext ?? null);

  // ✅ lastTurns は「assistantで終わる」形に正規化する
  // - 末尾userが残ると、最後に userText を足したとき user が二重になる
  const lastTurnsSafe = (() => {
    const t = Array.isArray(lastTurns) ? [...lastTurns] : [];
    while (t.length > 0 && t[t.length - 1]?.role === 'user') t.pop();
    return t;
  })();

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    {
      role: 'system',
      content:
        systemPromptForFullReply({
          directTask: isDirectTask,
          itOk,
          band,
          lockedILines,
        }) + mustIncludeRuleText,
    },


    // ✅ 内部パック（履歴要約やメタ）
    {
      role: 'system',
      content: buildInternalPackText({
        metaText,
        historyText,
        seedDraftHint,
        lastTurnsCount: lastTurnsSafe.length,
        itOk,
        band,
        directTask: isDirectTask,
        inputKind,
        lockedCount: lockedILines.length,
      }),
    },

    // ✅ seedDraft は “素材” として system で渡す（露出禁止）
    ...(seedDraft
      ? [
          {
            role: 'system' as const,
            content: `【内部素材：下書き（露出禁止）】\n${seedDraft}`,
          },
        ]
      : []),

    // ★ 直近2往復（最大4メッセージ）
    ...(lastTurnsSafe as Array<{ role: 'user' | 'assistant'; content: string }>),

    // ★ ユーザー入力は純度高く（メタを混ぜない）
    {
      role: 'user',
      content: userText || '(空)',
    },
  ];

  console.log('[IROS/rephraseEngine][MSG_PACK]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,

    lastTurns: lastTurnsSafe.length,
    hasHistoryText: Boolean(historyText),
    msgCount: messages.length,
    roles: messages.map((m) => m.role),

    msgHeads: messages.map((m, i) => ({
      i,
      role: m.role,
      len: String(m.content ?? '').length,
      head: safeHead(String(m.content ?? ''), 120),
    })),

    seedDraftLen: seedDraft.length,
    seedDraftHead: safeHead(seedDraft, 120),

    itOk,
    intentBand: band.intentBand,
    tLayerHint: band.tLayerHint,
    directTask: isDirectTask,

    inputKind,
    inputKindFromMeta,
    inputKindFromCtx,

    lockedILines: lockedILines.length,
  });

  // ---------------------------------------------
  // ✅ LLM call
  // ---------------------------------------------
  let raw = '';
  try {
    raw = await chatComplete({
      purpose: 'reply',
      model: opts.model,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
      max_tokens: 700,
      messages,

      // ✅ traceId 統一
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,

      // compat payloads
      trace: {
        traceId: debug.traceId,
        conversationId: debug.conversationId,
        userCode: debug.userCode,
      },
      audit: { slotPlanPolicy: 'FINAL' },
    } as any);
  } catch (e: any) {
    console.error('[IROS/REPHRASE_FINAL][LLM] failed', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      message: String(e?.message ?? e),
    });
    logRephraseOk(debug, extracted.keys, '', 'LLM_FAIL');
    return {
      ok: false,
      reason: 'LLM_CALL_FAILED',
      meta: { inKeys, rawLen: 0, rawHead: '' },
    };
  }

  // ✅ raw段階ログ
  logRephraseOk(debug, extracted.keys, raw, 'LLM');

  // ✅ 出力に internal pack ラベル等が混入した場合は破棄（露出禁止）
  if (containsForbiddenLeakText(raw)) {
    logRephraseOk(debug, extracted.keys, raw, 'INTERNAL_MARKER_LEAKED');
    return {
      ok: false,
      reason: 'INTERNAL_MARKER_LEAKED',
      meta: { inKeys, rawLen: String(raw ?? '').length, rawHead: safeHead(String(raw ?? ''), 80) },
    };
  }

  // ✅ ILINE改変禁止:検証（不一致なら破棄）
  const iLineOk = verifyLockedILinesPreserved(raw, lockedILines);

  console.log('[IROS/REPHRASE][VERIFY]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    iLine_preserved: iLineOk,
    lockedCount: lockedILines.length,
  });

  if (!iLineOk) {
    return {
      ok: false,
      reason: 'ILINE_NOT_PRESERVED',
      meta: { inKeys, rawLen: String(raw ?? '').length, rawHead: safeHead(String(raw ?? ''), 80) },
    };
  }

  // ================================
  // ✅ Recall-check hard guard (Phase11)
  // ================================
  {
    const recallCheck = recallGuardOk({
      slotKeys: inKeys,
      slotsForGuard: (extracted?.slots ?? null) as any,
      llmOut: raw,
    });

    console.log('[IROS/REPHRASE][RECALL_GUARD]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      enforced: shouldEnforceRecallGuard(inKeys),
      ok: recallCheck.ok,
      missing: recallCheck.missing,
      needles: recallCheck.needles,
    });

    if (!recallCheck.ok) {
      console.warn('[IROS/REPHRASE][RECALL_GUARD_REJECT]', {
        traceId: debug.traceId,
        conversationId: debug.conversationId,
        userCode: debug.userCode,
        missing: recallCheck.missing,
        needles: recallCheck.needles,
        outHead: normLiteForLog(raw).slice(0, 120),
      });

      return {
        ok: false,
        reason: 'RECALL_GUARD_REJECT',
        meta: { inKeys, rawLen: String(raw ?? '').length, rawHead: safeHead(String(raw ?? ''), 80) },
      };
    }
  }


  // ✅ STABILIZE(OBS/SHIFT/NEXT)も救う：この3点セットは薄い逃げが出やすい
  const isStabilizePack =
    Array.isArray(inKeys) &&
    inKeys.includes('OBS' as any) &&
    inKeys.includes('SHIFT' as any) &&
    inKeys.includes('NEXT' as any);

  // ✅ WARNでも“薄い逃げ”なら採用しない（seedへ戻す）
  // - flagReplyだけでなく、STABILIZEパックにも効かせる
  const shouldRejectWarnToSeed = (verdict: any) => {
    const level = String(verdict?.level ?? '').toUpperCase();
    if (level !== 'WARN') return false;

    const reasons = new Set((verdict?.reasons ?? []).map((x: any) => String(x)));

    // flagReply向け（以前の意図を保持）
    const isFlagReplyLike = Array.isArray(inKeys) && inKeys.every((k: any) => String(k).startsWith('FLAG_'));
    if (isFlagReplyLike) {
      return (
        reasons.has('HEDGE_MANY') ||
        reasons.has('HEDGE_PRESENT') ||
        reasons.has('GENERIC_PRESENT') ||
        reasons.has('GENERIC_MANY')
      );
    }

    // STABILIZE向け（今回ここが刺さる）
    if (isStabilizePack) {
      // 「汎用化 + ぼかし」セットは即seedに戻す
      const genericBad = reasons.has('GENERIC_MANY') || reasons.has('GENERIC_PRESENT');
      const hedgeBad = reasons.has('HEDGE_PRESENT') || reasons.has('HEDGE_MANY');
      const cheerBad = reasons.has('CHEER_PRESENT');
      return genericBad && (hedgeBad || cheerBad);
    }

    return false;
  };


  // ================================
  // ✅ Flagship Guard（採用ゲート）
  // - 対象は採用本文（clampLines → finalizeLamp後）
  // - FATAL なら 1回だけ再生成
  // - 再生成も FATAL なら「最小安全文」を採用（巻き戻らない）
  // ================================
  const guardEnabled = envFlagEnabled(process.env.IROS_FLAGSHIP_GUARD_ENABLED, true);

  const renderEngine = Boolean(debug.renderEngine ?? true);
  const candidate = finalizeLamp(clampLines(raw, maxLines), renderEngine);

  if (!candidate) {
    logRephraseOk(debug, extracted.keys, '', 'LLM_EMPTY_AFTER_CLAMP');
    return {
      ok: false,
      reason: 'LLM_EMPTY',
      meta: { inKeys, rawLen: 0, rawHead: '' },
    };
  }

  if (containsForbiddenLeakText(candidate)) {
    logRephraseOk(debug, extracted.keys, candidate, 'FINAL_LEAKED');
    return {
      ok: false,
      reason: 'FINAL_LEAKED',
      meta: { inKeys, rawLen: candidate.length, rawHead: safeHead(candidate, 80) },
    };
  }

  // ✅ 最終採用（candidate / retryCandidate）の verdict を meta.extra に運ぶための保持箱
  let lastFlagshipVerdict: any = null;
  let lastFlagshipHead: string | null = null;

  const runFlagship = (text: string) => {
    const v = flagshipGuard(text);

    // ✅ “最後に判定したverdict” を保持（採用経路がどれでも meta.extra に積める）
    lastFlagshipVerdict = {
      level: v.level,
      ok: v.ok,
      qCount: v.qCount,
      score: v.score,
      reasons: Array.isArray(v.reasons) ? v.reasons : [],
    };
    lastFlagshipHead = safeHead(text, 220);

    console.log('[IROS/FLAGSHIP][VERDICT]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      level: v.level,
      ok: v.ok,
      qCount: v.qCount,
      score: v.score,
      reasons: v.reasons,
      head: lastFlagshipHead,
    });
    return v;
  };

  const adoptAsSlots = (text: string, note?: string): RephraseResult => {
    const outSlots = buildSlotsWithFirstText(inKeys, text);

    // ✅ 入力側（opts.userContext）由来の raise は “true のときだけ” 付ける（falseは書かない）
    const raiseIn = readShouldRaiseFlagFromContext(opts?.userContext ?? null);

    // ✅ meta.extra は「空でも作らない」。ただし flagshipVerdict は “out” として常に載せる
    //   → 手順4（次ターン運搬）の核
    const extra: any = {};

    // (A) raiseIn（入力側）: true のときだけ載せる（ノイズ禁止）
    if (raiseIn.on === true) {
      extra.shouldRaiseFlag = true;
      extra.flagReasons = raiseIn.reason ? [raiseIn.reason] : [];
    }

    // (B) flagshipVerdict（出力側）: 常に載せる（out の証跡）
    // runFlagship() が保持しているならそれを使う。無い場合は最低限だけ詰める。
    if (typeof lastFlagshipVerdict !== 'undefined' && lastFlagshipVerdict) {
      extra.flagshipVerdict = lastFlagshipVerdict;
      if (typeof lastFlagshipHead !== 'undefined' && lastFlagshipHead) {
        extra.flagshipHead = lastFlagshipHead;
      }
    } else {
      // 保険：保持箱が無い構成でも out が null にならないようにする
      extra.flagshipVerdict = { level: null, ok: null, reasons: [] as string[], score: null };
    }

    const hasExtra = Object.keys(extra).length > 0;

    logRephraseAfterAttach(debug, inKeys, outSlots[0]?.text ?? '', note ?? 'LLM');

    return {
      ok: true,
      slots: outSlots,
      meta: {
        inKeys,
        outKeys: outSlots.map((x) => x.key),

        // ✅ 採用本文（text）を raw として扱う（採用同期）
        rawLen: String(text ?? '').length,
        rawHead: safeHead(String(text ?? ''), 80),

        note,
        ...(hasExtra ? ({ extra } as any) : {}),
      } as any,
    };
  };


  // ✅ slotPlan由来の seed（= LLMが薄く逃げたときに戻る場所）
  const seedFromSlotsRaw = (extracted?.slots ?? [])
    .map((s: any) => String(s?.text ?? ''))
    .filter((s: string) => s.trim())
    .join('\n');
  const seedFromSlots = seedFromSlotsRaw
    ? finalizeLamp(clampLines(seedFromSlotsRaw, maxLines), renderEngine)
    : '';

  // ✅ flagReply系（FLAG_*）のときだけ、WARNでも薄い逃げは採用しない
  const isFlagReplyLike = inKeys.every((k) => String(k).startsWith('FLAG_'));
  const shouldRejectWarn = (verdict: any) => {
    if (!isFlagReplyLike) return false;
    const level = String(verdict?.level ?? '').toUpperCase();
    if (level !== 'WARN') return false;

    const reasons = new Set((verdict?.reasons ?? []).map((x: any) => String(x)));
    return reasons.has('HEDGE_MANY') || reasons.has('GENERIC_PRESENT');
  };

  if (!guardEnabled) {
    return adoptAsSlots(candidate);
  }

// ✅ 置き換え範囲：
// rephraseSlotsFinal 内の「v = runFlagship(candidate) の直後〜 最後の return adoptAsSlots(candidate); まで」を
// まるごとこのブロックに置き換えてください。
// ※前提：このスコープで seedFromSlots / lockedILines / extracted / inKeys / messages / maxLines / renderEngine / opts / debug が生きていること
// ※重要：v を上書きするので `const v = ...` ではなく `let v = ...` にしてください。

let v = runFlagship(candidate);

// ================================
// ✅ 上位からの“介入要求”が立っているなら、OKでも強制で介入
// - STALL / POSITION_DRIFT のような「体験が崩れている」サインは writer 側で握り潰さない
// ================================
const raise = readShouldRaiseFlagFromContext(opts?.userContext ?? null);
const forceIntervene = raise.on === true;

if (forceIntervene) {
  console.warn('[IROS/FLAGSHIP][FORCE_INTERVENE]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    reason: raise.reason,
    verdictLevel: v.level,
    verdictReasons: v.reasons,
    head: safeHead(candidate, 160),
  });

  // ✅ 介入の種類で分岐：
  // - STALL / POSITION_DRIFT は「RETRYで喋らせ直す」より、seed（構造側の下書き）へ即戻しが最短
  const reasonText = String(raise.reason ?? '');
  const isStallOrDrift = /STALL|POSITION_DRIFT/i.test(reasonText);

  if (isStallOrDrift) {
    console.warn('[IROS/FLAGSHIP][RAISE_TO_SEED]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      reason: raise.reason,
    });
    return adoptAsSlots(seedFromSlots, 'FLAGSHIP_RAISE_TO_SEED');
  }

  // ✅ それ以外（安全/倫理/品質の崩れ）は従来通り「RETRY/FALLBACK」へ入れる
  v = {
    ...v,
    ok: false,
    level: 'FATAL',
    reasons: Array.from(new Set([...(v.reasons ?? []), 'FORCE_INTERVENE'])),
  } as any;
}

// 2) FATAL のときだけ 1回だけ再生成（OKならここには入らない）
if (!v.ok) {
  let raw2 = '';

  const retryMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    ...messages,
    {
      role: 'system',
      content:
        '【再生成（旗印）】\n' +
        '- 目的：読み手が“自分で答えを出せる場所”を作る。\n' +
        '- やること：視点/角度/切り分け/輪郭を1段だけ提示し、読者の足場を作る。\n' +
        '- 必須：入力（userText / lastTurns / historyText / seedDraft）に含まれる具体語を最低1つ、本文に自然に入れる（固有名詞/場所/条件/役割など）。\n' +
        '- 禁止：汎用応援（大丈夫/応援/きっと/焦らなくていい/少しずつ 等）、ぼかし（かもしれません/と思います 連発）、箇条書き。\n' +
        '- 禁止：入力に無い背景を“共鳴で補完”しない（推測で物語を足さない）。\n' +
        '- 質問：0〜1個まで（できれば0）。\n' +
        '- 行数：directTaskのルールに従う（directTask=FALSEなら4〜10行）。\n' +
        '- 会話文のみ。内部情報は出さない。',
    },
  ];

  console.log('[IROS/FLAGSHIP][RETRY]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    reason: v.reasons,
  });

  try {
    raw2 = await chatComplete({
      purpose: 'reply',
      model: opts.model,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
      max_tokens: 700,
      messages: retryMessages,

      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      trace: {
        traceId: debug.traceId,
        conversationId: debug.conversationId,
        userCode: debug.userCode,
      },
      audit: { slotPlanPolicy: 'FINAL', note: 'FLAGSHIP_RETRY' },
    } as any);
  } catch (e: any) {
    console.error('[IROS/FLAGSHIP][RETRY] failed', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      err: e?.message ?? String(e),
    });
    raw2 = '';
  }

  // ---- retry 後の各種ガード ----
  if (raw2 && containsForbiddenLeakText(raw2)) raw2 = '';
  if (raw2 && !verifyLockedILinesPreserved(raw2, lockedILines)) raw2 = '';

  if (raw2) {
    const recall2 = recallGuardOk({
      slotKeys: inKeys,
      slotsForGuard: (extracted?.slots ?? null) as any,
      llmOut: raw2,
    });
    if (!recall2.ok) raw2 = '';
  }

  if (raw2) {
    const retryCandidate = finalizeLamp(clampLines(raw2, maxLines), renderEngine);

    if (retryCandidate && !containsForbiddenLeakText(retryCandidate)) {
      const v2 = runFlagship(retryCandidate);

      // ✅ retry も WARN薄逃げなら seed に戻す（flagReplyだけ）
      if (shouldRejectWarn(v2) && seedFromSlots) {
        console.warn('[IROS/FLAGSHIP][REJECT_WARN_TO_SEED][RETRY]', {
          traceId: debug.traceId,
          conversationId: debug.conversationId,
          userCode: debug.userCode,
          level: v2.level,
          reasons: v2.reasons,
        });
        return adoptAsSlots(seedFromSlots, 'FLAGSHIP_WARN_REJECT_TO_SEED_RETRY');
      }

      if (v2.ok) {
        return adoptAsSlots(retryCandidate, 'FLAGSHIP_RETRY_ADOPTED');
      }
    }
  }

  // ================================
  // ✅ FALLBACK（巻き戻らず、最小の“旗印”安全文を採用）
  // ================================
  const userTextRaw = String(opts?.userText ?? '').trim();
  const userHead = userTextRaw ? safeHead(userTextRaw, 56) : '';

  const fallback = userHead
    ? `目標は「${userHead}」なんだね。\n\nその“完成”を、今日の言葉で一段だけ具体化すると何になる？`
    : `目標が「完成」に向いているのは伝わった。\n\nその“完成”を、今日の言葉で一段だけ具体化すると何になる？`;

  const cleanedFallback = finalizeLamp(clampLines(fallback, maxLines), renderEngine);

  if (!cleanedFallback || containsForbiddenLeakText(cleanedFallback)) {
    logRephraseOk(debug, extracted.keys, candidate, 'FLAGSHIP_FATAL_NO_FALLBACK');
    return {
      ok: false,
      reason: 'FLAGSHIP_GUARD_FATAL',
      meta: { inKeys, rawLen: candidate.length, rawHead: safeHead(candidate, 80) },
    };
  }

  console.log('[IROS/FLAGSHIP][FALLBACK_ADOPT]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    reasons: v.reasons,
    outHead: safeHead(cleanedFallback, 120),
  });

  return adoptAsSlots(cleanedFallback, 'FLAGSHIP_FALLBACK_ADOPTED');
}

// ✅ OK → そのまま採用
return adoptAsSlots(candidate);
}

/**
 * ✅ 絶対ルール（幻覚/捏造 防止）
 * - 入力に存在しない「過去の出来事」「前に言ってた」等を作らない
 * - 「覚えてる」「前に話したよね」等の“記憶断言”は禁止
 *   ただし、入力（history/messages/seedDraft）に明示で含まれている範囲の要約は可
 * - ユーザーが「覚えてる？」と聞いた場合は、事実の断言ではなく
 *   「この入力にある限りでは◯◯」の現在要約で返す
 * - 目的は“会話を自然にする”であり、ストーリー補完ではない
 */
