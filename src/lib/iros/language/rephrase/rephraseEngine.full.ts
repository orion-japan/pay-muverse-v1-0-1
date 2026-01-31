/* eslint-disable @typescript-eslint/no-explicit-any */

// src/lib/iros/language/rephraseEngine.ts
// iros — Rephrase/Generate Engine (slot-preserving)
//
// 目的：
// - LLMは「文章整形/表現」だけ（判断はしない）
// - slot key を落とさずに “送れる完成文” を生成する（slot-preserving）
// - 露出禁止（内部パック/メタ/JSON/キー名/制御マーカー）を確実に遮断
// - 直近2往復（最大4メッセージ）だけを LLM に渡す（薄まり防止）
//
// 重要：
// - traceId はこのファイルで確定して統一
// - [[ILINE]]...[[/ILINE]] は改変禁止（漏れたら破棄）
// - recall-guard（must include）がある場合、落ちたら破棄
// - FlagshipGuard は採用ゲート（FATALなら1回だけ再生成、ダメなら seed/fallback）
// - ONE_POINT scaffold 中は「仮置き一点」を本文に必ず残す（復元→無理なら不採用）
//
// NOTE：このファイルは “運用上の安全” のため、判定と復元を分離し、
//       最終的に「採用できる本文」を slot へ attach する責務に絞る。
// ---------------------------------------------
// IMPORTANT — DESIGN GUARD (DO NOT REDEFINE)
//
// This module is responsible ONLY for expression shaping (writer).
// It must NOT:
// - make decisions on behalf of the user
// - change philosophical/safety stance (user agency, SUN/north-star)
// - introduce new “diagnosis/decision” logic
//
// Meta values are constraints/background, not answers.
// Preserve user agency at all times.
// ---------------------------------------------

import crypto from 'node:crypto';
import { chatComplete } from '../../../llm/chatComplete';

import { recallGuardOk, shouldEnforceRecallGuard } from './guards';
import { containsForbiddenLeakText, extractDirectTask } from './leak';
import { finalizeLamp } from './lamp';
import { extractHistoryTextFromContext, extractLastTurnsFromContext } from './history';
import { readFlowDigest, readFlowTape } from './contextRead';
import { buildFirstPassMessages, buildRetryMessages, callWriterLLM } from './writerCalls';
import { systemPromptForFullReply } from './systemPrompt';

import { flagshipGuard } from '../../quality/flagshipGuard';
import {
  extractLockedILines,
  verifyLockedILinesPreserved,
  buildLockRuleText,
  ILINE_OPEN,
  ILINE_CLOSE,
} from './ilineLock';
// ---------------------------------------------
// types
// ---------------------------------------------
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

  /**
   * ✅ 入力種別（route 側で確定して渡す）
   * 例: 'micro' | 'greeting' | 'chat' | 'question' ...
   * - rephraseEngine 側の MIN_OK_KIND / directTask 判定などに使う
   */
  inputKind?: string | null;

  /** ✅ ログ用（chatComplete の trace に渡す） */
  debug?: {
    traceId?: string | null;
    conversationId?: string | null;
    userCode?: string | null;
    renderEngine?: boolean | null;

    // 互換/拡張：追加キーを落とさない
    [k: string]: any;
  } | null;
};

