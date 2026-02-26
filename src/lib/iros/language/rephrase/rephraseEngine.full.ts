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
import { detectIdeaBandProposeFromExtracted, makeIdeaBandCandidateBlocks } from './ideaBand';
import { computeMinOkPolicy, computeOkTooShortToRetry, computeNaturalTextReady } from './minOkPolicy';
import { runRetryPass } from './retryPass';
import { validateOutputPure } from './validateOutput';
import {
  buildBlockPlan,
  buildBlockPlanWithDiag,
  detectExplicitBlockPlanTrigger,
  renderBlockPlanSystem4,
} from '../../blockPlan/blockPlanEngine';
import { flagshipGuard } from '../../quality/flagshipGuard';
import {
  extractLockedILines,
  verifyLockedILinesPreserved,
  buildLockRuleText,
  ILINE_OPEN,
  ILINE_CLOSE,
} from './ilineLock';

// ==============================
// PATCH: 2-line format enforce (single retry)
// ==============================

function detectTwoLineFormatRequest(userText: string): boolean {
  const t = (userText || '').trim();
  if (!t) return false;
  return (
    t.includes('出力は2行だけ') ||
    (t.includes('1行目=') && t.includes('2行目=')) ||
    t.includes('2行だけ') ||
    t.includes('二行だけ')
  );
}

function stripOuterQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('「') && t.endsWith('」')) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function hasEmojiLike(s: string): boolean {
  return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s);
}

function validateTwoLineOutput(outText: string): { ok: true } | { ok: false; reason: string } {
  const raw = (outText || '').replace(/\r\n/g, '\n').trim();
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  if (lines.length !== 2) return { ok: false, reason: `lines!=2 (${lines.length})` };

  const l1 = lines[0].trim();
  const l2 = stripOuterQuotes(lines[1]);

  if (l1.length < 20 || l1.length > 30) return { ok: false, reason: `line1_len=${l1.length}` };
  if (!l2) return { ok: false, reason: 'line2_empty' };
  if (hasEmojiLike(l1) || hasEmojiLike(l2)) return { ok: false, reason: 'emoji_detected' };
  if (l2.endsWith('？') || l2.endsWith('?')) return { ok: false, reason: 'line2_is_question' };

  return { ok: true };
}