export type DebugFinal = {
  traceId: string;
  conversationId?: string | null;
  userCode?: string | null;
  renderEngine?: boolean | null;

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
        note?: string;
        extra?: any;
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

// ✅ internal pack（露出禁止の情報を system で渡す）
function buildInternalPackText(args: {
  metaText?: string | null;
  historyText?: string | null;
  seedDraftHint?: string | null;
  lastTurnsCount?: number | null;
  directTask?: boolean | null;
  inputKind?: string | null;
  itOk?: boolean | null;
  intentBand?: string | null;
  tLayerHint?: string | null;

  // ✅ 追加：このターンの userText（観測の唯一ソース）
  userText?: string | null;

  onePointText?: string | null;
  situationSummary?: string | null;
  depthStage?: string | null;
  phase?: string | null;
  qCode?: string | null;

  // ✅ 追加：flowDigest / flowTape（会話の“流れ”の短い要約とテープ）
  flowDigest?: string | null;
  flowTape?: string | null;
}): string {
  const obsUser = String(args.userText ?? '').trim();
  const obsOnePoint = String(args.onePointText ?? '').trim();
  const obsSummary = String(args.situationSummary ?? '').trim();

  // ✅ 観測は “このターンの userText” が最優先
  // - onePoint/summary は補助（ただし過去文が混ざり得るので最後）
  const obsPick =
    obsUser.length >= 6
      ? obsUser
      : obsOnePoint.length >= 6
        ? obsOnePoint
        : obsSummary.length >= 6
          ? obsSummary
          : '';

  const obsCard = [
    '【観測ルール（重要 / 背景禁止）】',
    '- obsPick は「このターンの userText（=いまの発話）から取れた観測」だけ。seedDraft/過去文/ONE_POINT/背景は材料にしない。',
    '- seedDraft の文言（例:「とても大きな質問なので…」）を本文に再利用するのは禁止。引用・再掲・言い換えも禁止。',
    '- 長期履歴・Q遷移・深度・IT/T・Anchor・RETURN 等の“背景”はここでは使わない（混ぜない）。',
    '',
    `obsUser=${obsUser || '(none)'}`,
    `obsOnePoint=${obsOnePoint || '(none)'}`,
    `obsSummary=${obsSummary || '(none)'}`,
    `obsPick=${obsPick || '(none)'}`,
    '',
    '【obsPick の入れ方（必須）】',
    '- 出力本文の冒頭〜中盤に、obsPick の語彙を含む「短い1文」を必ず入れる。',
    '- その1文は “見出し/タグ” を付けない（例：今の状況：/焦点：/ワンポイント：/入口： などは禁止）。',
    '- その1文は「説明」ではなく、観測をそのまま言い切る（余計な一般論を足さない）。',
    '',
    '【禁止（失敗判定）】',
    '- 推量語で濁す：かもしれません / 〜と思います / 〜でしょう / 可能性 / もし',
    '- 便利テンプレ：ことがある / 一つの手 / 自然に / きっかけになる / 整理してみると / 考えてみると',
    '- 見出しラベル：今の状況：/ 今ここで扱う焦点：/ まず一点：/ ワンポイント：/ 入口：',
    '',
    '【観測が無い場合】',
    '- 観測が無い場合のみ「仮置き」で1文に留める（推量で埋めない）。',
  ].join('\n');

  const flowDigest = String(args.flowDigest ?? '').trim();
  const flowTape = String(args.flowTape ?? '').trim();

  return [
    'INTERNAL PACK (DO NOT OUTPUT):',
    '',
    `lastTurnsCount=${args.lastTurnsCount ?? 0}`,
    `directTask=${String(args.directTask ?? false)}`,
    `inputKind=${args.inputKind ?? '(null)'}`,
    `itOk=${String(args.itOk ?? false)}`,
    `intentBand=${args.intentBand ?? '(null)'}`,
    `tLayerHint=${args.tLayerHint ?? '(null)'}`,
    '',
    'FLOW_HINT (DO NOT OUTPUT):',
    `flowDigest=${flowDigest || '(none)'}`,
    `flowTape=${flowTape || '(none)'}`,
    '',
    'HISTORY_HINT (DO NOT OUTPUT):',
    args.historyText || '(none)',
    '',
    'SEED DRAFT HINT (DO NOT OUTPUT):',
    args.seedDraftHint || '(none)',
    '',
    obsCard,
  ].join('\n');
}

// ---------------------------------------------
// basics
// ---------------------------------------------
function norm(s: unknown) {
  return String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function normLite(s: unknown) {
  return String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
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
    ...base, // ✅ 追加キーを落とさない
    traceId,
    conversationId: base.conversationId ?? null,
    userCode: base.userCode ?? null,
    renderEngine: base.renderEngine ?? true,
  };
}

// ---------------------------------------------
// slot extraction (slot-preserving)
// ---------------------------------------------
function stableOrderKeys(keys: string[]) {
  const ORDER = [
    'OBS',
    'SHIFT',
    'NEXT',
    'SAFE',
    'INSIGHT',
    // legacy-ish
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
 * extractSlotBlocks() と同等レンジから「key付き slots」を抽出する。
 * ✅ slotsが無い場合でも、content/assistantText から疑似slot(OBS)を作る
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

  // ✅ ILINE 等の制御マーカーはここで壊さない（lock抽出の素材なので保持）
  const normPreserveControl = (v: any): string => {
    const s = String(v ?? '');
    // 改行だけ正規化。余計な加工はしない（[[ILINE]] を残す）
    return s.replace(/\r\n/g, '\n').trim();
  };

  // ✅ slotsが無いケースを救う：contentから疑似slotを作る
  if (!slotsRaw) {
    const fallbackText = normPreserveControl(
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

      // ここが要点：norm() は使わない（ILINE を壊す可能性があるため）
      const text = normPreserveControl(s?.text ?? s?.value ?? s?.content ?? s?.message ?? s?.out ?? '');
      if (!key || !text) continue;

      out.push({ key, text });
    }
  } else if (typeof slotsRaw === 'object' && slotsRaw) {
    const keys = stableOrderKeys(Object.keys(slotsRaw));
    for (const k of keys) {
      const v = (slotsRaw as any)[k];

      const text = normPreserveControl(
        typeof v === 'string'
          ? v
          : v?.text ?? v?.content ?? v?.value ?? v?.message ?? v?.out ?? '',
      );
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

// ---------------------------------------------
// FIXED fallback (for FIXED mode)
// ---------------------------------------------
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
 *
 * ⚠️重要：ここでは norm() を使わない（段落 \n\n を潰す事故を防ぐ）
 */
function buildSlotsWithFirstText(inKeys: string[], firstText: string): Slot[] {
  const ZWSP = '\u200b';
  if (inKeys.length === 0) return [];

  const keepPara = (s: string) =>
    String(s ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim()
      .replace(/\n{3,}/g, '\n\n'); // 段落は残す（過剰な空行だけ畳む）

  const full = keepPara(firstText);

  if (!full) {
    return [
      { key: inKeys[0], text: '' },
      ...inKeys.slice(1).map((k) => ({ key: k, text: ZWSP })),
    ];
  }

  // 2行以上の空行で段落分割（1改行は文中改行として残す）
  const blocks = full
    .split(/\n\s*\n+/)
    .map((b) => keepPara(b))
    .filter((b) => b.length > 0);

  // ブロックが1つなら従来互換（先頭に全集約）
  if (blocks.length <= 1) {
    const out: Slot[] = [{ key: inKeys[0], text: full }];
    for (let i = 1; i < inKeys.length; i++) out.push({ key: inKeys[i], text: ZWSP });
    return out;
  }

  const out: Slot[] = [];
  const takeN = Math.min(inKeys.length, blocks.length);

  for (let i = 0; i < takeN; i++) out.push({ key: inKeys[i], text: blocks[i] });

  // blocks が余ったら最後に連結して落とさない
  if (blocks.length > inKeys.length && inKeys.length > 0) {
    const rest = blocks.slice(inKeys.length).join('\n\n');
    const lastIdx = inKeys.length - 1;
    out[lastIdx] = {
      key: inKeys[lastIdx],
      text: keepPara((out[lastIdx]?.text ?? '') + '\n\n' + rest),
    };
  }

  // keys が余ったらZWSPで埋める
  for (let i = takeN; i < inKeys.length; i++) out.push({ key: inKeys[i], text: ZWSP });

  return out;
}


// ---------------------------------------------
// recall-must-include（@RESTORE.last / @Q.ask）抽出
// ---------------------------------------------
function extractRecallMustIncludeFromSeed(seedDraftRaw: string): {
  restoreNeedle: string | null;
  questionNeedle: string | null;
} {
  const t = String(seedDraftRaw ?? '');

  let restoreNeedle: string | null = null;
  {
    const m =
      t.match(/@RESTORE[\s\S]*?"last"\s*:\s*"([^"]+)"/) ||
      t.match(/@RESTORE[\s\S]*?last"\s*:\s*"([^"]+)"/);
    if (m?.[1]) restoreNeedle = String(m[1]).trim();
  }

  let questionNeedle: string | null = null;
  {
    const m =
      t.match(/@Q[\s\S]*?"ask"\s*:\s*"([^"]+)"/) ||
      t.match(/@Q[\s\S]*?ask"\s*:\s*"([^"]+)"/);
    if (m?.[1]) questionNeedle = String(m[1]).trim();
  }

  return { restoreNeedle, questionNeedle };
}

function buildMustIncludeRuleText(args: {
  restoreNeedle: string | null;
  questionNeedle: string | null;
}): string {
  // recall-must-include（あれば“絶対保持”）
  const a = args.restoreNeedle
    ? `- 次の文を本文に**一字一句そのまま**含める：\n  ${args.restoreNeedle}`
    : '';
  const b = args.questionNeedle
    ? `- 次の問い（文）を本文に**一字一句そのまま**含める：\n  ${args.questionNeedle}`
    : '';

  const recallBody = [a, b].filter(Boolean).join('\n');

  // ✅ 追加：FLAGSHIPの“薄いテンプレ化”を誘発する語を禁止（HEDGE/GENERIC潰し）
  const bannedHedge = [
    'かもしれない',
    '可能性',
    '〜かも',
    'と思う',
    'だろう',
    'かもしれません',
    '可能性があります',
  ];

  const bannedGeneric = [
    '少し時間をかけて',
    '時間をかけて',
    '考えてみて',
    '考えてみる',
    '見つめてみて',
    '見つめてみる',
    'ゆっくり',
    '自分のペースで',
  ];

  const styleRules = [
    '【表現ルール（FLAGSHIP）】',
    '- 推量語は禁止（例：' + bannedHedge.join(' / ') + '）。',
    '- 一般論・励ましテンプレは禁止（例：' + bannedGeneric.join(' / ') + '）。',
    '- ユーザー入力に含まれる語・事実のみを素材にする（新しい助言／判断／一般論を足さない）。',
  ].join('\n');

  // recall があれば併記、無くても styleRules は常に返す
  const blocks: string[] = ['', styleRules];

  if (recallBody) {
    blocks.push(
      '',
      '【改変禁止（recall-must-include）】',
      '以下は“復元の足場”なので、削除・言い換え・要約は禁止。',
      recallBody,
    );
  }

  blocks.push('');
  return blocks.join('\n');
}

// ---------------------------------------------
// ✅ ONE_POINT scaffold helpers
// ---------------------------------------------
type SlotLike = { key?: string; text?: string; content?: string; value?: string };

const SCAFFOLD_PREFACE = 'いまの足場として一つだけ置く。違ったら捨てていい。';
const SCAFFOLD_PURPOSE = 'この文章は“答えを渡す”ためじゃなく、あなたが答えを出すための足場を置く。';

function getSlotText(s: SlotLike): string | null {
  const v = normLite(s.text ?? s.content ?? s.value ?? '');
  return v ? v : null;
}

function isScaffoldActive(slotsForGuard: SlotLike[] | null): boolean {
  const slots = Array.isArray(slotsForGuard) ? slotsForGuard : [];
  if (slots.length === 0) return false;

  const take = (s: any) => normLite(String(s?.text ?? s?.content ?? s?.value ?? ''));
  const hasPurposeSlot = !!slots.find((x: any) => /PURPOSE/i.test(String(x?.key ?? '')) && take(x));
  const hasOnePointSlot = !!slots.find((x: any) => /ONE_POINT/i.test(String(x?.key ?? '')) && take(x));
  const hasPoints3Slot = !!slots.find((x: any) => /POINTS_3/i.test(String(x?.key ?? '')) && take(x));

  // ✅ 新判定：構造スロットが揃っていれば scaffold
  if (hasPurposeSlot && hasOnePointSlot && hasPoints3Slot) return true;

  // ✅ 後方互換：旧 “固定文言” でも scaffold 扱いにできる（保険）
  const texts = slots
    .map((s) => getSlotText(s))
    .filter((x): x is string => Boolean(x));

  const hasPreface = texts.some((x) => x.includes(SCAFFOLD_PREFACE));
  const hasPurpose = texts.some((x) => x.includes(SCAFFOLD_PURPOSE));

  return hasPreface && hasPurpose;
}


function shouldEnforceOnePointGuard(slotKeys: string[] | null | undefined): boolean {
  if (!Array.isArray(slotKeys) || slotKeys.length === 0) return false;
  if (slotKeys.some((k) => /ONE_POINT/i.test(String(k)))) return true;
  if (slotKeys.some((k) => /^FLAG_ONE_POINT_/i.test(String(k)))) return true;
  return false;
}

function pickOnePointNeedle(
  slotsForGuard: SlotLike[] | null,
): { onePoint: string | null; source: string | null } {
  const slots = Array.isArray(slotsForGuard) ? slotsForGuard : [];
  if (slots.length === 0) return { onePoint: null, source: null };

  // (1) ONE_POINT key 優先（将来）
  for (const s of slots) {
    const k = String(s?.key ?? '').trim();
    if (!k) continue;
    if (/ONE_POINT/i.test(k)) {
      const t = getSlotText(s);
      if (t) return { onePoint: t, source: k };
    }
  }

  // (2) 現状想定：FLAG_DYNAMICS_1 を一点扱い
  for (const s of slots) {
    const k = String(s?.key ?? '').trim();
    if (k === 'FLAG_DYNAMICS_1') {
      const t = getSlotText(s);
      if (t) return { onePoint: t, source: k };
    }
  }

  // (保険) 最初の FLAG_DYNAMICS_*
  const dyn = slots
    .map((s) => ({ k: String(s?.key ?? '').trim(), t: getSlotText(s) }))
    .filter((x) => x.k.startsWith('FLAG_DYNAMICS_') && x.t);

  if (dyn.length > 0) return { onePoint: dyn[0]!.t!, source: dyn[0]!.k };

  return { onePoint: null, source: null };
}

function stripHedgeLite(text: string): string {
  let t = String(text ?? '');

  // “かもしれません”系だけを最小限で締める（意味追加しない）
  t = t.replace(/かもしれません/g, '感じがある。');
  t = t.replace(/かもしれない/g, '感じがある');
  t = t.replace(/もしかしたら/g, '');
  t = t.replace(/でしょう/g, '。');
  t = t.replace(/\bかも\b/g, '');

  t = t.replace(/。\s*。\s*/g, '。');
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/**
 * ✅ ONE_POINT 差し戻し（scaffoldがあるターンだけ）
 * - 「今の状況：」/「いまの一点：」行を優先固定（後方互換）
 * - なければ purpose 直後
 * - 最後は先頭行置換
 */
function restoreOnePointInOutput(args: { llmOut: string; onePoint: string }): string {
  const rawText0 = String(args.llmOut ?? '');
  const needleRaw = String(args.onePoint ?? '').trim();
  if (!rawText0.trim() || !needleRaw) return stripHedgeLite(rawText0);

  const normalizeOnePointLabel = (s: string) => {
    const x = String(s ?? '').trim();
    if (!x) return '';
    if (x.startsWith('今の状況：')) return x;
    if (x.startsWith('いまの一点：')) return `今の状況：${x.replace(/^いまの一点[:：]\s*/u, '').trim()}`;
    // ラベル無しで来た場合も「今の状況：」に寄せる
    return `今の状況：${x}`;
  };

  const needle = normalizeOnePointLabel(needleRaw);

  // 既に入ってるなら何もしない（hedgeは軽く除去して返す）
  if (normLite(rawText0).includes(normLite(needle))) return stripHedgeLite(rawText0);

  const lines = rawText0
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

  if (!lines.length) return stripHedgeLite(needle);

  // (1) 「今の状況：」or「いまの一点：」行があれば差し替える（「今の状況：」に統一）
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (ln.startsWith('今の状況：') || ln.startsWith('いまの一点：')) {
      lines[i] = needle;
      return stripHedgeLite(lines.join('\n'));
    }
  }

  // (2) scaffold purpose の直後に挿入
  const idxPurpose = lines.findIndex((x) => x.includes(SCAFFOLD_PURPOSE));
  if (idxPurpose >= 0) {
    lines.splice(idxPurpose + 1, 0, needle);
    return stripHedgeLite(lines.join('\n'));
  }

  // (3) 保険：先頭行を置換
  lines[0] = needle;
  return stripHedgeLite(lines.join('\n'));
}

function ensureOnePointInOutput(args: {
  slotsForGuard: SlotLike[] | null;
  llmOut: string;
}): {
  ok: boolean;
  out: string;
  missing: string[];
  needles: { onePoint: string | null; source: string | null };
} {
  const out0 = String(args.llmOut ?? '');
  const out = normLite(out0);
  if (!out) {
    return { ok: false, out: out0, missing: ['OUT_EMPTY'], needles: { onePoint: null, source: null } };
  }

  // scaffold じゃないターンは何もしない
  if (!isScaffoldActive(args.slotsForGuard)) {
    return { ok: true, out: out0, missing: [], needles: { onePoint: null, source: null } };
  }

  const picked = pickOnePointNeedle(args.slotsForGuard);

  if (!picked.onePoint) {
    return {
      ok: false,
      out: out0,
      missing: ['ONE_POINT_MISSING_IN_SLOTS'],
      needles: { onePoint: null, source: picked.source },
    };
  }

  // ✅ restore 側でラベル正規化されるので、ここは「存在チェック→無ければ restore」で十分
  if (out.includes(normLite(picked.onePoint))) {
    return { ok: true, out: out0, missing: [], needles: picked };
  }

  const restored = restoreOnePointInOutput({ llmOut: out0, onePoint: picked.onePoint });

  // ✅ 最終確認：差し戻した onePoint 本文（ラベル込み）が入っていること
  const restoredNorm = normLite(restored);
  const bodyNorm = normLite(
    String(picked.onePoint)
      .replace(/^(いまの一点|今の状況|ワンポイント|ポイント|足場)[:：]\s*/u, '')
      .trim(),
  );
  if (!restoredNorm.includes(bodyNorm)) {
    return { ok: false, out: restored, missing: ['ONE_POINT_NOT_PRESERVED'], needles: picked };
  }

  return { ok: true, out: restored, missing: [], needles: picked };
}

// ---------------------------------------------
// scaffold must-have（意味チェック）+ 復元
// ---------------------------------------------
function scaffoldMustHaveOk(args: {
  slotKeys: string[];
  slotsForGuard: SlotLike[] | null;
  llmOut: string;
}): { ok: boolean; missing: string[] } {
  const out = normLite(args.llmOut);
  if (!out) return { ok: false, missing: ['OUT_EMPTY'] };

  // scaffold 扱いでなければ何もしない
  if (!shouldEnforceOnePointGuard(args.slotKeys)) return { ok: true, missing: [] };

  const slots = Array.isArray(args.slotsForGuard) ? args.slotsForGuard : [];
  const take = (s: any) => normLite(String(s?.text ?? s?.content ?? s?.value ?? ''));

  const purposeSlot = slots.find((x: any) => /PURPOSE/i.test(String(x?.key ?? '')));
  const onePointSlot = slots.find((x: any) => /ONE_POINT/i.test(String(x?.key ?? '')));
  const points3Slot = slots.find((x: any) => /POINTS_3/i.test(String(x?.key ?? '')));

  const hasPurposeSlot = !!(purposeSlot && take(purposeSlot));
  const hasOnePointSlot = !!(onePointSlot && take(onePointSlot));
  const hasPoints3Slot = !!(points3Slot && take(points3Slot));

  // ✅ scaffold中は「構造slotsが揃っている」なら、本文の言い回し揺れで落とさない
  if (hasPurposeSlot && hasOnePointSlot && hasPoints3Slot) return { ok: true, missing: [] };

  const purposeNeedle = purposeSlot ? take(purposeSlot) : '';
  const onePointNeedle = onePointSlot ? take(onePointSlot) : '';
  const points3Needle = points3Slot ? take(points3Slot) : '';

  // 1) 足場フレーム
  const hasFrame =
    /(答えを渡さ|足場|いまは(結論|答え)を(出さ|急が)|決めなくて|まず.*(置く|作る))/u.test(out) ||
    (purposeNeedle && out.includes(purposeNeedle.slice(0, Math.min(18, purposeNeedle.length))));

  // 2) 一点
  const hasOnePoint =
    /(いまの一点|一点|焦点|ここで見(たい|る)のは|注目(点)?)/u.test(out) ||
    (onePointNeedle && out.includes(onePointNeedle.slice(0, Math.min(10, onePointNeedle.length))));

  // 3) 見る軸（2系統以上）
  const axesLabels = (() => {
    if (!points3Needle) return [];
    return points3Needle
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => x.replace(/^[・\-\*\u2022]\s*/g, ''))
      .map((x) => {
        const i = x.indexOf('（');
        return (i >= 0 ? x.slice(0, i) : x).trim();
      })
      .filter((x) => x.length >= 2)
      .slice(0, 4);
  })();

  const axesHits = axesLabels.filter((lb) => out.includes(lb));
  const hasAxes =
    axesHits.length >= 2 ||
    (() => {
      const a1 = /(タイミング|前\s*\/\s*最中\s*\/\s*後|いつ出る)/u.test(out);
      const a2 = /(守る理由|失いたくない|守ってる|保ってる)/u.test(out);
      const a3 = /(引っかか|止めてる|止まる|ひっかか)/u.test(out);
      return [a1, a2, a3].filter(Boolean).length >= 2;
    })();

  const missing: string[] = [];
  if (!hasFrame) missing.push('SCAFFOLD_NEED_FRAME');
  if (!hasOnePoint) missing.push('SCAFFOLD_NEED_ONE_POINT');
  if (!hasAxes) missing.push('SCAFFOLD_NEED_AXES');

  return { ok: missing.length === 0, missing };
}

function restoreScaffoldMustHaveInOutput(args: {
  llmOut: string;
  slotsForGuard: SlotLike[] | null;
  missing: string[];
}): string {
  let out = String(args.llmOut ?? '');
  const slots = Array.isArray(args.slotsForGuard) ? args.slotsForGuard : [];
  const take = (s: any) => normLite(String(s?.text ?? s?.content ?? s?.value ?? ''));

  const onePointSlot = slots.find((x: any) => /ONE_POINT/i.test(String(x?.key ?? '')));
  const points3Slot = slots.find((x: any) => /POINTS_3/i.test(String(x?.key ?? '')));

  const onePointNeedle = onePointSlot ? take(onePointSlot) : '';
  const points3Needle = points3Slot ? take(points3Slot) : '';

  const miss = new Set((args.missing ?? []).map((x) => String(x)));
  const k = (normLite(out).length + normLite(onePointNeedle).length) % 3;

  const addFrame = () => {
    const v =
      k === 0
        ? 'ここでは答えを渡しません。あなたが答えを出せる位置に足場を置きます。'
        : k === 1
          ? 'いまは結論を急がない。考えるための足場だけ整えます。'
          : '答えを決める前に、まず“考えが動く場所”を作ります。';
    out = v + '\n' + out;
  };

  const addOnePoint = () => {
    const base = onePointNeedle
      ? onePointNeedle
          .replace(/^今の状況[:：]\s*/u, '')
          .replace(/^いまの一点[:：]\s*/u, '')
          .trim()
      : '';

    if (!base) return;

    const variants = [
      `${base}——まずはここだけを置いておく。`,
      `${base}。いまはここ一点だけで十分。`,
      `${base}。ここから先は、焦らず一つずつでいい。`,
    ] as const;

    const v = variants[Math.abs(k) % variants.length];

    out = out + '\n' + v;
  };

  const addAxes = () => {
    const labels = (() => {
      if (!points3Needle) return [];
      const bad = (s: string) =>
        /(見る場所は3つだけ|見る軸|いまの一点|今ここで扱う|焦点|足場|答えを渡さ)/u.test(s);

      return points3Needle
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => x.replace(/^[・\-\*\u2022]\s*/g, ''))
        .map((x) => {
          const i = x.indexOf('（');
          return (i >= 0 ? x.slice(0, i) : x).trim();
        })
        .map((x) => x.replace(/[:：]\s*$/u, '').trim())
        .filter((x) => x.length >= 2)
        .filter((x) => !bad(x))
        .slice(0, 4);
    })();

    const pick2 = labels.length >= 2 ? labels.slice(0, 2) : labels;
    const v =
      pick2.length >= 2
        ? `見る軸はこの2つだけ残しておけば足ります：${pick2[0]}／${pick2[1]}。`
        : k === 0
          ? '見る軸は2つだけ残せば進みます（例：出るタイミング／守っている理由）。'
          : k === 1
            ? '確認するのは2点だけでいい（いつ出るか／何を守ってるか）。'
            : '見る場所を増やさない。2点だけで動かす（タイミングと理由）。';

    out = out + '\n' + v;
  };

  if (miss.has('SCAFFOLD_NEED_FRAME')) addFrame();
  // if (miss.has('SCAFFOLD_NEED_ONE_POINT')) addOnePoint(); // ← 意図どおり “追記復元” は無効
  if (miss.has('SCAFFOLD_NEED_AXES')) addAxes();

  return out;
}

// ---------------------------------------------
// IT成立（証拠）/ intentBand / shouldRaiseFlag / continuityGate を userContext から読む
// ---------------------------------------------
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
  const hintOk = tLayerHint && /^(?:[SRICT][123]|T[123])$/u.test(tLayerHint) ? tLayerHint : null;

  return { intentBand: bandOk, tLayerHint: hintOk };
}

function readShouldRaiseFlagFromContext(userContext: unknown): { on: boolean; reason: string | null } {
  if (!userContext || typeof userContext !== 'object') return { on: false, reason: null };
  const uc: any = userContext as any;

  const on =
    Boolean(
      tryGet(uc, ['shouldRaiseFlag']) ??
        tryGet(uc, ['meta', 'shouldRaiseFlag']) ??
        tryGet(uc, ['meta', 'extra', 'shouldRaiseFlag']) ??
        tryGet(uc, ['extra', 'shouldRaiseFlag']) ??
        tryGet(uc, ['ctxPack', 'shouldRaiseFlag']) ??
        tryGet(uc, ['ctxPack', 'meta', 'extra', 'shouldRaiseFlag']) ??
        tryGet(uc, ['ctx_pack', 'shouldRaiseFlag']) ??
        tryGet(uc, ['ctx_pack', 'meta', 'extra', 'shouldRaiseFlag']) ??
        tryGet(uc, ['memoryState', 'shouldRaiseFlag']) ??
        tryGet(uc, ['orchestratorState', 'shouldRaiseFlag']) ??
        false,
    ) === true;

  const reasonsRaw =
    (tryGet(uc, ['flagReasons']) ??
      tryGet(uc, ['flag_reasons']) ??
      tryGet(uc, ['meta', 'flagReasons']) ??
      tryGet(uc, ['meta', 'flag_reasons']) ??
      tryGet(uc, ['meta', 'extra', 'flagReasons']) ??
      tryGet(uc, ['meta', 'extra', 'flag_reasons']) ??
      tryGet(uc, ['extra', 'flagReasons']) ??
      tryGet(uc, ['extra', 'flag_reasons']) ??
      tryGet(uc, ['ctxPack', 'flagReasons']) ??
      tryGet(uc, ['ctxPack', 'flag_reasons']) ??
      tryGet(uc, ['ctxPack', 'meta', 'extra', 'flagReasons']) ??
      tryGet(uc, ['ctxPack', 'meta', 'extra', 'flag_reasons']) ??
      tryGet(uc, ['ctx_pack', 'flagReasons']) ??
      tryGet(uc, ['ctx_pack', 'flag_reasons']) ??
      tryGet(uc, ['ctx_pack', 'meta', 'extra', 'flagReasons']) ??
      tryGet(uc, ['ctx_pack', 'meta', 'extra', 'flag_reasons']) ??
      null) as any;

  let reasonFromArray: string | null = null;
  if (Array.isArray(reasonsRaw) && reasonsRaw.length > 0) {
    reasonFromArray = norm(String(reasonsRaw[0] ?? '')) || null;
  } else if (typeof reasonsRaw === 'string') {
    const first = reasonsRaw.split(/[,\s|]+/).filter(Boolean)[0];
    reasonFromArray = norm(String(first ?? '')) || null;
  }

  const reasonSingle =
    norm(
      String(
        tryGet(uc, ['flagReason']) ??
          tryGet(uc, ['flag_reason']) ??
          tryGet(uc, ['meta', 'flagReason']) ??
          tryGet(uc, ['meta', 'flag_reason']) ??
          tryGet(uc, ['meta', 'extra', 'flagReason']) ??
          tryGet(uc, ['meta', 'extra', 'flag_reason']) ??
          tryGet(uc, ['extra', 'flagReason']) ??
          tryGet(uc, ['extra', 'flag_reason']) ??
          tryGet(uc, ['ctxPack', 'flagReason']) ??
          tryGet(uc, ['ctxPack', 'flag_reason']) ??
          tryGet(uc, ['ctxPack', 'meta', 'extra', 'flagReason']) ??
          tryGet(uc, ['ctxPack', 'meta', 'extra', 'flag_reason']) ??
          tryGet(uc, ['ctx_pack', 'flagReason']) ??
          tryGet(uc, ['ctx_pack', 'flag_reason']) ??
          tryGet(uc, ['ctx_pack', 'meta', 'extra', 'flagReason']) ??
          tryGet(uc, ['ctx_pack', 'meta', 'extra', 'flag_reason']) ??
          '',
      ),
    ) || null;

  const reason = reasonFromArray ?? reasonSingle;
  return { on, reason };
}

// ---------------------------------------------
// continuity gate（鮮度ゲート / 合意）を userContext から読む
// - 続き口調を “許可する条件” をここで取り出せるようにする
// - 内部事情は本文に出さない（制御だけに使う）
// ---------------------------------------------
function readContinuityGateFromContext(userContext: unknown): {
  fresh: boolean | null;
  sessionBreak: boolean | null;
  breakReason: string | null;
  ageSec: number | null;
  userAckOk: boolean | null;
  userAckReason: string | null;
} {
  if (!userContext || typeof userContext !== 'object') {
    return {
      fresh: null,
      sessionBreak: null,
      breakReason: null,
      ageSec: null,
      userAckOk: null,
      userAckReason: null,
    };
  }
  const uc: any = userContext as any;

  const freshRaw =
    tryGet(uc, ['ctxPack', 'flow', 'fresh']) ??
    tryGet(uc, ['ctx_pack', 'flow', 'fresh']) ??
    tryGet(uc, ['ctxPack', 'flow', 'isFresh']) ??
    tryGet(uc, ['ctx_pack', 'flow', 'isFresh']) ??
    null;

  const sessionBreakRaw =
    tryGet(uc, ['ctxPack', 'flow', 'sessionBreak']) ??
    tryGet(uc, ['ctx_pack', 'flow', 'sessionBreak']) ??
    tryGet(uc, ['ctxPack', 'flow', 'session_break']) ??
    tryGet(uc, ['ctx_pack', 'flow', 'session_break']) ??
    null;

  const breakReason =
    norm(
      String(
        tryGet(uc, ['ctxPack', 'flow', 'breakReason']) ??
          tryGet(uc, ['ctx_pack', 'flow', 'breakReason']) ??
          tryGet(uc, ['ctxPack', 'flow', 'break_reason']) ??
          tryGet(uc, ['ctx_pack', 'flow', 'break_reason']) ??
          '',
      ),
    ) || null;

  const ageSecRaw =
    tryGet(uc, ['ctxPack', 'flow', 'ageSec']) ??
    tryGet(uc, ['ctx_pack', 'flow', 'ageSec']) ??
    tryGet(uc, ['ctxPack', 'flow', 'age_sec']) ??
    tryGet(uc, ['ctx_pack', 'flow', 'age_sec']) ??
    null;

  const userAckOkRaw =
    tryGet(uc, ['ctxPack', 'flow', 'userAck', 'ok']) ??
    tryGet(uc, ['ctx_pack', 'flow', 'userAck', 'ok']) ??
    tryGet(uc, ['ctxPack', 'flow', 'user_ack', 'ok']) ??
    tryGet(uc, ['ctx_pack', 'flow', 'user_ack', 'ok']) ??
    null;

  const userAckReason =
    norm(
      String(
        tryGet(uc, ['ctxPack', 'flow', 'userAck', 'reason']) ??
          tryGet(uc, ['ctx_pack', 'flow', 'userAck', 'reason']) ??
          tryGet(uc, ['ctxPack', 'flow', 'user_ack', 'reason']) ??
          tryGet(uc, ['ctx_pack', 'flow', 'user_ack', 'reason']) ??
          '',
      ),
    ) || null;

  const fresh = typeof freshRaw === 'boolean' ? freshRaw : freshRaw == null ? null : Boolean(freshRaw);
  const sessionBreak =
    typeof sessionBreakRaw === 'boolean' ? sessionBreakRaw : sessionBreakRaw == null ? null : Boolean(sessionBreakRaw);

  const ageSec =
    typeof ageSecRaw === 'number'
      ? ageSecRaw
      : typeof ageSecRaw === 'string' && ageSecRaw.trim() && Number.isFinite(Number(ageSecRaw))
        ? Number(ageSecRaw)
        : null;

  const userAckOk =
    typeof userAckOkRaw === 'boolean' ? userAckOkRaw : userAckOkRaw == null ? null : Boolean(userAckOkRaw);

  return { fresh, sessionBreak, breakReason, ageSec, userAckOk, userAckReason };
}


// ---------------------------------------------
// inputKind
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

  if (directTask) {
    return '（内部ヒント：具体策を先に。一般論・過去文の引用/再掲/言い換えは禁止）';
  }

  let out = s;

  if (/find_trigger_point/i.test(out)) {
    out = out.replace(/.*find_trigger_point.*(\n|$)/gi, '').trim();
  }

  if (out.length > 600) out = out.slice(0, 600).trim();

  return out;
}

// ---------------------------------------------
// logs
// ---------------------------------------------
function logRephraseOk(debug: DebugFinal | null | undefined, outKeys: string[], raw: string, mode?: string) {
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
  const blocksLen =
    Array.isArray((debug as any)?.rephraseBlocks) ? (debug as any).rephraseBlocks.length : null;

  console.log('[IROS/rephraseEngine][AFTER_ATTACH]', {
    traceId: debug?.traceId ?? null,
    conversationId: debug?.conversationId ?? null,
    userCode: debug?.userCode ?? null,
    mode: mode ?? null,
    renderEngine: debug?.renderEngine ?? true,
    outKeysLen: outKeys.length,
    rephraseBlocksLen: blocksLen,
    rephraseHead: safeHead(String(firstText ?? ''), 120),
  });
}

// ---------------------------------------------
// helpers: candidate pipeline
// ---------------------------------------------
function makeCandidate(text: string, maxLines: number, renderEngine: boolean) {
  const raw = clampLines(String(text ?? ''), maxLines);
  return finalizeLamp(raw, renderEngine);
}

function shouldRejectWarnToSeedFactory(args: {
  inKeys: string[];
  scaffoldActive: boolean;
}) {
  const { inKeys, scaffoldActive } = args;

  const isFlagReplyLike =
    Array.isArray(inKeys) && inKeys.length > 0 && inKeys.every((k) => String(k).startsWith('FLAG_'));
  const isStabilizePack =
    Array.isArray(inKeys) && inKeys.includes('OBS') && inKeys.includes('SHIFT') && inKeys.includes('NEXT');

  return (verdict: any) => {
    if (scaffoldActive) return false;

    const level = String(verdict?.level ?? '').toUpperCase();
    if (level !== 'WARN') return false;

    const reasons = new Set((verdict?.reasons ?? []).map((x: any) => String(x)));
    const genericBad = reasons.has('GENERIC_MANY') || reasons.has('GENERIC_PRESENT');
    const hedgeBad = reasons.has('HEDGE_PRESENT') || reasons.has('HEDGE_MANY');
    const cheerBad = reasons.has('CHEER_PRESENT') || reasons.has('CHEER_MANY');

    if (isFlagReplyLike) return genericBad || hedgeBad || cheerBad;
    if (isStabilizePack) return genericBad && (hedgeBad || cheerBad);

    return false;
  };
}
// ---------------------------------------------
// FINAL用：slotを保ったまま “会話本文” を作る
// ---------------------------------------------
export async function rephraseSlotsFinal(extracted: ExtractedSlots, opts: RephraseOptions): Promise<RephraseResult> {
  const debug = ensureDebugFinal(opts.debug);

  if (!extracted) {
    logRephraseOk(debug, [], '', 'NO_SLOTS');
    return { ok: false, reason: 'NO_SLOTS', meta: { inKeys: [], rawLen: 0, rawHead: '' } };
  }

  const enabled = envFlagEnabled(process.env.IROS_REPHRASE_FINAL_ENABLED, true);
  console.log('[IROS/REPHRASE_FLAG]', { raw: process.env.IROS_REPHRASE_FINAL_ENABLED, enabled });

  if (!enabled) {
    logRephraseOk(debug, extracted.keys, '', 'DISABLED');
    return { ok: false, reason: 'REPHRASE_DISABLED_BY_ENV', meta: { inKeys: extracted.keys, rawLen: 0, rawHead: '' } };
  }

  const mode = String(process.env.IROS_REPHRASE_FINAL_MODE ?? 'LLM').trim().toUpperCase();

  const maxLines =
    Number(process.env.IROS_REPHRASE_FINAL_MAXLINES) > 0
      ? Math.floor(Number(process.env.IROS_REPHRASE_FINAL_MAXLINES))
      : Math.max(4, Math.min(12, Math.floor(opts.maxLinesHint ?? 8)));

  const inKeys = extracted.keys;

  // ------------------------------------------------------------
  // SHIFT slot はこの関数で 1回だけ取得して使い回す
  // ------------------------------------------------------------
  const shiftSlot = Array.isArray((extracted as any)?.slots)
    ? (extracted as any).slots.find((s: any) => String(s?.key) === 'SHIFT')
    : null;

  console.log('[IROS/rephraseEngine][SHIFT_SLOT_HEAD]', {
    hasShiftSlot: !!shiftSlot,
    shiftSlotLen: shiftSlot?.text ? String(shiftSlot.text).length : 0,
    shiftSlotHead: shiftSlot?.text ? safeHead(String(shiftSlot.text), 220) : null,
  });

  // SHIFT.text から JSON 部分を抽出して parse（失敗したら null）
  // - 例: '@SHIFT {...}' / '{...}' のどちらも対応
  const parseShiftJson = (t?: string | null): any | null => {
    const raw = String(t ?? '').trim();
    if (!raw) return null;

    const i0 = raw.indexOf('{');
    const i1 = raw.lastIndexOf('}');
    if (i0 < 0 || i1 < 0 || i1 <= i0) return null;

    const jsonText = raw.slice(i0, i1 + 1).trim();
    try {
      return JSON.parse(jsonText);
    } catch {
      return null;
    }
  };

  // ✅ “内部マーカー” だけ落とす（ユーザーの @mention 等は落とさない）
  const INTERNAL_LINE_MARKER = /^@(OBS|SHIFT|SH|RESTORE|Q|SAFE|NEXT|END|TASK)\b/;

  // ✅ ILINE抽出用：内部マーカー行だけ除外（ILINEタグは保持する）
  const stripInternalMarkersForLock = (s: string) => {
    const lines = String(s ?? '')
      .split('\n')
      .map((x) => String(x ?? '').trimEnd());
    const kept = lines.filter((line) => {
      const t = String(line ?? '').trim();
      if (!t) return false;
      if (INTERNAL_LINE_MARKER.test(t)) return false;
      return true;
    });
    return kept.join('\n').trim();
  };

  // ✅ blocks 生成（renderGateway が block 意図で拾える形）
  // NOTE: ここは "string[]" を返す。{text,kind} 化は adoptAsSlots 側で 1 回だけ行う。
  const toRephraseBlocks = (s: string): string[] => {
    const raw = String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!raw) return [];

    // 1) 空行で段落ブロック化
    let parts = raw
      .split(/\n{2,}/g)
      .map((b) => b.trim())
      .filter(Boolean);

    // 2) 1ブロックしか取れないなら、単改行でブロック化（2行でもOK）
    if (parts.length <= 1) {
      const lines = raw
        .split('\n')
        .map((x) => String(x ?? '').trim())
        .filter(Boolean);
      if (lines.length >= 2) parts = lines;
    }

    return parts.slice(0, 8);
  };

  // (A) FIXED
  if (mode === 'FIXED') {
    const fixedTexts = buildFixedBoxTexts(inKeys.length);
    const out: Slot[] = inKeys.map((k, i) => ({ key: k, text: fixedTexts[i] ?? 'ここで止める。' }));

    logRephraseOk(debug, out.map((x) => x.key), out[0]?.text ?? '', 'FIXED');
    logRephraseAfterAttach(debug, out.map((x) => x.key), out[0]?.text ?? '', 'FIXED');

    const text0 = String(out[0]?.text ?? '').trim();
    const metaExtra: any = {
      rephraseBlocks: text0 ? [{ text: text0, kind: 'p' }] : [],
      rephraseHead: text0 ? safeHead(text0, 120) : null,
    };

    return {
      ok: true,
      slots: out,
      meta: {
        inKeys,
        outKeys: out.map((x) => x.key),
        rawLen: 0,
        rawHead: '',
        extra: metaExtra,
      },
    };
  }

  // (B) LLM
  const userText = norm(opts?.userText ?? '');
  const metaText = safeContextToText(opts?.userContext ?? null);

  const inputKindFromOpts = String(opts?.inputKind ?? '').trim().toLowerCase();
  const inputKindFromDebug = String((opts as any)?.debug?.inputKind ?? '').trim().toLowerCase();

  const inputKindFromCtx = extractInputKindFromContext(opts?.userContext ?? null);
  const inputKindFromMeta = extractInputKindFromMetaText(metaText);

  // ✅ 優先順位：opts.inputKind → debug.inputKind → userContext → metaText
  const inputKind =
    (inputKindFromOpts || null) ??
    (inputKindFromDebug || null) ??
    inputKindFromCtx ??
    inputKindFromMeta;

  const isDirectTask = extractDirectTask(userText, inputKind);

  const historyText = extractHistoryTextFromContext(opts?.userContext ?? null);
  const lastTurns = extractLastTurnsFromContext(opts?.userContext ?? null);

  // slot由来の下書き（露出禁止）
  const seedDraftRawAll = extracted.slots.map((s) => s.text).filter(Boolean).join('\n');

  const seedDraftRaw = extracted.slots
    .filter((s) => {
      const k = String((s as any)?.key ?? '');

      const ut = String(userText ?? '').trim();
      const isVeryShort = ut.length > 0 && ut.length <= 10;

      const isGreeting =
        /^(こんにちは|こんばんは|おはよう|もしもし|やあ|ハロー|hello|hi|hey|おつかれ|お疲れ)\b/i.test(ut);

      const isAckWord =
        /^(ありがとう|ありがとうございます|どうも|感謝|了解|りょうかい|わかった|分かった|OK|ok|おけ|オケ|承知|了解です|了解しました|お願いします|よろしく|宜しく)\b/.test(
          ut,
        );

      const isAckLike = isAckWord || (isVeryShort && !isGreeting);

      const hasOBS = extracted.slots.some((x) => String((x as any)?.key ?? '') === 'OBS');

      if (isAckLike) {
        if (hasOBS) return k === 'OBS';
        return k === 'SEED_TEXT' || k === 'DRAFT' || k === 'OBS';
      }

      if (k === 'OBS') return true;
      if (k === 'DRAFT') return true;
      if (k === 'SEED_TEXT') return true;

      if (k === 'SHIFT') return true;
      if (k === 'NEXT') return true;
      if (k === 'END') return true;
      if (k === 'ONE_POINT') return true;

      if (k.startsWith('FLAG_')) return true;

      return false;
    })
    .map((s) => s.text)
    .filter(Boolean)
    .join('\n');

  const recallMust = extractRecallMustIncludeFromSeed(seedDraftRawAll);
  const mustIncludeRuleText = buildMustIncludeRuleText(recallMust);

  // ILINE抽出：slot + userText 両方から拾う（seed 側は内部マーカー除外）
  const seedForLock = stripInternalMarkersForLock(seedDraftRaw);
  const lockSourceRaw = [seedForLock, userText].filter(Boolean).join('\n');

  console.info('[IROS/ILINE][LOCK_SOURCE]', {
    hasSeed: !!seedForLock,
    hasUser: !!userText,
    seedLen: String(seedForLock ?? '').length,
    userLen: String(userText ?? '').length,
    hasILINE_seed: /\[\[ILINE\]\]/.test(String(seedForLock ?? '')),
    hasILINE_user: /\[\[ILINE\]\]/.test(String(userText ?? '')),
    hasILINE_any: /\[\[ILINE\]\]/.test(String(lockSourceRaw ?? '')),
    hasILINE_END_any: /\[\[\/ILINE\]\]/.test(String(lockSourceRaw ?? '')),
    head200: String(lockSourceRaw ?? '').slice(0, 200),
    tail200: String(lockSourceRaw ?? '').slice(-200),
  });

  const { locked: lockedFromAll } = extractLockedILines(lockSourceRaw);

  // ✅ LLMに渡す素材は slot 由来のみ（重複防止）
  const { cleanedForModel: seedDraft0 } = extractLockedILines(seedForLock);
  const lockedILines = Array.from(new Set(lockedFromAll));

  console.info('[IROS/ILINE][LOCK_EXTRACT]', {
    lockedFromAllLen: Array.isArray(lockedFromAll) ? lockedFromAll.length : null,
    lockedUniqueLen: lockedILines.length,
    lockedUniqueHead200: String(lockedILines?.[0] ?? '').slice(0, 200),
  });

  const sanitizeSeedDraftForLLM = (s: string) => {
    const lines = String(s ?? '')
      .split('\n')
      .map((x) => String(x ?? '').trimEnd());

    const kept = lines.filter((line) => {
      const t = String(line ?? '').trim();
      if (!t) return false;
      if (INTERNAL_LINE_MARKER.test(t)) return false;
      if (/\[\[ILINE\]\]/.test(t) || /\[\[\/ILINE\]\]/.test(t)) return false;
      return true;
    });

    return kept.join('\n').trim();
  };

  const chooseSeedForLLM = (seed: string, userText: string) => {
    const s = String(seed ?? '').trim();
    const u = String(userText ?? '').trim();
    if (!u) return s;
    if (!s) return u;

    const tokens = Array.from(
      new Set(u.split(/[^\p{L}\p{N}一-龥ぁ-んァ-ヶー]+/u).filter(Boolean)),
    );
    const keyTokens = tokens.filter((t) => t.length >= 2).slice(0, 8);
    const hit = keyTokens.some((t) => s.includes(t));

    const abstractish = /見失わなければ|ここからは|整えなくていい|進む|動いてる|止まった/u.test(s);

    if (!hit || abstractish) return u;
    return s;
  };

  const seedDraftSanitized = sanitizeSeedDraftForLLM(seedDraft0);
  const seedFinal = chooseSeedForLLM(seedDraftSanitized, userText);

  function humanizeDirectivesForSeed(seedDraft0: string, userText: string): string {
    const raw = String(seedDraft0 ?? '').trim();
    if (!raw) return '';

    const hasOBS = /@OBS\b/.test(raw);
    const hasSHIFT = /@SHIFT\b/.test(raw) || /@SH\b/.test(raw);
    const hasRESTORE = /@RESTORE\b/.test(raw);
    const hasQ = /@Q\b/.test(raw);

    const lines: string[] = [];

    const ut = String(userText ?? '').trim();
    if (ut) lines.push(ut);

    const tags: string[] = [];
    if (hasOBS) tags.push('観測');
    if (hasSHIFT) tags.push('ずれ/方向');
    if (hasRESTORE) tags.push('焦点');
    if (hasQ) tags.push('問い');

    if (tags.length > 0) {
      lines.push('');
      lines.push(`（手がかり: ${tags.join(' / ')}）`);
    }

    return lines.join('\n').trim();
  }

  const seedDraft =
    seedFinal ||
    (/@(OBS|SHIFT|SH|RESTORE|Q|SAFE|NEXT|END|TASK)\b/m.test(String(seedDraft0 ?? ''))
      ? humanizeDirectivesForSeed(String(seedDraft0 ?? ''), userText)
      : '');

  const seedDraftHint = adaptSeedDraftHintForWriter(seedDraft, isDirectTask);
  const itOk = readItOkFromContext(opts?.userContext ?? null);
  const band = extractIntentBandFromContext(opts?.userContext ?? null);


// 既存の `lastTurns` をそのまま使い、再宣言しない
const lastTurnsSafe = (() => {
  const t0 = Array.isArray(lastTurns) ? lastTurns : []; // lastTurns が配列でない場合、空配列に初期化

  while (t0.length > 0 && t0[t0.length - 1]?.role === 'user') t0.pop();

  if (isDirectTask) {
    const users = t0
      .filter((m: any) => m?.role === 'user')
      .map((m: any) => ({ role: 'user' as const, content: String(m?.content ?? '') }))
      .filter((m: any) => m.content.trim().length > 0);
    return users.slice(-2);  // 最後の2件を返す
  }

  const t = t0
    .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && String(m?.content ?? '').trim())
    .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: String(m.content ?? '') }));

  return t.slice(-4);  // 最後の4件を返す
})();




  const flowDigest = readFlowDigest(opts?.userContext ?? null);
  const flowTape = readFlowTape(opts?.userContext ?? null);

  const systemPrompt =
    systemPromptForFullReply({
      directTask: isDirectTask,
      itOk,
      band,
      lockedILines,
    }) + mustIncludeRuleText;

  const internalPack = buildInternalPackText({
    metaText,
    historyText,
    seedDraftHint,
    lastTurnsCount: lastTurnsSafe.length,
    itOk,
    directTask: isDirectTask,
    inputKind,
    intentBand: band.intentBand,
    tLayerHint: band.tLayerHint,
    userText,
    onePointText: null,
    situationSummary: null,
    depthStage: null,
    phase: null,
    qCode: null,
    flowDigest,
    flowTape,
  });

  const messages = buildFirstPassMessages({ systemPrompt, internalPack });

  // ログ確認
  console.log('[IROS/rephraseEngine][MSG_PACK]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    lastTurns: lastTurnsSafe.length,
    hasHistoryText: Boolean(historyText),
    msgCount: messages.length,
    roles: messages.map((m) => m.role),
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
  // seedFromSlots（fallback用）
  // ---------------------------------------------
  const renderEngine = Boolean(debug.renderEngine ?? true);

  const seedFromSlotsRaw = (extracted?.slots ?? [])
    .map((s: any) => String(s?.text ?? ''))
    .filter((s: string) => {
      const line = String(s ?? '').trim();
      if (!line) return false;
      if (INTERNAL_LINE_MARKER.test(line)) return false;
      if (/\[\[ILINE\]\]/.test(line) || /\[\[\/ILINE\]\]/.test(line)) return false;
      return true;
    })
    .join('\n');

  const seedFromSlots = seedFromSlotsRaw ? makeCandidate(seedFromSlotsRaw, maxLines, renderEngine) : '';

  // ---------------------------------------------
  // shared validators
  // ---------------------------------------------
  const validateOutput = (rawText: string): { ok: boolean; reason?: string } => {
    const raw = String(rawText ?? '');

    if (!raw.trim()) return { ok: false, reason: 'OUT_EMPTY' };
    if (containsForbiddenLeakText(raw)) return { ok: false, reason: 'INTERNAL_MARKER_LEAKED' };

    const iLineOk = verifyLockedILinesPreserved(raw, lockedILines);
    if (!iLineOk) return { ok: false, reason: 'ILINE_NOT_PRESERVED' };

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

    if (!recallCheck.ok) return { ok: false, reason: 'RECALL_GUARD_REJECT' };

    return { ok: true };
  };

  // ---------------------------------------------
  // adopt helper（slot attach + meta）
  // ---------------------------------------------
  let lastFlagshipVerdict: any = null;
  let lastFlagshipHead: string | null = null;

  const adoptAsSlots = (text: string, note?: string, extra?: any): RephraseResult => {
    const outSlots = buildSlotsWithFirstText(inKeys, text);

    const raiseIn = readShouldRaiseFlagFromContext(opts?.userContext ?? null);
    const metaExtra: any = { ...(extra ?? {}) };

    if (raiseIn.on === true) {
      metaExtra.shouldRaiseFlag = true;
      metaExtra.flagReasons = raiseIn.reason ? [raiseIn.reason] : [];
    }

    if (lastFlagshipVerdict) {
      metaExtra.flagshipVerdict = lastFlagshipVerdict;
      if (lastFlagshipHead) metaExtra.flagshipHead = lastFlagshipHead;
    } else {
      metaExtra.flagshipVerdict = { level: null, ok: null, reasons: [] as string[], score: null };
    }

    const blocksText = toRephraseBlocks(text);
    const blocks = blocksText.map((t) => ({ text: t, kind: 'p' }));

    metaExtra.rephraseBlocks = blocks;
    metaExtra.rephraseHead =
      metaExtra.rephraseHead ??
      (blocks?.[0]?.text ? safeHead(String(blocks[0].text), 120) : null);

    try {
      (debug as any).rephraseBlocks = blocks;
    } catch {}

    logRephraseAfterAttach(debug, inKeys, outSlots[0]?.text ?? '', note ?? 'LLM');

    return {
      ok: true,
      slots: outSlots,
      meta: {
        inKeys,
        outKeys: outSlots.map((x) => x.key),
        rawLen: String(text ?? '').length,
        rawHead: safeHead(String(text ?? ''), 80),
        note,
        extra: metaExtra,
      },
    };
  };

  const runFlagship = (text: string, slotsForGuard: any, scaffoldActive: boolean) => {
    const raw = String(text ?? '');
    const textForGuard = raw;

    let v = flagshipGuard(textForGuard, {
      slotKeys: Array.isArray(inKeys) ? inKeys : null,
      slotsForGuard: Array.isArray(slotsForGuard) ? slotsForGuard : null,
    });

    // ✅ scaffold中は scaffold系欠落理由を “構造must-have” と整合させる
    if (scaffoldActive && Array.isArray(slotsForGuard)) {
      const mhFinal = scaffoldMustHaveOk({
        slotKeys: inKeys,
        slotsForGuard,
        llmOut: String(text ?? ''),
      });

      if (mhFinal.ok) {
        const drop = new Set([
          'SCAFFOLD_PURPOSE_MISSING',
          'SCAFFOLD_ONE_POINT_MISSING',
          'SCAFFOLD_POINTS3_NOT_PRESERVED',
          'SCAFFOLD_MUST_HAVE_BROKEN',
          'SCAFFOLD_NEED_FRAME',
          'SCAFFOLD_NEED_ONE_POINT',
          'SCAFFOLD_NEED_AXES',
        ]);

        const reasons0 = Array.isArray((v as any)?.reasons) ? (v as any).reasons : [];
        const reasons1 = reasons0.filter((r: any) => !drop.has(String(r)));
        const removed = reasons1.length !== reasons0.length;

        const level0 = String((v as any)?.level ?? '').toUpperCase();

        if (level0 === 'FATAL' && removed && reasons1.length === 0) {
          const warn = Number((v as any)?.score?.warn ?? 0);
          const nextLevel = warn >= 3 ? 'WARN' : 'OK';
          v = {
            ...(v as any),
            level: nextLevel,
            ok: true,
            reasons: [],
            score: { ...((v as any)?.score ?? {}), fatal: 0 },
            shouldRaiseFlag: false,
          } as any;
        } else if (removed) {
          v = { ...(v as any), reasons: reasons1 } as any;
        }
      }
    }

    lastFlagshipVerdict = {
      level: (v as any).level,
      ok: (v as any).ok,
      qCount: (v as any).qCount,
      score: (v as any).score,
      reasons: Array.isArray((v as any).reasons) ? (v as any).reasons : [],
    };
    lastFlagshipHead = safeHead(String(text ?? ''), 220);

    console.log('[IROS/FLAGSHIP][VERDICT]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      level: (v as any).level,
      ok: (v as any).ok,
      qCount: (v as any).qCount,
      score: (v as any).score,
      reasons: (v as any).reasons,
      head: lastFlagshipHead,
    });

    return v;
  };

  const guardEnabled = envFlagEnabled(process.env.IROS_FLAGSHIP_GUARD_ENABLED, true);

  // ---------------------------------------------
  // LLM call (1st)
  // ---------------------------------------------
  let raw = '';
  let raw2 = '';

  // ✅ 1st pass
  raw = await callWriterLLM({
    model: opts.model ?? 'gpt-4o',
    temperature: opts.temperature ?? 0.7,
    messages,
    traceId: debug.traceId ?? null,
    conversationId: debug.conversationId ?? null,
    userCode: debug.userCode ?? null,
  });


  // ログ（LLMの実出力で）
  logRephraseOk(debug, extracted.keys, raw, 'LLM');

  // 基本バリデーション（leak/iline/recall）
  {
    const v0 = validateOutput(raw);
    if (!v0.ok) {
      return {
        ok: false,
        reason: v0.reason || 'VALIDATION_FAILED',
        meta: { inKeys, rawLen: String(raw ?? '').length, rawHead: safeHead(String(raw ?? ''), 80) },
      };
    }
  }


  // ---------------------------------------------
  // ✅ ONE_POINT scaffold: “復元込み” で raw を整える
  // ---------------------------------------------
  const slotsForGuard = (extracted?.slots ?? null) as any;
  const scaffoldActive = isScaffoldActive(slotsForGuard) && shouldEnforceOnePointGuard(inKeys);

  let rawGuarded = raw;
  let scaffoldMissingAfterRestore: string[] = [];

  if (scaffoldActive) {
    const onePointFix = ensureOnePointInOutput({ slotsForGuard, llmOut: rawGuarded });

    console.log('[IROS/REPHRASE][ONE_POINT_GUARD]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      ok: onePointFix.ok,
      missing: onePointFix.missing,
      hasOnePoint: Boolean(onePointFix.needles.onePoint),
      source: onePointFix.needles.source,
    });

    if (!onePointFix.ok) {
      return {
        ok: false,
        reason: 'ONE_POINT_GUARD_REJECT',
        meta: { inKeys, rawLen: rawGuarded.length, rawHead: safeHead(rawGuarded, 80) },
      };
    }

    rawGuarded = onePointFix.out;

    const mh0 = scaffoldMustHaveOk({ slotKeys: inKeys, slotsForGuard, llmOut: rawGuarded });
    if (!mh0.ok) {
      rawGuarded = restoreScaffoldMustHaveInOutput({ llmOut: rawGuarded, slotsForGuard, missing: mh0.missing });
    }

    const mh1 = scaffoldMustHaveOk({ slotKeys: inKeys, slotsForGuard, llmOut: rawGuarded });
    scaffoldMissingAfterRestore = mh1.ok ? [] : mh1.missing;

    console.log('[IROS/REPHRASE][SCAFFOLD_MUST_HAVE]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      ok: mh1.ok,
      missing: mh1.missing,
      note: mh0.ok ? 'NO_RESTORE_NEEDED' : 'RESTORED_BEFORE_CHECK',
    });
  }

  // ---------------------------------------------
  // candidate 生成（clamp + lamp）
  // ---------------------------------------------
  let candidate = makeCandidate(rawGuarded, maxLines, renderEngine);

  if (!candidate) {
    logRephraseOk(debug, extracted.keys, '', 'LLM_EMPTY_AFTER_CLAMP');
    return { ok: false, reason: 'LLM_EMPTY', meta: { inKeys, rawLen: 0, rawHead: '' } };
  }

  if (scaffoldActive && candidate && slotsForGuard) {
    const mhAfterClamp = scaffoldMustHaveOk({ slotKeys: inKeys, slotsForGuard, llmOut: candidate });
    if (!mhAfterClamp.ok) {
      const restoredAfterClamp = restoreScaffoldMustHaveInOutput({
        llmOut: candidate,
        slotsForGuard,
        missing: mhAfterClamp.missing,
      });
      candidate = makeCandidate(restoredAfterClamp, maxLines, renderEngine);
    }
  }

  if (scaffoldActive && scaffoldMissingAfterRestore.length > 0 && seedFromSlots) {
    console.warn('[IROS/REPHRASE][SCAFFOLD_MUST_HAVE_TO_SEED]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      missing: scaffoldMissingAfterRestore,
    });
    return adoptAsSlots(seedFromSlots, 'SCAFFOLD_TO_SEED', {
      scaffoldActive: true,
      scaffoldMissing: scaffoldMissingAfterRestore,
    });
  }

  // ---------------------------------------------
  // Flagship Guard（採用ゲート）
  // ---------------------------------------------
  if (!guardEnabled) {
    return adoptAsSlots(candidate, 'FLAGSHIP_DISABLED', { scaffoldActive });
  }

  const raise = readShouldRaiseFlagFromContext(opts?.userContext ?? null);
  const forceIntervene = raise.on === true;

  const shouldRejectWarnToSeed = shouldRejectWarnToSeedFactory({ inKeys, scaffoldActive });

  let v = runFlagship(candidate, slotsForGuard, scaffoldActive);

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

    const reasonText = String(raise.reason ?? '');
    const isStallOrDrift = /STALL|POSITION_DRIFT/i.test(reasonText);

    if (isStallOrDrift && seedFromSlots) {
      return adoptAsSlots(seedFromSlots, 'FLAGSHIP_RAISE_TO_SEED', { scaffoldActive });
    }

    v = {
      ...v,
      ok: false,
      level: 'FATAL',
      reasons: Array.from(new Set([...(v.reasons ?? []), 'FORCE_INTERVENE'])),
    } as any;
  }

  if (v && String(v.level ?? '').toUpperCase() === 'WARN' && shouldRejectWarnToSeed(v) && seedFromSlots) {
    console.warn('[IROS/FLAGSHIP][REJECT_WARN_TO_SEED]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      level: v.level,
      reasons: v.reasons,
    });
    return adoptAsSlots(seedFromSlots, 'FLAGSHIP_WARN_REJECT_TO_SEED', { scaffoldActive });
  }

  // ------------------------------------------------------------
  // ✅ MIN_OK_LEN 制御（shift allow.short_reply_ok 対応）
  // ------------------------------------------------------------
  const vLevelPre = String((v as any)?.level ?? '').toUpperCase();
  const candidateLen = (candidate ?? '').trim().length;

  const inputKindNow = String(inputKind ?? inputKindFromMeta ?? inputKindFromCtx ?? 'chat')
    .trim()
    .toLowerCase();

  const isMicroOrGreetingNow = inputKindNow === 'micro' || inputKindNow === 'greeting';

  const shiftObj = parseShiftJson(shiftSlot?.text);

  const shortReplyOk =
    Boolean(shiftObj?.allow?.short_reply_ok) ||
    Boolean(shiftObj?.allow?.shortReplyOk) ||
    Boolean((opts as any)?.allow?.short_reply_ok) ||
    Boolean((opts as any)?.allow?.shortReplyOk) ||
    false;

  const MIN_OK_LEN = isMicroOrGreetingNow ? 0 : inputKindNow === 'chat' ? (shortReplyOk ? 0 : 40) : 80;

  console.log('[IROS/rephraseEngine][MIN_OK_KIND]', {
    inputKindNow,
    isMicroOrGreetingNow,
    shortReplyOk,
    MIN_OK_LEN,
    reason: isMicroOrGreetingNow
      ? 'micro_or_greeting'
      : inputKindNow === 'chat'
        ? (shortReplyOk ? 'chat_short_reply_ok' : 'chat_relaxed_40')
        : 'default_80',
    shiftTextHead: shiftSlot?.text ? safeHead(String(shiftSlot.text), 140) : null,
    shiftObjHasAllow: Boolean(shiftObj?.allow),
  });

  const shouldOkTooShortToRetry =
    !scaffoldActive && !isDirectTask && v?.ok && vLevelPre === 'OK' && candidateLen > 0 && candidateLen < MIN_OK_LEN;

  if (shouldOkTooShortToRetry) {
    console.warn('[IROS/FLAGSHIP][OK_TOO_SHORT_TO_RETRY]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      level: (v as any)?.level,
      len: candidateLen,
      min: MIN_OK_LEN,
      head: safeHead(candidate, 160),
    });
    console.warn('[IROS/rephraseEngine][MIN_OK_DEBUG]', {
      scaffoldActive,
      isDirectTask,
      v_ok: v?.ok,
      vLevelPre,
      candidateLen,
      MIN_OK_LEN,
    });

    v = {
      ...(v as any),
      ok: false,
      level: 'FATAL',
      reasons: Array.from(new Set([...(v.reasons ?? []), 'OK_TOO_SHORT_TO_RETRY'])),
    } as any;
  }

  const vLevel = String((v as any)?.level ?? '').toUpperCase();

  const naturalTextReady =
    !scaffoldActive &&
    !isDirectTask &&
    candidateLen >= MIN_OK_LEN &&
    (/\n{2,}/.test(candidate) || candidate.split('\n').filter(Boolean).length >= 3);

  if (v?.ok && vLevel === 'OK') {
    return adoptAsSlots(candidate, 'FLAGSHIP_OK', { scaffoldActive });
  }

  if (vLevel === 'WARN' && naturalTextReady) {
    return adoptAsSlots(candidate, 'FLAGSHIP_ACCEPT_AS_FINAL', {
      scaffoldActive,
      flagshipLevel: vLevel,
      retrySuppressed: true,
    });
  }

  if (vLevel === 'WARN') {
    console.warn('[IROS/FLAGSHIP][WARN_TO_RETRY]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      level: (v as any)?.level,
      reasons: (v as any)?.reasons,
    });

    v = {
      ...(v as any),
      ok: false,
      level: 'FATAL',
      reasons: Array.from(new Set([ ...(((v as any)?.reasons ?? []) as any[]), 'WARN_TO_RETRY' ])),
    } as any;
  }

  // ---------------------------------------------
  // FATAL → 1回だけ再生成（2ndは“編集/復元+整形”）
  // ---------------------------------------------
  const baseDraftForRepair: string = (() => {
    const a = seedFromSlots && seedFromSlots.trim() ? seedFromSlots.trim() : '';
    const b = candidate && candidate.trim() ? candidate.trim() : '';
    const c = seedDraft && seedDraft.trim() ? seedDraft.trim() : '';

    const reasons = new Set((((v as any)?.reasons ?? []) as any[]).map((x) => String(x)));
    const preferCandidateBecauseTooShort = reasons.has('OK_TOO_SHORT_TO_RETRY');
    const preferSeedDraft = reasons.has('NORMAL_SHORT_GENERIC_NO_QUESTION') || reasons.has('WARN_TO_RETRY');

    if (isDirectTask) return a || b || '';

    if (preferCandidateBecauseTooShort) return b || a || c || '';
    if (preferSeedDraft) return a || c || b || '';
    return b || a || c || '';
  })();



  console.log('[IROS/FLAGSHIP][RETRY]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    reason: v?.reasons,
  });

  // ✅ retry (2nd pass)
  const retryMessages = buildRetryMessages({
    systemPrompt,
    internalPack,
    baseDraftForRepair,
    userText,
  });

  raw2 = await callWriterLLM({
    model: opts.model ?? 'gpt-4o',
    temperature: opts.temperature ?? 0.7,
    messages: retryMessages,
    traceId: debug.traceId ?? null,
    conversationId: debug.conversationId ?? null,
    userCode: debug.userCode ?? null,
  });

  // ログ（LLMの実出力で）
  logRephraseOk(debug, extracted.keys, raw2, 'RETRY_LLM');

  // retry raw validation（最低限の安全）
  {
    const v2 = validateOutput(raw2);
    if (!v2.ok) {
      if (seedFromSlots) return adoptAsSlots(seedFromSlots, `RETRY_${v2.reason}_TO_SEED`, { scaffoldActive });
      return adoptAsSlots(candidate, `RETRY_${v2.reason}_USE_CANDIDATE`, { scaffoldActive });
    }

    const retryLen0 = String(raw2 ?? '').trim().length;
    if (!isDirectTask && !isMicroOrGreetingNow && retryLen0 > 0 && retryLen0 < MIN_OK_LEN) {
      const fallbackDraft = String(baseDraftForRepair ?? '').trim() || String(candidate ?? '').trim();
      if (seedFromSlots && String(seedFromSlots).trim()) {
        return adoptAsSlots(seedFromSlots, 'RETRY_TOO_SHORT_FORCE_USE_SEED', { scaffoldActive });
      }
      return adoptAsSlots(fallbackDraft, 'RETRY_TOO_SHORT_FORCE_USE_DRAFT', { scaffoldActive });
    }
  }

  // scaffold復元（retryでも同様）
  let raw2Guarded = raw2;
  if (scaffoldActive) {
    const onePointFix2 = ensureOnePointInOutput({ slotsForGuard, llmOut: raw2Guarded });
    if (onePointFix2.ok) raw2Guarded = onePointFix2.out;

    const mh0 = scaffoldMustHaveOk({ slotKeys: inKeys, slotsForGuard, llmOut: raw2Guarded });
    if (!mh0.ok) {
      raw2Guarded = restoreScaffoldMustHaveInOutput({
        llmOut: raw2Guarded,
        slotsForGuard,
        missing: mh0.missing,
      });
    }
  }

  let retryCandidate = makeCandidate(raw2Guarded, maxLines, renderEngine);

  // ✅ 2nd PASS が空ではないが、まだ短い → seed があるなら seed を優先
  {
    const retryLenNow = String(retryCandidate ?? '').trim().length;
    if (retryLenNow > 0 && retryLenNow < MIN_OK_LEN) {
      console.warn('[IROS/FLAGSHIP][RETRY_STILL_TOO_SHORT]', {
        traceId: debug.traceId,
        conversationId: debug.conversationId,
        userCode: debug.userCode,
        retryLen: retryLenNow,
        min: MIN_OK_LEN,
        head: safeHead(retryCandidate, 160),
        hasSeed: !!seedFromSlots,
      });

      const fallbackText = String(seedFromSlots ?? '').trim() || String(candidate ?? '').trim();
      const reason = seedFromSlots
        ? 'FLAGSHIP_RETRY_STILL_TOO_SHORT_USE_SEED'
        : 'FLAGSHIP_RETRY_STILL_TOO_SHORT_USE_CANDIDATE';

      return adoptAsSlots(fallbackText, reason, { scaffoldActive });
    }
  }

  if (scaffoldActive && retryCandidate) {
    const mhAfterClamp = scaffoldMustHaveOk({ slotKeys: inKeys, slotsForGuard, llmOut: retryCandidate });
    if (!mhAfterClamp.ok) {
      const restored = restoreScaffoldMustHaveInOutput({
        llmOut: retryCandidate,
        slotsForGuard,
        missing: mhAfterClamp.missing,
      });
      retryCandidate = makeCandidate(restored, maxLines, renderEngine);

      if (!retryCandidate || !retryCandidate.trim()) {
        console.warn('[IROS/FLAGSHIP][RETRY_EMPTY_AFTER_RESTORE_CLAMP]', {
          traceId: debug.traceId,
          conversationId: debug.conversationId,
          userCode: debug.userCode,
        });

        const fallback = baseDraftForRepair && baseDraftForRepair.trim() ? baseDraftForRepair : candidate;
        return adoptAsSlots(fallback, 'FLAGSHIP_RETRY_EMPTY_AFTER_RESTORE_USE_BASE_DRAFT', { scaffoldActive });
      }
    }
  }

  const vRetry = runFlagship(retryCandidate, slotsForGuard, scaffoldActive);

  console.log('[IROS/FLAGSHIP][RETRY_VERDICT]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    level: vRetry?.level,
    reasons: vRetry?.reasons,
    head: safeHead(retryCandidate, 160),
  });

  {
    const retryText = String(retryCandidate ?? '').trim();
    const retryLen = retryText.length;
    const retryLevel = String((vRetry as any)?.level ?? '').toUpperCase();
    const retryReasons = Array.from(
      new Set((((vRetry as any)?.reasons ?? []) as any[]).map((x) => String(x))),
    );

    const acceptRetry =
      !!vRetry?.ok &&
      retryLevel === 'OK' &&
      retryLen >= MIN_OK_LEN &&
      !retryReasons.includes('NORMAL_SHORT_GENERIC_NO_QUESTION');

    if (acceptRetry) {
      return adoptAsSlots(retryText, 'FLAGSHIP_RETRY_OK', { scaffoldActive });
    }

    if (vRetry && retryLevel === 'WARN' && seedFromSlots) {
      const mustSeed = shouldRejectWarnToSeed(vRetry) || retryLen < MIN_OK_LEN || retryReasons.includes('NORMAL_SHORT_GENERIC_NO_QUESTION');
      if (mustSeed) {
        return adoptAsSlots(seedFromSlots, 'FLAGSHIP_RETRY_WARN_TO_SEED', { scaffoldActive });
      }
    }
  }

  const reasonsArr = (((vRetry as any)?.reasons ?? (v as any)?.reasons ?? []) as any[]).map((x) => String(x));
  const fatalReasons = new Set(Array.from(new Set(reasonsArr)));

  // ✅ soft-fatal（危険ではなく “文章品質” で落ちた）なら seed 退避をしない
  // ✅ さらに seedFromSlots が directive-only（@TASK/@DRAFT だけ）なら採用すると UI が空になるので必ず避ける
  const softFatalReasons = new Set(['QCOUNT_TOO_MANY', 'HEDGE_PRESENT', 'GENERIC_PRESENT']);
  const isSoftFatalOnly = fatalReasons.size > 0 && Array.from(fatalReasons).every((r) => softFatalReasons.has(String(r)));
  // ✅ このブロック内だけで使う：directive-only 判定（外部依存なし）
  const isDirectiveOnly = (s0: any): boolean => {
    const lines = String(s0 ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((x) => String(x ?? '').trim())
      .filter(Boolean);

    if (lines.length === 0) return true;
    return lines.every((t) => /^@(?:CONSTRAINTS|OBS|TASK|SHIFT|NEXT|SAFE|ACK|RESTORE|Q|DRAFT)\b/.test(t));
  };

  const seedDirectiveOnly = seedFromSlots ? isDirectiveOnly(seedFromSlots) : false;

  // 既存の prefer 条件に、soft-fatal と directive-only seed 回避を追加
  const shouldPreferCandidateOnFatal =
    seedDirectiveOnly ||
    isSoftFatalOnly ||
    fatalReasons.has('OK_TOO_SHORT_TO_RETRY') ||
    fatalReasons.has('WARN_TO_RETRY');

  if (shouldPreferCandidateOnFatal) {
    const fallback =
      String(retryCandidate ?? '').trim() ||
      String(candidate ?? '').trim() ||
      // seed が directive-only の場合は絶対に使わない（空になる）
      (!seedDirectiveOnly ? String(seedFromSlots ?? '').trim() : '');

    return adoptAsSlots(fallback, 'FLAGSHIP_RETRY_FATAL_PREFER_CANDIDATE', {
      scaffoldActive,
      flagshipFatal: true,
      flagshipLevel: (vRetry as any)?.level ?? 'FATAL',
      flagshipReasons: Array.isArray((vRetry as any)?.reasons) ? (vRetry as any).reasons : [],
    });
  }

  // ✅ seedFromSlots を採用するのは「directive-only ではない」場合だけ
  if (seedFromSlots && !seedDirectiveOnly) {
    return adoptAsSlots(seedFromSlots, 'FLAGSHIP_RETRY_FATAL_TO_SEED', { scaffoldActive });
  }

  // seed が使えない（directive-only 等）ときは通常のフォールバックへ
  const fallbackText = String(retryCandidate ?? '').trim() || String(candidate ?? '').trim();
  return adoptAsSlots(fallbackText, 'FLAGSHIP_RETRY_FATAL_ACCEPT', {
    scaffoldActive,
    flagshipFatal: true,
    flagshipLevel: (vRetry as any)?.level ?? 'FATAL',
    flagshipReasons: Array.isArray((vRetry as any)?.reasons) ? (vRetry as any).reasons : [],
  });
}