async function enforceTwoLineIfRequested(params: {
  userText: string;
  rawOutText: string;
  callWriter: (override?: { temperature?: number; extraSystem?: string }) => Promise<string>;
}): Promise<{ text: string; enforced: boolean; reason?: string }> {
  const needs = detectTwoLineFormatRequest(params.userText);
  if (!needs) return { text: params.rawOutText, enforced: false };

  const v1 = validateTwoLineOutput(params.rawOutText);
  if (v1.ok) return { text: params.rawOutText, enforced: false };

  const extraSystem =
    '出力は必ず2行。\n' +
    '1行目=いまの状態の要約（20〜30文字）。\n' +
    '2行目=ユーザーが次に入力する“具体的な1文”（引用符なし・質問形なし）。\n' +
    '余計な説明・絵文字は禁止。';

  const retryText = await params.callWriter({ temperature: 0.2, extraSystem });

  const v2 = validateTwoLineOutput(retryText);
  if (v2.ok) return { text: retryText, enforced: true };

  return { text: params.rawOutText, enforced: false, reason: `retry_failed:${v2.reason}` };
}



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

  // ✅ 追加：会話が流れるための3点セット（topic / goal / 反復）
  topicDigest?: string | null;
  replyGoal?: string | null;
  repeatSignal?: string | null;
}): string {
  // 🚫 userText は LLM 入力に混入させない（internalPack へ露出しない）
  // - userText は「観測の唯一ソース」として使う設計が以前あったが、
  //   現在は「LLMに生文を渡さない」方針のため、ここでは参照しない。
  // - 代わりに onePoint / summary / topic / goal / repeat を “核” として渡す。

  const obsOnePoint = String(args.onePointText ?? '').trim();
  const obsSummary = String(args.situationSummary ?? '').trim();
  const obsTopic = String(args.topicDigest ?? '').trim();
  const obsGoal = String(args.replyGoal ?? '').trim();
  const obsRepeat = String(args.repeatSignal ?? '').trim();

  // ✅ 観測核（NOW_CORE）は userText を使わずに作る
  // - onePoint があれば最優先
  // - 次に summary
  const obsPick =
    obsOnePoint.length >= 6
      ? obsOnePoint
      : obsSummary.length >= 6
        ? obsSummary
        : '';

  // ✅ 露出は短い head のみに制限（ただし userText は露出しない）
  const head = (s: string, n = 80) => {
    const t = String(s ?? '').replace(/\r\n/g, '\n').trim();
    return t.length <= n ? t : t.slice(0, n) + '…';
  };

  // ✅ obsCard（ミニ版）
  // - userText は含めない
  // - “拾うべき核（obsPick）” と会話を流す3点だけを渡す
  const obsCard = [
    'OBS_SOURCES (DO NOT OUTPUT):',
    `obsOnePointHead=${obsOnePoint ? head(obsOnePoint, 120) : '(none)'}`,
    `obsSummaryHead=${obsSummary ? head(obsSummary, 120) : '(none)'}`,
    `obsPickHead=${obsPick ? head(obsPick, 120) : '(none)'}`,
    '',
    // ✅ 会話が流れるための3点（あれば優先）
    `TOPIC_DIGEST: ${obsTopic ? head(obsTopic, 220) : '(none)'}`,
    `REPLY_GOAL: ${obsGoal ? head(obsGoal, 220) : '(none)'}`,
    `REPEAT_SIGNAL: ${obsRepeat ? head(obsRepeat, 220) : '(none)'}`,
    '',
    // ✅ 最小ルール（短く）
    'USE_RULE (DO NOT OUTPUT):',
    '- obsPick は「核」として参照してよいが、原文引用や言い直しはしない。',
    '- 説明で埋めず、会話として短く返す。',
    '- 箇条書き・番号列挙・チェックリストで出力しない（必要なら1〜2文に畳む）。',
    '- 質問は最大1つまで。',
  ].join('\n');

  const flowDigest = String(args.flowDigest ?? '').trim();
  const flowTape = String(args.flowTape ?? '').trim();

  // ✅ META_HINT は「JSON断片の要約」ではなく「選抜キー言語化」に統一する
  // - JSON.parse をしない（keys=(json_parse_failed) を根絶）
  // - args.metaText（stringify由来）は LLM向けに使わない（デバッグ用途に限定）
  const metaTextRaw = String(args.metaText ?? '').trim(); // 互換保持（ただし LLM用には使わない）

  const metaText = (() => {
    const ctx: any = (args as any) ?? {};
    const ctxPack: any = ctx.ctxPack ?? ctx.ctx_pack ?? null;

    const pick = (...cands: any[]) => {
      for (const v of cands) {
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (!s) continue;
        return s;
      }
      return null;
    };

    // ✅ 構造メタ（柱）
    const inputKind = pick(ctx.inputKind, ctxPack?.inputKind);
    const depthStage = pick(ctx.depthStage, ctxPack?.depthStage, ctxPack?.unified?.depthStage);
    const phase = pick(ctx.phase, ctxPack?.phase);
    const qCode = pick(ctx.qCode, ctxPack?.qCode);

    const intentBand = pick(ctx.intentBand, ctxPack?.intentBand);
    const tLayerHint = pick(ctx.tLayerHint, ctxPack?.tLayerHint);

    const flowDelta = pick(ctxPack?.flow?.delta, ctxPack?.flowDelta);
    const returnStreak = pick(ctxPack?.flow?.returnStreak, ctxPack?.returnStreak);

    const itOk = pick(ctx.itOk, ctxPack?.itTriggered, ctxPack?.it_triggered);
    const goalKind = pick(ctxPack?.replyGoal?.kind, ctxPack?.goalKind, ctx.replyGoal);
    const slotPlanPolicy = pick(ctxPack?.slotPlanPolicy, ctx.slotPlanPolicy);

    // ✅ 瞬間反応（カード材料）
    const e_turn = pick(ctx.e_turn, ctxPack?.mirror?.e_turn, ctxPack?.e_turn);
    const polarity = pick(ctx.polarity, ctxPack?.mirror?.polarity, ctxPack?.polarity);

    // ✅ self acceptance（補正）
    const sa = pick(ctx.sa, ctxPack?.sa, ctxPack?.selfAcceptance, ctxPack?.self_acceptance);

    // ✅ 任意（必要時のみ）
    const fixedNorth = pick(ctxPack?.fixedNorth?.key, ctxPack?.fixedNorth_meta, ctxPack?.fixedNorthKey);

    const lines: string[] = [];

    if (inputKind) lines.push(`inputKind=${inputKind}`);
    if (depthStage) lines.push(`depthStage=${depthStage}`);
    if (phase) lines.push(`phase=${phase}`);
    if (qCode) lines.push(`qCode=${qCode}`);

    if (intentBand) lines.push(`intentBand=${intentBand}`);
    if (tLayerHint) lines.push(`tLayerHint=${tLayerHint}`);

    if (flowDelta) lines.push(`flowDelta=${flowDelta}`);
    if (returnStreak) lines.push(`returnStreak=${returnStreak}`);

    if (itOk != null) lines.push(`itOk=${itOk}`);
    if (goalKind) lines.push(`goalKind=${goalKind}`);
    if (slotPlanPolicy) lines.push(`slotPlanPolicy=${slotPlanPolicy}`);

    if (e_turn) lines.push(`e_turn=${e_turn}`);
    if (polarity) lines.push(`polarity=${polarity}`);
    if (sa) lines.push(`sa=${sa}`);

    if (fixedNorth) lines.push(`fixedNorth=${fixedNorth}`);

    // 無いなら空
    return lines.length ? lines.join('\n') : '';
  })();

  const parts: string[] = [
    'INTERNAL PACK (DO NOT OUTPUT):',
    '',
    `lastTurnsCount=${args.lastTurnsCount ?? 0}`,
    `directTask=${String(args.directTask ?? false)}`,
    `inputKind=${args.inputKind ?? '(null)'}`,
    `itOk=${String(args.itOk ?? false)}`,
    `intentBand=${args.intentBand ?? '(null)'}`,
    `tLayerHint=${args.tLayerHint ?? '(null)'}`,
    '',
    'META_HINT (DO NOT OUTPUT):',
    metaText || '(none)',
    '',
    'FLOW_HINT (DO NOT OUTPUT):',
    `flowDigest=${flowDigest || '(none)'}`,
    `topicDigest=${String(args.topicDigest ?? '').trim() || '(none)'}`,
    `replyGoal=${String(args.replyGoal ?? '').trim() || '(none)'}`,
    `repeatSignal=${String(args.repeatSignal ?? '').trim() || '(none)'}`,
    `flowTape=${flowTape || '(none)'}`,
  ];

  const historyTrim = String(args.historyText ?? '').trim();
  if (historyTrim) {
    parts.push('', 'HISTORY_HINT (DO NOT OUTPUT):', historyTrim);
  }

  const seedTrim = String(args.seedDraftHint ?? '').trim();
  if (seedTrim) {
    parts.push('', 'SEED DRAFT HINT (DO NOT OUTPUT):', seedTrim);
  }

  parts.push('', obsCard);

  return parts.join('\n');
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

      // ✅ traceId は「上流で渡される」のが正。
      // ここで randomUUID を出すのは最終保険だが、発生したら必ずログに残す。
      let traceId = traceIdRaw;

      if (!traceId) {
        traceId = crypto.randomUUID();

        console.warn('[IROS/rephraseEngine][TRACE_FALLBACK_UUID]', {
          traceId,
          reason: 'EMPTY_BASE_TRACEID',
          baseTraceId: (base as any)?.traceId ?? null,
          debugTraceId: (debug as any)?.traceId ?? null,
          conversationId: (debug as any)?.conversationId ?? null,
          userCode: (debug as any)?.userCode ?? null,
        });
      }

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

  // ✅ slotsの取り元を拡張（"slotPlan（本文）" を最優先）
  // - framePlan.slots は「箱の定義（schema）」の可能性が高いので最後に回す
  const slotsRaw =
    // 1) slotPlan（本文）を最優先
    extra?.slotPlan?.slots ??
    extra?.slotPlan ??
    extra?.meta?.slotPlan?.slots ??
    extra?.meta?.slotPlan ??
    // 2) framePlan.slotPlan（本文を持つ実装もある）
    framePlan?.slotPlan?.slots ??
    framePlan?.slotPlan ??
    // 3) 最後に framePlan.slots（schemaの可能性が高い）
    framePlan?.slots ??
    null;

  // ✅ ILINE 等の制御マーカーはここで壊さない（lock抽出の素材なので保持）
  const normPreserveControl = (v: any): string => {
    const s = String(v ?? '');
    return s.replace(/\r\n/g, '\n').trim();
  };

// ✅ slot本文を「深めに」拾う（contentがネストしてるケースを救う）
const pickTextDeep = (v: any): string => {
  if (v == null) return '';

  // ✅ schemaっぽい slot 定義JSON（文字列）を本文扱いしない
  const isSchemaJsonString = (s: string): boolean => {
    const t = String(s ?? '').trim();
    if (!t.startsWith('{') || !t.endsWith('}')) return false;
    // OBS/SHIFT/NEXT/SAFE の id + hint がある「定義」を弾く
    return /"id"\s*:\s*"(OBS|SHIFT|NEXT|SAFE)"/.test(t) && /"hint"\s*:/.test(t);
  };

  if (typeof v === 'string') {
    return isSchemaJsonString(v) ? '' : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);

  // 配列は join（ただし空要素は落とす）
  if (Array.isArray(v)) {
    const parts = v
      .map((x) => pickTextDeep(x))
      .map((s) => String(s ?? '').trim())
      .filter((s) => s.length > 0);
    return parts.join('\n');
  }

  if (typeof v === 'object') {
    // よくあるキーを順に深掘り
    const CANDS = ['text', 'value', 'content', 'message', 'out', 'body', 'seed_text', 'seedText'];

    for (const k of CANDS) {
      const got = pickTextDeep((v as any)?.[k]);
      if (String(got ?? '').trim().length > 0) return got;
    }

    // ✅ schemaっぽい slot 定義（id/required/hint だけ）を本文扱いしない
    const keys = Object.keys(v as any);
    const schemaOnly =
      keys.length > 0 &&
      keys.every((k) => k === 'id' || k === 'key' || k === 'required' || k === 'hint');

    if (schemaOnly) return '';

    // 最後の保険：知らない形でも落としきらない（ただし schemaOnly は除外済み）
    try {
      const j = JSON.stringify(v);
      return typeof j === 'string' && !isSchemaJsonString(j) ? j : '';
    } catch {
      return '';
    }
  }

  return '';
};


  const buildFallbackObs = (): ExtractedSlots | null => {
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
  };

  // ✅ slots が無いケース：contentから疑似slotを作る
  if (!slotsRaw) return buildFallbackObs();

  const out: Slot[] = [];

  const pushIfValid = (keyLike: any, textLike: any) => {
    const key = String(keyLike ?? '').trim();
    const text0 = pickTextDeep(textLike);
    const text = normPreserveControl(text0);
    if (!key || !text) return;
    out.push({ key, text });
  };

  if (Array.isArray(slotsRaw)) {
    for (const s of slotsRaw) {
      // slot定義(schema)の形（id/required/hintのみ）を弾く
      if (s && typeof s === 'object') {
        const ks = Object.keys(s);
        const schemaOnly =
          ks.length > 0 && ks.every((k) => k === 'id' || k === 'key' || k === 'required' || k === 'hint');
        if (schemaOnly) continue;
      }

      const key = (s as any)?.key ?? (s as any)?.id ?? (s as any)?.slotId ?? (s as any)?.name ?? '';
      const text =
        (s as any)?.text ??
        (s as any)?.value ??
        (s as any)?.content ??
        (s as any)?.message ??
        (s as any)?.out ??
        (s as any)?.body ??
        (s as any)?.seed_text ??
        (s as any)?.seedText ??
        '';
      pushIfValid(key, text);
    }
  } else if (typeof slotsRaw === 'object' && slotsRaw) {
    const keys = stableOrderKeys(Object.keys(slotsRaw));
    for (const k of keys) {
      const v = (slotsRaw as any)[k];

      // slot定義(schema)の形（id/required/hintのみ）を弾く
      if (v && typeof v === 'object') {
        const ks = Object.keys(v);
        const schemaOnly =
          ks.length > 0 && ks.every((kk) => kk === 'id' || kk === 'key' || kk === 'required' || kk === 'hint');
        if (schemaOnly) continue;
      }

      const text =
        typeof v === 'string'
          ? v
          : (v as any)?.text ??
            (v as any)?.content ??
            (v as any)?.value ??
            (v as any)?.message ??
            (v as any)?.out ??
            (v as any)?.body ??
            (v as any)?.seed_text ??
            (v as any)?.seedText ??
            v;
      pushIfValid(String(k), text);
    }
  }

  // ✅ slotsRaw はあるが “本文が1つも取れない” ケースを救う（ここが本丸）
  if (out.length === 0) return buildFallbackObs();

  return {
    slots: out,
    keys: out.map((x) => x.key),
    source: 'slotPlan.slots',
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

  // ✅ このターンの itOk は「このターンの扉」だけを見る
  // - itTriggered（過去の状態）や tLayerModeActive（濃度モード）は itOk の代替にしない
  // - orchestrator が meta.itTrigger.ok（camel/snake）を供給している前提
  const ok =
    tryGet(uc, ['itTrigger', 'ok']) ??
    tryGet(uc, ['it_trigger', 'ok']) ??
    tryGet(uc, ['meta', 'itTrigger', 'ok']) ??
    tryGet(uc, ['meta', 'it_trigger', 'ok']) ??
    tryGet(uc, ['ctxPack', 'itTrigger', 'ok']) ??
    tryGet(uc, ['ctxPack', 'it_trigger', 'ok']) ??
    tryGet(uc, ['ctx_pack', 'itTrigger', 'ok']) ??
    tryGet(uc, ['ctx_pack', 'it_trigger', 'ok']) ??
    null;

  return ok === true;
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

    try {
      console.log('[IROS/rephraseEngine][INTENT_BAND_EXTRACT]', {
        intentBand_raw: intentBand,
        tLayerHintRaw,
        itxStep,
        tLayerHint_afterFallback: tLayerHint,
        bandOk,
        hintOk,
        note:
          tLayerHintRaw
            ? 'from_tLayerHintRaw'
            : itxStep
              ? 'from_itxStep_fallback'
              : 'no_hint',
      });
    } catch {}

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
  debug: any,
  outKeys: string[],
  head: string,
  note: string,
  attachExtra?: any
) {
  try {
    const extra =
      attachExtra ??
      (debug as any)?.meta?.extra ??
      (debug as any)?.extra ??
      null;

    const hasExtra = !!(extra && typeof extra === 'object' && Object.keys(extra).length > 0);

    console.log('[IROS/rephraseEngine][AFTER_ATTACH][EXTRA_TRACE]', {
      traceId: (debug as any)?.traceId ?? null,
      conversationId: (debug as any)?.conversationId ?? null,
      hasExtra,
      blockPlanMode: extra?.blockPlanMode ?? null,
      blockPlanBlocksLen: Array.isArray(extra?.blockPlan?.blocks) ? extra.blockPlan.blocks.length : 0,
      hasRephraseBlocks: Array.isArray(extra?.rephraseBlocks) ? true : false,
      rephraseBlocksLen: Array.isArray(extra?.rephraseBlocks) ? extra.rephraseBlocks.length : 0,
      outKeysLen: Array.isArray(outKeys) ? outKeys.length : 0,
      note: note ?? null,
      head: safeHead(String(head ?? ''), 80),
    });
  } catch {}
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
  // ✅ opts のトップレベル（conversationId/userCode/traceId）を debug に確実に反映
  const debug = ensureDebugFinal({
    ...(opts?.debug ?? {}),
    traceId: (opts as any)?.traceId ?? (opts as any)?.debug?.traceId ?? null,
    conversationId: (opts as any)?.conversationId ?? (opts as any)?.debug?.conversationId ?? null,
    userCode: (opts as any)?.userCode ?? (opts as any)?.debug?.userCode ?? null,

    // ✅ LLM audit 用：debug 経由で参照されるため、ここで落とさず伝播する
    slotPlanPolicy:
      (opts as any)?.slotPlanPolicy ??
      (opts as any)?.debug?.slotPlanPolicy ??
      null,
  } as any);


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

  let maxLines =
    Number(process.env.IROS_REPHRASE_FINAL_MAXLINES) > 0
      ? Math.floor(Number(process.env.IROS_REPHRASE_FINAL_MAXLINES))
      : Math.max(4, Math.min(12, Math.floor(opts.maxLinesHint ?? 8)));

  const inKeys = extracted.keys;

  // ------------------------------------------------------------
  // SHIFT slot はこの関数で 1回だけ取得して使い回す
  // - key が 'SHIFT' 固定じゃないケース（@SHIFT / shift / kind側）も拾う
  // ------------------------------------------------------------
  const slotsAny: any[] = Array.isArray((extracted as any)?.slots) ? ((extracted as any).slots as any[]) : [];

  const normKey = (v: any) => String(v ?? '').trim();
  const upperKey = (v: any) => normKey(v).toUpperCase();

  const isShiftKey = (k: any) => {
    const u = upperKey(k);
    // 厳密：SHIFT / @SHIFT のみ
    return u === 'SHIFT' || u === '@SHIFT';
  };

  const isShiftKind = (k: any) => {
    const u = upperKey(k);
    // kind 側に shift が入る場合
    return u === 'SHIFT' || u === 'SHIFT_PRESET';
  };

  const shiftSlot =
    slotsAny.find((s: any) => isShiftKey(s?.key)) ??
    slotsAny.find((s: any) => isShiftKind(s?.kind)) ??
    null;

  console.log('[IROS/rephraseEngine][SHIFT_SLOT_HEAD]', {
    hasShiftSlot: !!shiftSlot,
    shiftSlotKey: shiftSlot ? normKey((shiftSlot as any)?.key) : null,
    shiftSlotKind: shiftSlot ? normKey((shiftSlot as any)?.kind) : null,
    shiftSlotLen: (shiftSlot as any)?.text ? String((shiftSlot as any).text).length : 0,
    shiftSlotHead: (shiftSlot as any)?.text ? safeHead(String((shiftSlot as any).text), 220) : null,
    // デバッグ用：slots の key/kind 先頭だけ（長くしない）
    slotsKeysSample: slotsAny
      .slice(0, 20)
      .map((s: any) => ({
        key: normKey(s?.key),
        kind: normKey(s?.kind),
      })),
  });


    // ✅ FULL dump (opt-in): node inspect / safeHead の切り捨てを回避して SHIFT を全文で出す
    // 使い方: IROS_DEBUG_SHIFT_FULL=1 を付けて dev 起動
    if (process.env.IROS_DEBUG_SHIFT_FULL === '1' && shiftSlot?.text) {
      const full = String(shiftSlot.text);
      console.log('[IROS/rephraseEngine][SHIFT_SLOT_FULL_LEN]', full.length);
      console.log('[IROS/rephraseEngine][SHIFT_SLOT_FULL_BEGIN]');
      console.log(full);
      console.log('[IROS/rephraseEngine][SHIFT_SLOT_FULL_END]');
    }


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
  // NOTE:
  // - writer に渡す seedDraft から internal directive を確実に除去するためのマーカー
  // - @Q_SLOT などの @*_SLOT を必ず落とす（seed 混入防止）
  const INTERNAL_LINE_MARKER =
  /^@(OBS|SHIFT|SH|RESTORE|Q|Q_SLOT|SAFE|NEXT|NEXT_HINT|END|TASK|SEED_TEXT)\b/;
// ✅ ILINE抽出用：内部マーカー行は「捨てる」のではなく、必要な本文だけ抽出して残す
// - 非内部行（ユーザー本文など）はそのまま残す
// - @NEXT_HINT は LOCK 材料にしない（必ず除外）
// - 内部行は JSON から本文候補のみ拾う（原則 user は拾わない）
// - ただし ILINE タグがある場合は救済的に拾う
const stripInternalMarkersForLock = (s: string) => {
  const lines = String(s ?? '')
    .split('\n')
    .map((x) => String(x ?? '').trimEnd());

  const out: string[] = [];
  const pushUnique = (t: string) => {
    const v = String(t ?? '').trim();
    if (!v) return;
    if (!out.includes(v)) out.push(v);
  };

  // JSONから拾う候補キー（LOCK用：本文系のみ）
  // NOTE: user は原則拾わない（@OBS の user が userText と同一になりやすい）
  const PICK_KEYS = ['text', 'seed_text', 'seedText', 'content', 'message', 'body', 'value'];

  for (const line of lines) {
    const t0 = String(line ?? '');
    const t = t0.trim();
    if (!t) continue;

    // ✅ 先に落とす（INTERNAL_LINE_MARKER に含まれてなくても混入させない）
    if (/^@NEXT_HINT\b/.test(t)) continue;

    // 非内部行（= ユーザーが素で書いた本文等）は基本そのまま残す
    // ただし「hint ...」は表示ノイズになりやすいので、本文だけを残す（LOCK用の整形）
    if (!INTERNAL_LINE_MARKER.test(t)) {
      const rawLine = t0.trim();

      // "hint ..." / "hint(... ) ..." を本文だけにする
      const m = rawLine.match(/^hint(?:\([^)]+\))?\s+(.+)$/);
      if (m && m[1]) {
        pushUnique(String(m[1]).trim());
      } else {
        pushUnique(rawLine);
      }
      continue;
    }


    // 内部行：JSON部分を抽出
    const i0 = t.indexOf('{');
    const i1 = t.lastIndexOf('}');
    if (i0 < 0 || i1 <= i0) continue;

    const jsonText = t.slice(i0, i1 + 1).trim();
    let obj: any = null;
    try {
      obj = JSON.parse(jsonText);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;

    const dump = JSON.stringify(obj);
    const hasILineTag = /\[\[ILINE\]\]/.test(dump) || /\[\[\/ILINE\]\]/.test(dump);

    let pickedAny = false;

    // 本文候補を拾う
    for (const k of PICK_KEYS) {
      const v = (obj as any)?.[k];
      if (typeof v === 'string' && v.trim()) {
        pushUnique(v.trim());
        pickedAny = true;
      }
    }

    // ILINEタグがあるのに上で拾えてない場合は、文字列っぽい値を浅く探索して救済
    if (hasILineTag && !pickedAny) {
      for (const v of Object.values(obj)) {
        if (typeof v === 'string' && v.trim()) {
          if (/\[\[ILINE\]\]/.test(v) || /\[\[\/ILINE\]\]/.test(v)) {
            pushUnique(v.trim());
            pickedAny = true;
          }
        }
      }
    }

    // ✅ 例外：ILINEタグ付きの場合だけ user も拾う（必要なら）
    if (hasILineTag) {
      const u = (obj as any)?.user;
      if (typeof u === 'string' && u.trim()) pushUnique(u.trim());
    }
  }

  return out.join('\n').trim();
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

  // ✅ 重要：8固定だと multi7（見出し+本文）で後半が落ちる
  // - 見出し+本文 で 6段を作る場合、最大 12 まで必要になり得る
  // - ここは “保険” なので少し広めに取る（renderGateway側で表示はクランプされる）
  const MAX_REPHRASE_BLOCKS = 16;

  return parts.slice(0, MAX_REPHRASE_BLOCKS);
};


  // (A) FIXED
  if (mode === 'FIXED') {
    const fixedTexts = buildFixedBoxTexts(inKeys.length);
    const out: Slot[] = inKeys.map((k, i) => ({ key: k, text: fixedTexts[i] ?? 'ここで止める。' }));

    const text0 = String(out[0]?.text ?? '').trim();
    const metaExtra: any = {
      rephraseBlocks: text0 ? [{ text: text0, kind: 'p' }] : [],
      rephraseHead: text0 ? safeHead(text0, 120) : null,
    };

    logRephraseOk(debug, out.map((x) => x.key), out[0]?.text ?? '', 'FIXED');
    logRephraseAfterAttach(debug, out.map((x) => x.key), out[0]?.text ?? '', 'FIXED', metaExtra);

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

  // ✅ 方針（改）：生の全文履歴は渡さず、「直近の要点だけ」を historyText として渡す
  // - “続けてください”でも対象がわかる最低限の文脈を入れる
  // - userText混入（@OBS.user など）とは別経路なので、ここは安全に整形して使う
  const lastTurns = extractLastTurnsFromContext(opts?.userContext ?? null);

// src/lib/iros/language/rephrase/rephraseEngine.full.ts
// buildHistoryTextLite を “user生文ゼロ” にする（HISTORY_LITE 漏れ止血）

const buildHistoryTextLite = (turns: any[]): string => {
  const lines: string[] = ['HISTORY_LITE (DO NOT OUTPUT):'];

  for (const t of Array.isArray(turns) ? turns : []) {
    const role = t?.role === 'assistant' ? 'assistant' : t?.role === 'user' ? 'user' : null;
    if (!role) continue;

    // 🚫 user 生文は禁止：HISTORY_LITE には “[USER]” だけ残す
    if (role === 'user') {
      lines.push('user: [USER]');
      continue;
    }

    // assistant は短く整形（長文化しない）
    const raw = String(t?.content ?? t?.text ?? '').replace(/\r\n/g, '\n').trim();
    if (!raw) continue;

    const one = raw.length > 260 ? `${raw.slice(0, 260)}…` : raw;
    lines.push(`assistant: ${one}`);
  }

  return lines.join('\n');
};

  const historyText = buildHistoryTextLite(lastTurns);
// slot由来の下書き（露出禁止）
// - @OBS 内の user/lastUserText を writer に渡さない（userText混入の経路を遮断）
const sanitizeSlotTextForWriter = (s: string) => {
  const t = String(s ?? '').trim();
  if (!t) return '';

  // @OBS {"...": "..."} の JSON 部分だけを安全に編集する
  if (/^@OBS\b/.test(t)) {
    const i0 = t.indexOf('{');
    const i1 = t.lastIndexOf('}');
    if (i0 >= 0 && i1 > i0) {
      const head = t.slice(0, i0).trimEnd();
      const jsonText = t.slice(i0, i1 + 1);
      try {
        const obj = JSON.parse(jsonText);
        if (obj && typeof obj === 'object') {
          // ✅ userText混入キーを落とす
          delete (obj as any).user;
          delete (obj as any).lastUserText;
        }
        return `${head} ${JSON.stringify(obj)}`.trim();
      } catch {
        // パースできない場合はそのまま（壊さない）
        return t;
      }
    }
  }

  return t;
};

const seedDraftRawAll = extracted.slots
  .map((s) => sanitizeSlotTextForWriter(s.text))
  .filter(Boolean)
  .join('\n');

  // ✅ slotキーは key だけでなく id も見る（framePlan 由来で id しか無いケースを救う）
  const getSlotKey = (s: any) => {
    return String(s?.key ?? s?.id ?? s?.slotKey ?? s?.slot_id ?? '').trim();
  };

  const seedDraftRawPicked = extracted.slots
    .filter((s) => {
      const k = getSlotKey(s);

      const ut = String(userText ?? '').trim();
      const isVeryShort = ut.length > 0 && ut.length <= 10;

      const isGreeting =
        /^(こんにちは|こんばんは|おはよう|もしもし|やあ|ハロー|hello|hi|hey|おつかれ|お疲れ)\b/i.test(ut);

      const isAckWord =
        /^(ありがとう|ありがとうございます|どうも|感謝|了解|りょうかい|わかった|分かった|OK|ok|おけ|オケ|承知|了解です|了解しました|お願いします|よろしく|宜しく)\b/.test(
          ut,
        );

      const isAckLike = isAckWord || (isVeryShort && !isGreeting);

      const hasOBS = extracted.slots.some((x) => getSlotKey(x) === 'OBS');

      if (isAckLike) {
        if (hasOBS) return k === 'OBS';
        return k === 'SEED_TEXT' || k === 'DRAFT' || k === 'OBS';
      }

      if (k === 'OBS') return true;
      if (k === 'DRAFT') return true;
      if (k === 'SEED_TEXT') return true;

      if (k === 'SHIFT') return true;

      // 🚫 NEXT は「内部ヒント」なので writer 素材に混ぜない
      // if (k === 'NEXT') return true;

      if (k === 'END') return true;
      if (k === 'ONE_POINT') return true;

      if (k.startsWith('FLAG_')) return true;

      return false;
    })
    .map((s) => s.text)
    .filter(Boolean)
    .join('\n');

  // ✅ 保険：拾えた seed が userText 相当だけになったら rawAll に戻す
  const seedDraftRaw = (() => {
    const all = String(seedDraftRawAll ?? '').trim();
    const picked = String(seedDraftRawPicked ?? '').trim();
    const ut = String(userText ?? '').trim();

    // all 側に @SHIFT などの directive があるのに、picked が userText だけなら事故
    const allHasDirective = /@(OBS|SHIFT|SH|RESTORE|Q|Q_SLOT|SAFE|NEXT|END|TASK|SEED_TEXT)\b/m.test(all);
    const pickedLooksLikeUserOnly =
      !!ut &&
      (!!picked && (picked === ut || (picked.length <= ut.length + 2 && picked.includes(ut))));

    if (allHasDirective && pickedLooksLikeUserOnly) return all;
    return picked || all;
  })();


  const recallMust = extractRecallMustIncludeFromSeed(seedDraftRawAll);
  const mustIncludeRuleText = buildMustIncludeRuleText(recallMust);

  // ILINE抽出：slot + userText 両方から拾う（seed 側は内部マーカー除外）
  const seedForLock = stripInternalMarkersForLock(seedDraftRaw);

  // ✅ seedForLock が userText を “含んでいる” ケースがある（SEED_TEXT が userText を内包する等）
  //    → その場合に userText を追加連結すると「同文2回」になって LLM がオウム返ししやすい。
  const seedStr = String(seedForLock ?? '').trim();
  const userStr = String(userText ?? '').trim();

  const normForDup = (s: string) => {
    // 既存：軽い正規化（改行は残る）
    return s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  };

  // ✅ 追加：改行差を潰して「同文」を検出できるようにする
  const normForDupFlat = (s: string) => {
    return String(s ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\n+/g, ' ')      // 改行 → スペース
      .replace(/[ \t]+/g, ' ')   // 連続空白を潰す
      .trim();
  };

  const seedNorm = normForDup(seedStr);
  const userNorm = normForDup(userStr);

  const seedFlat = normForDupFlat(seedStr);
  const userFlat = normForDupFlat(userStr);

  const seedHasUser =
    (!!seedNorm && !!userNorm && (seedNorm === userNorm || (userNorm.length >= 12 && seedNorm.includes(userNorm)))) ||
    (!!seedFlat && !!userFlat && (seedFlat === userFlat || (userFlat.length >= 12 && seedFlat.includes(userFlat))));

  // ✅ userText は「ILINEタグがある時だけ」 lockSource に入れる（将来の誤固定を防止）
  const userHasILINE = /\[\[ILINE\]\]/.test(userStr) || /\[\[\/ILINE\]\]/.test(userStr);

  // ✅ LOCK素材は基本 seed のみ。user に ILINE がある場合だけ追加（ただし重複は追加しない）
  const lockParts = [
    seedStr,
    userHasILINE && !seedHasUser ? userStr : '',
  ]
    .filter((x): x is string => Boolean(String(x ?? '').trim()))
    .map((x) => String(x));

  const lockSourceRaw = lockParts.join('\n');

  console.info('[IROS/ILINE][LOCK_PARTS]', {
    seedLen: String(seedForLock ?? '').length,
    userLen: String(userText ?? '').length,

    seedEqUser: String(seedForLock ?? '') === String(userText ?? ''),
    seedHasUser,

    // ✅ “実際に採用される lockParts” の長さを出す
    lockPartsLen: lockParts.length,

    lockHasNewline: String(lockSourceRaw ?? '').includes('\n'),
    lockLen: String(lockSourceRaw ?? '').length,
    lockHead120: String(lockSourceRaw ?? '').slice(0, 120),
  });

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

  // ✅ LLMに渡す素材は「slot由来」を使う（LOCK用seedForLockは使わない）
  // - seedForLock は ILINE抽出のための整形であり、LLM seed にすると指示素材が消えやすい
  const { cleanedForModel: seedDraft0 } = extractLockedILines(seedDraftRaw);
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

    // ✅ 方針：@NEXT_HINT は evidence 用に slotPlan 側へ残すが、
    // ✅ writer の seed（seedFinal/seedDraft）には絶対に混ぜない（自然文混入を防ぐ）

    if (!u) return s;
    if (!s) return u;

    // ✅ directives seed（@SHIFT 等）は “素材そのもの” なので userText で潰さない
    const hasDirectives =
      /@(OBS|SHIFT|SH|RESTORE|Q|SAFE|NEXT|END|TASK)\b/m.test(s);

    if (hasDirectives) {
      // directives seed を保つ（NEXT_HINT は混ぜない）
      return s;
    }

    // ✅ 短文（同意/感想/短い呼びかけ）では userText 退避しない
    // - seed を捨てると、writer が材料不足で抽象テンプレに寄りやすい
    const isVeryShort = u.length <= 30;

    const isAckLike =
      /^(ありがとう|ありがとうございます|どうも|感謝|了解|りょうかい|わかった|分かった|OK|ok|承知|お願いします|よろしく|宜しく)/u.test(
        u,
      ) ||
      /^(楽しみ|良さそう|いいね|なるほど|たしかに|そうだね|それで|それなら)/u.test(u);

    if (isVeryShort || isAckLike) return s;

    // ここから下は「plain seed」のときだけ userText 優先の可能性を検討
    const tokens = Array.from(
      new Set(u.split(/[^\p{L}\p{N}一-龥ぁ-んァ-ヶー]+/u).filter(Boolean)),
    );
    const keyTokens = tokens.filter((t) => t.length >= 2).slice(0, 8);
    const hit = keyTokens.some((t) => s.includes(t));

    const abstractish = /見失わなければ|ここからは|整えなくていい|進む|動いてる|止まった/u.test(s);

    // ✅ userText を優先するのは「seedが噛み合わない AND seedが抽象」くらいに絞る
    if (!hit && abstractish) return u;

    // 噛み合っていないが抽象でもない → seed を残す（材料優先）
    return s;
  };



// replace: src/lib/iros/language/rephrase/rephraseEngine.full.ts
// from: 2267
// to:   2311 手前（= const itOk 行の直前まで）
//
// 目的：seedDraftを「seedFinal一本」にし、userText混入の地雷を消す。

const seedDraftSanitized = sanitizeSeedDraftForLLM(seedDraft0);

// ✅ 方針：writer へ userText を絶対に渡さない
// - chooseSeedForLLM の userText 経路を遮断
// - seed が空になる場合は固定の安全フレーズにフォールバック
const seedFinal = chooseSeedForLLM(seedDraftSanitized, '') || '続けてください';

// ✅ seedDraft は seedFinal を正本とする（userText遮断の一貫性）
// - humanizeDirectivesForSeed は userText を混ぜうるため削除（地雷化する）
const seedDraft = seedFinal;

// writer向けの軽いヒント（※ここも userText を足さない前提）
const seedDraftHint = adaptSeedDraftHintForWriter(seedDraft, isDirectTask);
const itOk = readItOkFromContext(opts?.userContext ?? null);
const band = extractIntentBandFromContext(opts?.userContext ?? null);

// 既存の `lastTurns` をそのまま使い、会話が「assistant始まり」になるように整える
const lastTurnsSafe = (() => {
  const t = (Array.isArray(lastTurns) ? lastTurns : [])
    .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m: any) => ({
      role: m.role as 'user' | 'assistant',
      content: String(m.content ?? '').trim(),
    }))
    .filter((m: any) => m.content.length > 0);

  // 直近を少し広めに取る
  let tail = t.slice(-6);

  // internalPack が user 固定なので、turns の先頭が user だと user,user 連投になる。
  // 先頭が user で、後ろに assistant がいるなら、先頭側の user を落として assistant 始まりへ寄せる。
  while (tail.length > 0 && tail[0].role === 'user' && tail.some((x) => x.role === 'assistant')) {
    tail.shift();
  }

  // 最終的に最大4メッセージ
  return tail.slice(-4);
})();



  // =========================================================
  // Flow / Context Digest
  // =========================================================
  const flowDigest = readFlowDigest(opts?.userContext ?? null);
  const flowTape = readFlowTape(opts?.userContext ?? null);

  // topic / goal / repeat（存在すれば拾う・なければ null）
  const topicDigest = String(
    (opts?.userContext as any)?.topicDigest ??
      (opts?.userContext as any)?.meta?.topicDigest ??
      (opts?.userContext as any)?.extra?.topicDigest ??
      (opts?.userContext as any)?.ctxPack?.topicDigest ??
      (opts?.userContext as any)?.orch?.topicDigest ??
      ''
  ).trim() || null;

  const replyGoal = String(
    (opts?.userContext as any)?.replyGoal ??
      (opts?.userContext as any)?.ctxPack?.replyGoal ??
      ''
  ).trim() || null;

  const repeatSignal = String(
    (opts?.userContext as any)?.repeatSignal ??
      (opts?.userContext as any)?.ctxPack?.repeatSignal ??
      ''
  ).trim() || null;

  // =========================================================
  // Shift slot text（既存）
  // =========================================================
  const shiftTextForMode = String(
    (shiftSlot as any)?.text ??
      (shiftSlot as any)?.content ??
      (shiftSlot as any)?.value ??
      (shiftSlot as any)?.body ??
      (shiftSlot as any) ??
      ''
  );

  // repeatSignal（topic/goal/repeat の拾い上げ結果）を優先して使う
  const repeatSignalSame = repeatSignal === 'same_phrase';

  // --- lane detect (SHIFT欠落でも復元する) -----------------------------
  // SHIFTが無いケースが実在する（dev.logで確認済み）ため、
  // SHIFTだけに依存せず、meta/seed/ユーザー文も含めて laneKey / kind を拾う。
  const laneHintText = [
    String(shiftTextForMode ?? ''),
    String(metaText ?? ''),
    String(seedDraftHint ?? ''),
    String(userText ?? ''),
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);

  // ✅ raw hit（repeat判定の前に、レーン意図そのものを拾う）
  const hitTConcretize =
    /"laneKey"\s*:\s*"T_CONCRETIZE"/.test(laneHintText) ||
    /"kind"\s*:\s*"t_concretize"/.test(laneHintText) ||
    /\bT_CONCRETIZE\b/.test(laneHintText) ||
    /\bt_concretize\b/.test(laneHintText);

  // =========================================================
  // ✅ IDEA_BAND の「今回だけ強制終了」暫定ポリシー
  // - 汚染源（shift/meta/seed）由来の IDEA_BAND 痕跡では発火させない
  // - ユーザーが“候補/リスト要求”したターンだけ IDEA_BAND を許可する
  // =========================================================
  const userTextForIdeaBand = String(userText ?? '').trim();

  // 候補要求（ざっくり判定：今は安全側＝要求が明示された時だけ）
  const wantsCandidatesByUserText =
    /候補|案|選択肢|リスト|一覧|いくつ|何個|どれがいい|おすすめ|オプション|パターン|候補出し|並べて|列挙/.test(
      userTextForIdeaBand,
    );

  // IDEA_BAND のヒットは userText 由来だけで見る（＝“1回出したら次ターンで落ちる”）
  const hitIdeaBand = wantsCandidatesByUserText;

  // ✅ kill policy:
  // - same_phrase でも IDEA_BAND は殺さない（候補は再提示が必要になることがある）
  // - T_CONCRETIZE は従来どおり repeat を抑制（会話破壊を避ける）
  //
  // ✅ lane single source of truth:
  // - wantsIdeaBand を固定で立てない（下流が常時 IDEA_BAND 化して壊れる）
  // - 同時ヒット時は T_CONCRETIZE を優先（レーンは単一に収束させる）
// - wantsIdeaBand を固定で立てない（下流が常時 IDEA_BAND 化して壊れる）
// ✅ repeatSignalSame（同句反復）が立っている時は lane を立てず、counsel/normal 側へ逃がす
const wantsTConcretize = hitTConcretize && !repeatSignalSame;
const wantsIdeaBand = !wantsTConcretize && hitIdeaBand && !repeatSignalSame;



  try {
    console.log('[IROS/rephraseEngine][LANE_DETECT]', {
      killPolicyRev: 'phase1.5-ideaBandNoKill',
      wantsTConcretize,
      wantsIdeaBand,
      repeatSignalSame,
      repeatSignalHead: String(((opts?.userContext as any)?.ctxPack?.repeatSignal ?? '')).slice(0, 120),

      shiftTextForModeHead: shiftTextForMode.slice(0, 120),
      shiftSlotType: typeof (shiftSlot as any),
      shiftSlotKeys:
        shiftSlot && typeof shiftSlot === 'object' ? Object.keys(shiftSlot as any).slice(0, 12) : null,
      laneHintHead: laneHintText.slice(0, 160),
    });
  } catch {}


  // ✅ T_CONCRETIZE の“圧”を下げて会話を壊さない（復唱/抽象テンプレ逃げを抑制）
  const tConcretizeHeader = wantsTConcretize
    ? [
      '【T_CONCRETIZE（優先）】',
      '- 本文は短め（2〜8行目安）。',
      '- 冒頭でユーザー文をそのまま復唱しない（短く言い換えて言い切る）。',
      '- “次の一歩”は1つだけ。抽象語で逃げず、対象/操作点を1つに絞る（例示OK）。',
      '- 未来の指示は「命令」ではなく“選択肢提示”で出す（例：A/B/C）。',
      '- 質問は最大1つまで（必要なときだけ）。',
      '',

      ].join('\n')
    : '';

  // ✅ IDEA_BAND（候補生成）出力契約：Phase1をそのまま“強制”
  const ideaBandHeader = wantsIdeaBand
    ? [
        '【IDEA_BAND 出力契約（最優先）】',
        '- 出力は2〜5行のみ（1行=1候補）。',
        '- 各行は「◯◯という選択肢」または同等の“候補提示”だけを書く。',
        '- 行動指示・一手・具体化（ToDo/手順/時間/タイマー/次は…）は禁止。',
        '- 説明・一般論・比喩・鏡（言い換え）・構造化（Aしたい/でもB）も書かない。',
        '- 質問は0（聞き返しで進めない）。',
        '',
      ].join('\n')
    : '';

  // ✅ IDEA_BAND のときは directTask を強制で無効化する
  //    （directTask があると “文章を仕上げる” 側に吸われて契約違反の初撃が出やすい）
  const directTaskForPrompt = wantsIdeaBand ? false : isDirectTask;

  // ✅ レーンが明示されている時は GROUND をやめる
  //    （GROUND骨格が IDEA_BAND を潰すため）
  const baseSystemPrompt = systemPromptForFullReply({
    ...(opts as any)?.systemPromptArgs,

    // ✅ directTask は wantsIdeaBand を考慮した版を渡す
    directTask: directTaskForPrompt,

    // ✅ IT成立（証拠）を systemPrompt に届ける
    itOk,

    // ✅ intentBand / tLayerHint を systemPrompt に届ける（GUIDE_I 判定の材料）
    band,

    // ✅ micro/greeting は GUIDE_I を止める（“接続だけ”の短文で I/T 誘導が出るのを防ぐ）
    personaMode:
      inputKind === 'micro' || inputKind === 'greeting'
        ? 'GROUND'
        : (undefined as any),

    // ✅ exprLane は「string」ではなく「{ fired, lane, reason }」想定。
    //    postprocess 側で ctxPack.exprMeta に合流している前提。
    exprLane:
      (opts as any)?.userContext?.ctxPack?.exprMeta ??
      (opts as any)?.userContext?.exprMeta ??
      (opts as any)?.exprMeta ??
      null,
  });

  // ✅ レーン契約は「最後」に置く（後段の詳細指示が勝つ）
  const laneContractTail = (tConcretizeHeader || '') + (ideaBandHeader || '');

  const systemPrompt = baseSystemPrompt + mustIncludeRuleText + laneContractTail;

  // ✅ q/depth/phase を “確証つきで” internalPack に入れる（STATE_SNAPSHOTの土台）
  // 優先順位：opts直指定 → ctxPack（最終スタンプ） → userContext直指定 → null
  const pickedDepthStage =
    (opts as any)?.depthStage ??
    (opts as any)?.userContext?.ctxPack?.depthStage ??
    (opts as any)?.userContext?.depthStage ??
    null;

  const pickedPhase =
    (opts as any)?.phase ??
    (opts as any)?.userContext?.ctxPack?.phase ??
    (opts as any)?.userContext?.phase ??
    null;

  const pickedQCode =
    (opts as any)?.qCode ??
    (opts as any)?.userContext?.ctxPack?.qCode ??
    (opts as any)?.userContext?.qCode ??
    null;

  // ✅ NEW: カードseed材料（e_turn / polarity / sa）を“確証つきで”拾う
  // 優先順位：opts直指定 → ctxPack（最終スタンプ） → userContext直指定 → null
  // ※ e_turn は instant（保存しない）/ qCode は state（保存）で混同しない
  const pickedETurn =
    (opts as any)?.e_turn ??
    (opts as any)?.userContext?.ctxPack?.mirror?.e_turn ??
    (opts as any)?.userContext?.e_turn ??
    null;

  const pickedPolarity =
    (opts as any)?.polarity ??
    (opts as any)?.userContext?.ctxPack?.mirror?.polarity ??
    (opts as any)?.userContext?.polarity ??
    null;

  const pickedSa =
    (opts as any)?.sa ??
    (opts as any)?.userContext?.ctxPack?.sa ??
    (opts as any)?.userContext?.sa ??
    null;


  const exprDirectiveV1ForPack = String(
    (opts as any)?.userContext?.ctxPack?.exprMeta?.directiveV1 ??
    (opts as any)?.userContext?.exprMeta?.directiveV1 ??
    ''
  ).trim();

    // ✅ internalPack 本体
    let internalPack = buildInternalPackText({
      metaText,



      // ✅ internalPack に history を二重投入しない（messages 側で lastTurns を渡している）
      historyText: '',

      seedDraftHint,
      lastTurnsCount: lastTurnsSafe.length,
      itOk,
      directTask: directTaskForPrompt,
      inputKind,
      intentBand: band.intentBand,
      tLayerHint: band.tLayerHint,
      userText,
      onePointText: null,

      // まずは “入れる” を優先（要件：確証つきで通す）
      situationSummary: null,
      depthStage: pickedDepthStage,
      phase: pickedPhase,
      qCode: pickedQCode,

      flowDigest,
      flowTape,

      // ✅ 会話が流れるための3点（topic / goal / 反復）
      topicDigest,
      replyGoal,
      repeatSignal,

      // ✅ NEW: Writer向け短い再指示（INTERNAL PACKへ）
      exprDirectiveV1: exprDirectiveV1ForPack,
    } as any);

// ✅ NEW: RESONANCE_STATE seedin（状態→seed_text を LLM 内部材料として渡す）
// - 見出しを必ず付ける（WRITER_IN_PACK_HEAD が検出する）
// - 行数は短く固定（長文化防止）
// - 2重挿入はしない（この関数内で “必ず1回” にする）
try {
  const ctxPack: any = (opts as any)?.userContext?.ctxPack ?? null;

  const rs: any =
    ctxPack?.resonanceState ??
    (opts as any)?.userContext?.resonanceState ??
    (opts as any)?.resonanceState ??
    null;

  // ✅ 最優先：resonanceState.seed.seed_text（postprocess 正本）
  const seedTextRaw: any =
    (rs?.seed?.seed_text ?? null) ||
    (rs?.seed_text ?? null) ||
    // ✅ 互換：旧キー meta.extra.seed_text 相当
    (ctxPack?.seed_text ?? null) ||
    ((opts as any)?.userContext?.seed_text ?? null) ||
    ((opts as any)?.seed_text ?? null) ||
    null;

  const seedTrim = typeof seedTextRaw === 'string' ? seedTextRaw.trim() : '';
  const block = seedTrim ? clampLines(seedTrim, 6).trim() : '';

  // ✅ すでに入ってたら追記しない（多重注入の止血）
  const already = /RESONANCE_STATE_SEED\s*\(DO NOT OUTPUT\)/.test(String(internalPack ?? ''));

  const appended = Boolean(block && !already);

  if (appended) {
    internalPack = [
      String(internalPack ?? '').trim(),
      `RESONANCE_STATE_SEED (DO NOT OUTPUT):\n${block}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  console.log('[IROS/rephraseEngine][RESONANCE_SEEDIN]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    hasSeed: Boolean(block),
    seedLen: block.length,
    seedHead: block.slice(0, 96),
    appended,
    already,
  });
} catch (e) {
  console.warn('[IROS/rephraseEngine][RESONANCE_SEEDIN] skipped', e);
}
// =========================================================
// ✅ NEW: CARD seedin（B：seed を LLM に渡す）
// - current: 観測できれば S1..T3（検出不能は null 許容）
// - future: 完全ランダム（S1..I3, e1..e5, yin/yang 全ランダム）
// - LLM へ渡すのは「カード2枚＋短いルール」だけ（10〜15行に強制）
// =========================================================
try {
  const { buildDualCardPacket, formatDualCardPacketForLLM } = await import('@/lib/iros/cards/card180');

  const ctxPack: any = (opts as any)?.userContext?.ctxPack ?? null;

  const packet = buildDualCardPacket(
    {
      current: {
        // stage は “柱” を優先（S1..T3 が来る想定）
        stage: pickedDepthStage ?? null,

        // e_turn / polarity は mirrorFlow の instant を正本として拾う（無ければ null → 現状カードnull）
        e_turn: (ctxPack?.mirror?.e_turn ?? ctxPack?.e_turn ?? null) as any,
        polarity: (ctxPack?.mirror?.polarity ?? ctxPack?.polarity ?? null) as any,

        // sa はあれば補正材料として渡す（無ければ null）
        sa: (ctxPack?.sa ?? null) as any,

        // basedOn は短い根拠（user head）でOK（長文禁止）
        basedOn: String(userText ?? '').trim().slice(0, 80) || null,
        confidence: (ctxPack?.mirror?.confidence ?? ctxPack?.confidence ?? null) as any,
      },
      previous: null,
      randomSeed: null,
    },
    {
      // 仕様どおり
      currentUndetectablePolicy: 'null',
    },
  );

  // ✅ card180 側で「カード2枚＋ルール」を生成
  const raw = String(formatDualCardPacketForLLM(packet) ?? '').trim();

  // ✅ 要件：LLMへ渡すのは 10〜15行
  // - card180 側が将来伸びても、ここで必ず短く固定する
  const cardSeedText = clampLines(raw, 15).trim();

  // internalPack の末尾に “短い塊” として追記（空は足さない）
  if (cardSeedText) {
    internalPack = [String(internalPack ?? '').trim(), cardSeedText].filter(Boolean).join('\n\n');
  }
} catch (e) {
  console.warn('[IROS/rephraseEngine][CARD_SEEDIN] skipped', e);
}

  // ✅ 観測（確証を取る）
  const __ip = String(internalPack ?? '');
  const __tailN = 260;

  console.log('[IROS/rephraseEngine][STATE_SNAPSHOT_PICKED]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    pickedDepthStage,
    pickedPhase,
    pickedQCode,
    internalPackHead: safeHead(__ip, 220),
    internalPackTail: __ip.length <= __tailN ? __ip : __ip.slice(-__tailN),
  });


// 目的：buildFirstPassMessages に渡す seedDraft を固定文字列から seedDraft に差し替え。

  // ✅ 方針：writer へ userText を一切渡さない（turns/history/finalUserText から除外）
  // - ただし「assistant側の過去ターン」は渡してよい（user生文は渡さない）
  // - 目的：writer messages に assistant ターンが載らず roles=[system,user] になっていた問題を解消する
// ✅ 方針：writer へ userText を一切渡さない（turns/history/finalUserText から除外）
// - ただし「会話の役割列（assistant/user）」は保つ（user本文は伏せる）
// - 目的：roles=[system,user] を回避し、会話の文脈だけを維持する
// ✅ 方針：writer へ userText を一切渡さない（turns/history/finalUserText から除外）
// - ただし「会話の役割列（assistant/user）」は保つ（user本文は伏せる）
// - 目的：roles=[system,user] を回避し、会話の文脈だけを維持する
const rawTurnsForWriter =
  (opts as any)?.turnsForWriter ??
  (opts as any)?.userContext?.turnsForWriter ??
  (opts as any)?.userContext?.ctxPack?.historyForWriter ??
  (opts as any)?.userContext?.historyForWriter ??
  [];

// ✅ 末尾だけ使う（LAST_TURNS_PICK と整合させる）
const MAX_TURNS_FOR_WRITER = 6;
const rawTail = Array.isArray(rawTurnsForWriter)
  ? rawTurnsForWriter.slice(-MAX_TURNS_FOR_WRITER)
  : [];

const turnsForWriter: any[] = rawTail
  .map((t: any) => {
    const role = t?.role === 'assistant' ? 'assistant' : t?.role === 'user' ? 'user' : null;
    if (!role) return null;

    // 🚫 user は生文禁止：内容は必ず伏せる（役割だけ残す）
    if (role === 'user') return { role: 'user', content: '[USER]' };

    const content = String(t?.content ?? '').trim();
    if (!content) return null;
    return { role: 'assistant', content };
  })
  .filter(Boolean);

  // ✅ buildFirstPassMessages は finalUserText を採用しない（強制遮断）ため、
  // ✅ 「最後を user で終わらせる」保証は seedDraft で行う（固定文のみ）
  let messages = buildFirstPassMessages({
    systemPrompt,
    internalPack,
    turns: turnsForWriter,
    seedDraft, // ✅ ここで上で確定した seedFinal（userText遮断済み）を渡す
  });

  // ✅ HistoryDigest v1（外から渡された場合のみ注入）
  // - 生成はここではしない（生成元は本線側に固定）
  // - 注入は systemPrompt の直後に入る（micro と同じ）
  const digestMaybe =
    (opts as any)?.historyDigestV1 ??
    (opts as any)?.userContext?.historyDigestV1 ??
    (opts as any)?.userContext?.ctxPack?.historyDigestV1 ??
    null;

  if (digestMaybe) {
    const { injectHistoryDigestV1 } = await import('@/lib/iros/history/historyDigestV1');
    const inj = injectHistoryDigestV1({ messages: messages as any, digest: digestMaybe });
    messages = inj.messages as any;
  }

  // ✅ 表現メタ（exprMeta/allow）を system 2本目として必ず注入する
  // - 判断メタ（q/depth/phase 等）は別。ここは「表現の許可」だけ。
  // - “会話が流れる”ための自由度はここで解放する（メタの檻の中）。

  // ---------------------------------------------
  // allow（進行圧）: 推進/断定/抽象削減/具体化の「許可」
  // - lane を上書きしない（lane=何をするか / allow=どれくらい強くやるか）
  // - まだ配線が無い前提なので、この場で決めて system で渡す（pure）
  // ---------------------------------------------
  const laneKeyForAllow =
    (opts as any)?.laneKey ??
    (opts as any)?.userContext?.laneKey ??
    (opts as any)?.userContext?.ctxPack?.laneKey ??
    // wants* がこのスコープに居れば拾う
    ((typeof wantsTConcretize !== 'undefined' && wantsTConcretize) ? 'T_CONCRETIZE' : null) ??
    ((typeof wantsIdeaBand !== 'undefined' && wantsIdeaBand) ? 'IDEA_BAND' : null) ??
    null;

  let allowText: string | null = null;
  let allowObj: any = null;

  // ✅ vector（方向）: allow確定直後に算出（seed本文には混ぜない）
  const VECTOR_PASS_ENABLED =
    String(process.env.IROS_VECTOR_PASS ?? '').toLowerCase() === '1' ||
    String(process.env.IROS_VECTOR_PASS ?? '').toLowerCase() === 'true';

  type VectorMode = 'advance' | 'deepen' | 'stabilize' | 'mirror' | 'reframe';
  type IrosVector = { mode: VectorMode; weight: 0 | 1 | 2 | 3; reason: string };

  let vectorPicked: IrosVector | null = null;

  function clampW(n: any): 0 | 1 | 2 | 3 {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    if (x <= 0) return 0;
    if (x >= 3) return 3;
    return (Math.round(x) as any) as 0 | 1 | 2 | 3;
  }

  function pickVectorAfterAllow(args2: {
    allow: any;
    replyGoal: string | null;
    flowDigest: string | null;
    repeatSignal: boolean;
    itOk: boolean;
    depthStage: string | null;
  }): IrosVector | null {
    const allow = args2.allow;
    if (!allow || typeof allow !== 'object') return null;

    const strength = clampW((allow as any).strength);

    // --- candidates（優先順） ---
    const goal = String(args2.replyGoal ?? '').toLowerCase();
    const flow = String(args2.flowDigest ?? '').toLowerCase();
    const isReturn = flow.includes('return');
    const isI = String(args2.depthStage ?? '').startsWith('I');

    const candidates: IrosVector[] = [];

    // reframe（意図/意味づけの再構成がテーマ）
    if (goal.includes('reframe')) {
      candidates.push({ mode: 'reframe', weight: strength, reason: 'goal=reframe' });
    }

    // RETURN / 反復気味 → mirror寄り（ただし narrow はしない）
    if (args2.repeatSignal || isReturn) {
      candidates.push({ mode: 'mirror', weight: strength, reason: args2.repeatSignal ? 'repeatSignal' : 'flow=RETURN' });
    }

    // I帯 & itOk → deepen（問いを深く）
    if (isI && args2.itOk) {
      candidates.push({ mode: 'deepen', weight: strength, reason: 'I+itOk' });
    }

    // 既定：advance（前へ）
    candidates.push({ mode: 'advance', weight: strength, reason: 'default' });

    // --- clip by allow（衝突防止の核） ---
    const clipped = candidates.filter((v) => {
      // propose禁止なら advance を出さない
      if (v.mode === 'advance' && (allow as any).propose === false) return false;

      // assert=false は「断定禁止」。advance 自体は禁止しない（提案として書ける）
      // if (v.mode === 'advance' && (allow as any).assert === false) return false;

      return true;
    });


    if (clipped.length === 0) return null;

    // concretize禁止なら advance のweightを落とす（方向は残すが推進圧を弱める）
    const picked = { ...clipped[0] };
    if (picked.mode === 'advance' && (allow as any).concretize === false) {
      picked.weight = (picked.weight >= 2 ? 1 : picked.weight) as 0 | 1 | 2 | 3;
      picked.reason = `${picked.reason}+clip:concretize=false`;
    }

    // weight=0 なら無し扱い
    if (picked.weight === 0) return null;
    return picked;
  }

  try {
    const { buildAllow, formatAllowSystemText } = await import('@/lib/iros/allow/buildAllow');

    // ※ pickedDepthStage / pickedQCode / repeatSignal / itOk はこの直前で確保済みの前提
    allowObj = buildAllow({
      depthStage: pickedDepthStage ?? null,
      laneKey: laneKeyForAllow,
      repeatSignal: Boolean(repeatSignal),
      qPrimary: pickedQCode ?? null,
      itOk: Boolean(itOk),
    } as any);

    // -------------------------------------------------------
    // deepReadBoost（RETURN streak>=2 のときだけ “1段だけ” 許可を上げる）
    // - 目的：命名ではなく「構造説明」を少し増やす余地を作る
    // - 実装：allow.strength を +1（上限3）にするだけ（他は触らない）
    // -------------------------------------------------------
    const flowDeltaNow =
      String(flowDigest ?? '').toLowerCase().includes('return') ? 'RETURN' : null;

    // seed_text（例: '流れ:RETURN / 戻り:2'）から戻り回数を読む。無ければ 0。
    const returnStreakNow = (() => {
      // ctxPack はこの位置ではまだ宣言されていないので、opts から直接取る
      const src = String(
        ((opts as any)?.userContext?.ctxPack?.seed_text ?? '') ||
          (flowDigest ?? '')
      );
      const m = src.match(/戻り:\s*(\d+)/);
      const n = m ? Number(m[1]) : 0;
      return Number.isFinite(n) ? n : 0;
    })();
    if (allowObj && typeof allowObj === 'object') {
      if (flowDeltaNow === 'RETURN' && returnStreakNow >= 2) {
        const cur = Number((allowObj as any).strength ?? 2);
        const next = Number.isFinite(cur) ? cur + 1 : 3;
        (allowObj as any).strength = Math.min(next, 3);
        (allowObj as any).__deepReadBoost = { flowDeltaNow, returnStreakNow }; // ログ確認用（露出しない）
      }
    }

    allowText = formatAllowSystemText(allowObj as any);

    console.log('[IROS/rephraseEngine][ALLOW]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      depthStage: pickedDepthStage ?? null,
      qCode: pickedQCode ?? null,
      phase: pickedPhase ?? null,
      laneKeyForAllow,
      repeatSignal: Boolean(repeatSignal),
      itOk: Boolean(itOk),
      allow: allowObj,
    });

    // ✅ vector算出（まだ“渡さない”。まずログ検証のみ）
    if (VECTOR_PASS_ENABLED) {
      vectorPicked = pickVectorAfterAllow({
        allow: allowObj,
        replyGoal: String(replyGoal ?? '').trim() || null,
        flowDigest: String(flowDigest ?? '').trim() || null,
        repeatSignal: Boolean(repeatSignal),
        itOk: Boolean(itOk),
        depthStage: pickedDepthStage ?? null,
      });

      console.log('[IROS/VECTOR][PICK]', {
        traceId: debug.traceId,
        conversationId: debug.conversationId,
        userCode: debug.userCode,
        enabled: true,
        vector: vectorPicked,
      });
    } else {
      console.log('[IROS/VECTOR][PICK]', {
        traceId: debug.traceId,
        conversationId: debug.conversationId,
        userCode: debug.userCode,
        enabled: false,
        vector: null,
      });
    }
  } catch (e) {
    console.log('[IROS/rephraseEngine][ALLOW][ERR]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      error: String(e ?? ''),
    });
    allowText = null;
    allowObj = null;

    // allowが無いならvectorも無し（空ならmetaにも出さない方針に一致）
    if (VECTOR_PASS_ENABLED) {
      console.log('[IROS/VECTOR][PICK]', {
        traceId: debug.traceId,
        conversationId: debug.conversationId,
        userCode: debug.userCode,
        enabled: true,
        vector: null,
        reason: 'allow_missing',
      });
    }
  }


  // ---------------------------------------------
  // exprMeta（表現の質）: 語彙/比喩/余白の「許可」
  // ---------------------------------------------
  const exprMetaFromCtx =
    (opts as any)?.exprMeta ??
    (opts as any)?.userContext?.exprMeta ??
    (opts as any)?.userContext?.ctxPack?.exprMeta ??
    null;

  // 最小の既定（まずは効かせる）
  // - lane契約（IDEA_BAND/T_CONCRETIZE）は systemPrompt 側に既にある前提。
  // - ここは「言い方の自由」を与えるだけ（形式は壊さない）。
  const exprMetaDefault = {
    tone: 'med', // low|med|high
    density: 'rich', // thin|normal|rich
    metaphor: 'lite', // off|lite|on
    ambiguity: 'deny', // deny|allow
    brevity: 'normal', // short|normal|long
    rhythm: 'breathe', // flat|breathe
    forbidden: ['結論：', '次の一手：', '箇条書き', 'チェックリスト'],
  };

  const exprMeta = (exprMetaFromCtx && typeof exprMetaFromCtx === 'object')
    ? { ...exprMetaDefault, ...(exprMetaFromCtx as any) }
    : exprMetaDefault;

  const exprMetaText =
    [
      '【EXPR_META（露出禁止）】',
      '- ここは “表現の許可” だけ。判断（depth/q/回転/結論の中身）は変えない。',
      '- 形式契約（行数/レーン契約/禁止形式）は守ったまま、語彙・比喩・余白だけ自由に使ってよい。',
      `- tone: ${String((exprMeta as any).tone)}`,
      `- density: ${String((exprMeta as any).density)}`,
      `- metaphor: ${String((exprMeta as any).metaphor)}`,
      `- ambiguity: ${String((exprMeta as any).ambiguity)}`,
      `- brevity: ${String((exprMeta as any).brevity)}`,
      `- rhythm: ${String((exprMeta as any).rhythm)}`,
      `- forbidden: ${(Array.isArray((exprMeta as any).forbidden) ? (exprMeta as any).forbidden : []).join(', ')}`,
    ].join('\n');

// systemPrompt（先頭system） → allow（system2） → exprMeta（system3） → BLOCK_PLAN（system4）
// ※ HistoryDigest v1 を system2 に入れてる場合は “その後ろ” になるが、ここは同一処理内では優先順位固定でOK
// --- BLOCK_PLAN（system4）生成（設計図のみ / 例外演出のみ） ---
const ctxPack = (opts as any)?.userContext?.ctxPack ?? null;

const goalKind =
  ctxPack?.replyGoal?.kind ?? // ✅ ctxPack 正本
  ctxPack?.goalKind ??
  (opts as any)?.userContext?.goalKind ??
  (opts as any)?.goalKind ??
  null;

// ✅ depth / IT は “構造メタ” から拾う（BlockPlan 自動条件に必要）
const depthStage =
  ctxPack?.depthStage ??
  ctxPack?.unified?.depthStage ??
  (opts as any)?.userContext?.depthStage ??
  null;

// IT_TRIGGER（true/false）を最小で拾う（存在しない場合は false）
const itTriggered = Boolean(
  ctxPack?.itTriggered ??
    ctxPack?.it_triggered ??
    ctxPack?.qCounts?.it_triggered_true ??
    ctxPack?.qCounts?.it_triggered ??
    false
);

  // ✅ explicitTrigger は「今回の入力（opts.userText）」を正本にする
  // - messages は、history/bridgeの都合で “別ターンの短文” が最後の user に紛れることがある
  // - その場合「続けてください」等が trigger 判定を汚染するので、opts を優先し fallback としてのみ messages を使う
  const resolveUserTextForTrigger = (): { text: string; pickedFrom: 'opts' | 'messages' | 'empty' } => {
    const rawUserTextFromOpts = String((opts as any)?.userText ?? '').trim();

    const rawUserTextFromMessages = (() => {
      try {
        // messages を後ろから走査して「role:user」の最後を拾う
        for (let i = (messages as any[])?.length - 1; i >= 0; i--) {
          const m: any = (messages as any[])[i];
          if (m?.role === 'user') return String(m?.content ?? '').trim();
        }
      } catch {}
      return '';
    })();

    // ✅ 正本: opts（今回入力）
    if (rawUserTextFromOpts.length > 0) return { text: rawUserTextFromOpts, pickedFrom: 'opts' };

    // ✅ fallback: messages（今回入力が空のときだけ）
    if (rawUserTextFromMessages.length > 0) return { text: rawUserTextFromMessages, pickedFrom: 'messages' };

    return { text: '', pickedFrom: 'empty' };
  };

  const resolvedTrigger = resolveUserTextForTrigger();
  const userTextForTrigger = resolvedTrigger.text;

  const explicitTrigger = detectExplicitBlockPlanTrigger(userTextForTrigger);

  // ✅ 観測点：トリガ元テキストの採用元を固定ログ化
  try {
    console.log('[IROS/rephraseEngine][BLOCK_PLAN_TRIGGER_TEXT]', {
      traceId: (debug as any)?.traceId ?? null,
      conversationId: (debug as any)?.conversationId ?? null,
      userCode: (debug as any)?.userCode ?? null,
      pickedFrom: resolvedTrigger.pickedFrom,
      optsLen: String((opts as any)?.userText ?? '').trim().length,
      msgLen: userTextForTrigger.length,
      head: userTextForTrigger.slice(0, 80),
    });
  } catch {}

  // ✅ v2方針：BlockPlan + 診断（why）を同時取得
  const { plan: blockPlan, diag: blockPlanDiag } = buildBlockPlanWithDiag({
    userText: userTextForTrigger,
    goalKind,
    exprLane: (exprMeta as any)?.lane ?? null,
    explicitTrigger,

    // ✅ 自動判定の最小版に必要
    depthStage,
    itTriggered,
  });

  const blockPlanText = blockPlan ? renderBlockPlanSystem4(blockPlan) : '';

  // ---- ✅ DIAG を必ずログ化（why/flags を 1ターン確証として固定）----
  try {
    const d: any = blockPlanDiag && typeof blockPlanDiag === 'object' ? blockPlanDiag : null;

    console.log('[IROS/rephraseEngine][BLOCK_PLAN_DIAG]', {
      traceId: (debug as any)?.traceId ?? null,
      conversationId: (debug as any)?.conversationId ?? null,
      userCode: (debug as any)?.userCode ?? null,

      // ✅ 最重要：確証（why）
      why: d?.why ?? null,

      // ✅ 判定の内訳（存在しないキーは null）
      explicit: d?.explicit ?? null,
      wantsDeeper: d?.wantsDeeper ?? null,
      autoDeepen: d?.autoDeepen ?? null,
      autoCrack: d?.autoCrack ?? null,

      // ✅ turn context（後段の gate で突合できるように）
      goalKind,
      depthStage,
      itTriggered,

      // ✅ 生トリガ観測（同一turnで突合）
      explicitTrigger,
      triggerPickedFrom: (resolvedTrigger as any)?.pickedFrom ?? null,
      triggerHead: String(userTextForTrigger ?? '').slice(0, 80),

      // ✅ 生成結果の最小
      mode: (blockPlan as any)?.mode ?? null,
      blocksLen: Array.isArray((blockPlan as any)?.blocks) ? (blockPlan as any).blocks.length : 0,
      sysLen: String(blockPlanText ?? '').trim().length,
      enabled: Boolean(blockPlanText && String(blockPlanText).trim().length > 0),
    });
  } catch {}

  // ✅ 観測点：blockPlan が「生成されてるか/空か」を確定する
  try {
    const d: any = blockPlanDiag && typeof blockPlanDiag === 'object' ? blockPlanDiag : null;

    console.log('[IROS/rephraseEngine][BLOCK_PLAN]', {
      traceId: (debug as any)?.traceId ?? null,
      conversationId: (debug as any)?.conversationId ?? null,
      userCode: (debug as any)?.userCode ?? null,

      enabled: Boolean(blockPlanText && String(blockPlanText).trim().length > 0),

      goalKind,
      exprLane: (exprMeta as any)?.lane ?? null,
      explicitTrigger,

      // ✅ 最重要：why をここにも載せて検索1発に寄せる
      why: d?.why ?? null,

      // ✅ 旗（同一turnで拾えるように）
      wantsDeeper: d?.wantsDeeper ?? null,
      autoDeepen: d?.autoDeepen ?? null,
      autoCrack: d?.autoCrack ?? null,

      // ✅ trigger観測をここに統合（到達保証ログ）
      triggerPickedFrom: (resolvedTrigger as any)?.pickedFrom ?? null,
      triggerHead: String(userTextForTrigger ?? '').slice(0, 80),

      depthStage,
      itTriggered,

      mode: (blockPlan as any)?.mode ?? null,
      blocksLen: Array.isArray((blockPlan as any)?.blocks) ? (blockPlan as any).blocks.length : 0,

      sysLen: String(blockPlanText ?? '').trim().length,
    });
  } catch {}

// ✅ BLOCK_PLAN が入る時だけ、行数クランプを緩める（完走優先）
if (blockPlanText && String(blockPlanText).trim().length > 0) {
  const modeStr = String((blockPlan as any)?.mode ?? '').trim();
  const min = modeStr === 'multi7' ? 40 : 32; // multi7:40 / multi6:32（例外演出は長くてよい）
  if (typeof (maxLines as any) === 'number' && (maxLines as any) > 0) {
    maxLines = Math.max(maxLines, min);
  } else {
    maxLines = min;
  }
}

  // ✅ system を1枚に統合（systemPrompt → allow → runtimePolicy → exprMeta → BLOCK_PLAN）
  if (Array.isArray(messages) && messages.length > 0 && (messages as any)[0]?.role === 'system') {
    const base = String((messages as any)[0]?.content ?? '');
    const extraSystemParts: string[] = [];

    // allow（任意）
    if (allowText && String(allowText).trim().length > 0) {
      extraSystemParts.push(String(allowText));
    }

    // -------------------------------------------------
    // runtime policy（軽量・可変にしない）
    // - 段/行数/見出し採用は LLM 判断に任せる
    // - ただし「内部信号の露出禁止」「具体語アンカー」「見出し形式」だけは system で押さえる
    // -------------------------------------------------
    const runtimeWriterPolicyText = [
      '【WRITER RUNTIME POLICY（DO NOT OUTPUT）】',
      '- 内部信号（obs/flow/e_turn/polarity/intent/depth など）は使ってよいが、ラベル名や内部語を本文に出さない。',
      '- 抽象だけでまとめず、ユーザー発話の具体語を最低1つ残す。',
      '- 段・行数・見出しの有無は内容に合わせて決めてよい（無理に構造化しない）。',
      '- 見出しを使う場合のみ、形式は「## 絵文字1つ + 半角スペース + 見出し本文」にする。',
      '- 絵文字や見た目は文脈優先。固定テンプレ化しない（🫧は使わない）。',
    ].join('\n');

    if (runtimeWriterPolicyText.trim()) {
      extraSystemParts.push(runtimeWriterPolicyText);
    }

    // ✅ EXPR_META を system に混入（directiveV1 は system に混入しない）
    if (exprMetaText && String(exprMetaText).trim().length > 0) {
      const em: any = exprMeta && typeof exprMeta === 'object' ? exprMeta : {};
      const directiveV1_on = Boolean(em.directiveV1_on);
      const directiveV1 = String(em.directiveV1 ?? '').trim();
      const hasDirectiveV1 = !!(directiveV1_on && directiveV1.length > 0);

      // ✅ system には exprMetaText のみ入れる（directiveV1 は入れない）
      extraSystemParts.push(String(exprMetaText));

      // 追跡用（directive が存在している事実だけ見える化）
      try {
        console.log('[IROS/rephraseEngine][EXPR_META]', {
          injected: true,
          hasDirectiveV1,
          directiveInSystem: false,
        });
      } catch {}
    }

    // BLOCK_PLAN（条件付き）
    if (blockPlanText && String(blockPlanText).trim().length > 0) {
      extraSystemParts.push(String(blockPlanText));
    }

    const merged = [base, ...extraSystemParts]
      .filter((s) => String(s).trim().length > 0)
      .join('\n\n');

    messages = [{ role: 'system', content: merged } as any, ...messages.slice(1)] as any;
  }

  // ✅ system は必ず1枚に正規化（先頭に複数あれば結合して潰す）
  if (Array.isArray(messages) && messages.length >= 2) {
    const head = messages[0];
    if (head?.role === 'system') {
      let i = 1;
      const extraSystems: any[] = [];
      while (i < messages.length && messages[i]?.role === 'system') {
        extraSystems.push(messages[i]);
        i++;
      }

      if (extraSystems.length > 0) {
        const merged = [
          String(head?.content ?? ''),
          ...extraSystems.map((m) => String(m?.content ?? '')),
        ]
          .filter((s) => String(s).trim().length > 0)
          .join('\n\n');

        messages = [{ role: 'system', content: merged } as any, ...messages.slice(i)] as any;
      }
    }
  }
  // ✅ HOTFIX: LLM に渡す末尾 user は「今回入力(opts.userText)」を正本に固定する
  // - 履歴の都合で「続けてください」等が末尾 user に紛れると、seedDraft/lastUser が汚染される
  try {
    const cur = String((opts as any)?.userText ?? '').trim();
    if (cur) {
      for (let i = (messages as any[])?.length - 1; i >= 0; i--) {
        const m: any = (messages as any[])[i];
        if (m?.role === 'user') {
          (messages as any[])[i] = { ...m, content: cur };
          break;
        }
      }
    }
  } catch {}
  console.log('[IROS/rephraseEngine][EXPR_META]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    injected: true,
    tone: (exprMeta as any).tone,
    density: (exprMeta as any).density,
    metaphor: (exprMeta as any).metaphor,
    ambiguity: (exprMeta as any).ambiguity,
    brevity: (exprMeta as any).brevity,
    rhythm: (exprMeta as any).rhythm,
  });

  // ログ確認
/* =========================================
 * [置換] src/lib/iros/language/rephrase/rephraseEngine.full.ts
 * 範囲: 2856〜2864 を丸ごと置き換え
 * 目的: historyText の「中身の見え方」と「空判定」を MSG_PACK に追加
 * ========================================= */
console.log('[IROS/rephraseEngine][MSG_PACK]', {
  traceId: debug.traceId,
  conversationId: debug.conversationId,
  userCode: debug.userCode,

  lastTurns: lastTurnsSafe.length,
  hasHistoryText: Boolean(historyText),
  historyTextLen: String(historyText ?? '').length,
  historyTextIsEmpty: !String(historyText ?? '').trim(),
  historyTextHead: safeHead(String(historyText ?? ''), 180),

  msgCount: messages.length,
  roles: messages.map((m: any) => m.role),

  // ✅ 実際に LLM に送る「結合後 system」の長さ（systemポートの太さの確証）
  systemLen:
    Array.isArray(messages) && messages[0]?.role === 'system'
      ? String((messages[0] as any)?.content ?? '').length
      : 0,

  // ✅ 各メッセージのサイズ内訳（誰がprompt_tokensを太らせているか確定）
  msgLens: (Array.isArray(messages) ? messages : []).map((m: any, idx: number) => ({
    i: idx,
    role: String(m?.role ?? ''),
    len: String(m?.content ?? '').length,
    head: safeHead(String(m?.content ?? ''), 120),
  })),

  internalPackLen: String(internalPack ?? '').length,
  internalPackHasHistoryHint: /HISTORY_HINT\s*\(DO NOT OUTPUT\)/i.test(String(internalPack ?? '')),

  // ✅ merged system の内訳（このスコープで参照できる範囲だけ）
  mergedSystemPartsLen: {
    systemPrompt: String(systemPrompt ?? '').length,
    exprMetaText: String(exprMetaText ?? '').length,
    blockPlanText: String(blockPlanText ?? '').length,
  },

  // ✅ seedDraft 実体の監査（発生源特定用）
  seedDraftLen: seedDraft.length,
  seedDraftHead: safeHead(seedDraft, 120),
  seedDraftRawAllHead: safeHead(seedDraftRawAll, 200),

    // ✅ slots の中身を “頭だけ” 監査（自然文混入の犯人探し）
    slotsHead: (extracted?.slots ?? []).map((s: any, i: number) => ({
      i,
      key: String(s?.key ?? ''),
      head: safeHead(String(s?.text ?? ''), 80),
    })),

    itOk,
    intentBand: band.intentBand,
    tLayerHint: band.tLayerHint,

    directTask: directTaskForPrompt,
    directTask_raw: isDirectTask,
    inputKind,
    inputKindFromMeta,
    inputKindFromCtx,

    lockedILines: lockedILines.length,
  });
  console.log('[IROS/BLOCK_PLAN][inject]', {
    enabled: Boolean(blockPlanText && String(blockPlanText).trim().length > 0),
    mode: blockPlan?.mode ?? null,
    blocks: blockPlan?.blocks ?? null,
    explicitTrigger,
    goalKind,
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

  const validateOutput = (rawText: string): RephraseResult => {
    const res = validateOutputPure({
      rawText,

      // context
      inKeys,
      wantsIdeaBand,
      lockedILines,

      // deps (injected)
      safeHead,
      containsForbiddenLeakText,
      verifyLockedILinesPreserved,
      recallGuardOk,
      buildSlotsWithFirstText,

      // for recall guard
      extractedSlotsForRecall: (extracted?.slots ?? null) as any,
    });

    // ✅ 既存の呼び出し側は RephraseResult を期待しているので互換で返す
    if (!res.ok) {
      return {
        ok: false,
        reason: res.reason || 'VALIDATION_FAILED',
        meta: res.meta ?? { inKeys, rawLen: String(rawText ?? '').length, rawHead: safeHead(String(rawText ?? ''), 80) },
      } as any;
    }

    return {
      ok: true,
      slots: res.slots as any,
      meta: res.meta as any,
    } as any;
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

    // ✅ BLOCK_PLAN を meta.extra に刻む（renderGateway / handleIrosReply が拾う正本）
    // - 旧キー互換：extra.blockPlan.explicitTrigger を必ず用意
    // - ctxPack には入れない（継続禁止：このターン確定だけ meta.extra へ）
    try {
      const d: any = blockPlanDiag && typeof blockPlanDiag === 'object' ? blockPlanDiag : null;
      const enabled = Boolean(blockPlanText && String(blockPlanText).trim().length > 0);

      if (!metaExtra.blockPlan || typeof metaExtra.blockPlan !== 'object') metaExtra.blockPlan = {};

      // 旧キー互換（下流が参照している）
      metaExtra.blockPlan.explicitTrigger = explicitTrigger === true;

      // 確証（why）
      metaExtra.blockPlan.why = d?.why ?? null;

      // 採用フラグ（inject/LLM_GATE 側で突合）
      metaExtra.blockPlan.enabled = enabled;

      // 内訳（診断の根拠）
      metaExtra.blockPlan.explicit = d?.explicit ?? null;
      metaExtra.blockPlan.wantsDeeper = d?.wantsDeeper ?? null;
      metaExtra.blockPlan.autoDeepen = d?.autoDeepen ?? null;
      metaExtra.blockPlan.autoCrack = d?.autoCrack ?? null;

      // turn context（デバッグ突合用）
      metaExtra.blockPlan.goalKind = goalKind ?? null;
      metaExtra.blockPlan.depthStage = depthStage ?? null;
      metaExtra.blockPlan.itTriggered = itTriggered ?? null;

      // trigger source（同一turnの確証）
      metaExtra.blockPlan.triggerPickedFrom = (resolvedTrigger as any)?.pickedFrom ?? null;
      metaExtra.blockPlan.triggerHead = String(userTextForTrigger ?? '').slice(0, 80);
    } catch {}

    // --- blocks (default: paragraph-ish) ---
    const safeParseJson = (s0: any): any | null => {
      try {
        return JSON.parse(String(s0 ?? '').trim());
      } catch {
        return null;
      }
    };

    const isIdeaBand = detectIdeaBandProposeFromExtracted(extracted);

    // idea_band は「2ブロック以上」が取れないと [] になることがある。
    // その場合は通常の段落/改行分割にフォールバックして、最低でも 1 block を作る。
    let blocksText = isIdeaBand ? makeIdeaBandCandidateBlocks(text) : toRephraseBlocks(text);
    if (!Array.isArray(blocksText) || blocksText.length === 0) {
      blocksText = toRephraseBlocks(text);
    }


    // --- LLM signals（密度など）を抽出して meta.extra に積む（depth直結禁止）
    const clamp01 = (x: number): number => {
      if (!Number.isFinite(x)) return 0;
      return x < 0 ? 0 : x > 1 ? 1 : x;
    };

    const extractLlmSignals = (textRaw: string) => {
      const s = String(textRaw ?? '');
      const charLen = s.length;
      const newlines = (s.match(/\n/g) ?? []).length;
      const punct = (s.match(/[、。,.!?！？]/g) ?? []).length;
      const kanji = (s.match(/[\u4E00-\u9FFF]/g) ?? []).length;

      const punctRatio = charLen > 0 ? clamp01(punct / charLen) : 0;
      const kanjiRatio = charLen > 0 ? clamp01(kanji / charLen) : 0;

      // length / kanji / punctuation / newline を軽く合成した “density”
      const lenScore = clamp01(charLen / 240);
      const nlScore = clamp01(newlines / 4);
      const density = clamp01(lenScore * 0.55 + kanjiRatio * 0.25 + punctRatio * 0.15 + nlScore * 0.05);

      return { density, charLen, newlines, punctRatio, kanjiRatio };
    };

    const blocks = blocksText.map((t) => ({ text: t, kind: 'p' }));

    // ✅ 1回だけ代入（重複排除）
    metaExtra.rephraseBlocks = blocks;

    // ✅ signals を付与（受け口）
    try {
      (metaExtra as any).llmSignals = extractLlmSignals(String(text ?? ''));
    } catch {}

    // ✅ BLOCK_PLAN を meta.extra にも運ぶ（renderGateway/handleIrosReply が拾える受け口）
    try {
      if (blockPlan && typeof blockPlan === 'object') {
        const mode = (blockPlan as any).mode ?? null;
        const blocks = Array.isArray((blockPlan as any).blocks) ? (blockPlan as any).blocks : null;

        if (mode) (metaExtra as any).blockPlanMode = mode;
        if (mode || blocks) (metaExtra as any).blockPlan = { mode: mode ?? null, blocks: blocks ?? null };
      }
    } catch {}

    metaExtra.rephraseHead =
      metaExtra.rephraseHead ??
      (blocks?.[0]?.text ? safeHead(String(blocks[0].text), 120) : null);

    try {
      (debug as any).rephraseBlocks = blocks;
      (debug as any).llmSignals = (metaExtra as any).llmSignals ?? null;
    } catch {}

    logRephraseAfterAttach(debug, inKeys, outSlots[0]?.text ?? '', note ?? 'LLM', metaExtra);

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

    const slotKeysForGuard = Array.isArray(inKeys) ? inKeys : ['SEED_TEXT', 'OBS', 'SHIFT'];

    let v = flagshipGuard(stripHedgeLite(textForGuard), {

      slotKeys: slotKeysForGuard,
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

  const guardEnabled = envFlagEnabled(process.env.IROS_FLAGSHIP_GUARD_ENABLED, false);

  // ---------------------------------------------
  // LLM call (1st)
  // ---------------------------------------------
  let raw = '';
  let raw2 = '';

  // ✅ 1st pass
  const slotPlanPolicyResolved =
    (opts as any)?.slotPlanPolicy ??
    (opts as any)?.userContext?.slotPlanPolicy ??
    (opts as any)?.userContext?.ctxPack?.slotPlanPolicy ??
    (debug as any)?.slotPlanPolicy ??
    null;

  // ✅ historyDigestV1: ctxPack / userContext から拾う（存在する時だけ “実際に注入” する）
  const historyDigestV1 =
    (opts as any)?.historyDigestV1 ??
    (opts as any)?.userContext?.historyDigestV1 ??
    (opts as any)?.userContext?.ctxPack?.historyDigestV1 ??
    null;

  // ⚠️ 注意：
  // pickedQCode / pickedDepthStage / pickedPhase は
  // すでに上（internalPackの直前あたり）で定義されている前提で “再定義しない”
  // ここでは参照だけする。

// ✅ micro-like は rephrase LLM を呼ばずに即 return（コスト/遅延を消す）
{
  const seedDraftTrim = String(seedDraft ?? '').trim();
  const userLenTiny = String(userText ?? '').trim().length <= 2;
  const seedLenTiny = seedDraftTrim.length > 0 && seedDraftTrim.length <= 40;

  // inputKind が 'micro' / 'greeting' を持っている場合もここで吸収
  const microLikeEarly =
    inputKind === 'micro' ||
    inputKind === 'greeting' ||
    (userLenTiny && seedLenTiny);

  if (microLikeEarly) {
    // この関数の引数 `extracted` をそのまま slots として扱う（slots 変数に依存しない）
    const fixed: any = { ...(extracted as any) };

    // seedDraft を OBS に採用（短文で前に進む）
    fixed.OBS = {
      ...(fixed.OBS ?? {}),
      key: 'OBS',
      content: seedDraftTrim,
      head: seedDraftTrim,
    };

    // scaffoldActive はこの時点では未確定なので、ここでは false 固定でOK（あとで必要なら再設計）
    return {
      ok: true,
      slots: fixed,
      meta: {
        inKeys: Object.keys((extracted as any) ?? {}),
        outKeys: ['OBS'],
        rawLen: seedDraftTrim.length,
        rawHead: seedDraftTrim.slice(0, 200),
        note: 'MICRO_LIKE_SKIP_REPHRASE',
        extra: {
          scaffoldActive: false,
          // ✅ renderGateway が期待してるのは「文字列ブロック配列」
          rephraseBlocks: [seedDraftTrim],
        },
      },
    } as any;
  }
}
/* =========================================
 * [置換 1] src/lib/iros/language/rephrase/rephraseEngine.full.ts
 * 範囲: 3585〜3592 を丸ごと置換
 * 目的: resonance seed の「存在」だけでなく「位置（index）と周辺（前後スニペット）」を出す
 * ========================================= */
{
  const pack = String(internalPack ?? '');

  // marker は揺れるので広めに拾う（RESONANCE_STATE_SEED / RESONANCE_STATE / seedin）
  const seedIdx = pack.search(/RESONANCE_STATE_SEED\s*\(DO NOT OUTPUT\)|RESONANCE_STATE\b|seedin/i);
  const near =
    seedIdx >= 0
      ? pack.slice(Math.max(0, seedIdx - 140), Math.min(pack.length, seedIdx + 240))
      : null;

  // 先頭/末尾の確認も残す（head/tail は従来どおり）
  console.log('[IROS/LLM][WRITER_IN_PACK_HEAD]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,

    packLen: pack.length,
    packLines: pack ? pack.split('\n').length : 0,

    hasResonanceSeed: seedIdx >= 0,
    seedIdx,
    seedNear: near,

    head: pack.slice(0, 260),
    tail: pack.slice(-260),
  });
}
  raw = await callWriterLLM({
    model: opts.model ?? 'gpt-5',
    temperature: opts.temperature ?? 0.7,
    messages,
    traceId: debug.traceId ?? null,
    conversationId: debug.conversationId ?? null,
    userCode: debug.userCode ?? null,

    // ✅ 重要：拾ってるだけだった digest を “実際に渡す”
    historyDigestV1,

    audit: {
      mode: 'rephrase',
      slotPlanPolicy: slotPlanPolicyResolved,

      // ✅ “確証つき” の値をそのまま使う（再定義しない）
      qCode: (typeof pickedQCode !== 'undefined' ? pickedQCode : null) as any,
      depthStage: (typeof pickedDepthStage !== 'undefined' ? pickedDepthStage : null) as any,
      phase: (typeof pickedPhase !== 'undefined' ? pickedPhase : null) as any,

      // ✅ ログ
      hasDigest: Boolean(historyDigestV1),
      historyDigestV1Head: historyDigestV1 ? safeHead(String(historyDigestV1), 140) : null,
    },
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

  // ---------------------------------------------
  // run flagship
  // ---------------------------------------------
  let v = runFlagship(candidate, slotsForGuard, scaffoldActive);

  // ---------------------------------------------
  // BLOCK_PLAN contract enforcement
  // - 必須見出しが「順番通りに」「全部」出ていない場合は FATAL に落として retry を誘発する
  // - 切断/短文化ではなく「完走させる」ための契約
  // ---------------------------------------------
  const isBlockPlanEnabled = Boolean(blockPlanText && String(blockPlanText).trim().length > 0);

  const blockHeadFromKind = (k: any): string => {
    switch (String(k)) {
      case 'ENTRY':
        return '入口';
      case 'DUAL':
        return '二項';
      case 'FOCUS_SHIFT':
        return '焦点移動';
      case 'ACCEPT':
        return 'ACCEPT';
      case 'INTEGRATE':
        return '統合';
      case 'NEXT_MIN':
        return '最小の一手';
      default:
        return String(k);
    }
  };

  const normalizeHead = (s: string) => {
    let t = String(s ?? '').trim();

    // ✅ Markdown 見出し（### など）を剥がす：契約判定は「見出し語」だけで一致させる
    t = t.replace(/^#{1,6}\s*/u, '');

    // 先頭の装飾・番号・箇条書きっぽいものを剥がす
    t = t.replace(
      /^(?:[✨⭐️🌟🔸🔹・•\-–—]\s*|\(?\d+\)?[.)]\s*|[①-⑳]\s*)/u,
      ''
    );

    return t.trim();
  };




  const splitLines = (t: string) =>
    String(t ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((x) => String(x ?? '').trim())
      .filter((x) => x.length > 0);

  const checkBlockPlanContract = (text: string) => {
    if (!isBlockPlanEnabled || !blockPlan?.blocks?.length) {
      return { ok: true as const, missing: [] as string[] };
    }

    const required = blockPlan.blocks.map(blockHeadFromKind).map(normalizeHead);
    const lines = splitLines(text).map(normalizeHead);

    // 見出しは「行頭に単独」前提なので “行一致” で拾う（緩めすぎない）
    const idxs: number[] = [];
    let searchFrom = 0;

    for (const head of required) {
      let found = -1;

      // ✅ 表記ゆれを相互に許容（required がどっちでも拾う）
      const headAliases =
        head === '受容' || head === 'ACCEPT'
          ? new Set(['受容', 'ACCEPT'])
          : head === '状況' || head === 'SITUATION'
            ? new Set(['状況', 'SITUATION'])
            : head === '選択' || head === '選択肢' || head === 'CHOICE'
              ? new Set(['選択', '選択肢', 'CHOICE'])
              : new Set([head]);

      // ✅ 1回だけ走査する（for の入れ子を消す）
      for (let i = searchFrom; i < lines.length; i++) {
        const line = lines[i];

        // ✅ 完全一致 or 先頭一致（末尾の句点/絵文字/装飾は無視してカウント）
        for (const a of headAliases) {
          if (line === a || line.startsWith(a)) {
            found = i;
            break;
          }
        }
        if (found >= 0) break;
      }

      if (found < 0) {
        return { ok: false as const, missing: [head] };
      }
      idxs.push(found);
      searchFrom = found + 1;
    }

    // 念のため：順序が崩れていたらNG（上の探索で基本担保されるが保険）
    for (let i = 1; i < idxs.length; i++) {
      if (idxs[i] <= idxs[i - 1]) {
        return { ok: false as const, missing: required };
      }
    }

    return { ok: true as const, missing: [] as string[] };
  };


  if (isBlockPlanEnabled) {
    const r0 = checkBlockPlanContract(candidate ?? '');

    if (!r0.ok) {
      const missing = Array.isArray(r0.missing) ? r0.missing : [];
      const miss0 = normalizeHead(String(missing[0] ?? ''));
      const isOnlyNextMin =
        missing.length === 1 && (miss0 === '最小の一手' || miss0 === 'NEXT_MIN' || miss0 === 'NEXT');

      // ✅ 末尾が「見出し開始だけ」で途切れている（例: "\n### " / "###" で終わる）なら、
      // これは後半欠落の可能性が高いので従来どおり FATAL → retry を許可する（安全弁）。
      const candTrimEnd = String(candidate ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trimEnd();

      const lastLine = candTrimEnd.split('\n').slice(-1)[0] ?? '';
      const isTailTruncatedHeading =
        /^\s*###/.test(lastLine) && lastLine.trim().length <= 6; // "###" / "### " / "### ?" 程度

      // ⚠️ 仕様変更（仕様書と差分あり）
      // 仕様書では「最小の一手（NEXT_MIN）」は必須ブロックだが、実運用では毎回出すと過剰になりやすい。
      // そのため missing が「最小の一手」だけの場合は、補完（AUTO_PATCH）も retry 促進もせず、そのまま通す。
      // ※ただし末尾途切れ（見出し開始だけで切断）は安全弁として従来通り retry を許可する。
      if (!isTailTruncatedHeading && isOnlyNextMin) {
        v = {
          ...(v as any),
          ok: true,
          level: 'OK',
          reasons: Array.from(new Set([...(v?.reasons ?? []), 'NEXT_MIN_OPTIONAL_SKIPPED'])),
        } as any;
      } else {
        // ✅ それ以外の契約違反はログは残す
        console.warn('[IROS/BLOCK_PLAN][CONTRACT_VIOLATION]', {
          traceId: debug.traceId,
          conversationId: debug.conversationId,
          userCode: debug.userCode,
          mode: blockPlan?.mode ?? null,
          blocks: blockPlan?.blocks ?? null,
          missing: r0.missing,
          head: safeHead(candidate, 220),
          soft: !isTailTruncatedHeading,
          tailTruncated: isTailTruncatedHeading,
        });

        if (isTailTruncatedHeading) {
          // ✅ 安全弁：本当に欠落っぽいときだけ従来どおり retry
          v = {
            ...(v as any),
            ok: false,
            level: 'FATAL',
            reasons: Array.from(new Set([...(v?.reasons ?? []), 'BLOCK_PLAN_CONTRACT'])),
          } as any;
        } else {
          // ✅ soft：retryしない（renderGateway補完へ）
          v = {
            ...(v as any),
            ok: true,
            level: 'OK',
            reasons: Array.from(new Set([...(v?.reasons ?? []), 'BLOCK_PLAN_CONTRACT_SOFT'])),
          } as any;
        }
      }
    }
  }

  // ---------------------------------------------
  // IDEA_BAND contract check（IDEA_BAND時は“候補形”のみ許可）
  // - 違反したら FATAL に落として retry を誘発（語り文のまま通さない）
  // ---------------------------------------------

  const normalizeIdeaBandLine = (line: string) =>
    String(line ?? '')
      .trim()
      // 先頭の番号/記号を落とす（1) / 1. / ① / - / • など）
      .replace(/^(?:\(?\d+\)?[.)]\s*|[①-⑳]\s*|[-*•・◯]\s*)/u, '')
      .trim();

  const isIdeaBandHint =
    /"kind"\s*:\s*"idea_band"/.test(String(shiftSlot?.text ?? '')) ||
    /\bIDEA_BAND\b/.test(String(shiftSlot?.text ?? '')) ||
    /\bidea_band\b/.test(String(shiftSlot?.text ?? ''));

  const isIdeaBandCandidateShapeOk = (text: string) => {
    const lines = String(text ?? '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // IDEA_BAND は「2〜maxLines」の“候補行”が必須
    if (lines.length < 2) return false;
    if (typeof maxLines === 'number' && maxLines > 0 && lines.length > maxLines) return false;

    // 各行：箇条書き/質問/長文語り を弾く（最低限）
    for (const rawLine of lines) {
      // 箇条書きっぽい先頭
      if (/^[-*•・◯]\s+/u.test(rawLine)) return false;

      const line = normalizeIdeaBandLine(rawLine);

      // 空行化は弾く
      if (!line) return false;

      // 質問は禁止（IDEA_BANDは候補提示のみ）
      if (/[?？]/u.test(line)) return false;

      // 句点が2つ以上＝語り文になりがち（保守的に弾く）
      const dotCount = (line.match(/[。]/g) ?? []).length;
      if (dotCount >= 2) return false;
    }

    return true;
  };

  if (isIdeaBandHint) {
    const okShape = isIdeaBandCandidateShapeOk(candidate ?? '');
    if (!okShape) {
      console.warn('[IROS/IDEA_BAND][CONTRACT_VIOLATION]', {
        traceId: debug.traceId,
        conversationId: debug.conversationId,
        userCode: debug.userCode,
        head: safeHead(candidate, 160),
      });

      // IDEA_BAND なのに形が崩れた → ここでFATALに落として retry を確実に発生させる
      v = {
        ...(v as any),
        ok: false,
        level: 'FATAL',
        reasons: Array.from(new Set([...(v?.reasons ?? []), 'IDEA_BAND_CONTRACT'])),
      } as any;
    }
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

  const vLevelPre = String((v as any)?.level ?? '').toUpperCase();
  let candidateLen = (candidate ?? '').trim().length;

  const shiftObj = parseShiftJson(shiftSlot?.text);

  const pol = computeMinOkPolicy({
    inputKind,
    inputKindFromMeta,
    inputKindFromCtx,
    shiftSlotText: shiftSlot?.text,
    shiftObj,
    optsAllow: (opts as any)?.allow,
  });

  const inputKindNow = pol.inputKindNow;
  const isMicroOrGreetingNow = pol.isMicroOrGreetingNow;

// - Micro Writer が先に走って microDraft（短文の最終候補）ができている状態で、ここで rephrase writer を呼ぶと「二重LLM」になる。
//   二重LLM = microGenerate と writer/rephraseGenerate の両方が同一ターンで実行されること。
//   micro が ok のときは（原則）microDraft を採用し、rephrase writer は呼ばない（例外は明示する）。
  const userLenTiny = String(userText ?? '').trim().length <= 2;
  const seedDraftTrim = String(seedDraft ?? '').trim();
  const seedLenTiny = seedDraftTrim.length > 0 && seedDraftTrim.length <= 40;

  const microLikeNow = Boolean(isMicroOrGreetingNow || (userLenTiny && seedLenTiny));

  if (microLikeNow) {
    const fixed = seedDraftTrim || String(candidate ?? '').trim() || '';
    if (fixed.length > 0) {
      return adoptAsSlots(fixed, 'MICRO_LIKE_SKIP_REPHRASE', { scaffoldActive });
    }
  }

  const shortReplyOkRaw = pol.shortReplyOkRaw;
  const shortReplyOk = pol.shortReplyOk;

  const shiftKind = pol.shiftKind;
  const isTConcretize = pol.isTConcretize;
  const isIdeaBand = pol.isIdeaBand;
  // ---------------------------------------------
  // IDEA_BAND contract enforcement（pol.isIdeaBand 確定後に強制）
  // - 候補形でなければ FATAL に落として retry を誘発する
  // ---------------------------------------------
  if (isIdeaBand) {
    const lines = String(candidate ?? '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const normalizeLine = (line: string) =>
      String(line ?? '')
        .trim()
        .replace(/^(?:\(?\d+\)?[.)]\s*|[①-⑳]\s*|[-*•・◯]\s*)/u, '')
        .trim();

    let okShape = true;

    // 2〜maxLines（maxLines が未定義なら 5 扱い）
    const maxLinesLocal = typeof (maxLines as any) === 'number' && (maxLines as any) > 0 ? (maxLines as any) : 5;
    if (lines.length < 2) okShape = false;
    if (okShape && lines.length > maxLinesLocal) okShape = false;

    if (okShape) {
      for (const raw of lines) {
        // 箇条書きは禁止（候補は番号を後段で付ける）
        if (/^[-*•・◯]\s+/u.test(raw)) { okShape = false; break; }

        const line = normalizeLine(raw);
        if (!line) { okShape = false; break; }

        // 質問は禁止
        if (/[?？]/u.test(line)) { okShape = false; break; }

        // ★最重要：候補行に「。」は出さない（説明文を即死させる）
        if (/[。]/u.test(line)) { okShape = false; break; }

        // 1行が長すぎるのも候補ではない（安全側）
        if (line.length > 36) { okShape = false; break; }
      }
    }

    if (!okShape) {
      console.warn('[IROS/IDEA_BAND][CONTRACT_VIOLATION]', {
        traceId: debug.traceId,
        conversationId: debug.conversationId,
        userCode: debug.userCode,
        head: safeHead(candidate, 160),
        lines: lines.length,
      });

      v = {
        ...(v as any),
        ok: false,
        level: 'FATAL',
        reasons: Array.from(new Set([...(v?.reasons ?? []), 'IDEA_BAND_CONTRACT'])),
      } as any;
    }
  }


  const MIN_OK_LEN = pol.MIN_OK_LEN;

  console.log('[IROS/rephraseEngine][MIN_OK_KIND]', {
    inputKindNow,
    isMicroOrGreetingNow,
    shortReplyOk,
    MIN_OK_LEN,
    reason: pol.reason, // ✅ 変換しない（そのまま）
    shiftTextHead: shiftSlot?.text ? safeHead(String(shiftSlot.text), 140) : null,
    shiftObjHasAllow: Boolean(shiftObj?.allow),
    isTConcretize,
    isIdeaBand,
    shiftKind: shiftKind || null,
  });


  const tooShortPol = computeOkTooShortToRetry({
    candidate,
    scaffoldActive,
    isDirectTask,
    vOk: Boolean(v?.ok),
    vLevelPre,
    candidateLen,
    MIN_OK_LEN,
    isIdeaBand,
  });

  const hasAdvanceHint = tooShortPol.hasAdvanceHint;
  const shouldOkTooShortToRetry = tooShortPol.shouldOkTooShortToRetry;


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
      isTConcretize,
      hasAdvanceHint,
      isIdeaBand,
    });

    // ✅ “短いだけ” でも chat では 1回だけ retry に落とす
    v = {
      ...(v as any),
      ok: false,
      level: 'FATAL',
      reasons: Array.from(new Set([...(v.reasons ?? []), 'OK_TOO_SHORT_TO_RETRY'])),
    } as any;
  }

  // ✅ DEV: 強制的に retry を踏む（E2E確認用）
  // - userText 埋め込み（[[FORCE_RETRY]]）は本番経路を汚染して収束しないので廃止
  // - 代わりに opts.forceRetry を “DEV限定” で受け取る
  const devForceRetry =
    process.env.NODE_ENV !== 'production' && Boolean((opts as any)?.forceRetry);

  if (devForceRetry) {
    console.warn('[IROS/FLAGSHIP][FORCE_RETRY]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      via: 'opts.forceRetry',
    });

    v = {
      ...(v as any),
      ok: false,
      level: 'FATAL',
      reasons: Array.from(new Set([ ...(((v as any)?.reasons ?? []) as any[]), 'FORCE_RETRY' ])),
    } as any;
  }

  const vLevel = String((v as any)?.level ?? '').toUpperCase();

  const naturalTextReady = computeNaturalTextReady({
    candidate,
    candidateLen,
    MIN_OK_LEN,
    scaffoldActive,
    isDirectTask,
  });

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

  // ✅ OK は retry しない（ここで確定して返す）
  if ((v as any)?.ok === true) {
    return adoptAsSlots(candidate, 'FLAGSHIP_OK_NO_RETRY', { scaffoldActive });
  }

  // ✅ micro/greeting は “体験優先” で retry しない：1st出力をそのまま確定して返す
  // - micro を seedDraft として repair/rephrase に流すと「microのつもりが通常writerが走る」事故になる
  // - ここでは flagship のOK判定に落ちなくても、microなら確定を優先する
  if (isMicroOrGreetingNow) {
    const microText =
      String(candidate ?? '').trim() ||
      String(seedFromSlots ?? '').trim() ||
      String(seedDraft ?? '').trim() ||
      '';

    if (microText.length > 0) {
      return adoptAsSlots(microText, 'MICRO_ONLY_NO_RETRY', { scaffoldActive });
    }
    // 空なら既存の retry/repair へ（保険）
  }

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

  return await runRetryPass({
    debug,
    opts,
    slotPlanPolicyResolved,

    systemPrompt,
    internalPack,
    turns: lastTurnsSafe,
    baseDraftForRepair,
    userText,

    candidate,
    scaffoldActive,
    seedFromSlots,
    inKeys,
    maxLines,
    renderEngine,

    isDirectTask,
    isMicroOrGreetingNow,
    MIN_OK_LEN,
    historyDigestV1: digestMaybe ?? null,

    firstFatalReasons: Array.isArray((v as any)?.reasons) ? ((v as any).reasons as any[]).map((x) => String(x)) : [],

    buildRetryMessages,
    callWriterLLM,
    logRephraseOk,
    validateOutput,

    ensureOnePointInOutput,
    scaffoldMustHaveOk,
    restoreScaffoldMustHaveInOutput,

    makeCandidate,

    runFlagship,
    shouldRejectWarnToSeed,

    safeHead,
    adoptAsSlots,

    extractedKeys: extracted.keys,
    slotsForGuard,
  });
}
