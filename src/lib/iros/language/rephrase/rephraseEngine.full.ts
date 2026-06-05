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

import {
  recallGuardOk,
  shouldEnforceRecallGuard,
  checkWriterGuardsMinimal,
} from './guards';
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
import { getShortFixedPhrase } from '../shortFixedPhrase';
import { buildTopicLineV1, extractKeywordsV1 } from '@/lib/iros/history/historyDigestV1';
import {
  extractLockedILines,
  verifyLockedILinesPreserved,
  buildLockRuleText,
  ILINE_OPEN,
  ILINE_CLOSE,
} from './ilineLock';
import {
  computeSlotDecision,
  computeSlotDecision as computeSlotDecisionFromEngine,
  type SlotName as SlotNameFromEngine,
  type SlotWeightInput as SlotWeightInputFromEngine,
} from './slotWeightEngine';
import { buildPatternBlocks } from '../../slotPatterns/buildPatternBlocks';
import { selectSlotPattern } from '../../slotPatterns/selectSlotPattern';
import { buildRelationshipAnalysis } from '../../relationship/relationshipAnalysisEngine';
import { analysisToDetailPattern } from '../../relationship/mappers/analysisToDetailPattern';

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
  seedInstruction?: string | null;
  lastTurnsCount?: number | null;
  directTask?: boolean | null;
  inputKind?: string | null;
  itOk?: boolean | null;
  intentBand?: string | null;
  tLayerHint?: string | null;

  // ✅ 観測ソース
  // userText は生文のまま渡す。
  // ただし、意味決定の正本は seed 側に置き、ここでは観測入力として扱う。
  userText?: string | null;

  onePointText?: string | null;
  situationSummary?: string | null;
  depthStage?: string | null;
  phase?: string | null;
  qCode?: string | null;

  // ✅ Depth Personality Model
  personDepthPattern?: string | null;
  depthDelta?: string | null;
  responseDepthStrategy?: string | null;

  // ✅ flow
  flowDigest?: string | null;
  flowTape?: string | null;

  // ✅ 会話が流れるための3点セット（topic / goal / repeat）
  topicDigest?: string | null;
  replyGoal?: any; // string or object({kind,...}) が混在し得る
  repeatSignal?: string | null;

  // ✅ フォールバック用（呼び出し側が渡せるならここに入れる）
  ctxPack?: {
    topicDigest?: string | null;
    conversationLine?: string | null;
    replyGoal?: any;
    repeatSignal?: string | null;
    goalKind?: string | null;
    slotPlanPolicy?: string | null;
    inputKind?: string | null;
    depthStage?: string | null;
    phase?: string | null;
    qCode?: string | null;
    intentBand?: string | null;
    tLayerHint?: string | null;
    flow?: { delta?: string | null; returnStreak?: any } | null;
    returnStreak?: any;
    itTriggered?: any;
    it_triggered?: any;
    mirror?: { e_turn?: string | null; polarity?: string | null } | null;
    e_turn?: string | null;
    polarity?: string | null;
    sa?: any;
    selfAcceptance?: any;
    self_acceptance?: any;
    fixedNorth?: { key?: string | null } | null;
    fixedNorth_meta?: string | null;
    fixedNorthKey?: string | null;
    unified?: { depthStage?: string | null } | null;
    input_kind?: string | null;
  } | null;

  // ✅ 揺れ吸収（呼び出し側で直接渡せる場合）
  goalKind?: string | null;

  // ✅ rules / shift / blockPlanMode
  rules?: any;
  shiftRules?: any;
  shift?: any;
  blockPlanMode?: string | null;
  block_plan_mode?: string | null;

  // ✅ 瞬間反応
  e_turn?: string | null;
  polarity?: string | null;

  // ✅ self acceptance
  sa?: any;
}): string {
  // --- small utils ---
  const asTrim = (v: any) => (typeof v === 'string' ? v.trim() : '');
  const asNorm = (v: any) => asTrim(v).replace(/\r\n/g, '\n');
  const safeHead = (s: string, n = 220) => {
    const t = asNorm(s);
    return t.length <= n ? t : t.slice(0, n) + '…';
  };
  const head = (s: string, n = 80) => safeHead(s, n);

  const ctxPack: any = (args as any)?.ctxPack ?? null;
// ✅ SEEDを最上位に固定
const seedBlock = String(args.seedInstruction ?? '').trim();

const seedHead = seedBlock
  ? `SEED_INSTRUCTION (DO NOT OUTPUT):\n${seedBlock}`
  : '';
  // --- OBS sources (NO userText) ---
  const obsOnePoint = asNorm(args.onePointText ?? '');
  const obsSummary = asNorm(args.situationSummary ?? '');

  // --- topic / goal / repeat (for internal pack labels) ---
  // ✅ 目的：rephrase.ts が埋めた ctxPack.topicDigest / replyGoal / repeatSignal を
  //          obsCard（STATE_SNAPSHOT_PICKED）の表示に確実に反映する。
  const obsTopic = asNorm(
    // 1) upstream が直に渡した topicDigest
    (args as any)?.topicDigest ??
      (args as any)?.topic_digest ??
      // 2) ctxPack（rephrase.ts が補完している）
      (ctxPack as any)?.topicDigest ??
      // 3) 最後の保険：conversationLine（「会話の線」）
      (ctxPack as any)?.conversationLine ??
      ''
  );

  const obsGoal = (() => {
    // goal は文字列化して観測ラベルに出す（kind/object でも落ちないように）
    const raw: any =
      (args as any)?.replyGoal ??
      (args as any)?.reply_goal ??
      (args as any)?.goalKind ??
      (args as any)?.goal_kind ??
      (ctxPack as any)?.goalKind ??
      (ctxPack as any)?.replyGoal ??
      null;

    if (raw === null || raw === undefined) return '';

    if (typeof raw === 'string') return raw.trim();

    // replyGoal が { kind: 'reflect_position', ... } などの形でも拾う
    const kind = (raw as any)?.kind;
    if (typeof kind === 'string' && kind.trim()) return kind.trim();

    // それ以外は表示用に短く JSON 文字列化（null/空は弾く）
    try {
      const s = JSON.stringify(raw);
      return typeof s === 'string' ? s.trim() : '';
    } catch {
      return String(raw).trim();
    }
  })();

  const obsRepeat = (() => {
    const raw: any =
      (args as any)?.repeatSignal ??
      (args as any)?.repeat_signal ??
      (ctxPack as any)?.repeatSignal ??
      null;

    // repeat は boolean が混ざるので、表示ラベルとして正規化する
    if (raw === null || raw === undefined) return '';

    if (typeof raw === 'string') return raw.trim();

    if (typeof raw === 'boolean') return raw ? 'SAME' : 'NONE';

    // オブジェクト等は stringify して短く出す
    try {
      const s = JSON.stringify(raw);
      return typeof s === 'string' ? s.trim() : '';
    } catch {
      return String(raw).trim();
    }
  })();
  // ✅ 観測核（NOW_CORE）は userText を使わずに作る
  const obsPick =
    obsOnePoint.length >= 6
      ? obsOnePoint
      : obsSummary.length >= 6
        ? obsSummary
        : '';

// --- obsCard ---
const obsCard = (() => {
  const rules: any =
    (args as any)?.shiftRules ??
    (args as any)?.rules ??
    (args as any)?.shift?.rules ??
    null;

  // rules（上流指定）を尊重しつつ、デフォルトは「質問0」寄りにする
  const qMaxRaw = rules?.questions_max;

  const blockPlanMode = asTrim((args as any)?.blockPlanMode ?? (args as any)?.block_plan_mode ?? '');
  const goalKind = asTrim((args as any)?.goalKind ?? ctxPack?.goalKind ?? ctxPack?.replyGoal?.kind ?? '');
  const replyGoalNow = asTrim((args as any)?.replyGoal ?? (ctxPack as any)?.replyGoal ?? '');

  // flow/inputKind は “ctxPack 正本” から拾う（rephrase.ts が埋めている前提）
  const inputKindNow = asTrim((args as any)?.inputKind ?? (ctxPack as any)?.inputKind ?? '');
  const flowDeltaNow = asTrim(
    (ctxPack as any)?.flow?.delta ??
      (ctxPack as any)?.flow?.flowDelta ??
      ''
  ).toUpperCase();

  // ✅ 質問を抑える条件（ここが効く）
  // - 接続ターン（micro/greeting）
  // - RETURN（戻り）
  // - reflect_position（位置の反射）
  // - stabilize / mini3
  const suppressQuestions =
    inputKindNow === 'micro' ||
    inputKindNow === 'greeting' ||
    flowDeltaNow === 'RETURN' ||
    String(replyGoalNow).toLowerCase() === 'reflect_position' ||
    goalKind === 'stabilize' ||
    blockPlanMode === 'mini3';

  // 上流の forbid 指定
  const forbidQMUp = !!rules?.forbid_question_marks;
  const forbidInterUp = !!rules?.forbid_interrogatives;

  // ✅ 抑制条件では forbid を強制ON（“?”や尋問形を避ける）
  const forbidQM = suppressQuestions ? true : forbidQMUp;
  const forbidInter = suppressQuestions ? true : forbidInterUp;

  // ✅ qMax：抑制条件では 0 を優先。そうでなければ上流指定、なければ 1
  const qMax =
    suppressQuestions
      ? 0
      : (typeof qMaxRaw === 'number' ? qMaxRaw : 1);

  const forceNoQuestions = forbidQM || forbidInter || qMax === 0;

  const questionRuleLine = forceNoQuestions
    ? '- 質問は原則しない（0）。'
    : typeof qMax === 'number'
      ? `- 質問は最大${qMax}つまで。`
      : '- 質問は最大1つまで。';

  // ✅ オウム返し抑制（明文化して強制）
  const echoRuleLine =
    '- 冒頭でユーザー文をそのまま復唱しない（同語反復・引用・括弧引用をしない）。短く要約して言い切る。';

  // ✅ forbid の時は、文末 ? や尋問形を避ける指示も追加
  const forbidLines: string[] = [];
  if (forbidQM) forbidLines.push('- 文末を「?」で終えない。');
  if (forbidInter) forbidLines.push('- 「どれ？/どっち？/何？」などの尋問形を使わない。');

  return [
    'OBS_SOURCES (DO NOT OUTPUT):',
    `obsOnePointHead=${obsOnePoint ? head(obsOnePoint, 120) : '(none)'}`,
    `obsSummaryHead=${obsSummary ? head(obsSummary, 120) : '(none)'}`,
    `obsPickHead=${obsPick ? head(obsPick, 120) : '(none)'}`,
    '',
    `TOPIC_DIGEST: ${obsTopic ? head(obsTopic, 220) : '(none)'}`,
    `REPLY_GOAL: ${obsGoal ? head(obsGoal, 220) : '(none)'}`,
    `REPEAT_SIGNAL: ${obsRepeat ? head(obsRepeat, 220) : '(none)'}`,
    '',
    'USE_RULE (DO NOT OUTPUT):',
    '- obsPick は「核」として参照してよいが、原文引用や言い直しはしない。',
    echoRuleLine,
    '- 説明で埋めず、会話として短く返す。',
    '- 番号列挙・チェックリストで出力しない。ユーザーが例を求めた場合のみ、番号ではなく「- 」の箇条書きを独立行で使ってよい。',
    ...forbidLines,
    questionRuleLine,
  ].join('\n');
})();

  // --- flow ---
  const flowDigest = asNorm(args.flowDigest ?? '');
  const flowTape = asNorm(args.flowTape ?? '');

  // --- meta hint (pick keys, no JSON.parse) ---
  const metaText = (() => {
    const ctx: any = (args as any) ?? {};
    const cp: any = ctxPack ?? null;

    const pickStr = (...cands: any[]) => {
      for (const v of cands) {
        if (v === undefined || v === null) continue;

        if (typeof v === 'string') {
          const s = v.trim();
          if (!s) continue;
          return s;
        }

        if (typeof v === 'number' || typeof v === 'boolean') {
          const s = String(v).trim();
          if (!s) continue;
          return s;
        }

        // object / array はここでは文字列化しない
        // polarity などで [object Object] 汚染を防ぐ
        continue;
      }
      return null;
    };
    const pickAny = (...cands: any[]) => {
      for (const v of cands) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'string' && !v.trim()) continue;
        return v;
      }
      return null;
    };

    const inputKind = pickStr(ctx.inputKind, cp?.inputKind, cp?.input_kind);
    const depthStage = pickStr(ctx.depthStage, cp?.depthStage, cp?.unified?.depthStage);
    const phase = pickStr(ctx.phase, cp?.phase);
    const qCode = pickStr(ctx.qCode, cp?.qCode);

    const intentBand = pickStr(ctx.intentBand, cp?.intentBand);
    const tLayerHint = pickStr(ctx.tLayerHint, cp?.tLayerHint);

    const flowDelta = pickStr(cp?.flow?.delta, cp?.flowDelta);
    const returnStreak = pickAny(cp?.flow?.returnStreak, cp?.returnStreak);

    const itOk = pickAny(ctx.itOk, cp?.itTriggered, cp?.it_triggered);
    const goalKind = pickStr(ctx.goalKind, cp?.goalKind, cp?.replyGoal?.kind);
    const slotPlanPolicy = pickStr(cp?.slotPlanPolicy, ctx.slotPlanPolicy);

    // ✅ mode / openingPolicy（相談のみの冒頭ACK制御）
    const modeRaw = pickStr(
      (args as any)?.meta?.mode,
      (cp as any)?.mode,
      (cp as any)?.meta?.mode,
      (ctx as any)?.mode,
    );

    const modeNorm = (() => {
      const m = String(modeRaw ?? '').trim().toLowerCase();
      if (!m) return null;
      if (m === 'counsel' || m === 'consult' || m === 'surface') return 'counsel';
      if (m === 'diagnosis' || m === 'ir') return 'diagnosis';
      if (m === 'vision') return 'vision';
      if (m === 'recall') return 'recall';
      if (m === 'mirror' || m === 'reflect') return 'mirror';
      if (m === 'resonate') return 'resonate';
      if (m === 'intention') return 'intention';
      if (m === 'auto') return 'auto';
      return m; // 未知でもログ用途で残す
    })();

    const openingPolicy = modeNorm === 'counsel' ? 'ack_1line' : 'none';

    const e_turn = pickStr(cp?.mirror?.e_turn);
    const polarity = pickStr(ctx.polarity, cp?.mirror?.polarity, cp?.polarity);

    const sa = pickAny(ctx.sa, cp?.sa, cp?.selfAcceptance, cp?.self_acceptance);
    const fixedNorth = pickStr(cp?.fixedNorth?.key, cp?.fixedNorth_meta, cp?.fixedNorthKey);

    const depthBandForMeta =
      typeof depthStage === 'string' && depthStage.trim()
        ? depthStage.trim().toUpperCase().charAt(0)
        : '';

    const allowHighMetaInPack =
      depthBandForMeta !== 'S' && depthBandForMeta !== 'F';


    const lines: string[] = [];
    if (inputKind) lines.push(`inputKind=${inputKind}`);
    if (depthStage) lines.push(`depthStage=${depthStage}`);
    if (phase) lines.push(`phase=${phase}`);
    if (qCode) lines.push(`qCode=${qCode}`);

    if (modeNorm) lines.push(`mode=${modeNorm}`);
    if (openingPolicy) lines.push(`openingPolicy=${openingPolicy}`);

    if (allowHighMetaInPack && intentBand) lines.push(`intentBand=${intentBand}`);
    if (allowHighMetaInPack && tLayerHint) lines.push(`tLayerHint=${tLayerHint}`);

    if (flowDelta) lines.push(`flowDelta=${flowDelta}`);
    if (returnStreak !== null) lines.push(`returnStreak=${String(returnStreak)}`);

    if (itOk !== null) lines.push(`itOk=${String(itOk)}`);
    if (goalKind) lines.push(`goalKind=${goalKind}`);
    if (slotPlanPolicy) lines.push(`slotPlanPolicy=${slotPlanPolicy}`);

    if (e_turn) lines.push(`e_turn=${e_turn}`);
    if (polarity) lines.push(`polarity=${polarity}`);
    if (sa !== null) lines.push(`sa=${String(sa)}`);

    if (fixedNorth && allowHighMetaInPack) lines.push(`fixedNorth=${fixedNorth}`);

    return lines.length ? lines.join('\n') : '';
  })();

  const isNewQuotedReferenceSourceForInternalPack =
    (args as any)?.newQuotedReferenceSource === true ||
    (args as any)?.extra?.newQuotedReferenceSource === true ||
    (args as any)?.extra?.ctxPack?.newQuotedReferenceSource === true ||
    (args as any)?.ctxPack?.newQuotedReferenceSource === true ||
    (ctxPack as any)?.newQuotedReferenceSource === true;

  const rawMetaTextForInternalPack = String((args as any)?.metaText ?? '').trim();

  const effectiveMetaTextForInternalPack = isNewQuotedReferenceSourceForInternalPack
    ? ''
    : rawMetaTextForInternalPack;

  console.log('[IROS/INTERNAL_PACK_META_GATE]', {
    isNewQuotedReferenceSourceForInternalPack,
    rawMetaTextLen: rawMetaTextForInternalPack.length,
    effectiveMetaTextLen: effectiveMetaTextForInternalPack.length,
    argsCtxPackNewQuotedReferenceSource:
      (args as any)?.ctxPack?.newQuotedReferenceSource === true,
    ctxPackNewQuotedReferenceSource:
      (ctxPack as any)?.newQuotedReferenceSource === true,
  });

  const mergedMetaTextForInternalPack = [
    effectiveMetaTextForInternalPack,
    String(metaText ?? '').trim(),
  ]
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .join('\n')
    .trim();

  // --- assemble (V3 minimal) ---
  // ✅ internalPack を太らせない（system/contract 側に寄せる）
  // - HISTORY_HINT / FLOW_TAPE / SEED_DRAFT / obsCard は pack から外す
  // - 目的：packLen を 250〜300 台に落とす
  //
  // ✅ 設計固定：STATE は metaText に依存させず、常時1行で入れる
  // - LLMは「表現担当」なので、座標（depth/phase/q）だけは毎回同じ場所にあるべき
  const parts: string[] = [
    'INTERNAL PACK (DO NOT OUTPUT):',
    '',
    `inputKind=${args.inputKind ?? '(null)'}`,
    `directTask=${String(args.directTask ?? false)}`,
  ];

  // ✅ STATE（常時1行）
  // metaText側と同じ優先順：args → ctxPack（unified含む）
  const cp: any = ctxPack ?? null;
  const depthStage =
    String((args as any)?.depthStage ?? '').trim() ||
    String(cp?.depthStage ?? '').trim() ||
    String(cp?.unified?.depthStage ?? '').trim() ||
    '(null)';
  const phase =
    String((args as any)?.phase ?? '').trim() ||
    String(cp?.phase ?? '').trim() ||
    '(null)';
  const qCode =
    String((args as any)?.qCode ?? '').trim() ||
    String(cp?.qCode ?? '').trim() ||
    '(null)';

  const personDepthPattern =
    String((args as any)?.personDepthPattern ?? '').trim() ||
    String(cp?.personDepthPattern ?? '').trim() ||
    String(cp?.person_depth_pattern ?? '').trim() ||
    '';
  const depthDelta =
    String((args as any)?.depthDelta ?? '').trim() ||
    String(cp?.depthDelta ?? '').trim() ||
    String(cp?.depth_delta ?? '').trim() ||
    '';
  const responseDepthStrategy =
    String((args as any)?.responseDepthStrategy ?? '').trim() ||
    String(cp?.responseDepthStrategy ?? '').trim() ||
    String(cp?.response_depth_strategy ?? '').trim() ||
    '';
  const depthBandForStatePack =
    typeof depthStage === 'string' && depthStage.trim()
      ? depthStage.trim().toUpperCase().charAt(0)
      : '';

  const allowHighMetaInStatePack =
    depthBandForStatePack !== 'S' && depthBandForStatePack !== 'F';

  parts.push(
    '',
    [
      `STATE: depthStage=${depthStage}`,
      `phase=${phase}`,
      `qCode=${qCode}`,
      personDepthPattern ? `personDepthPattern=${personDepthPattern}` : null,
      depthDelta ? `depthDelta=${depthDelta}` : null,
      responseDepthStrategy ? `responseDepthStrategy=${responseDepthStrategy}` : null,
    ]
      .filter(Boolean)
      .join(' '),
  );

  // META（さらに短く）※STATEはここに入れない
  if (mergedMetaTextForInternalPack && String(mergedMetaTextForInternalPack).trim()) {
    parts.push('', 'META:', clampLines(String(mergedMetaTextForInternalPack), 12));
  }

  // FLOW（短く）※生文/オブジェクト事故を落とす
  const flowOne = sanitizeFlowDigest(flowDigest);
  const flowStory = String(flowDigest ?? '').trim();

  if (allowHighMetaInStatePack && flowOne && flowOne.trim()) {
    parts.push('', `FLOW: ${flowOne}`);
  }

  // 会話の流れをLLMに渡す（長すぎる場合はカット）
  if (allowHighMetaInStatePack && flowStory && flowStory.length < 120) {
    parts.push('', `FLOW_STORY: ${flowStory}`);
  }

  // 重要フラグ（最小）
  if (args.goalKind) parts.push('', `goalKind=${String(args.goalKind)}`);
  if (args.itOk != null) parts.push(`itOk=${String(args.itOk)}`);

  // mirror（最小）
  const et = asNorm(args.e_turn ?? '');
  const pol = asNorm(args.polarity ?? '');
  if (et || pol) {
    const row: string[] = [];
    if (et) row.push(`e_turn=${et}`);
    if (pol) row.push(`polarity=${pol}`);
    parts.push('', row.join(' / '));
  }

  return [
    seedHead,
    ...parts
  ]
  .filter((v) => String(v ?? '').trim().length > 0)
  .join('\n\n');
}
// ✅ FLOW_DIGEST を pack 用にサニタイズ（生文/オブジェクト事故を落とす + 1行固定）
function sanitizeFlowDigest(v: unknown): string {
  const s0 = String(v ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  if (!s0) return '';

  // ① 危険ワードでカット（ここ以降は捨てる）
  const cutKeys = ['Anchor:', '【観測】user:'];
  let cutAt = -1;
  for (const k of cutKeys) {
    const i = s0.indexOf(k);
    if (i >= 0) cutAt = cutAt < 0 ? i : Math.min(cutAt, i);
  }

  const s1 = (cutAt >= 0 ? s0.slice(0, cutAt) : s0).trim();

  // ② 改行を潰して完全1行化
  const oneLine = s1.replace(/\s+/g, ' ').trim();

  // ③ 末尾の「/」や「 /」を除去（今回の “... /” 対策）
  return oneLine.replace(/\s*\/\s*$/, '').trim();
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
  const t = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!t) return '';

  const rawLines = t.split('\n');

  // 余白は意味として残す。
  // ただし連続空行が暴走しないよう、空行は最大1行までに正規化する。
  const normalizedLines: string[] = [];
  let prevWasBlank = false;

  for (const line of rawLines) {
    const trimmed = String(line ?? '').trim();

    if (!trimmed) {
      if (!prevWasBlank) {
        normalizedLines.push('');
        prevWasBlank = true;
      }
      continue;
    }

    normalizedLines.push(trimmed);
    prevWasBlank = false;
  }

  // 先頭/末尾の空行は落とす
  while (normalizedLines.length > 0 && normalizedLines[0] === '') normalizedLines.shift();
  while (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1] === '') normalizedLines.pop();

  if (normalizedLines.length === 0) return '';

  if (normalizedLines.length <= maxLines) {
    return normalizedLines.join('\n');
  }

  const sliced = normalizedLines.slice(0, Math.max(1, maxLines));

  // 末尾が空行で終わらないように整える
  while (sliced.length > 0 && sliced[sliced.length - 1] === '') sliced.pop();

  return sliced.join('\n').trimEnd();
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
    'まず整理の箱を3つだけ示す。',
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

  // ✅ recall が無いときは MUST_INCLUDE を空にする（“常時テンプレ化”を止める）
  if (!recallBody) return '';

  // ✅ recall があるときだけ “改変禁止” を追加（復元の基準）
  const blocks: string[] = [
    '',
    '【改変禁止（recall-must-include）】',
    '以下は“復元の基準”なので、削除・言い換え・要約は禁止。',
    recallBody,
    '',
  ];

  return blocks.join('\n');
}
// ---------------------------------------------
// ✅ ONE_POINT scaffold helpers
// ---------------------------------------------
type SlotLike = { key?: string; text?: string; content?: string; value?: string };

const SCAFFOLD_PREFACE = 'いまの基準を一つだけ示す。違ったら外していい。';
const SCAFFOLD_PURPOSE = 'この文章は“答えを渡す”ためではなく、あなたが答えを出すための基準を一つ示す。';

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

  // 通常会話では Markdown 太字を表に残さない。
  t = t.replace(/\*\*/g, '');

  // 概念説明の末尾に出やすい「次回案内」「追加できます」系は削る。
  // 本文の途中にある能力説明までは削らず、段落末尾だけを対象にする。
  t = t.replace(
    /(?:\n\n|\n|^)?(?:触れられる入口\s*)?(?:もし必要なら|必要なら次に|必要なら)、?[^\n。]*(?:できます|できる|出せます|出せる|ほどけます|深められます|整理できます|説明できます)[。.!！]?$/u,
    ''
  );

  t = t.replace(
    /(?:\n\n|\n|^)?(?:触れられる入口\s*)?(?:もし必要なら|必要なら|次に|もっと詳しく|さらに詳しく)[^\n。]*(?:できます|できる|出せます|出せる|ほどけます|深められます|整理できます|説明できます)[。.!！]?$/u,
    ''
  );

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
      .replace(/^(いまの一点|今の状況|ワンポイント|ポイント|基準)[:：]\s*/u, '')
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

  // 1) 基準フレーム
  const hasFrame =
    /(答えを渡さ|基準|いまは(結論|答え)を(出さ|急が)|決めなくて|まず.*(示す|作る))/u.test(out) ||
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
        ? 'ここでは答えを渡しません。あなたが答えを出せる位置に基準を置きます。'
        : k === 1
          ? 'いまは結論を急がない。考えるための基準だけ整えます。'
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
        /(見る場所は3つだけ|見る軸|いまの一点|今ここで扱う|焦点|基準|答えを渡さ)/u.test(s);

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

  // 1) 今ターンの明示 itOk を最優先
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

  if (ok === true) return true;

  // 2) 明示クリアがある時は継続しない
  const clearExplicit =
    tryGet(uc, ['clearItx']) === true ||
    tryGet(uc, ['itxClear']) === true ||
    tryGet(uc, ['meta', 'clearItx']) === true ||
    tryGet(uc, ['meta', 'itxClear']) === true ||
    tryGet(uc, ['ctxPack', 'clearItx']) === true ||
    tryGet(uc, ['ctxPack', 'itxClear']) === true ||
    tryGet(uc, ['ctx_pack', 'clearItx']) === true ||
    tryGet(uc, ['ctx_pack', 'itxClear']) === true;

  if (clearExplicit) return false;

  // 3) 18日向け: 前回IT継続を許可
  // - 今ターンで新規 trigger がなくても、
  //   既存 itxStep + reason/anchor が残っていれば writer では itOk 扱いに寄せる
  const stepRaw =
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
    null;

  const reasonRaw =
    tryGet(uc, ['itxReason']) ??
    tryGet(uc, ['itx_reason']) ??
    tryGet(uc, ['meta', 'itxReason']) ??
    tryGet(uc, ['meta', 'itx_reason']) ??
    tryGet(uc, ['ctxPack', 'itxReason']) ??
    tryGet(uc, ['ctxPack', 'itx_reason']) ??
    tryGet(uc, ['ctx_pack', 'itxReason']) ??
    tryGet(uc, ['ctx_pack', 'itx_reason']) ??
    tryGet(uc, ['memoryState', 'itxReason']) ??
    tryGet(uc, ['memoryState', 'itx_reason']) ??
    tryGet(uc, ['orchestratorState', 'itxReason']) ??
    tryGet(uc, ['orchestratorState', 'itx_reason']) ??
    tryGet(uc, ['last_state', 'itxReason']) ??
    tryGet(uc, ['last_state', 'itx_reason']) ??
    null;

  const anchorRaw =
    tryGet(uc, ['intentAnchor']) ??
    tryGet(uc, ['intent_anchor']) ??
    tryGet(uc, ['meta', 'intentAnchor']) ??
    tryGet(uc, ['meta', 'intent_anchor']) ??
    tryGet(uc, ['ctxPack', 'intentAnchor']) ??
    tryGet(uc, ['ctxPack', 'intent_anchor']) ??
    tryGet(uc, ['ctx_pack', 'intentAnchor']) ??
    tryGet(uc, ['ctx_pack', 'intent_anchor']) ??
    tryGet(uc, ['memoryState', 'intentAnchor']) ??
    tryGet(uc, ['memoryState', 'intent_anchor']) ??
    tryGet(uc, ['orchestratorState', 'intentAnchor']) ??
    tryGet(uc, ['orchestratorState', 'intent_anchor']) ??
    tryGet(uc, ['last_state', 'intentAnchor']) ??
    tryGet(uc, ['last_state', 'intent_anchor']) ??
    null;

  const step = String(stepRaw ?? '').trim().toUpperCase();
  const reason = String(reasonRaw ?? '').trim();

  const anchorKey =
    typeof anchorRaw === 'string'
      ? anchorRaw.trim()
      : anchorRaw && typeof anchorRaw === 'object' && typeof (anchorRaw as any).key === 'string'
        ? String((anchorRaw as any).key).trim()
        : '';

  const hasCarryStep = /^(T1|T2|T3)$/u.test(step);
  const hasCarryReason =
    reason.includes('IT_TRIGGER_OK') || reason.includes('IT_HOLD');
  const hasCarryAnchor = anchorKey.length > 0;

  return hasCarryStep && (hasCarryReason || hasCarryAnchor);
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
      rephraseBlockKeysPreview: Array.isArray(extra?.rephraseBlocks)
        ? extra.rephraseBlocks
            .slice(0, 8)
            .map((b: any) => String(b?.blockKey ?? '(none)'))
        : [],
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
// V3 CURRENT WRITER ROUTE.
// This function is the active V3 rephrase / writer path.
// Do not treat FlowSeedV21 / V21 as the active route when debugging or extending IROS.
// If older seedEngine / FlowSeedV21 code appears in search results, treat it as legacy unless explicitly reactivated.
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

  const hintedMaxLines =
    typeof (opts as any)?.maxLinesHint === 'number' && Number.isFinite((opts as any).maxLinesHint)
      ? Math.floor((opts as any).maxLinesHint)
      : 8;
      console.log('[IROS/rephraseEngine][MAXLINES_INIT]', {
        traceId: (debug as any)?.traceId ?? null,
        conversationId: (debug as any)?.conversationId ?? null,
        userCode: (debug as any)?.userCode ?? null,
        envMaxLines: Number(process.env.IROS_REPHRASE_FINAL_MAXLINES) > 0
          ? Math.floor(Number(process.env.IROS_REPHRASE_FINAL_MAXLINES))
          : null,
        optsMaxLinesHint:
          typeof (opts as any)?.maxLinesHint === 'number' && Number.isFinite((opts as any).maxLinesHint)
            ? Math.floor((opts as any).maxLinesHint)
            : null,
        hintedMaxLines,
      });
  let maxLines =
    Number(process.env.IROS_REPHRASE_FINAL_MAXLINES) > 0
      ? Math.floor(Number(process.env.IROS_REPHRASE_FINAL_MAXLINES))
      : Math.max(8, Math.min(80, hintedMaxLines));

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

  function verbalizeSlotText(raw: string): string | null {
    if (!raw) return null;

    const s = String(raw).trim();

    // JSON部分だけ抜く
    const jsonMatch = s.match(/\{[\s\S]*\}$/);
    let obj: any = null;
    if (jsonMatch) {
      try {
        obj = JSON.parse(jsonMatch[0]);
      } catch {}
    }

    // fallback
    const line =
      obj?.line ||
      obj?.hint ||
      obj?.text ||
      '';

    if (!line) return null;

    // --- Sofia寄り自然文整形 ---
    let t = String(line).trim();

    // 変な記号除去
    t = t.replace(/[「」]/g, '');
    t = t.replace(/\s+/g, ' ');

    // 語尾を軽く整える（固すぎ防止）
    if (!/[。]$/.test(t)) {
      t = t + 'です。';
    }

    return t;
  }

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

type SlotName = SlotNameFromEngine;
type SlotWeightInput = SlotWeightInputFromEngine;

const toRephraseBlocks = (s: string): string[] => {
  const text = String(s ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const cleanLine = (v: string): string =>
    String(v ?? '')
      .replace(/\[\[ILINE\]\]/g, '')
      .replace(/\[\[\/ILINE\]\]/g, '')
      .replace(/[ \t]+/g, ' ')
      .trim();

  const isBulletLike = (v: string): boolean =>
    /^[-*•・◯]\s+/u.test(String(v ?? '').trim());

  const splitParagraphToSentences = (v: string): string[] => {
    const src = cleanLine(v);
    if (!src) return [];

    const parts: string[] = [];
    let buf = '';
    let quoteDepth = 0;

    for (const ch of src) {
      if (/[「『]/u.test(ch)) quoteDepth += 1;

      buf += ch;

      if (/[」』]/u.test(ch)) {
        quoteDepth = Math.max(0, quoteDepth - 1);
      }

      // ✅ 日本語カギ括弧の内側では句点分割しない
      // 例: 「連絡がなくて少し心配していました。落ち着いたら、また連絡ください。」
      // の途中で改行されるのを防ぐ。
      if (quoteDepth === 0 && /[。！？]/u.test(ch)) {
        const t = cleanLine(buf);
        if (t) parts.push(t);
        buf = '';
      }
    }

    const tail = cleanLine(buf);
    if (tail) parts.push(tail);

    return parts.length > 0 ? parts : [src];
  };

  const mergeShortSentences = (items: string[]): string[] => {
    const out: string[] = [];
    let buf = '';

    const flush = () => {
      const t = cleanLine(buf);
      if (t) out.push(t);
      buf = '';
    };

    for (const raw of items) {
      const t = cleanLine(raw);
      if (!t) continue;

      if (!buf) {
        buf = t;
        continue;
      }

      const bufShort = buf.length < 38;
      const tShort = t.length < 30;
      const combinedShort = cleanLine(`${buf} ${t}`).length < 56;

      if (bufShort && tShort && combinedShort) {
        buf = cleanLine(`${buf} ${t}`);
      } else {
        flush();
        buf = t;
      }
    }

    flush();
    return out;
  };

  const splitLongBlock = (v: string): string[] => {
    const src = cleanLine(v);
    if (!src) return [];

    if (src.length <= 88) return [src];

    const pivotPatterns = [
      /ただし/u,
      /一方で/u,
      /なので/u,
      /そのため/u,
      /つまり/u,
      /要するに/u,
      /です。ただ/u,
      /ます。ただ/u,
      /です。一方で/u,
      /ます。一方で/u,
    ];

    for (const re of pivotPatterns) {
      const m = src.match(re);
      if (!m || m.index == null) continue;

      const idx = m.index;
      if (idx < 18 || idx > src.length - 18) continue;

      const a = cleanLine(src.slice(0, idx));
      const b = cleanLine(src.slice(idx));
      if (a && b) return [a, b];
    }

    return [src];
  };

  const paragraphHasBullet = (value: string): boolean =>
    String(value ?? '')
      .split('\n')
      .map(cleanLine)
      .some((line) => isBulletLike(line));

  const normalizeParagraphForBlock = (value: string): string => {
    const lines = String(value ?? '')
      .split('\n')
      .map(cleanLine)
      .filter(Boolean);

    if (lines.length === 0) return '';

    // Markdown箇条書きを含む段落は、見出しと「- 」行の改行を保持する。
    if (lines.some((line) => isBulletLike(line))) {
      return lines.join('\n').trim();
    }

    return cleanLine(lines.join(' '));
  };

  const paragraphs = text
    .split(/\n{2,}/)
    .map(normalizeParagraphForBlock)
    .filter(Boolean);

  let blocks: string[] = [];

  if (paragraphs.length >= 2) {
    blocks = paragraphs.flatMap((p) => (paragraphHasBullet(p) ? [p] : splitLongBlock(p)));
  } else {
    const lines = text
      .split('\n')
      .map(cleanLine)
      .filter(Boolean);

    if (lines.length >= 4) {
      blocks = lines;
    } else {
      const sentenceUnits = mergeShortSentences(
        lines.flatMap((line) => splitParagraphToSentences(line))
      );

      blocks = sentenceUnits.flatMap((p) => splitLongBlock(p));
    }
  }

  blocks = blocks
  .map(cleanLine)
  .filter(Boolean)
  .filter((v, i, arr) => i === 0 || v !== arr[i - 1]);

if (blocks.length === 0) {
  return [cleanLine(text)];
}

return blocks;
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
  const metaTextBase = safeContextToText(opts?.userContext ?? null);

  const extraForUnderstanding: any =
    (opts as any)?.extra && typeof (opts as any).extra === 'object'
      ? (opts as any).extra
      : {};

  const directCtxPackForUnderstanding: any =
    (opts as any)?.ctxPack && typeof (opts as any).ctxPack === 'object'
      ? (opts as any).ctxPack
      : {};

  const userCtxForUnderstanding: any = {
    ...extraForUnderstanding,
    ...((opts as any)?.userContext ?? {}),
  };

  const ctxPackForUnderstanding: any =
    userCtxForUnderstanding?.ctxPack && typeof userCtxForUnderstanding.ctxPack === 'object'
      ? {
          ...directCtxPackForUnderstanding,
          ...userCtxForUnderstanding.ctxPack,
        }
      : directCtxPackForUnderstanding;

  const memoryStateSnapshotForUnderstanding: any =
    userCtxForUnderstanding?.memoryStateSnapshot ??
    ctxPackForUnderstanding?.memoryStateSnapshot ??
    null;

  const pickUnderstandingText = (...values: any[]): string | null => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return null;
  };

  const pickUnderstandingNumber = (...values: any[]): number | null => {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim().length > 0) {
        const n = Number(value.trim());
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  };

  const baseQCodeForUnderstanding = pickUnderstandingText(
    userCtxForUnderstanding?.qCode,
    userCtxForUnderstanding?.q_code,
    ctxPackForUnderstanding?.qCode,
    ctxPackForUnderstanding?.q_code,
  );

  const stateQPrimaryForUnderstanding = pickUnderstandingText(
    memoryStateSnapshotForUnderstanding?.qPrimary,
    memoryStateSnapshotForUnderstanding?.q_primary,
    ctxPackForUnderstanding?.qPrimary,
    ctxPackForUnderstanding?.q_primary,
  );

  const depthStageForUnderstanding = pickUnderstandingText(
    memoryStateSnapshotForUnderstanding?.depthStage,
    memoryStateSnapshotForUnderstanding?.depth_stage,
    userCtxForUnderstanding?.depthStage,
    userCtxForUnderstanding?.depth_stage,
    ctxPackForUnderstanding?.depthStage,
    ctxPackForUnderstanding?.depth_stage,
  );

  const phaseForUnderstanding = pickUnderstandingText(
    memoryStateSnapshotForUnderstanding?.phase,
    userCtxForUnderstanding?.phase,
    ctxPackForUnderstanding?.phase,
  );

  const selfAcceptanceForUnderstanding = pickUnderstandingNumber(
    memoryStateSnapshotForUnderstanding?.selfAcceptance,
    memoryStateSnapshotForUnderstanding?.self_acceptance,
    memoryStateSnapshotForUnderstanding?.sa,
    userCtxForUnderstanding?.selfAcceptance,
    userCtxForUnderstanding?.self_acceptance,
    userCtxForUnderstanding?.sa,
    ctxPackForUnderstanding?.selfAcceptance,
    ctxPackForUnderstanding?.self_acceptance,
    ctxPackForUnderstanding?.sa,
    (opts as any)?.sa,
  );

  const sentimentLevelForUnderstanding = pickUnderstandingText(
    memoryStateSnapshotForUnderstanding?.sentimentLevel,
    memoryStateSnapshotForUnderstanding?.sentiment_level,
    userCtxForUnderstanding?.sentimentLevel,
    userCtxForUnderstanding?.sentiment_level,
    ctxPackForUnderstanding?.sentimentLevel,
    ctxPackForUnderstanding?.sentiment_level,
  );

  const currentETurnForUnderstanding = pickUnderstandingText(
    userCtxForUnderstanding?.e_turn,
    ctxPackForUnderstanding?.e_turn,
    userCtxForUnderstanding?.mirrorFlowV1?.mirror?.e_turn,
    ctxPackForUnderstanding?.mirrorFlowV1?.mirror?.e_turn,
    userCtxForUnderstanding?.mirror?.e_turn,
    ctxPackForUnderstanding?.mirror?.e_turn,
  );

  const polarityForUnderstanding = pickUnderstandingText(
    userCtxForUnderstanding?.polarity?.out,
    userCtxForUnderstanding?.polarity?.in,
    ctxPackForUnderstanding?.polarity?.out,
    ctxPackForUnderstanding?.polarity?.in,
    userCtxForUnderstanding?.mirrorFlowV1?.mirror?.polarity?.out,
    ctxPackForUnderstanding?.mirrorFlowV1?.mirror?.polarity?.out,
    userCtxForUnderstanding?.mirror?.polarity?.out,
    ctxPackForUnderstanding?.mirror?.polarity?.out,
  );

  const returnStreakForUnderstanding = pickUnderstandingNumber(
    userCtxForUnderstanding?.flow?.returnStreak,
    ctxPackForUnderstanding?.flow?.returnStreak,
    userCtxForUnderstanding?.mirrorFlowV1?.flow?.returnStreak,
    ctxPackForUnderstanding?.mirrorFlowV1?.flow?.returnStreak,
  );

  const interpretationHintForUnderstanding = (() => {
    const depth = String(depthStageForUnderstanding ?? '').trim().toUpperCase();
    const polarity = String(polarityForUnderstanding ?? '').trim().toLowerCase();
    const sentiment = String(sentimentLevelForUnderstanding ?? '').trim().toLowerCase();

    if (selfAcceptanceForUnderstanding != null && selfAcceptanceForUnderstanding < 0.45) {
      return '受け取り可能度が低め。断定や深掘りを抑え、短く扱える言葉へ戻す。';
    }

    if (depth.startsWith('S') && (polarity === 'yin' || polarity === 'neg' || sentiment.includes('neg'))) {
      return 'S帯域で反応が内向き。意味を広げすぎず、今扱える一点に絞る。';
    }

    if (depth.startsWith('C') || depth.startsWith('I') || depth.startsWith('T')) {
      return '創造・意図側まで扱える。根拠のある意味展開は許可し、ただし飛躍は避ける。';
    }

    return '状態メタを本文に露出せず、返答の深さ・温度・具体度の調整に使う。';
  })();

  const userUnderstandingStateText = [
    'USER_UNDERSTANDING_STATE:',
    baseQCodeForUnderstanding ? `- base_q_code: ${baseQCodeForUnderstanding}` : null,
    stateQPrimaryForUnderstanding ? `- state_q_primary: ${stateQPrimaryForUnderstanding}` : null,
    depthStageForUnderstanding ? `- depth_stage: ${depthStageForUnderstanding}` : null,
    phaseForUnderstanding ? `- phase: ${phaseForUnderstanding}` : null,
    selfAcceptanceForUnderstanding != null
      ? `- self_acceptance: ${selfAcceptanceForUnderstanding}`
      : null,
    sentimentLevelForUnderstanding ? `- sentiment_level: ${sentimentLevelForUnderstanding}` : null,
    currentETurnForUnderstanding ? `- current_e_turn: ${currentETurnForUnderstanding}` : null,
    polarityForUnderstanding ? `- polarity: ${polarityForUnderstanding}` : null,
    returnStreakForUnderstanding != null ? `- return_streak: ${returnStreakForUnderstanding}` : null,
    `- interpretation_hint: ${interpretationHintForUnderstanding}`,
  ]
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .join('\n')
    .trim();

  const isNewQuotedReferenceSourceForUnderstandingMemoryGate =
    (opts as any)?.extra?.newQuotedReferenceSource === true ||
    (opts as any)?.extra?.ctxPack?.newQuotedReferenceSource === true ||
    (opts as any)?.ctxPack?.newQuotedReferenceSource === true ||
    (opts as any)?.userContext?.newQuotedReferenceSource === true ||
    (opts as any)?.userContext?.ctxPack?.newQuotedReferenceSource === true ||
    (opts as any)?.userContext?.meta?.extra?.newQuotedReferenceSource === true ||
    (opts as any)?.userContext?.meta?.extra?.ctxPack?.newQuotedReferenceSource === true ||
    ctxPackForUnderstanding?.newQuotedReferenceSource === true;

  const rawMemoryStateNoteText = String(
    userCtxForUnderstanding?.memoryStateNoteText ??
    ctxPackForUnderstanding?.memoryStateNoteText ??
    ''
  ).trim();

  const rawLongTermMemoryNoteText = String(
    userCtxForUnderstanding?.longTermMemoryNoteText ??
    ctxPackForUnderstanding?.longTermMemoryNoteText ??
    ''
  ).trim();

  const memoryStateNoteText = isNewQuotedReferenceSourceForUnderstandingMemoryGate
    ? ''
    : rawMemoryStateNoteText;

  const longTermMemoryNoteText = isNewQuotedReferenceSourceForUnderstandingMemoryGate
    ? ''
    : rawLongTermMemoryNoteText;

  console.log('[IROS/REPHRASE_MEMORY_META_GATE]', {
    isNewQuotedReferenceSourceForUnderstandingMemoryGate,
    rawMemoryStateNoteTextLen: rawMemoryStateNoteText.length,
    rawLongTermMemoryNoteTextLen: rawLongTermMemoryNoteText.length,
    memoryStateNoteTextLen: memoryStateNoteText.length,
    longTermMemoryNoteTextLen: longTermMemoryNoteText.length,
    optsExtraNewQuotedReferenceSource: (opts as any)?.extra?.newQuotedReferenceSource === true,
    optsExtraCtxPackNewQuotedReferenceSource: (opts as any)?.extra?.ctxPack?.newQuotedReferenceSource === true,
    optsCtxPackNewQuotedReferenceSource: (opts as any)?.ctxPack?.newQuotedReferenceSource === true,
    userContextCtxPackNewQuotedReferenceSource: (opts as any)?.userContext?.ctxPack?.newQuotedReferenceSource === true,
    userContextMetaExtraCtxPackNewQuotedReferenceSource:
      (opts as any)?.userContext?.meta?.extra?.ctxPack?.newQuotedReferenceSource === true,
    ctxPackForUnderstandingNewQuotedReferenceSource:
      ctxPackForUnderstanding?.newQuotedReferenceSource === true,
  });

  const metaText = [userUnderstandingStateText, metaTextBase, memoryStateNoteText, longTermMemoryNoteText]
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .join('\n')
    .trim();

  console.log(
    '[IROS/rephraseEngine][USER_UNDERSTANDING_STATE_JSON]',
    JSON.stringify({
      hasUserUnderstandingState: userUnderstandingStateText.length > 0,
      userUnderstandingStateText,
      metaTextHasUserUnderstandingState: metaText.includes('USER_UNDERSTANDING_STATE:'),
      baseQCodeForUnderstanding,
      stateQPrimaryForUnderstanding,
      depthStageForUnderstanding,
      phaseForUnderstanding,
      selfAcceptanceForUnderstanding,
      sentimentLevelForUnderstanding,
      currentETurnForUnderstanding,
      polarityForUnderstanding,
      returnStreakForUnderstanding,
    }),
  );

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
  // ✅ HISTORY_LITE の材料は、writer に渡す尾部を最優先にする
  // - generic な turns/historyForWriter ではなく、
  //   このターンで正規化した writer 用 tail を優先
  // - これで「過去 assistant 自然文」が HISTORY_LITE 経由で再混入するのを止める
  const lastTurns = (() => {
    const preferred =
      Array.isArray((opts as any)?.turnsForWriter) && (opts as any).turnsForWriter.length > 0
        ? (opts as any).turnsForWriter
        : Array.isArray((opts as any)?.messages) &&
            (opts as any).messages.length > 0
          ? (opts as any).messages
          : Array.isArray((opts as any)?.userContext?.turnsForWriter) &&
              (opts as any).userContext.turnsForWriter.length > 0
            ? (opts as any).userContext.turnsForWriter
            : Array.isArray((opts as any)?.userContext?.ctxPack?.turnsForWriter) &&
                (opts as any).userContext.ctxPack.turnsForWriter.length > 0
              ? (opts as any).userContext.ctxPack.turnsForWriter
              : null;

    if (preferred) return preferred;
    return extractLastTurnsFromContext(opts?.userContext ?? null);
  })();

  // src/lib/iros/language/rephrase/rephraseEngine.full.ts
  // buildHistoryTextLite を “user生文ゼロ” にする（HISTORY_LITE 漏れ止血）

  // buildHistoryTextLite を “user生文ゼロ” にする（HISTORY_LITE 漏れ止血）
  // + assistant の「入力の有無確認」系を履歴から除去（増殖防止）
  const buildHistoryTextLite = (turns: any[]): string => {
    const lines: string[] = ['HISTORY_LITE (DO NOT OUTPUT):'];

    const sanitizeUserForHistory = (raw: string): string => {
      let t = String(raw ?? '').replace(/\r\n/g, '\n').trim();
      if (!t) return '';

      t = t
        .split('\n')
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!t) return '';

      const firstSentence = t.split(/(?<=[。！？!?])/u)[0]?.trim() ?? t;
      t = firstSentence.replace(/\s+/g, ' ').trim();
      if (!t) return '';

      return t.length > 80 ? `${t.slice(0, 80)}…` : t;
    };

    const pickedTurns = (Array.isArray(turns) ? turns : []).slice(-4);

    for (const t of pickedTurns) {
      const role = t?.role === 'user' ? 'user' : null;
      if (!role) continue;

      const raw = String(t?.content ?? t?.text ?? '').replace(/\r\n/g, '\n').trim();
      if (!raw) continue;

      const one = sanitizeUserForHistory(raw);
      if (!one) continue;
      lines.push(`user: ${one}`);
    }

    return lines.join('\n');
  };

  const historyText = (() => {
    const ctxPackForHistoryText =
      (opts as any)?.ctxPack ??
      (opts as any)?.userContext?.ctxPack ??
      (opts as any)?.userContext?.ctxPackV1 ??
      null;

      const primaryQuestion =
      (ctxPackForHistoryText as any)?.question ??
      (opts as any)?.userContext?.question ??
      (opts as any)?.extra?.question ??
      (opts as any)?.userContext?.meta?.extra?.question ??
      null;

    const questionType = String(primaryQuestion?.questionType ?? '').trim();
    const tMode = String(primaryQuestion?.tState?.mode ?? '').trim();

    const pastStateNoteTextForHistory = String(
      (opts as any)?.extra?.pastStateNoteText ??
      (opts as any)?.userContext?.pastStateNoteText ??
      (opts as any)?.userContext?.meta?.extra?.pastStateNoteText ??
      ''
    ).trim();

    const pastStateTriggerKindForHistory = String(
      (opts as any)?.extra?.pastStateTriggerKind ??
      (opts as any)?.userContext?.pastStateTriggerKind ??
      (opts as any)?.userContext?.meta?.extra?.pastStateTriggerKind ??
      ''
    ).trim();

    const shouldPreferPastStateRecallForHistory =
      !!pastStateNoteTextForHistory &&
      (pastStateTriggerKindForHistory === 'keyword' ||
        pastStateTriggerKindForHistory === 'recent_topic');

        const historyPatternKey = selectSlotPattern({
          line: String(
            (opts as any)?.meta?.extra?.presentationKind ??
              (opts as any)?.userContext?.meta?.extra?.presentationKind ??
              ''
          )
            .trim()
            .toLowerCase(),
          questionType,
          detailMode:
            (ctxPackForHistoryText as any)?.detailMode === true ||
            (opts as any)?.userContext?.ctxPack?.detailMode === true,
          followupText: String((opts as any)?.userText ?? '').trim(),
          userText: String((opts as any)?.userText ?? '').trim(),
          targetLabel: null,
          hasPriorDiagnosis: false,
        });

        const hfw =
          historyPatternKey === 'DECLARATION_RESONANCE_V1'
            ? []
            : (ctxPackForHistoryText as any)?.historyForWriter ??
              (opts as any)?.userContext?.historyForWriter ??
              (opts as any)?.userContext?.ctxPack?.historyForWriter ??
              [];

              const hasHistoryForWriter = Array.isArray(hfw) && hfw.length > 0;

              const historyGoalKind = String(
                (ctxPackForHistoryText as any)?.goalKind ??
                  (opts as any)?.userContext?.goalKind ??
                  (opts as any)?.extra?.goalKind ??
                  ''
              ).trim();

              const explicitContinuationRequested = /この前|続き|前に言ってた|前に|前の話(?:し)?|前の流れ|つなげて|続きとして/.test(
                String((opts as any)?.userText ?? '')
              );

              const shouldDropHistoryLiteByMode =
                historyPatternKey === 'NORMAL_COMPRESSED_V1' &&
                historyGoalKind === 'stabilize' &&
                !explicitContinuationRequested;

              if (hasHistoryForWriter) {
                const currentUserNorm = String((opts as any)?.userText ?? '')
                  .replace(/\r\n/g, '\n')
                  .trim();

                const lastHistoryUserNorm = (() => {
                  const lastUser = [...(hfw as any[])]
                    .reverse()
                    .find((x) => x?.role === 'user');
                  return String(lastUser?.content ?? lastUser?.text ?? '')
                    .replace(/\r\n/g, '\n')
                    .trim();
                })();

                const shouldDropDuplicateHistoryLite =
                  historyPatternKey === 'NORMAL_COMPRESSED_V1' &&
                  !!currentUserNorm &&
                  lastHistoryUserNorm === currentUserNorm;

                try {
                  console.log(
                    '[IROS/HISTORY_LITE_GUARD]',
                    JSON.stringify({
                      historyPatternKey,
                      historyGoalKind,
                      explicitContinuationRequested,
                      currentUserNorm,
                      lastHistoryUserNorm,
                      sameAsCurrentUser: lastHistoryUserNorm === currentUserNorm,
                      shouldDropDuplicateHistoryLite,
                      shouldDropHistoryLiteByMode,
                    }),
                  );
                } catch {}

                if (shouldDropHistoryLiteByMode) {
                  return '';
                }

                if (shouldDropDuplicateHistoryLite) {
                  return '';
                }

                return buildHistoryTextLite(hfw as any[]);
              }

              const currentUserNormForFallback = String((opts as any)?.userText ?? '')
                .replace(/\r\n/g, '\n')
                .trim();

              const lastTurnsUserNorm = (() => {
                const lastUser = [...(Array.isArray(lastTurns) ? lastTurns : [])]
                  .reverse()
                  .find((x) => x?.role === 'user');
                return String(lastUser?.content ?? lastUser?.text ?? '')
                  .replace(/\r\n/g, '\n')
                  .trim();
              })();

              const shouldDropDuplicateHistoryLiteFromFallback =
                historyPatternKey === 'NORMAL_COMPRESSED_V1' &&
                !!currentUserNormForFallback &&
                lastTurnsUserNorm === currentUserNormForFallback;

              try {
                console.log(
                  '[IROS/HISTORY_LITE_FALLBACK_GUARD]',
                  JSON.stringify({
                    historyPatternKey,
                    currentUserNormForFallback,
                    lastTurnsUserNorm,
                    sameAsCurrentUser: lastTurnsUserNorm === currentUserNormForFallback,
                    shouldDropDuplicateHistoryLiteFromFallback,
                  }),
                );
              } catch {}

              // ✅ 旧 stopgap も維持
              // meaning + confirm では HISTORY_LITE を writer に渡さない
              if (questionType === 'meaning' && tMode === 'confirm') {
                return '';
              }

              // ✅ pastState recall（keyword / recent_topic）では HISTORY_LITE fallback も止める
              if (shouldPreferPastStateRecallForHistory) {
                return '';
              }

              if (shouldDropDuplicateHistoryLiteFromFallback) {
                return '';
              }

              // ✅ fallback: 履歴正本が無い時だけ使う
              return buildHistoryTextLite(lastTurns);
  })();

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

const slotsTextRawAll = extracted.slots
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
  // ✅ picked も sanitize を通す（OBS の user 混入を落とす）
  .map((s) => sanitizeSlotTextForWriter(s.text))
  .filter(Boolean)
  .join('\n');

// ✅ 保険：拾えた seed が userText 相当だけになったら rawAll（slotsTextRawAll）に戻す
const seedDraftRaw = (() => {
  const all = String(slotsTextRawAll ?? '').trim();
  const picked = String(seedDraftRawPicked ?? '').trim();
  const ut = String(userText ?? '').trim();

  const allHasDirective = /@(OBS|SHIFT|SH|RESTORE|Q|Q_SLOT|SAFE|NEXT|END|TASK|SEED_TEXT)\b/m.test(all);
  const pickedLooksLikeUserOnly =
    !!ut &&
    (!!picked && (picked === ut || (picked.length <= ut.length + 2 && picked.includes(ut))));

  if (allHasDirective && pickedLooksLikeUserOnly) return all;
  return picked || all;
})();

// ✅ must-include は「slots全文」ではなく「実際に使う seed」から抽出する
const recallMust = extractRecallMustIncludeFromSeed(seedDraftRaw);
const mustIncludeRuleText = buildMustIncludeRuleText(
  recallMust ?? { restoreNeedle: null, questionNeedle: null }
);
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

  // ✅ seed/user のどちらに ILINE が含まれているかを判定
  const seedHasILINE = /\[\[ILINE\]\]/.test(seedStr) || /\[\[\/ILINE\]\]/.test(seedStr);

  // ✅ userText は「ILINEタグがある時だけ」 lockSource に入れる（将来の誤固定を防止）
  const userHasILINE = /\[\[ILINE\]\]/.test(userStr) || /\[\[\/ILINE\]\]/.test(userStr);

  // ✅ LOCK素材は「ILINEが含まれるテキスト」だけに限定する
  // - ILINE が無い seed/user を lockSource に入れると、seedEqUser のとき誤って “全文ロック素材” っぽく見える
  // - extractLockedILines は ILINE が無いと何も抽出しないため、ここで素材側を絞るのが正しい
  const lockParts = [
    seedHasILINE ? seedStr : '',
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

      // ✅ NEXT_HINT は evidence 専用：seed には絶対混ぜない
      if (/^@NEXT_HINT\b/.test(t)) return false;

      // ✅ ILINE マーカーは露出禁止（中身だけ残すのは extractLockedILines 側で処理済み）
      if (/\[\[ILINE\]\]/.test(t) || /\[\[\/ILINE\]\]/.test(t)) return false;

      // ✅ “directive行(@OBS/@SHIFT/@SAFE…)" は seed として必要なので落とさない
      // （= INTERNAL_LINE_MARKER ではフィルタしない）

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

const isIrDiagnosis =
  (opts as any)?.meta?.extra?.isIrDiagnosisTurn === true ||
  (opts as any)?.meta?.extra?.presentationKind === 'diagnosis' ||
  (opts as any)?.meta?.extra?.irDiagnosis === true ||
  (opts as any)?.meta?.extra?.mode === 'ir' ||
  (opts as any)?.meta?.extra?.intent === 'ir';

// =========================
// ir診断は完全に軽量seed固定
// =========================
let seedFinal = '';
let diagnosisFollowupRequiredRuleText = '';
let diagnosisFollowupSeedForMaterialize = '';
let isDiagnosisFollowupSeedForMaterialize = false;

if (isIrDiagnosis) {
  const override =
    String(
      (opts as any)?.meta?.extra?.contentOverride ??
      (opts as any)?.meta?.extra?.finalAssistantTextCandidate ??
      (opts as any)?.meta?.extra?.finalAssistantText ??
      ''
    ).trim();

  seedFinal = override || 'ir診断';
} else {
  const seedDraftSanitized = sanitizeSeedDraftForLLM(seedDraft0);

  const resolvedAskSeedFromShift = (() => {
    try {
      const source = String(slotsTextRawAll ?? seedDraftRaw ?? '').trim();
      if (!source) return '';

      const m = source.match(/@SHIFT\s+({[^\n]+})/);
      if (!m?.[1]) return '';

      const obj = JSON.parse(m[1]);

      const intent = String(obj?.intent ?? '').trim();
      const meaningKind = String(obj?.meaning_kind ?? '').trim();
      const sourceKind = String(obj?.source ?? '').trim();
      const seedText = String(obj?.seed_text ?? '').replace(/\s+/g, ' ').trim();

      const isResolvedTruthStructure =
        sourceKind === 'resolved_ask' &&
        (
          intent === 'answer_truth_structure' ||
          meaningKind === 'answer_truth_structure' ||
          meaningKind === 'truth_structure'
        );

      if (!isResolvedTruthStructure || !seedText) return '';

      return seedText;
    } catch {
      return '';
    }
  })();

  const canonicalOneLineSeed = (() => {
    try {
      const source = [String(seedDraftRaw ?? ''), String(slotsTextRawAll ?? '')]
        .find((s) => /FLOW_V2\s*\(DO NOT OUTPUT\):/i.test(String(s ?? ''))) ?? '';

      if (!source) return '';

      const current =
        (source.match(/(?:^|\n)current=([^\n]+)/)?.[1] ?? '').trim();

      if (!current) return '';

      return '関心の重心が別の論点へ移っている';
    } catch {
      return '';
    }
  })();

  const diagnosisFollowupSeedFromCtx = (() => {
    const candidates = [
      (opts as any)?.meta?.extra?.ctxPack?.diagnosisFollowupAnalysisSeed,
      (opts as any)?.meta?.extra?.diagnosisFollowupAnalysisSeed,
      (opts as any)?.ctxPack?.diagnosisFollowupAnalysisSeed,
      (opts as any)?.userContext?.ctxPack?.diagnosisFollowupAnalysisSeed,

      (opts as any)?.meta?.extra?.ctxPack?.lastIrDiagnosis?.summary,
      (opts as any)?.meta?.extra?.ctxPack?.lastIrDiagnosis?.diagnosisText,
      (opts as any)?.meta?.extra?.ctxPack?.lastIrDiagnosis?.text,
      (opts as any)?.meta?.extra?.ctxPack?.lastIrDiagnosis?.assistantText,
      (opts as any)?.meta?.extra?.ctxPack?.lastIrDiagnosis?.observation,
      (opts as any)?.meta?.extra?.ctxPack?.lastIrDiagnosis?.state,

      (opts as any)?.meta?.extra?.lastIrDiagnosis?.summary,
      (opts as any)?.meta?.extra?.lastIrDiagnosis?.diagnosisText,
      (opts as any)?.meta?.extra?.lastIrDiagnosis?.text,
      (opts as any)?.meta?.extra?.lastIrDiagnosis?.assistantText,
      (opts as any)?.meta?.extra?.lastIrDiagnosis?.observation,
      (opts as any)?.meta?.extra?.lastIrDiagnosis?.state,

      (opts as any)?.ctxPack?.lastIrDiagnosis?.summary,
      (opts as any)?.ctxPack?.lastIrDiagnosis?.diagnosisText,
      (opts as any)?.ctxPack?.lastIrDiagnosis?.text,
      (opts as any)?.ctxPack?.lastIrDiagnosis?.assistantText,
      (opts as any)?.ctxPack?.lastIrDiagnosis?.observation,
      (opts as any)?.ctxPack?.lastIrDiagnosis?.state,

      (opts as any)?.userContext?.ctxPack?.lastIrDiagnosis?.summary,
      (opts as any)?.userContext?.ctxPack?.lastIrDiagnosis?.diagnosisText,
      (opts as any)?.userContext?.ctxPack?.lastIrDiagnosis?.text,
      (opts as any)?.userContext?.ctxPack?.lastIrDiagnosis?.assistantText,
      (opts as any)?.userContext?.ctxPack?.lastIrDiagnosis?.observation,
      (opts as any)?.userContext?.ctxPack?.lastIrDiagnosis?.state,

      (opts as any)?.meta?.extra?.ctxPack?.topicHint,
      (opts as any)?.ctxPack?.topicHint,
      (opts as any)?.userContext?.ctxPack?.topicHint,
    ];

    return candidates
      .map((v) => String(v ?? '').trim())
      .find((v) => v.length > 0) ?? '';
  })();

  const isDiagnosisFollowupSeed =
    (opts as any)?.meta?.extra?.ctxPack?.diagnosisFollowup === true ||
    (opts as any)?.meta?.extra?.diagnosisFollowup === true ||
    (opts as any)?.ctxPack?.diagnosisFollowup === true ||
    (opts as any)?.userContext?.ctxPack?.diagnosisFollowup === true ||
    String((opts as any)?.meta?.extra?.ctxPack?.continuityKind ?? '').trim() === 'diagnosis_followup' ||
    String((opts as any)?.ctxPack?.continuityKind ?? '').trim() === 'diagnosis_followup' ||
    String((opts as any)?.userContext?.ctxPack?.continuityKind ?? '').trim() === 'diagnosis_followup' ||
    Boolean((opts as any)?.meta?.extra?.ctxPack?.lastIrDiagnosis) ||
    Boolean((opts as any)?.meta?.extra?.lastIrDiagnosis) ||
    Boolean((opts as any)?.ctxPack?.lastIrDiagnosis) ||
    Boolean((opts as any)?.userContext?.ctxPack?.lastIrDiagnosis);

  const FALLBACK_SEED =
    'ユーザーの最後の発話に、結論を先にして短く直接答えてください。';

  seedFinal =
    (isDiagnosisFollowupSeed ? diagnosisFollowupSeedFromCtx : '') ||
    resolvedAskSeedFromShift ||
    chooseSeedForLLM(seedDraftSanitized, '') ||
    canonicalOneLineSeed ||
    FALLBACK_SEED;


  diagnosisFollowupRequiredRuleText =
    isDiagnosisFollowupSeed && diagnosisFollowupSeedFromCtx
      ? [
          '',
          '【診断フォロー回答必須】',
          'ユーザーは前回診断の中身を確認している。',
          '前回診断の内容を背景扱いで終わらせず、回答本文に必ず反映する。',
          'DIAGNOSIS_FOLLOWUP_ANALYSIS_SEED がある場合は、task/not_task/answer_start を最優先し、診断全文を再掲しない。',
          '前回診断本文がある場合は、その本文から確認できる内容をそのまま回答に使う。',
          '前回診断本文がない場合は、「今は前回診断の中身を確認できません」と正直に答える。',
          '確認できない診断を、あるように言わない。確認できる診断を、ないように言わない。',
          '診断本文・保存メタ・履歴の区別を混ぜない。本文があるなら本文、本文がないなら無い、履歴だけなら履歴だけと分けて答える。',
          '推測で補完せず、取得できている情報の範囲だけを答える。',
          '少なくとも「現状」「ポイント」「意識の向かう先」「メッセージ」のうち、診断本文に存在する要素を2つ以上使って答える。',
          '「確認したい流れです」「気になっているようです」だけで終わらせない。',
          '前回診断本文:',
          diagnosisFollowupSeedFromCtx,
          '',
        ].join('\n')
      : '';

  isDiagnosisFollowupSeedForMaterialize = isDiagnosisFollowupSeed;
  diagnosisFollowupSeedForMaterialize =
    isDiagnosisFollowupSeed && diagnosisFollowupSeedFromCtx
      ? diagnosisFollowupSeedFromCtx
      : '';
  console.log('[IROS/DIAG_FOLLOWUP_SEED_PICK]', {
    isDiagnosisFollowupSeed,
    diagnosisFollowupSeedLen: String(diagnosisFollowupSeedFromCtx ?? '').length,
    diagnosisFollowupSeedHead: safeHead(String(diagnosisFollowupSeedFromCtx ?? ''), 180),
    seedFinalLen: String(seedFinal ?? '').length,
    seedFinalHead: safeHead(String(seedFinal ?? ''), 180),
    hasMetaExtraCtxLastIrDiagnosis: Boolean((opts as any)?.meta?.extra?.ctxPack?.lastIrDiagnosis),
    hasMetaExtraLastIrDiagnosis: Boolean((opts as any)?.meta?.extra?.lastIrDiagnosis),
    hasCtxPackLastIrDiagnosis: Boolean((opts as any)?.ctxPack?.lastIrDiagnosis),
    hasUserContextCtxPackLastIrDiagnosis: Boolean((opts as any)?.userContext?.ctxPack?.lastIrDiagnosis),
    metaExtraCtxLastIrDiagnosisKeys: Object.keys((opts as any)?.meta?.extra?.ctxPack?.lastIrDiagnosis ?? {}),
    userContextCtxLastIrDiagnosisKeys: Object.keys((opts as any)?.userContext?.ctxPack?.lastIrDiagnosis ?? {}),
  });
}

// 正本
// ✅ seedDraft は seedFinal を正本とする（userText遮断の一貫性）
const seedDraft = seedFinal;

console.log('[IROS/SEED_FINAL_AFTER_PICK]', {
  seedFinalLen: String(seedFinal ?? '').length,
  seedFinalHead: safeHead(String(seedFinal ?? ''), 220),
  seedDraftHead: safeHead(String(seedDraft ?? ''), 220),
  isIrDiagnosis,
  hasMetaExtraCtxLastIrDiagnosis: Boolean((opts as any)?.meta?.extra?.ctxPack?.lastIrDiagnosis),
  hasUserContextCtxPackLastIrDiagnosis: Boolean((opts as any)?.userContext?.ctxPack?.lastIrDiagnosis),
});
// writer向けの軽いヒント（※ここも userText を足さない前提）
const seedInstruction = (() => {
  const s = String(seedDraft ?? '')
    .replace(/^[ \t]*@OBS[^\n]*(?:\n|$)/gm, '')
    .replace(/^[ \t]*@SHIFT[^\n]*(?:\n|$)/gm, '')
    .replace(/^[ \t]*@SAFE[^\n]*(?:\n|$)/gm, '')
    .replace(/^[ \t]*@NEXT_HINT[^\n]*(?:\n|$)/gm, '')
    .replace(/^[ \t]*@DELTA[^\n]*(?:\n|$)/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!s) return '';

  return `【最重要指示】
以下の意味に従って応答を生成してください。
この意味を優先し、それ以外の文脈は補助として扱ってください。

${s}`;
})();
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

  // 末尾 user はこのターンの user と二重になるので落とす
  if (tail.length > 0 && tail[tail.length - 1]?.role === 'user') {
    tail = tail.slice(0, -1);
  }

  // 最大4メッセージ
  return tail.slice(-4);
})();



  // =========================================================
  // Flow / Context Digest
  // =========================================================
  const flowDigest = readFlowDigest(opts?.userContext ?? null);
  const flowTape = readFlowTape(opts?.userContext ?? null);

  // topic / goal / repeat（存在すれば拾う・なければ null）
  // NOTE: `??` は ''（空文字）で止まるので、trim後に空なら次候補へ進める
  const pickNonEmpty = (...cands: any[]) => {
    for (const v of cands) {
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (!s) continue;
      return s;
    }
    return '';
  };

  const topicDigest = pickNonEmpty(
    (opts?.userContext as any)?.topicDigest,
    (opts?.userContext as any)?.meta?.topicDigest,
    (opts?.userContext as any)?.extra?.topicDigest,
    (opts?.userContext as any)?.ctxPack?.topicDigest,
    // ✅ conversationLine を topicDigest のフォールバックとして採用
    (opts?.userContext as any)?.ctxPack?.conversationLine,
    (opts?.userContext as any)?.orch?.topicDigest
  );

  const replyGoal = pickNonEmpty(
    (opts?.userContext as any)?.replyGoal,
    (opts?.userContext as any)?.ctxPack?.replyGoal
  ) || null;

  const repeatSignal = pickNonEmpty(
    (opts?.userContext as any)?.repeatSignal,
    (opts?.userContext as any)?.ctxPack?.repeatSignal
  ) || null;

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
  //
  // ⚠️ ただし T_CONCRETIZE は「汚染（meta/seed/userText）」で過剰発火しやすいので、
  //     判定ソースを SHIFT 系（shiftSlot/shiftText）に限定して安定化する。
  const laneHintText = [
    String(shiftTextForMode ?? ''),
    String(metaText ?? ''),
    String(seedInstruction ?? ''),
    String(userText ?? ''),
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);

  // ✅ T_CONCRETIZE 判定は SHIFT 系だけを見る（汚染で立ち続けるのを防ぐ）
  const laneHintTextForLane = String(shiftTextForMode ?? '').slice(0, 4000);

  const shiftLaneKey =
  shiftSlot && typeof shiftSlot === 'object' ? String((shiftSlot as any)?.laneKey ?? '') : '';
const shiftKindForLane =
  shiftSlot && typeof shiftSlot === 'object' ? String((shiftSlot as any)?.kind ?? '') : '';
  // ✅ raw hit（repeat判定の前に、レーン意図そのものを拾う）
  const hitTConcretize =
    shiftLaneKey === 'T_CONCRETIZE' ||
    shiftKindForLane === 't_concretize' ||
    /"laneKey"\s*:\s*"T_CONCRETIZE"/.test(laneHintTextForLane) ||
    /"kind"\s*:\s*"t_concretize"/.test(laneHintTextForLane) ||
    /\bT_CONCRETIZE\b/.test(laneHintTextForLane) ||
    /\bt_concretize\b/.test(laneHintTextForLane);

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
  // ✅ repeatSignalSame（同句反復）が立っている時は T_CONCRETIZE を立てず、counsel/normal 側へ逃がす
  const wantsTConcretize = hitTConcretize && !repeatSignalSame;

  // ✅ IDEA_BAND は same_phrase でも殺さない（コメントどおり）
  const wantsIdeaBand = !wantsTConcretize && hitIdeaBand;


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
      '- 本文は短め（2〜6行目安）。',
      '- 冒頭でユーザー文をそのまま復唱しない（短く言い換えて言い切る）。',
      '- “次の一歩”は1つだけ。抽象語で逃げず、対象/操作点を1つに絞る（例示OK）。',
      '- 選択肢列挙（A/B/C、候補、◯◯という選択肢）は禁止。1つに絞って言い切る。',
      '- 質問は0。聞き返しで進めず、このターンで1つに収束させる。',
      '',

      ].join('\n')
    : '';

  // ✅ IDEA_BAND（候補生成）出力契約：Phase1をそのまま“強制”
  const ideaBandHeader = wantsIdeaBand
    ? [
      '【IDEA_BAND 出力契約（最優先）】',
      '- 出力は2〜4行のみ。',
      '- 候補列挙は禁止。「◯◯という選択肢」「A/B/C」「候補:」の形は使わない。',
      '- まず、ユーザーの中で同時に立っている2つの力を自然文で1回だけ言語化する。',
      '- その次に、そのズレが何を迷わせているかを1行で言い切る。',
      '- 行動指示・ToDo・手順・時間指定・聞き返しは禁止。',
      '- 一般論・箇条書き・メニュー化は禁止。共鳴による構造再配置だけを書く。',
        '',
      ].join('\n')
    : '';

  // ✅ IDEA_BAND のときは directTask を強制で無効化する
  //    （directTask があると “文章を仕上げる” 側に吸われて契約違反の初撃が出やすい）
  const directTaskForPrompt = wantsIdeaBand ? false : isDirectTask;

  const muPersonalityInstructions =
    typeof (opts as any)?.extra?.muPersonalityInstructions === 'string' &&
    (opts as any).extra.muPersonalityInstructions.trim().length > 0
      ? (opts as any).extra.muPersonalityInstructions.trim()
      : null;

  // ✅ レーンが明示されている時は GROUND をやめる
  //    （GROUND骨格が IDEA_BAND を潰すため）
  const baseSystemPrompt = systemPromptForFullReply({
    ...(opts as any)?.systemPromptArgs,

    // ✅ inputKind を systemPrompt に渡す（micro/greeting 判定・ログ整合）
    inputKind,

    // ✅ IROS内に重ねるMu人格設定
    muPersonalityInstructions,

    // ✅ directTask は wantsIdeaBand を考慮した版を渡す
    directTask: directTaskForPrompt,

    // ✅ IT成立（証拠）を systemPrompt に届ける
    itOk,

    // ✅ intentBand / tLayerHint を systemPrompt に届ける（GUIDE_I 判定の材料）
    band,
    shiftKind: String(parseShiftJson(String((shiftSlot as any)?.text ?? ''))?.kind ?? ''),

    // ✅ question 系を systemPrompt に渡す
    // - 説明要求 / 構造確認 / 理由説明では GUIDE_I を抑えるため
    questionType: String(
      (
        (opts as any)?.userContext?.question?.questionType ??
        (opts as any)?.userContext?.meta?.extra?.question?.questionType ??
        ''
      )
    ).trim(),
    questionFocus: String(
      (
        (opts as any)?.userContext?.question?.tState?.focus ??
        (opts as any)?.userContext?.meta?.extra?.question?.tState?.focus ??
        ''
      )
    ).trim(),
    askBackAllowed: (() => {
      const p =
        (opts as any)?.userContext?.question?.outputPolicy ??
        (opts as any)?.userContext?.meta?.extra?.question?.outputPolicy ??
        null;
      return p?.askBackAllowed === true;
    })(),

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

  // ✅ レーン契約は「最後」に示す（後段の詳細指示が勝つ）
  const laneContractTail = (tConcretizeHeader || '') + (ideaBandHeader || '');

  const systemPrompt = baseSystemPrompt + mustIncludeRuleText + diagnosisFollowupRequiredRuleText + laneContractTail;
  try {
    console.log('[IROS/MUST_INCLUDE][LEN]', {
      hasRecall: Boolean(recallMust?.restoreNeedle || recallMust?.questionNeedle),
      mustLen: mustIncludeRuleText ? String(mustIncludeRuleText).length : 0,
      diagnosisFollowupRequiredLen: diagnosisFollowupRequiredRuleText ? String(diagnosisFollowupRequiredRuleText).length : 0,
    });
  } catch {}
  // ✅ q/depth/phase を “確証つきで” internalPack に入れる（STATE_SNAPSHOTの土台）
  // 優先順位：opts直指定 → ctxPack（最終スタンプ） → userContext直指定 → null
  const pickedObservedStage =
    (opts as any)?.observedStage ??
    (opts as any)?.userContext?.ctxPack?.observedStage ??
    (opts as any)?.userContext?.observedStage ??
    null;

  const pickedDepthStage =
    pickedObservedStage ??
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
      ctxPack: ctxPackForUnderstanding,
      newQuotedReferenceSource:
        (opts as any)?.extra?.newQuotedReferenceSource === true ||
        (opts as any)?.extra?.ctxPack?.newQuotedReferenceSource === true ||
        (opts as any)?.ctxPack?.newQuotedReferenceSource === true ||
        (opts as any)?.userContext?.newQuotedReferenceSource === true ||
        (opts as any)?.userContext?.ctxPack?.newQuotedReferenceSource === true ||
        (opts as any)?.userContext?.meta?.extra?.newQuotedReferenceSource === true ||
        (opts as any)?.userContext?.meta?.extra?.ctxPack?.newQuotedReferenceSource === true ||
        ctxPackForUnderstanding?.newQuotedReferenceSource === true,



      // ✅ internalPack に history を二重投入しない（messages 側で lastTurns を渡している）
      historyText: '',

      seedInstruction,
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
      personDepthPattern: (opts as any)?.personDepthPattern ?? null,
      depthDelta: (opts as any)?.depthDelta ?? null,
      responseDepthStrategy: (opts as any)?.responseDepthStrategy ?? null,
      e_turn: pickedETurn,
      polarity: pickedPolarity,
      sa: pickedSa,

      flowDigest,
      flowTape,

      // ✅ 会話が流れるための3点（topic / goal / 反復）
      topicDigest,
      replyGoal,
      repeatSignal,

      // ✅ NEW: Writer向け短い再指示（INTERNAL PACKへ）
      exprDirectiveV1: exprDirectiveV1ForPack,
    } as any);


// =========================================================
// ✅ FLOW seedin（card完全削除版）
// - 常に flow をベースに扱う
// - inputKind に依存しない
// =========================================================

const disableFlowSeedin =
  String(process.env.IROS_DISABLE_FLOW_SEEDIN ?? '').trim() === '1';

const inputKindForSeed: string =
  String((opts as any)?.inputKind ?? '').toLowerCase();

if (!disableFlowSeedin) {
  const ctxPack0: any = (opts as any)?.userContext?.ctxPack ?? null;

  const ip = String(internalPack ?? '');

  const { buildFlowEngineResult } = await import('@/lib/iros/flow/flowEngine');

  const basedOn = String(userText ?? '').trim().slice(0, 80) || null;

  const ucExtra: any =
    (opts as any)?.userContext?.meta?.extra ??
    (opts as any)?.userContext?.extra ??
    null;

  const mirrorFlowV1Any: any =
    ctxPack0?.mirrorFlowV1 ??
    ucExtra?.ctxPack?.mirrorFlowV1 ??
    ucExtra?.mirrorFlowV1 ??
    null;

  const mirrorAny: any =
    ctxPack0?.mirror ??
    ucExtra?.ctxPack?.mirror ??
    ucExtra?.mirror ??
    mirrorFlowV1Any?.mirror ??
    null;

  const e_turn =
    (mirrorFlowV1Any?.mirror?.e_turn ??
      mirrorAny?.e_turn ??
      ctxPack0?.e_turn ??
      ucExtra?.ctxPack?.e_turn ??
      ucExtra?.e_turn ??
      null) as any;

  // ✅ FLOW_V2 の currentFlow に必要なのは pos/neg。
  // yin/yang は内向き/外向きの位相なので、ここでは pos/neg に変換しない。
  // 最優先は MirrorFlow が作った e_turn_v2.polarity。
  const polarity =
    (mirrorFlowV1Any?.mirror?.e_turn_v2?.polarity ??
      mirrorFlowV1Any?.mirror?.turnPolarity ??
      mirrorFlowV1Any?.mirror?.turn_polarity ??
      mirrorAny?.e_turn_v2?.polarity ??
      mirrorAny?.turnPolarity ??
      mirrorAny?.turn_polarity ??
      ctxPack0?.turnPolarity ??
      ctxPack0?.turn_polarity ??
      ucExtra?.ctxPack?.turnPolarity ??
      ucExtra?.ctxPack?.turn_polarity ??
      ucExtra?.turnPolarity ??
      ucExtra?.turn_polarity ??
      mirrorFlowV1Any?.mirror?.polarity ??
      mirrorAny?.polarity ??
      ctxPack0?.polarity ??
      ucExtra?.ctxPack?.polarity ??
      ucExtra?.polarity ??
      null) as any;

  const polarityNorm =
    (() => {
      const raw =
        typeof polarity === 'string'
          ? polarity
          : polarity?.e_turn_v2?.polarity ??
            polarity?.turnPolarity ??
            polarity?.turn_polarity ??
            polarity?.polarity ??
            polarity?.out ??
            polarity?.in ??
            null;

      const s = String(raw ?? '').trim().toLowerCase();

      if (s === 'pos' || s === 'positive' || s === '+' || s === 'plus') return 'pos';
      if (s === 'neg' || s === 'negative' || s === '-' || s === 'minus') return 'neg';

      // ✅ yin/yang は位相。FLOW_V2 の状態極性には使わない。
      return null;
    })();
  const sa =
    (ctxPack0?.sa ??
      ucExtra?.ctxPack?.sa ??
      ucExtra?.sa ??
      null) as any;

  const confidence =
    (mirrorFlowV1Any?.mirror?.confidence ??
      mirrorAny?.confidence ??
      ctxPack0?.confidence ??
      ucExtra?.ctxPack?.confidence ??
      ucExtra?.confidence ??
      null) as any;
    console.log(
      '[IROS/rephraseEngine][FLOW_CURRENT_INPUT]',
      JSON.stringify({
        traceId: debug.traceId,
        conversationId: debug.conversationId,
        userCode: debug.userCode,
        pickedDepthStage: pickedDepthStage ?? null,
        e_turn: e_turn ?? null,
        polarity: polarity ?? null,
        sa: sa ?? null,
        confidence: confidence ?? null,
        phase: ctxPack0?.phase ?? null,
      })
    );
    const parseFlowNowFromAny = (flowLike: unknown) => {
      if (flowLike && typeof flowLike === 'object') {
        const anyFlow = flowLike as any;

        const eTurnObj = String(
          anyFlow.e_turn ?? anyFlow.eTurn ?? anyFlow.energy ?? ''
        ).trim();
        const depthStageObj = String(
          anyFlow.depthStage ?? anyFlow.stage ?? ''
        ).trim();
        const polarityObj = String(
          anyFlow.polarity ?? anyFlow.polarityBand ?? ''
        ).trim().toLowerCase();

        if (eTurnObj && depthStageObj && polarityObj) {
          const pol =
            polarityObj === 'yang' || polarityObj === 'positive' || polarityObj === 'pos'
              ? 'pos'
              : polarityObj === 'yin' || polarityObj === 'negative' || polarityObj === 'neg'
                ? 'neg'
                : null;

          if (pol) {
            return {
              e_turn: eTurnObj as any,
              depthStage: depthStageObj as any,
              polarity: pol as any,
            };
          }
        }
      }

      const s = String(flowLike ?? '').trim();
      if (!s || s === '(null)' || s === 'null') return null;

      const m = s.match(/^(e[1-5])-([A-Za-z]\d+)-(pos|neg)$/i);
      if (!m) return null;

      return {
        e_turn: m[1].toLowerCase() as any,
        depthStage: m[2].toUpperCase() as any,
        polarity: m[3].toLowerCase() as any,
      };
    };

    const ctxPackFlow =
      (ctxPack0 as any)?.flow ??
      (ucExtra as any)?.ctxPack?.flow ??
      (ucExtra as any)?.flow ??
      null;

    const previousNow =
      parseFlowNowFromAny(ctxPackFlow?.current) ??
      parseFlowNowFromAny(ctxPackFlow?.currentFlow) ??
      parseFlowNowFromAny(ctxPackFlow?.previous) ??
      parseFlowNowFromAny(ctxPackFlow?.previousFlow) ??
      null;
      console.log(
        '[IROS/rephraseEngine][FLOW_PREV_CANDIDATES]',
        JSON.stringify({
          traceId: debug.traceId,
          conversationId: debug.conversationId,
          userCode: debug.userCode,
          ctx_flow_current: ctxPack0?.flow?.current ?? null,
          ctx_flow_currentFlow: ctxPack0?.flow?.currentFlow ?? null,
          ctx_flow_previous: ctxPack0?.flow?.previous ?? null,
          ctx_flow_previousFlow: ctxPack0?.flow?.previousFlow ?? null,
          uc_ctx_flow_current: ucExtra?.ctxPack?.flow?.current ?? null,
          uc_ctx_flow_currentFlow: ucExtra?.ctxPack?.flow?.currentFlow ?? null,
          uc_ctx_flow_previous: ucExtra?.ctxPack?.flow?.previous ?? null,
          uc_ctx_flow_previousFlow: ucExtra?.ctxPack?.flow?.previousFlow ?? null,
          extra_flow_current: ucExtra?.flow?.current ?? null,
          extra_flow_currentFlow: ucExtra?.flow?.currentFlow ?? null,
          extra_flow_previous: ucExtra?.flow?.previous ?? null,
          extra_flow_previousFlow: ucExtra?.flow?.previousFlow ?? null,
          previousNow,
        })
      );
    console.log(
      '[IROS/rephraseEngine][FLOW_INPUT_BEFORE_BUILD]',
      JSON.stringify({
        traceId: debug.traceId,
        conversationId: debug.conversationId,
        userCode: debug.userCode,

        pickedDepthStage,
        e_turn,
        polarityNorm,
        sa,
        confidence,
        phase: ctxPack0?.phase ?? null,

        mirrorFlowV1_mirror_e_turn_v2_polarity:
          mirrorFlowV1Any?.mirror?.e_turn_v2?.polarity ?? null,
        mirrorFlowV1_mirror_turnPolarity:
          mirrorFlowV1Any?.mirror?.turnPolarity ??
          mirrorFlowV1Any?.mirror?.turn_polarity ??
          null,
        mirrorFlowV1_mirror_polarity:
          mirrorFlowV1Any?.mirror?.polarity ?? null,

        mirrorAny_e_turn_v2_polarity:
          mirrorAny?.e_turn_v2?.polarity ?? null,
        mirrorAny_turnPolarity:
          mirrorAny?.turnPolarity ?? mirrorAny?.turn_polarity ?? null,
        mirrorAny_polarity:
          mirrorAny?.polarity ?? null,

        ctxPack_turnPolarity:
          ctxPack0?.turnPolarity ?? ctxPack0?.turn_polarity ?? null,
        ctxPack_polarity:
          ctxPack0?.polarity ?? null,

        ucExtra_ctxPack_turnPolarity:
          ucExtra?.ctxPack?.turnPolarity ??
          ucExtra?.ctxPack?.turn_polarity ??
          null,
        ucExtra_ctxPack_polarity:
          ucExtra?.ctxPack?.polarity ?? null,

        ucExtra_turnPolarity:
          ucExtra?.turnPolarity ?? ucExtra?.turn_polarity ?? null,
        ucExtra_polarity:
          ucExtra?.polarity ?? null,
      })
    );

    const flowResult = buildFlowEngineResult({
      current: {
        depthStage: (pickedDepthStage ?? null) as any,
        e_turn,
        polarity: polarityNorm,
        sa,
        basedOn,
        confidence,
        phase: (ctxPack0?.phase ?? null) as any,
      },
      previousNow,
    });

  // ✅ ctxPack に flow を反映（V2 minimal）
  if (ctxPack0) {
    ctxPack0.flow = {
      current: flowResult?.currentFlow ?? null,
      previous: flowResult?.previousFlow ?? null,
      futureRandom: flowResult?.futureFlowRandom ?? null,
      delta: flowResult?.delta ?? null,
      at: new Date().toISOString(),
    };
  }

  const flowSeedText = [
    'FLOW_V2 (DO NOT OUTPUT):',
    `current=${flowResult?.currentFlow?.id ?? '(null)'}`,
    `prev=${flowResult?.previousFlow?.id ?? '(null)'}`,
    `delta=${flowResult?.delta?.deltaType ?? '(null)'}`,
    `energy=${flowResult?.currentFlow?.energy ?? '(null)'}`,
    `futureRandom=${flowResult?.futureFlowRandom?.id ?? '(null)'}`,
  ].join('\n');

  internalPack = String(internalPack ?? '')
    .replace(/\n*FLOW180_SEED\s*\(DO NOT OUTPUT\):[\s\S]*$/i, '')
    .replace(/\n*FLOW\s*\(DO NOT OUTPUT\):[\s\S]*?(?=\n[A-Z0-9_ ]+\(DO NOT OUTPUT\):|$)/i, '')
    .replace(/\n*FLOW_V2\s*\(DO NOT OUTPUT\):[\s\S]*?(?=\n[A-Z0-9_ ]+\(DO NOT OUTPUT\):|$)/i, '')
    .trim();

  internalPack = [
    internalPack,
    flowSeedText,
  ]
    .filter(Boolean)
    .join('\n\n');

  console.log(
    '[IROS/rephraseEngine][FLOW_ENGINE_RESULT]',
    JSON.stringify({
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      currentFlow: flowResult?.currentFlow?.id ?? null,
      previousFlow: flowResult?.previousFlow?.id ?? null,
      futureFlowRandom: flowResult?.futureFlowRandom?.id ?? null,
      delta: flowResult?.delta ?? null,
      energy: flowResult?.currentFlow?.energy ?? null,
    })
  );

  console.log(
    '[IROS/rephraseEngine][FLOW_V2_SEEDIN]',
    JSON.stringify({
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      seed: flowSeedText,
    })
  );
}
// ✅ upstream 観測（internalPack 時点の事実だけを見る）
// - ここは messages 注入前なので injected 側は見ない
// - downstream の injected 実体確認は writerCalls / STATE_CUES 側ログを正とする
const canonicalOneLineSeedBlock = (() => {
  try {
    const flowV2Block =
      String(internalPack ?? '').match(
        /FLOW_V2\s*\(DO NOT OUTPUT\):[\s\S]*?(?=\n[A-Z0-9_ ]+\(DO NOT OUTPUT\):|$)/i
      )?.[0] ?? '';

    const current =
      (flowV2Block.match(/(?:^|\n)current=([^\n]+)/)?.[1] ?? '').trim();
    const prev =
      (flowV2Block.match(/(?:^|\n)prev=([^\n]+)/)?.[1] ?? '').trim();
    const delta =
      (flowV2Block.match(/(?:^|\n)delta=([^\n]+)/)?.[1] ?? '').trim();
      if (!current) return '';

      const [e_prev, layer_prev, polarity_prev] =
        prev && prev !== '(null)' ? prev.split('-') : [null, null, null];

      const [e_now, layer_now, polarity_now] =
        current && current !== '(null)' ? current.split('-') : [null, null, null];

      const sevenPattern = (() => {
        if (!prev || prev === '(null)') return 'start_anchor';
        if (
          layer_prev === layer_now &&
          polarity_prev === polarity_now &&
          (delta === 'same' || delta.length === 0)
        ) {
          return e_prev !== e_now ? 'energy_shift' : 'hold';
        }
        if (layer_prev !== layer_now && polarity_prev === polarity_now) {
          return 'layer_shift';
        }
        if (layer_prev === layer_now && polarity_prev !== polarity_now) {
          return 'polarity_shift';
        }
        if (layer_prev !== layer_now && polarity_prev !== polarity_now) {
          return 'turn_shift';
        }
        return 'structure_shift';
      })();

      const oneLineText = (() => {
        switch (sevenPattern) {
          case 'start_anchor':
            return 'いま新しい論点に重心が置かれた';
          case 'hold':
            return 'いま同じ論点に留まっている';
          case 'energy_shift':
            return '同じ論点のまま温度が変わっている';
          case 'layer_shift':
            return '見ている層が切り替わっている';
          case 'polarity_shift':
            return '受け取り方の向きが反転している';
          case 'turn_shift':
            return '視点と向きが同時に切り替わっている';
          default:
            return '関心の重心が別の論点へ移っている';
        }
      })();

      if (!oneLineText) return '';
    return [
      'SEED (DO NOT OUTPUT):',
      oneLineText,
    ].join('\n');
  } catch {
    return '';
  }
})();

console.log('[IROS/CANONICAL_ONE_LINE_SEED_BLOCK]', {
  traceId: debug.traceId,
  conversationId: debug.conversationId,
  userCode: debug.userCode,
  hasBlock: canonicalOneLineSeedBlock.length > 0,
  head: safeHead(canonicalOneLineSeedBlock, 160),
});

if (canonicalOneLineSeedBlock) {
  console.log('[IROS/CANONICAL_ONE_LINE_SEED_BLOCK][SKIPPED_PREPEND]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    reason: 'DISABLED_TO_PRESERVE_INTERNAL_PACK_STATE',
    head: safeHead(canonicalOneLineSeedBlock, 160),
  });
}

const __ip = String(internalPack ?? '');

const __tailN = 260;

const __pickBlockNear = (src: string, pattern: RegExp, span = 520) => {
  const idx = src.search(pattern);
  if (idx < 0) return '';
  const start = idx;
  const nextBlank = src.indexOf('\n\n', start);
  const end = nextBlank >= 0 ? nextBlank : Math.min(src.length, start + span);
  return src.slice(start, end);
};

const flow180SeedRaw =
  __ip.match(/FLOW180_SEED\s*\(DO NOT OUTPUT\):[\s\S]*?(?=\n[A-Z0-9_ ]+\(DO NOT OUTPUT\):|$)/i)?.[0] ??
  null;

console.log('[IROS/FLOW180]', flow180SeedRaw);

const flowSeedNearInternal =
  __pickBlockNear(__ip, /SEED\s*\(DO NOT OUTPUT\)\s*:/i, 520) ||
  __pickBlockNear(__ip, /FLOW_V2\s*\(DO NOT OUTPUT\)\s*:/i, 520) ||
  __pickBlockNear(__ip, /FLOW:\s*/i, 520);

console.log('[IROS/SEED]', flowSeedNearInternal);
const __patterns = {
  mirror: /FLOW_SEED_V1\b/i,
  flow: /FLOW180_SEED\s*\(DO NOT OUTPUT\)/i,
  flowV1: /FLOW:\s*\n/i,
};

const __traceId = String((opts as any)?.traceId ?? '');
const __conversationId = String((opts as any)?.conversationId ?? '');
const __userCode = String((opts as any)?.userCode ?? '');

const __messages = Array.isArray((opts as any)?.messages)
  ? ((opts as any).messages as any[])
  : [];

  const __assistantCandidates = __messages.filter(
    (m) => m?.role === 'assistant' && typeof m?.content === 'string'
  );

  const __assistantLast =
    __assistantCandidates.length > 0 ? __assistantCandidates[__assistantCandidates.length - 1] : null;

  const __injectedPack = String(__assistantLast?.content ?? '');

console.log('[IROS/rephraseEngine][STATE_SNAPSHOT_UPSTREAM]', {
  traceId: __traceId,
  conversationId: __conversationId,
  userCode: __userCode,
  pickedDepthStage,
  pickedPhase,
  pickedQCode,

  internalHasMirrorFlowSeed: __patterns.mirror.test(String(internalPack ?? '')),
  internalHasFlowSeed: __patterns.flow.test(String(internalPack ?? '')),

  upstreamHasMirrorFlowSeed: __patterns.mirror.test(__injectedPack),
  upstreamHasFlowSeed: __patterns.flow.test(__injectedPack),

  head: String(internalPack ?? '').slice(0, 800),
});
console.log('[IROS/rephraseEngine][STATE_SNAPSHOT_UPSTREAM_MSGSRC]', {
  traceId: __traceId,
  conversationId: __conversationId,
  userCode: __userCode,
  messagesLen: __messages.length,
  roles: __messages.map((m) => m?.role),
  lastAssistantHead:
    typeof __assistantLast?.content === 'string'
      ? __assistantLast.content.slice(0, 300)
      : '',
});
// - 目的：roles=[system,user] を回避し、会話の文脈だけを維持する
// ✅ 方針：writer へ userText を一切渡さない（turns/history/finalUserText から除外）
// - ただし「会話の役割列（assistant/user）」は保つ（user本文は伏せる）
const topicDigestForWriter =
  String(
    (opts as any)?.topicDigest ??
    (opts as any)?.userContext?.topicDigest ??
    (opts as any)?.userContext?.ctxPack?.topicDigest ??
    ''
  ).trim();

const topicDigestV2ForWriter =
  (opts as any)?.topicDigestV2 ??
  (opts as any)?.userContext?.topicDigestV2 ??
  (opts as any)?.userContext?.ctxPack?.topicDigestV2 ??
  null;

const conversationLineForWriter =
  String(
    (opts as any)?.conversationLine ??
    (opts as any)?.userContext?.conversationLine ??
    (opts as any)?.userContext?.ctxPack?.conversationLine ??
    ''
  ).trim();

// ✅ まず turnsForWriter を優先
// ✅ 無ければ ctxPack.turns を使う
// ✅ pastState recall（keyword / recent_topic）のときは
//    historyForWriter フォールバックを止めて、過去 assistant 文脈への引っ張られを防ぐ
const pastStateNoteTextForWriter = String(
  (opts as any)?.extra?.pastStateNoteText ??
  (opts as any)?.userContext?.pastStateNoteText ??
  (opts as any)?.userContext?.meta?.extra?.pastStateNoteText ??
  ''
).trim();

const pastStateTriggerKindForWriter = String(
  (opts as any)?.extra?.pastStateTriggerKind ??
  (opts as any)?.userContext?.pastStateTriggerKind ??
  (opts as any)?.userContext?.meta?.extra?.pastStateTriggerKind ??
  ''
).trim();

const shouldPreferPastStateRecall =
  !!pastStateNoteTextForWriter &&
  (pastStateTriggerKindForWriter === 'keyword' ||
    pastStateTriggerKindForWriter === 'recent_topic');

    const turnsPatternKeyForWriter = selectSlotPattern({
      line: String(
        (opts as any)?.meta?.extra?.presentationKind ??
          (opts as any)?.userContext?.meta?.extra?.presentationKind ??
          ''
      )
        .trim()
        .toLowerCase(),
      questionType: String(
        (opts as any)?.extra?.question?.questionType ??
          (opts as any)?.userContext?.question?.questionType ??
          (opts as any)?.userContext?.meta?.extra?.question?.questionType ??
          ''
      ).trim(),
      detailMode:
        (opts as any)?.ctxPack?.detailMode === true ||
        (opts as any)?.userContext?.ctxPack?.detailMode === true,
      followupText: String((opts as any)?.userText ?? '').trim(),
      userText: String((opts as any)?.userText ?? '').trim(),
      targetLabel: null,
      hasPriorDiagnosis: false,
    });

    const rawTurnsForWriter =
      shouldPreferPastStateRecall || turnsPatternKeyForWriter === 'DECLARATION_RESONANCE_V1'
        ? (
            (opts as any)?.turnsForWriter ??
            (opts as any)?.messages ??
            (opts as any)?.userContext?.turnsForWriter ??
            (opts as any)?.userContext?.ctxPack?.turnsForWriter ??
            (opts as any)?.userContext?.ctxPack?.turns ??
            (opts as any)?.userContext?.turns ??
            lastTurnsSafe ??
            []
          )
        : (
            (opts as any)?.turnsForWriter ??
            (opts as any)?.messages ??
            (opts as any)?.userContext?.turnsForWriter ??
            (opts as any)?.userContext?.ctxPack?.turnsForWriter ??
            (opts as any)?.userContext?.ctxPack?.turns ??
            (opts as any)?.userContext?.turns ??
            (opts as any)?.userContext?.ctxPack?.historyForWriter ??
            (opts as any)?.userContext?.historyForWriter ??
            lastTurnsSafe ??
            []
          );

console.log('[IROS/PAST_STATE][turnsForWriter_policy]', {
  traceId: (opts as any)?.traceId ?? (opts as any)?.extra?.traceId ?? null,
  shouldPreferPastStateRecall,
  pastStateTriggerKindForWriter: pastStateTriggerKindForWriter || null,
  hasPastStateNoteText: !!pastStateNoteTextForWriter,
  rawTurnsIsArray: Array.isArray(rawTurnsForWriter),
  rawTurnsLen: Array.isArray(rawTurnsForWriter) ? rawTurnsForWriter.length : null,
});

// ✅ 末尾だけ使う（LAST_TURNS_PICK と整合）
const MAX_TURNS_FOR_WRITER = 6;
const rawTail = Array.isArray(rawTurnsForWriter)
  ? rawTurnsForWriter.slice(-MAX_TURNS_FOR_WRITER)
  : [];

  const askBackAllowedForWriter = (() => {
    const p =
      (opts as any)?.extra?.question?.outputPolicy ??
      (opts as any)?.userContext?.question?.outputPolicy ??
      (opts as any)?.userContext?.meta?.extra?.question?.outputPolicy ??
      null;
    return p?.askBackAllowed === true;
  })();

  const turnsForWriterBase: any[] = rawTail
    .map((t: any) => {
      const role =
        t?.role === 'user'
          ? 'user'
          : t?.role === 'assistant'
            ? 'assistant'
            : null;
      if (!role) return null;

      const content = String(t?.content ?? '').trim();
      if (!content) return null;

      return { role, content };
    })
    .filter(Boolean);

  // ✅ latest user の正本は writerCalls.ts の args.userText に一本化する
  // - turnsForWriter には「履歴だけ」を渡す
  // - 末尾が user の場合は current turn 混入の可能性が高いため 1件落とす
  const turnsForWriter: any[] =
    turnsForWriterBase.length > 0 &&
    turnsForWriterBase[turnsForWriterBase.length - 1]?.role === 'user'
      ? turnsForWriterBase.slice(0, -1)
      : turnsForWriterBase;

  console.log('[IROS/rephraseEngine][TURNS_FOR_WRITER_SHAPE]', {
    traceId: debug.traceId ?? null,
    conversationId: debug.conversationId ?? null,
    userCode: debug.userCode ?? null,
    askBackAllowedForWriter,
    rawTailLen: Array.isArray(rawTail) ? rawTail.length : 0,
    baseLen: turnsForWriterBase.length,
    finalLen: turnsForWriter.length,
    roles: turnsForWriter.map((t: any) => t?.role ?? null),
  });

// ✅ buildFirstPassMessages が持っている “会話線” をちゃんと渡す
// ✅ さらに ctxPack/extra を渡して writerCalls 側の COORD/CARDS 注入を確実に発火させる
const ctxPackForWriter =
  (opts as any)?.ctxPack ??
  (opts as any)?.userContext?.ctxPack ??
  (opts as any)?.userContext?.ctxPackV1 ??
  null;

if (ctxPackForWriter && typeof ctxPackForWriter === 'object') {
  const textForDiagnosisFollowup = String((opts as any)?.userText ?? '').trim();

  const hasIrDiagnosisContext =
    (ctxPackForWriter as any)?.irMeta &&
    typeof (ctxPackForWriter as any).irMeta === 'object';

  const asksDiagnosisFollowup =
    /診断内容|診断結果|さっきの診断|ir診断|詳しく|詳細|深く|具体的に/u.test(
      textForDiagnosisFollowup,
    );

  const isDiagnosisFollowupCtx =
    (ctxPackForWriter as any)?.diagnosisFollowup === true ||
    String((ctxPackForWriter as any)?.continuityKind ?? '').trim() ===
      'diagnosis_followup' ||
    (
      (ctxPackForWriter as any)?.detailMode === true &&
      hasIrDiagnosisContext &&
      asksDiagnosisFollowup
    );

  if (isDiagnosisFollowupCtx) {
    (ctxPackForWriter as any).diagnosisFollowup = true;
    (ctxPackForWriter as any).followupKind =
      typeof (ctxPackForWriter as any).followupKind === 'string' &&
      String((ctxPackForWriter as any).followupKind).trim()
        ? String((ctxPackForWriter as any).followupKind).trim()
        : 'concretize';
    (ctxPackForWriter as any).continuityKind = 'diagnosis_followup';
  }
}

// question の正本をここで一度だけ決める
const primaryQuestionForWriter =
  (ctxPackForWriter?.question &&
  typeof ctxPackForWriter.question === 'object')
    ? ctxPackForWriter.question
    : ((opts as any)?.userContext?.question &&
        typeof (opts as any).userContext.question === 'object')
      ? (opts as any).userContext.question
      : ((opts as any)?.extra?.question &&
          typeof (opts as any).extra.question === 'object')
        ? (opts as any).extra.question
        : ((opts as any)?.userContext?.meta?.extra?.question &&
            typeof (opts as any).userContext.meta.extra.question === 'object')
          ? (opts as any).userContext.meta.extra.question
          : ((opts as any)?.meta?.extra?.question &&
              typeof (opts as any).meta.extra.question === 'object')
            ? (opts as any).meta.extra.question
            : null;

const primaryQuestionSource =
  (ctxPackForWriter?.question &&
  typeof ctxPackForWriter.question === 'object')
    ? 'ctxPack.question'
    : ((opts as any)?.userContext?.question &&
        typeof (opts as any).userContext.question === 'object')
      ? 'userContext.question'
      : ((opts as any)?.extra?.question &&
          typeof (opts as any).extra.question === 'object')
        ? 'extra.question'
        : ((opts as any)?.userContext?.meta?.extra?.question &&
            typeof (opts as any).userContext.meta.extra.question === 'object')
          ? 'userContext.meta.extra.question'
          : ((opts as any)?.meta?.extra?.question &&
              typeof (opts as any).meta.extra.question === 'object')
            ? 'meta.extra.question'
            : 'none';

try {
  console.log('[IROS/rephraseEngine][QUESTION_SOURCE_CHECK]', {
    traceId: debug.traceId ?? null,
    conversationId: debug.conversationId ?? null,
    userCode: debug.userCode ?? null,
    primary_source: primaryQuestionSource,
    primary_question: primaryQuestionForWriter,
  });
} catch {}
try {
  console.log('[IROS/rephraseEngine][CTXPACK_FOR_WRITER_PICK]', {
    traceId: debug.traceId ?? null,
    conversationId: debug.conversationId ?? null,
    userCode: debug.userCode ?? null,

    opts_ctxPack_keys:
      (opts as any)?.ctxPack && typeof (opts as any).ctxPack === 'object'
        ? Object.keys((opts as any).ctxPack)
        : [],

    userContext_ctxPack_keys:
      (opts as any)?.userContext?.ctxPack &&
      typeof (opts as any).userContext.ctxPack === 'object'
        ? Object.keys((opts as any).userContext.ctxPack)
        : [],

    picked_keys:
      ctxPackForWriter && typeof ctxPackForWriter === 'object'
        ? Object.keys(ctxPackForWriter)
        : [],

    picked_hasHistoryForWriter:
      !!(ctxPackForWriter && Array.isArray((ctxPackForWriter as any).historyForWriter)),

    picked_historyForWriter_len:
      ctxPackForWriter && Array.isArray((ctxPackForWriter as any).historyForWriter)
        ? (ctxPackForWriter as any).historyForWriter.length
        : 0,
  });
} catch {}
const continuityKindForWriter =
  String(
    (opts as any)?.continuityKind ??
      (opts as any)?.userContext?.continuityKind ??
      (opts as any)?.userContext?.ctxPack?.continuityKind ??
      '',
  ).trim() || null;

const suppressContinuationConfirm =
  continuityKindForWriter === 'continuation' ||
  continuityKindForWriter === 'same_line';

const systemPromptForWriter = [
  systemPrompt,
  suppressContinuationConfirm
    ? 'CONTINUITY_RULE (DO NOT OUTPUT): continuation / same_line のとき、「前の話の続きで進めてよいですか？」「前の続きで進めますか？」などの確認文を出さない。継続前提でそのまま本題に入る。'
    : '',
]
  .filter(Boolean)
  .join('\n\n');

  const slotDecisionForFirstPass = computeSlotDecisionFromEngine({
    depthStage:
      String((ctxPackForWriter as any)?.depthStage ?? '').trim() || null,

      questionType: (() => {
        const s = String((opts as any)?.userText ?? '').trim();

        if (/意図|階層|構造|仕組み|関係|違い|配置|流れ|構成|背景|文脈|位置づけ/u.test(s)) {
          return 'structure';
        }

        if (/意味|なぜ|どういうこと|どう受け止め|どう読める/u.test(s)) {
          return 'meaning';
        }

        if (/どうしたい|どう進む|どこへ向かう|何のため/u.test(s)) {
          return 'intent';
        }

        if (/ありますか|登場しますか|出てきますか|書かれていますか|記されていますか|載っていますか|あるか|ないか|本当ですか|事実ですか/u.test(s)) {
          return 'truth';
        }

        if (/とは/u.test(s) && !/意図|階層|構造|仕組み|関係|違い|配置|流れ|構成|背景|文脈|位置づけ|意味/u.test(s)) {
          return 'truth';
        }

        return null;
      })(),

    goalKind:
    String(
      (ctxPackForWriter as any)?.goalKind ??
      (ctxPackForWriter as any)?.targetKind ??
      ''
    ).trim() || null,

    deltaType: (() => {
      const packForFirstPass = String(internalPack ?? '');

      const fromFlow180 =
        packForFirstPass
          ? String(
              packForFirstPass.match(/FLOW180\s*\(DO NOT OUTPUT\):[\s\S]*?deltaType=([^\n]+)/)?.[1] ?? ''
            ).trim()
          : '';
      if (fromFlow180) return fromFlow180;

      const fromState =
        packForFirstPass
          ? String(
              packForFirstPass.match(/STATE:\n[\s\S]*?deltaType=([^\n]+)/)?.[1] ?? ''
            ).trim()
          : '';
      if (fromState) return fromState;

      const flowDeltaObj = (ctxPackForWriter as any)?.flow?.delta;
      if (flowDeltaObj && typeof flowDeltaObj === 'object') {
        const v = String((flowDeltaObj as any)?.deltaType ?? '').trim();
        if (v) return v;
      }

      const flowDeltaType = String((ctxPackForWriter as any)?.flow?.deltaType ?? '').trim();
      if (flowDeltaType) return flowDeltaType;

      const topDeltaType = String((ctxPackForWriter as any)?.deltaType ?? '').trim();
      if (topDeltaType) return topDeltaType;

      return null;
    })(),

  returnStreak: (() => {
    const rsFromFlow = (ctxPackForWriter as any)?.flow?.returnStreak;
    if (typeof rsFromFlow === 'number' && Number.isFinite(rsFromFlow)) {
      return rsFromFlow;
    }

    const rsTop = (ctxPackForWriter as any)?.returnStreak;
    if (typeof rsTop === 'number' && Number.isFinite(rsTop)) {
      return rsTop;
    }

    return 0;
  })(),

  continuityKind:
    String((ctxPackForWriter as any)?.continuityKind ?? '').trim() || null,
  });
  function buildDetailPatternWriterDirectives(
    patternKey: string
  ): Record<string, unknown> {
    const key = String(patternKey ?? '').trim();

    const questionTypeForBomb = (() => {
      const explicit = String(
        (opts as any)?.userContext?.question?.questionType ??
          (opts as any)?.userContext?.meta?.extra?.question?.questionType ??
          (opts as any)?.ctxPack?.question?.questionType ??
          (opts as any)?.meta?.extra?.question?.questionType ??
          ''
      )
        .trim()
        .toLowerCase();

      if (
        explicit === 'meaning' ||
        explicit === 'structure' ||
        explicit === 'intent' ||
        explicit === 'truth'
      ) {
        return explicit;
      }

      const s = String(
        (opts as any)?.userText ??
          (opts as any)?.followupText ??
          (opts as any)?.inputText ??
          ''
      ).trim();

      if (
        /どうしたら良い|どうしたらいい|どうすれば良い|どうすればいい|良い方法|いい方法|方法はありますか|どう進めたら良い|どう進めたらいい|どう進めれば良い|どう進めればいい|最終的にどうしたら|最終的にどうすれば|協調する方法|打ち解けるには/u.test(
          s
        )
      ) {
        return 'intent';
      }

      if (
        /違い|共通点|比較|比べる|相性|組み合わせ|関係性|関わり合い|問題点|協調|理解点|打ち解ける|どう見えやすい|どう映りやすい|ぶつかりやすい|すれ違い|誤解|なぜぶつかる|何がズレる|どこでズレる/u.test(
          s
        )
      ) {
        return 'structure';
      }

      if (/意味|なぜ|どういうこと|どう受け止め|どう読める/u.test(s)) {
        return 'meaning';
      }

      if (/とは|教えて|ありますか|ですか|あるか|ないか/u.test(s)) {
        return 'truth';
      }

      return null;
    })();

    const goalKindForBomb = String(
      (opts as any)?.goalKind ??
        (opts as any)?.userContext?.goalKind ??
        (opts as any)?.userContext?.ctxPack?.goalKind ??
        (opts as any)?.ctxPack?.goalKind ??
        (opts as any)?.ctxPack?.replyGoal?.kind ??
        ''
    ).trim();

    const methodTextForBomb = String(
      (opts as any)?.userText ??
        (opts as any)?.followupText ??
        (opts as any)?.inputText ??
        ''
    ).trim();

    const compareTextForBomb = String(
      (opts as any)?.userText ??
        (opts as any)?.followupText ??
        (opts as any)?.inputText ??
        ''
    ).trim();

    const isMeaningUncoverBomb =
      key === 'NORMAL_DETAIL_V1' &&
      questionTypeForBomb === 'meaning' &&
      goalKindForBomb === 'uncover';

    const isIntentMethodBomb =
      key === 'NORMAL_DETAIL_V1' &&
      questionTypeForBomb === 'intent' &&
      /どうしたら良い|どうしたらいい|どうすれば良い|どうすればいい|良い方法|いい方法|方法はありますか|どう進めたら良い|どう進めたらいい|どう進めれば良い|どう進めればいい|最終的にどうしたら|最終的にどうすれば/u.test(
        methodTextForBomb
      );

      const isCompareStructureBomb =
      key === 'NORMAL_DETAIL_V1' &&
      (questionTypeForBomb === 'structure' ||
        questionTypeForBomb === 'intent' ||
        questionTypeForBomb === 'truth') &&
      /違い|共通点|比較|比べる|相性|組み合わせ|関係性|関わり合い|問題点|協調|協調する方法|理解点|打ち解ける|打ち解けるには|どう見えやすい|どう映りやすい|ぶつかりやすい|すれ違い|誤解|なぜぶつかる|何がズレる|どこでズレる|原因|何が原因|原因になりやすい|ぶつかる原因/u.test(
        compareTextForBomb
      );

    const relationshipDetailMaterial = (() => {
      if (!isCompareStructureBomb) return null;

      try {
        const relationshipMemory =
          (opts as any)?.ctxPack?.relationshipMemory ??
          (opts as any)?.userContext?.ctxPack?.relationshipMemory ??
          (opts as any)?.userContext?.relationshipMemory ??
          null;

        const flow =
          (opts as any)?.ctxPack != null && typeof (opts as any)?.ctxPack === 'object'
            ? {
                delta: (opts as any)?.ctxPack?.flow?.delta ?? null,
                currentStage: (opts as any)?.ctxPack?.primaryStage ?? null,
                observedStage: (opts as any)?.ctxPack?.observedStage ?? null,
                qCode: (opts as any)?.ctxPack?.qCode ?? null,
                emotionalTemperature: (opts as any)?.ctxPack?.emotionalTemperature ?? null,
                continuityKind: (opts as any)?.ctxPack?.continuityKind ?? null,
                relationFocus: (opts as any)?.ctxPack?.relationFocus ?? null,
                mirrorFlowV1: (opts as any)?.ctxPack?.mirrorFlowV1 ?? null,
              }
            : null;

        const analysis = buildRelationshipAnalysis({
          userText: compareTextForBomb,
          relationshipMemory,
          flow,
        });

        return analysisToDetailPattern(analysis);
      } catch (error) {
        console.log('[IROS/REL_ANALYSIS][BUILD_FAILED]', {
          traceId: (opts as any)?.debug?.traceId ?? null,
          conversationId: (opts as any)?.debug?.conversationId ?? null,
          userCode: (opts as any)?.debug?.userCode ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();

    if (
      key !== 'IR_DETAIL_V1' &&
      key !== 'NORMAL_DETAIL_V1' &&
      key !== 'NORMAL_RESONANCE_V1' &&
      key !== 'NORMAL_PRACTICAL_RESONANCE_V1' &&
      key !== 'DECLARATION_RESONANCE_V1' &&
      key !== 'NORMAL_COMPRESSED_V1'
    ) {
      return {};
    }

    if (key === 'NORMAL_COMPRESSED_V1') {
      return {
        pattern_key: key,
        pattern_mode: 'normal_compressed',
        bodyStyle: {
          preferBlockSplit: true,
          minBlocks: 1,
          maxBlocks: 3,
          maxSentencesPerBlock: 4,
          minSentences: 2,
          maxSentences: 12,
        },
        writeConstraints: [
          // --- 構造 ---
          'normal_compressed では、必ず4つの段落で返す',
          '段落順は OBS → SHIFT → NEXT → SAFE に固定する',

          // --- 各段落の役割 ---
          'OBSは今いちばん前にある状態だけを書く',
          'SHIFTは流れが止まっている一点だけを書く',
          'NEXTは「残っているのは〜」で始めない。まだ決める前に、今どこまで確認すればよいかを日常語で短く書く',
          'SAFEは許可・励まし・安心づけにしない。抽象語で余韻に逃がさず、読んだ人が分かる日常語で、まだ決めきれていない点・今確認できている点を短く返す',
          'SAFEは「〜していい」「無理に〜しなくていい」「十分です」「落ち着いていきます」で閉じない',

          // --- 基本ルール ---

          // --- 基本ルール ---
          '説明せず自然文で書く',
          'seedにない新しい意味・具体軸を足さない',
          'emotion_inner / emotion_need がseedにある場合、それは入力に基づく感情材料としてOBSまたはSHIFTに自然に滲ませてよい。ただしラベル名は本文に出さない',
          'emotion_inner / emotion_need がseedにある場合でも、OBSの先頭は感情の言い換えだけで開始しない',
          'emotion_inner / emotion_need の文を、そのまま単独文として本文に出さない。特に「〜がつらい」「〜したい」「〜が怖い」はユーザー感情の断定として出さず、質問への定義文に薄く反映する',
          'OBSの最初の一文は、質問への定義・軸・見取り図を短く返す',
          'emotion_inner / emotion_need は、定義のあとに必要な範囲で自然に反映する',
          '具体例を求められた場合は、OBSで定義し、その後に3〜5個の具体例を出す',
          '具体例を求められた場合は、「必要なら例を出せます」で終えず、その場で具体例を出す',
          '「どう通すか」「どう通す」の具体例では、単なる日本語用例ではなく、感情・受け取ったもの・判断・意図をどの出口に変えるかで例を出す',
          '「どう通すか」「どう通す」の具体例では、「話を通す」「申請を通す」「予定を通す」だけに寄せない',
          '「どう通すか」「どう通す」の具体例では、「言葉として通す」「行動として通す」「作品として通す」「境界として通す」「意図として通す」「受け取らないことで通す」のような出口分類を優先する',
          '具体例は番号ではなく「- 」の箇条書きで独立行にする',
          '具体例の箇条書きは、1項目1行で「- 見出し：説明。例: ...」の形にする',
          '同じ核を、日常語で分かりやすく言い換えて深める',
          '質問しない。ただし、ユーザー状態に合う次の見取り図・分岐・扱い方は、SAFEで1文だけ出してよい',
          'SAFEでは「必要なら〜できます」「もっと知りたいですか？」より、「次に分けるなら〜で見られます」「ここから見るなら〜が分かりやすいです」のような入口提示を優先する',

          // --- 意味制御（最重要） ---
          'SAFE以外で意味を収束させない',
          '原因・理由・構造を推測しない',
          '入力にない関係・対立・感情を作らない',

          // --- 禁止表現（まとめ） ---
          '助言・方向づけ・励ましを書かない',
          '評価・肯定・安心させる表現を書かない',
          '未来予測や変化の示唆を書かない',
          '「〜と思います」「〜かもしれません」を使わない',
          '「だから」で文を始めない。必要なら「そのため」「ここでは」「今は」に言い換える',
          '断定的なまとめ表現で締めない（〜だけです等）',
        ]
      };
    }

    if (key === 'NORMAL_PRACTICAL_RESONANCE_V1') {
      return {
        pattern_key: key,
        pattern_mode: 'normal_practical_resonance',
        pattern_block_order: 'practical_resonance',
        block_current_state:
          '1段落目は、まず結論を短く出す。気持ちは受け止めるが、比喩や余韻を先に置かない。ユーザーが今どう動けばいいか分かる入り方にする。ただし resolvedAsk.askType が relationship_last_contact_answer の場合は、ユーザー発話そのものを意味づけせず、直前の確認質問への回答として扱う。ユーザー側なら「あなたから送ったんですね。」、相手側なら「相手からだったんですね。」のように、確認結果から自然に始める。',
        block_state_action:
          '2段落目は、すぐ送る話に固定せず、ユーザーの中で何が揺れているかを日常語で整理する。送信文は、ユーザーが「どう送る」「文を作って」「なんて送ればいい」と求めた時だけ出す。',
        block_caution:
          '3段落目は、禁止や命令で締めず、不安がそのまま相手に向かいすぎる時に何が起きやすいかを日常語で映す。相手の本音は断定しない。',
        block_closing_line:
          '最後は命令形で止めない。状況が不足している相談では、短い状況確認質問を1つだけ置いてよい。状況が足りている場合は、次に話せる現実の入口を自然文で残す。resolvedAsk.askType が relationship_last_contact_answer の場合は、「送ってからどれくらい経っていますか？」のように、次の状況が分かる確認質問へつなげてよい。',
        bodyStyle: {
          preferBlockSplit: true,
          minBlocks: 3,
          maxBlocks: 4,
          maxSentencesPerBlock: 3,
          minSentences: 4,
          maxSentences: 10,
        },
        writeConstraints: [
          'normal_practical_resonance では、最初に結論を短く出す',
          '深く読むが、普通の言葉に翻訳する',
          'MuSelfナレッジは本文材料ではなく、返答方向の制御だけに使う',
          '恋愛・人間関係では、相手攻略だけで終わらせず、必要に応じてユーザー自身の反応へ日常語で戻す',
          '自己受容・MS理論・ニコイチ問題などの専門語は、ユーザーが学びや根本原因を求めた時以外は出さない',
          '深度が浅い時は、背景理論を説明せず、寄り添いと揺れている点の整理を優先する',
          '詩的な比喩・余韻・抽象語を先に出さない',
          '「場」「位置」「反転」「線」「糸」「静かに」「立ち位置が細くなる」「届き方が細くなる」などの抽象表現で締めない',
          '「位置」は使わず、「不安が強く出すぎない」「自分を崩さない」「重く伝わりすぎない」のように日常語へ言い換える',
          '「細くなる」は使わず、「重く伝わりやすい」「相手が返しにくくなる」「あとで自分が苦しくなる」のように言い換える',
          '恋愛・人間関係の不安では、具体行動を常時出さない。まず寄り添い、何が揺れているかを日常語で映す',
          '送信文は、ユーザーが「どう送る」「文を作って」「なんて送ればいい」と明示した時だけ出す',
          '必要な時だけ問いで整理する。ただし質問で丸投げせず、「返事が欲しいのか、安心を確かめたいのか」のように選択の形で示す',
          '送信文を出す場合だけ、長くしない。責めない。返事を急かしすぎない',
          '長文・連投・確認の追撃は勧めないが、「やめてください」「止めてください」の命令形にしない',
          '相手の本音・愛情・未練・浮気・脈あり脈なしを断定しない',
          '説明を増やしすぎない。受け止め → 揺れている点の整理 → 必要な時だけ問いの整理、の順にする',
          '質問だけで丸投げしない。ただし状況が不足している相談では、短い状況確認質問を1つだけ最後に置いてよい',
          'resolvedAsk.askType=relationship_last_contact_answer の場合、ユーザーの「わたしです」「わたしからです」「最後はわたしからです」を自己表明として解釈しない。直前の確認質問への回答として扱い、「あなたから送ったんですね。」または「相手からだったんですね。」で受ける',
          'resolvedAsk.askType=relationship_last_contact_answer の場合、「あなたの『わたしです』」「自分を差し出す」「自分の輪郭」「自分のことだと言い切れた」は使わない',
          '「必要なら〜できます」で逃げず、必要な時だけ問いの整理をその場で出す',
          '「十分」「十分です」「それで十分です」は絶対に使わない',
          '「足ります」「これで足ります」「それで足ります」「短い一通だけにしてください」「ここで止めてください」は使わない',
          '「自分を崩さない」「自分も崩れにくい」は使わない。必要なら「あとで後悔しにくい」「不安をぶつけすぎない」「相手が返しやすい形にする」に言い換える',
          '送信例の後は「これで足ります」「ここで止めてください」「これ以上は足さないでください」と書かない',
          '締めは命令形にしない。「今見るのは、彼を諦めるかどうかではなく、返事が欲しいのか、安心を確かめたいのかです」のように、選択を整理する形で閉じる',
        ],
      };
    }

    if (key === 'DECLARATION_RESONANCE_V1' || key === 'NORMAL_RESONANCE_V1') {
      return {
        pattern_key: key,
        pattern_mode:
          key === 'DECLARATION_RESONANCE_V1'
            ? 'declaration_resonance'
            : 'normal_resonance',
        pattern_block_order:
          'free_resonance',
        block_state_surface:
          '必要な文量だけで、いま大事なところを日常語で書く。説明を増やすより、ユーザーが受け取りやすい言葉にする。',
        bodyStyle: {
          preferBlockSplit: true,
          minBlocks: 2,
          maxBlocks: 5,
          maxSentencesPerBlock: 3,
          minSentences: 2,
          maxSentences: 9,
        },
        writeConstraints: [
          `${
            key === 'DECLARATION_RESONANCE_V1'
              ? 'declaration_resonance'
              : 'normal_resonance'
          } では、段落数を固定しない`,
          'state_surface / state_weight / state_open_edge / state_residue の順番を固定しない',
          '必要なものだけを自然文に統合する',
          '大事なところを、むずかしい言葉にせず日常語で書く',
          'まとめだけ、助言だけ、安心させるだけで終わらせない',

          // ✅ 革新共鳴
          '因果説明を増やさない',
          '「〜だから」「〜すると」「〜していく」を減らす',
          '「近づく」「深まる」「届く」「変わる」で締めない',
          'いま必要な大事なところを、ふつうの言葉で返す',
          '無理に結論にせず、今わかる範囲だけを返してよい',
          '一番伝えたい一文を優先し、まわりの説明を増やしすぎない',

          // ✅ resonateは削るのではなく、最初から状態文だけにする
          'normal_resonanceでは、2〜4文に固定しない。恋愛・怒り・不安・限界・関係相談では、必要な文量で2〜5段落まで自然に返す',
          'normal_resonanceでは、基本は観測や共鳴を優先する。恋愛・怒り・不安・限界・関係相談でも、送信文や行動指示を常時出さず、まず何が揺れているかを日常語で映す',
          'normal_resonanceでは、状態を見るだけで終わらせず、ユーザーが心の中で本当に求めていることを、受け取りやすい言葉で返す',
          'normal_resonanceでは、「穴」「空白」「気配」「ほどける」などの抽象語をそのまま出しすぎない。恋愛・人間関係・浮気・夫婦・不安・怒り・限界では、安心感・寂しさ・逃げ場・不安・やさしさ・ほっとしたい気持ちなど、実際の感情に置き換える',
          'normal_resonanceでは、ユーザーが「わからない」「どうしたらいい」と言った場合は、深めるより先に、日常語でやさしく分ける',
          'normal_resonanceでは、「〜していい」「〜しなくていい」「〜なくていい」で薄めない。ただし、ユーザーを守るための短い境界線は自然な会話語で返してよい',
          'normal_resonanceでは、「十分です」「それで十分」「そのままでいい」「そのまま大事にしていい」「無理に広げなくていい」「急いで形にしなくていい」「説明を足さなくていい」で閉じない',
          'normal_resonanceで短い同意・納得入力を受けた場合は、入力語そのものを評価しない。直前assistantの核心を1つ受けて、「そこが見えたなら、次に見るのは〜」のように次の方向を日常語で返す',
          'normal_resonanceで「確かに」「なるほど」「それです」系に返す場合は、受け止めで止めず、直前の話題に接続する。例: 「そこです。待てなさの中心は、返事そのものより、曖昧なまま置かれる感じに反応しているところです」',
          'normal_resonanceでは、「分かったことを保留する」より、「見えた核心から次に見る方向を示す」ことを優先する',
          'normal_resonanceでは、「必要なら」で逃げない。ただし恋愛・人間関係の不安では、ユーザーが「どう送る」「文を作って」「なんて送ればいい」と明示した時だけ送信文を出す',
          'normal_resonanceでは、「正しいです」「合っています」「近いです」「自然です」で判定しない',
          'normal_resonanceでは、「合図」「〜に近い」「〜すると」「〜が抜ける」で説明しない',
          'normal_resonanceでは、「無理に〜すると」「言い切らないほうが」「〜ほうが守られる」を使わない',
          'normal_resonanceでは、「〜が残っている」「〜が前に出ている」「〜の手前にある」の形へ固定しない。必要なら直接文・宣言文・本音の表面化で返す',
          'normal_resonanceでは、比較文を無理に「残っている」構文へ変換しない。文脈上自然なら、直接文として返す',
          'normal_resonanceでは、共鳴が成立している場合、説明用の型よりも届く言葉を優先する',
          'normal_resonanceでは、比較・宣言・短い断定を必要に応じて許可する。ただし根拠のない決めつけにはしない',
          'normal_resonanceでは、原因説明を増やしすぎない。ただし、恋愛・怒り・不安・限界では、気持ちを受ける → 本当に求めていることを日常語にする → 必要な時だけ問いを分ける、まで自然に進んでよい',
          'normal_resonanceでは、状態文だけでなく、気持ちが少し前に進む文・本当に言いたかったことを戻す文・短い言い切りも許可する',
          'normal_resonanceでは、最後の1文を観測文に固定しない。必要なら、受け止め・短い言い切り・本当に求めていることの言葉で閉じる',
        ],
      };
    }

    return {
      pattern_key: key,
      pattern_mode: key === 'NORMAL_DETAIL_V1' ? 'normal_detail' : 'diagnosis_detail',

      block_current_state:
        relationshipDetailMaterial?.block_current_state ??
        (isCompareStructureBomb
          ? '1段落目の1文目は、二者それぞれの説明から入らず、この関係の核を先に置く。最初に「この二人は何がぶつかりやすい関係か」「どういう組み合わせか」が一文で立つようにする。A/Bの性格紹介ではなく、関係の輪郭が最初に見える自然文を優先する。たとえば「この二人は、強さの出しどころがぶつかりやすい関係です。」「この組み合わせは、近づき方の違いがそのままズレになりやすいです。」のように、関係の核が先に立つ書き方にする。'
          : isIntentMethodBomb
            ? '1段落目の1文目は、いま何が決めきれずに止まっているかをそのまま置く。説明や要約にしない。方法の話に飛ぶ前に、いま詰まっている一点を自然文で出す。'
            : '1段落目の1文目は、今いちばん前にあるものをそのまま言葉にする。説明や要約にしない。判断や整理より先に、その場に立っている核心を自然文で出す。見えている状態を薄めず、最初の1文で軸が立つ書き方を優先する。'),

      block_misrecognition_negation:
        relationshipDetailMaterial?.block_misrecognition_negation ??
        (isCompareStructureBomb
          ? '1段落目の2文目は、そのズレを未熟さや配慮不足として片づけない。説明や弁護にしない。欠点ではなく、力を出すタイミングと向ける先が噛み合いにくいだけだと自然に伝わる一文にする。たとえば「遠慮がないというより、引く場所が重なりにくいです。」「冷たいというより、見ている場所がずれているだけです。」のように、誤読を一段読み替える強さを優先する。'
          : isIntentMethodBomb
            ? '1段落目の2文目は、その詰まりを弱さや迷いとして片づけない。説得や慰めにしない。決めたいのに決めきれないことを、そのまま受けてよい形で置く。'
            : '1段落目の2文目は、その状態を弱さや迷いとして片づけない。訂正や解説にしない。ひとつに決めきれない感じを、そのままやわらかく受け取る。文頭は前の文を受ける流れの語で始め、言い聞かせる調子にしない。'),

      block_structural_reframe:
        relationshipDetailMaterial?.block_structural_reframe ??
        (isCompareStructureBomb
          ? '1段落目の3文目は、魅力や可能性へ早く着地しない。一般論にしない。この関係で本当にぶつかっているものを、一段深い対比として固定する。たとえば「強さの有無ではなく、強さの出しどころがぶつかっています。」「どちらが正しいかではなく、どちらが前に立つかがぶつかっています。」のように、争点の芯が一文で残る書き方を優先する。'
          : isIntentMethodBomb
            ? '1段落目の3文目は、今回の方法質問の芯を仮置きする。案内文や一般論にしない。何を決める前に何を先に定めるべきかを、一文で静かに言い切る。'
            : '1段落目の3文目は、今回の核を仮に示してよい。案内文や説明文にしない。何がこの迷いの中心にあるのかを、やわらかい断定で一文にする。言い切りすぎず、でも主題が一段深く見える強さを優先する。'),

      block_breakdown_core_gap:
        relationshipDetailMaterial?.block_breakdown_core_gap ??
        (isCompareStructureBomb
          ? '2段落目の1文目は、まずこの関係で何がぶつかっているかを一文で固定する。A/Bの説明から入らない。性格紹介や一般論にしない。「意見の違いがそのまま対立に見えやすいです。」「どちらも引きたくないので、正しさの押し合いになりやすいです。」のように、争点の芯が最初に見える自然文を優先する。'
          : isIntentMethodBomb
            ? '2段落目の1文目は、いま噛み合っていない二つを名指しする。整理や分析にしない。決めたい気持ちと、決める対象がまだ曖昧なことの差が一文で見えるようにする。'
            : '2段落目の1文目は、噛み合っていないところをそのまま名指ししてよい。整理や分析にしない。何と何が同時に残っているのか、どの二つが引っぱり合っているのかを、平明な自然文で一文にする。ここでは差が分かる強さを優先する。'),

      block_breakdown_defense:
        relationshipDetailMaterial?.block_breakdown_defense ??
        (isCompareStructureBomb
          ? '2段落目の2文目は、そこで何を守ろうとして強く出るのかを書く。A/Bの性格説明にしない。たとえば「自分のやり方を崩したくないので、相手の出方を待つより先に動きたくなります。」「主導権を渡したくないので、譲るより先に押し返したくなります。」のように、反応の裏で守っているものが見える自然文を優先する。'
          : isIntentMethodBomb
            ? '2段落目の2文目は、そこで守ろうとしているものを書く。一般論にしない。雑に決めて後悔したくないことや、見誤りたくないことがにじむように置く。'
            : '2段落目の2文目は、そこで守ろうとしているものを書く。一般論にしない。大事にしているものがにじむ言葉にする。断定しすぎず、でも曖昧に逃がさない。前文から自然につながる言い方にする。'),

      block_breakdown_rejection_target:
        relationshipDetailMaterial?.block_breakdown_rejection_target ??
        (isCompareStructureBomb
          ? '2段落目の3文目は、起きやすい誤解を場面として見せる。説明順に並べすぎない。相手がどう見えてしまうかが、そのまま浮かぶ一文にする。たとえば「一方には相手が押してくるように見え、もう一方には相手が引かずに重たく見えやすいです。」「こちらには強くかぶせてくるように見え、向こうには譲る気がないように見えやすいです。」のように、その場で起きる誤読の像が一歩具体に立つ強さを優先する。'
          : isIntentMethodBomb
            ? '2段落目の3文目は、外したくないものをひとつに寄せる。説明ではなく、その輪郭だけが残る書き方にする。次段で方法が狭まる終わり方にする。'
            : '2段落目の3文目は、外したくないもの、避けたいものを書く。列挙せず、ひとつに寄せる。説明ではなく、その輪郭だけが残る書き方にする。3段落目の方向が静かに開く終わり方にする。'),

      block_reading_direction:
        relationshipDetailMaterial?.block_reading_direction ??
        (isCompareStructureBomb
          ? '3段落目の1文目は、打ち解ける理解点を説明ではなく読み替えとして置く。どちらも相手を雑に扱っているのではなく、見ている場所が違うだけだと自然にわかる一文にする。'
          : isMeaningUncoverBomb
            ? '3段落目の1文目は、I層の爆心として書く。今回はどちら寄りかを仮置きするだけでなく、何がこの迷いの主因として前に出ているのかを一文で言い当てる。ただし断定の押しつけにはしない。いま主に残っている本音と、まだ切れずに残っているもののどちらが核なのかが、静かに深く伝わる書き方を優先する。'
            : isIntentMethodBomb
              ? '3段落目の1文目は、先にやる一手を短く置く。観測へ戻さず、方法を1つに絞る。結論を濁さず、いま最初に定めるべき対象や基準を一文で言う。'
              : '3段落目の1文目は、今回はどちら寄りかを仮置きしてよい。ただし先に結論だけを置かず、なぜそちらに見えるのかが一緒に伝わる一文にする。「見るなら」「次は」などの案内語にしない。結論確定ではなく、いま主にどちらの力が前に出ていて、どちらがまだ残っているのかが同時にわかる書き方を優先する。'),

      block_concrete_sort_axis:
        relationshipDetailMaterial?.block_concrete_sort_axis ??
        (isCompareStructureBomb
          ? '3段落目の2文目は、AがBをどう読むと関係の見え方が変わるかを書く。説明口調にしない。Aの目に見えていた欠点が、別の力として見え直す感じを自然文で置く。'
          : isIntentMethodBomb
            ? '3段落目の2文目は、その一手をどう具体化するかを書く。比較説明ではなく、選択肢を増やさずに軸を細める。たとえば「やる・やめる・保留」のどれに近いかを見る、など一段狭い見方を置く。'
            : '3段落目の2文目は、比べている二つの違いを書く。比較を説明しない。その差が読めば分かる形で、そのまま言葉にする。整理語を使わず、前文の見立てをそのまま細める。'),

      block_concrete_sort_boundary:
        relationshipDetailMaterial?.block_concrete_sort_boundary ??
        (isCompareStructureBomb
          ? '3段落目の3文目は、BがAをどう読むと関係の見え方が変わるかを書く。受け止める、認める、敵にしない、は使わない。Bの目に見えていた欠点が、別の力として見え直す感じを自然文で置く。'
          : isIntentMethodBomb
            ? '3段落目の3文目は、全部を一度に決めない境界を書く。ただし保留に逃がさず、どこまでを今ここで決めるかを残す。方法の範囲を狭めて4段落目へつなぐ。'
            : '3段落目の3文目は、まだ決めきらなくていい範囲を書く。助言や指示にしない。ただし未確定で閉じるだけにせず、どこまでは仮置きできていて、どこから先がまだ未確定なのかが残る書き方にする。4段落目へ静かに着地できるよう閉じすぎない。'),

      block_conclusion:
        relationshipDetailMaterial?.block_conclusion ??
        (isCompareStructureBomb
          ? '4段落目の1文目は、二者の違いを役割として置く。Aが関係に何を入れ、Bが関係に何を入れるかが一読で見える形にする。'
          : isMeaningUncoverBomb
            ? '4段落目の1文目は、最後に残る核を短く深く置く。まとめにしない。何が実際にはまだ残っていて、その残りをどこで見誤りやすいのかを、少しだけ言い切る。意味を早く決めたいことより、まだ残したいものともう手放していいものの境目を見誤りたくないことを核として置く。ここで整えすぎず、爆心の残響をそのまま前に置く。'
            : isIntentMethodBomb
              ? '4段落目の1文目は、結論だけ言うならの形で短く置く。一般論にしない。先に決めるべき基準や対象をひとつに絞ることを、そのまま前に出す。'
              : '4段落目の1文目は、最後に残る核を書く。まとめにしない。いちばん残るものが、読んだ人に伝わる形で返す。ここまでの流れを回収するが、総括の言い方にはしない。'),

      block_caution:
        relationshipDetailMaterial?.block_caution ??
        (isCompareStructureBomb
          ? '4段落目の2文目は、二者がそろうと関係に何が立ち上がるかを書く。安全方向に戻さず、深さと広さ、温度と風通し、推進力と視点の変化のように、組み合わさったときの魅力が見える文にする。'
          : isMeaningUncoverBomb
            ? '4段落目の2文目は、SAFEを極限まで弱める。励まし・許可・安心づけ・保留理由にしない。まだ閉じていない構造の残りだけを書く。未完了を肯定せず、何がまだ整いきっていないかを短く残す。'
          : isIntentMethodBomb
            ? '4段落目の2文目は、方法を広げすぎない注意だけを残す。慰めにしない。全部を片づけようとするとまたぼやけることを、短く置く。'
            : '4段落目の2文目は、励まし・許可・安心づけにしない。まだ整いきっていない構造の残りだけを書く。未完了を肯定せず、何がまだ閉じていないかを短く残す。前文の核を弱めない。'),

      block_closing_line:
        relationshipDetailMaterial?.block_closing_line ??
        (isCompareStructureBomb
          ? '4段落目の3文目は、説明ではなく一撃で閉じる。最後に、この関係の本質が一文で残るようにする。例はその比較対象に合うものだけを使う。たとえば「この関係は、同じ強さを競わせるより、力の置き場を分けたときに一番まとまります。」「強さがぶつかる関係ではなく、強さの向きを分けたときに大きく動ける組み合わせです。」のように、関係の核がそのまま覚えられる一文を優先する。'
          : isIntentMethodBomb
            ? '4段落目の3文目は、余韻で逃がさず最初の行動で閉じる。励ましや余白にしない。今ここで着手する一手がそのまま残るように、短く具体的に終える。たとえば「まずは、外したくないものを一つ決めてください」のように閉じる。'
            : '4段落目の3文目は、余韻だけで閉じる。文や言葉への言及をしない。強く締めず、静けさと少しの残りだけが場に残る形で終える。完全に閉じ切らず、呼吸が残る終わり方にする。'),
            bodyStyle: isCompareStructureBomb
            ? {
                preferBlockSplit: true,
                minBlocks: 4,
                maxSentencesPerBlock: 4,
                minSentences: 15,
                maxSentences: 15,
              }
            : key === 'IR_DETAIL_V1'
              ? {
                  preferBlockSplit: true,
                  minBlocks: 4,
                  maxSentencesPerBlock: 4,
                  minSentences: 10,
                  maxSentences: 18,
                }
              : {
                  preferBlockSplit: true,
                  minBlocks: 3,
                  maxSentencesPerBlock: 4,
                  minSentences: 8,
                  maxSentences: 14,
                },

          writeConstraints: isCompareStructureBomb
            ? [
                'normal_detail / diagnosis_detail では、必ず4つの段落で返す',
                '4つの段落は、OBS → SHIFT → NEXT → SAFE の順に固定する',
                '比較説明型では合計15文ちょうどで返す',

                '1段落目はちょうど4文で書く',
                '1段落目は Aの核 → Bの核 → 違いを優劣にしない補正 → 差の芯 の順に置く',

                '2段落目はちょうど4文で書く',
                '2段落目は Aの基準 → Bの基準 → Aから見た違和感 → Bから見た違和感 の順に置く',

                '3段落目はちょうど4文で書く',
                '3段落目は 理解点の核 → A側の受け取り直し → B側の受け取り直し → 打ち解ける鍵 の順に置く',

                '4段落目はちょうど3文で書く',
                '4段落目は Aの居心地 → Bの居心地 → 関係の着地 の順に置く',

                '比較説明では、違いの発生、A側の核、B側の核、ぶつかる点、相互の誤解、相互理解の鍵、最後の着地が読めるだけの材料を先に出す',
                '特徴説明と理解点を同じ責務に混在させない',
                '誤解と結論を同じ責務に混在させない',
                'OBS / SHIFT / NEXT / SAFE は説明文ではなく自然文で書く',
                'closing_line は現在地の結論で静かに閉じる',
              ]
            : key === 'IR_DETAIL_V1'
              ? [
                  'IR_DETAIL_V1 では、診断後の深掘りとして返す。分析レポートではなく、相手・関係・状況の見立てを日常語で書く',
                  '4つの段落は、見えていること → 内側で起きていること → ポイント → まとめ の順にする',
                  '見出しを使う場合は「🌀 いま見えていること」「🧭 いま内側で起きていること」「🌱 ポイント」「🪔 まとめ」のように短くする',
                  '「構造」「階層」「位相」「主軸」「観測」「再配置」「象徴」「核」「余韻」「閉じる」は本文に出しすぎない',
                  '相手の本心や事実を断定しない。「今見える範囲では」「〜に見えます」「〜になりやすいです」の温度で書く',
                  'ユーザーから見えやすい感覚を一度入れる。例：はっきりしない、本音が見えにくい、完全に終わった感じではない、など',
                  '本文は難しい分析語より、読んだ人がそのまま納得できる言葉を優先する',
                  '恋愛・対人相談では、相手の状態だけで終わらせず、ユーザー側からどう見えやすいかも短く入れる',
                  '助言に寄せすぎない。必要な場合も「追う・詰める」などの強い行動指示ではなく、今の見え方の整理に留める',

                  '1段落目は2〜3文で書く',
                  '2段落目は2〜4文で書く',
                  '3段落目は2〜3文で書く',
                  '4段落目は2〜3文で書く',

                  '番号リストは使わない。1. / 2. / 3. の形式は禁止する',
                  '太字は要点を強めるために使ってよい。ただし1段落につき多くても1〜2箇所にする',
                  '区切り線 --- は、見出し同士の切り替わりが分かりやすくなる場合に使ってよい',
                  '最後は「完全に終わり」「絶対に進む」などの断定ではなく、今見える状態のまとめで閉じる',
                  'OBS / SHIFT / NEXT / SAFE は出力しない。自然文として出す',

                  'current_state は、今見える範囲の状態を日常語で書く',
                  'misrecognition_negation は、誤解しやすい見え方を少しやわらげる',
                  'structural_reframe は、今回の見立てを日常語で一文にする',
                  'breakdown_core_gap は、ユーザーから見えやすいズレを日常語で書く',
                  'breakdown_defense は、相手や関係が守ろうとしているペース・余裕・距離感として書く',
                  'breakdown_rejection_target は、避けたいことを強い断定にせず、見え方として書く',
                  'reading_direction は、今どちらの動きが強く見えるかを書く',
                  'concrete_sort_axis は、相手の気持ちの有無より、行動に変える力があるかどうかの違いとして書く',
                  'concrete_sort_boundary は、今決めきれない範囲を短く残す',
                  'conclusion は、最後に残る見立てを短く書く',
                  'caution は、ユーザーが消耗しやすい見方を短く書く',
                  'closing_line は、今の状態のまとめでやわらかく閉じる',
                ]
              : [
                'normal_detail では、資料風の見出し展開よりも、自然文で深く分かる説明を優先する',
                '構成は、導入 → 核の説明 → ズレの見え方 → 着地を基本にし、必要以上に大きな章立てへ広げない',
                '「詳しく」「階層」「構造」「層」「段階」が含まれる問いでは、対象物に固有の層・段階・部位・中心軸がある場合、それを省略せず展開する',
                '対象物が五重塔なら、第一層〜第五層と中心軸までを自然に展開する。山岳修行なら、欲求・浄化・覚悟・奉仕・一体化など、問いに即した段階を展開する',
                'Markdown見出しは原則使わない。使う場合も2個までにし、資料タイトルのような見出しを避ける',
                '「今ここを揃える」「焦点を移す」「一枚に戻す」などの型見出しは使わない。見出しを使う場合も短い日常語にする',
                '対象物に層・部位・段階・中心軸などの固有構造がある場合は、その構造に沿って意味を展開する',
                '説明だけで終わらず、表の理解と奥の意図、ユーザー側の見え方と相手側に届く見え方、行為の外形と内側の意味の間に起きるズレを表面化する',
                'そのズレが相手側ではどんな受け取りになるか、どこで受け取り違いが起きるか、どう再配置すれば届くかまで書く',
                'そのズレがなぜ刺さるのか、どこに階層差・受け取り違い・意図の不一致があるのかを、問いの範囲内で深く意味付けする',
                'ただし、根拠のない個人背景・過去原因・相手の本心・事実確認できない断定は足さない',
                '番号リストは使わない。1. / 2. / 3. の形式は禁止する',
                '小見出しは太字の独立行で出す。例：「**第一層：地の意図**」「**第二層：水の意図**」「**第三層：火の意図**」「**中心軸**」',
                '区切り線 --- は、見出し同士の切り替わりが分かりやすくなる場合に使ってよい',
                '装飾は控える。太字は必要な箇所だけにし、絵文字や大きな見出しで印象を作らない',
                '1段落目は3〜4文で書く',
                '1段落目は current_state → misrecognition_negation → structural_reframe の順を守る',
                '1段落目の前半で違いの発生や現在地を置き、後半で今回の核を仮置きしてよい',
                '2段落目は3〜4文で書く',
                '2段落目は breakdown_core_gap → breakdown_defense → breakdown_rejection_target の順を守る',
                '2段落目では、なぜズレるか、何を守ろうとしているか、どこに拒否が出ているかを分けて置く',
                '3段落目は3〜4文で書く',
                '3段落目は reading_direction → concrete_sort_axis → concrete_sort_boundary の順を守る',
                '3段落目では、次に見る焦点、比べる軸、どこまでを今回扱うかを分けて置く',
                '4段落目は3〜4文で書く',
                '4段落目は conclusion → caution → closing_line の順を守る',
                '4段落目には必ず closing_line に相当する短い本文を最後の1文として書く',
                '4段落目を見出しだけで終わらせない。3段落で終えることを禁止する',
                '4段落目を次の提案や案内にしない',
                'NORMAL_DETAIL_V1 では、素材を増やしすぎず、読んで自然に入る量で要点を深める',
                '比較説明では、違いの発生、A側の核、B側の核、ぶつかる点、相互の誤解、相互理解の鍵、最後の着地が読めるだけの材料を先に出す',
                '一つの文に複数責務を詰め込みすぎない',
                '特徴説明と理解点を同じ責務に混在させない',
                '誤解と結論を同じ責務に混在させない',
                'OBS / SHIFT / NEXT / SAFE は説明文ではなく自然文で書く',
                'current_state は今ある状態を書く',
                'misrecognition_negation はその状態を弱さと決めない',
                'structural_reframe は今回の核を一段仮置きする',
                'breakdown_core_gap は混在している二つを名指しする',
                'breakdown_defense は守ろうとしているものを書く',
                'breakdown_rejection_target は避けたいものを書く',
                'reading_direction は次に見る焦点を書く',
                'concrete_sort_axis は比較の軸を書く',
                'concrete_sort_boundary は今回どこまで扱うかを書く',
                'conclusion は最後に残る核を書く',
                'caution は急ぎすぎると何を見失うかを書く',
                'closing_line は現在地の結論で静かに閉じる',
              ],
    };
  }
  const writerPatternKeyForFirstPass = String(
    (ctxPackForWriter as any)?.patternKey ??
      (opts as any)?.ctxPack?.patternKey ??
      (opts as any)?.userContext?.ctxPack?.patternKey ??
      selectSlotPattern({
        line: String(
          (opts as any)?.meta?.extra?.presentationKind ??
            (opts as any)?.userContext?.meta?.extra?.presentationKind ??
            ''
        )
          .trim()
          .toLowerCase(),
        questionType: null,
        detailMode:
          (opts as any)?.ctxPack?.detailMode === true ||
          (opts as any)?.userContext?.ctxPack?.detailMode === true,
        followupText: String((opts as any)?.userText ?? '').trim(),
        userText: String((opts as any)?.userText ?? '').trim(),
        targetLabel: null,
        hasPriorDiagnosis: false,
      }) ??
      ''
  ).trim();

  const isDetailPatternWriterForFirstPass =
  writerPatternKeyForFirstPass === 'IR_DETAIL_V1' ||
  writerPatternKeyForFirstPass === 'NORMAL_DETAIL_V1';

const writerDirectivesFromSlotForFirstPass = isDetailPatternWriterForFirstPass
  ? {
      ...buildDetailPatternWriterDirectives(writerPatternKeyForFirstPass),
    }
  : {
      slot_order: Array.isArray(slotDecisionForFirstPass?.order)
        ? slotDecisionForFirstPass.order.join(',')
        : '',
      slot_opening_role:
        Array.isArray(slotDecisionForFirstPass?.order) && slotDecisionForFirstPass.order.length > 0
          ? String(slotDecisionForFirstPass.order[0] ?? '')
          : '',

      ...(slotDecisionForFirstPass?.emphasis
        ? Object.fromEntries(
            Object.entries(slotDecisionForFirstPass.emphasis).map(([k, v]) => [
              `slot_emphasis_${String(k).toLowerCase()}`,
              String(v),
            ])
          )
        : {}),

      ...(slotDecisionForFirstPass?.weights
        ? Object.fromEntries(
            Object.entries(slotDecisionForFirstPass.weights).map(([k, v]) => [
              `slot_weight_${String(k).toLowerCase()}`,
              String(v),
            ])
          )
        : {}),

      ...buildDetailPatternWriterDirectives(writerPatternKeyForFirstPass),
    };

    let messages = buildFirstPassMessages({
      systemPrompt: systemPromptForWriter,
      internalPack,
      historyText,
      turns: turnsForWriter,
      seedDraft,
      topicDigest: topicDigestForWriter,
      topicDigestV2: topicDigestV2ForWriter,
      conversationLine: conversationLineForWriter,
    outputPolicy:
      primaryQuestionForWriter?.outputPolicy &&
      typeof primaryQuestionForWriter.outputPolicy === 'object'
        ? primaryQuestionForWriter.outputPolicy
        : null,

    qCode: pickedQCode ?? null,
    depthStage: pickedDepthStage ?? null,
    phase: pickedPhase ?? null,
    e_turn: pickedETurn ?? null,

    userText: String((opts as any)?.userText ?? ''),

    slotDecision: slotDecisionForFirstPass,
    writerDirectives: {
      ...writerDirectivesFromSlotForFirstPass,
    },
    traceId: debug.traceId ?? null,
    conversationId: debug.conversationId ?? null,
    userCode: debug.userCode ?? null,

    userContext: (opts as any)?.userContext ?? null,
    ctxPack: ctxPackForWriter ?? null,

    mirrorFlowV1: (() => {
      const candidate =
        (ctxPackForWriter as any)?.mirrorFlowV1 ??
        (opts as any)?.userContext?.ctxPack?.mirrorFlowV1 ??
        (opts as any)?.userContext?.meta?.extra?.ctxPack?.mirrorFlowV1 ??
        (opts as any)?.userContext?.meta?.extra?.mirrorFlowV1 ??
        null;

      try {
        console.log(
          '[IROS/rephraseEngine][MIRROR_FLOW_V1_BEFORE_WRITER]',
          JSON.stringify({
            type: typeof candidate,
            isObject: !!candidate && typeof candidate === 'object',
            isString: typeof candidate === 'string',
            head:
              typeof candidate === 'string'
                ? candidate.slice(0, 200)
                : candidate && typeof candidate === 'object'
                  ? JSON.stringify(candidate).slice(0, 200)
                  : null,
          }),
        );
      } catch {}

      return candidate;
    })(),

    extra: {
      question:
        ((opts as any)?.ctxPack?.question &&
        typeof (opts as any).ctxPack.question === 'object')
          ? (opts as any).ctxPack.question
          : ((opts as any)?.userContext?.ctxPack?.question &&
              typeof (opts as any).userContext.ctxPack.question === 'object')
            ? (opts as any).userContext.ctxPack.question
            : (opts as any)?.extra?.question ??
              (opts as any)?.userContext?.question ??
              (opts as any)?.userContext?.meta?.extra?.question ??
              null,
      pastStateNoteText:
        (opts as any)?.extra?.pastStateNoteText ??
        (opts as any)?.userContext?.pastStateNoteText ??
        (opts as any)?.userContext?.meta?.extra?.pastStateNoteText ??
        null,
      pastStateTriggerKind:
        (opts as any)?.extra?.pastStateTriggerKind ??
        (opts as any)?.userContext?.pastStateTriggerKind ??
        (opts as any)?.userContext?.meta?.extra?.pastStateTriggerKind ??
        null,
      pastStateKeyword:
        (opts as any)?.extra?.pastStateKeyword ??
        (opts as any)?.userContext?.pastStateKeyword ??
        (opts as any)?.userContext?.meta?.extra?.pastStateKeyword ??
        null,
      referenceJudgeSeedForFirstPass:
        ((opts as any)?.extra?.referenceJudgeSeed) ??
        ((opts as any)?.userContext?.ctxPack?.referenceJudgeSeed) ??
        ((opts as any)?.userContext?.meta?.extra?.referenceJudgeSeed) ??
        null,
      referenceJudgeSeed:
        ((opts as any)?.extra?.referenceJudgeSeed) ??
        ((opts as any)?.userContext?.ctxPack?.referenceJudgeSeed) ??
        ((opts as any)?.userContext?.meta?.extra?.referenceJudgeSeed) ??
        null,
      goalKind:
        (opts as any)?.goalKind ??
        (opts as any)?.userContext?.goalKind ??
        (opts as any)?.userContext?.ctxPack?.goalKind ??
        (opts as any)?.userContext?.ctxPack?.replyGoal?.kind ??
        null,
    },
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
  const shiftKindForAllow = String(
    (opts as any)?.shiftKind ??
      (opts as any)?.shiftKindNow ??
      (opts as any)?.userContext?.shiftKind ??
      (opts as any)?.userContext?.ctxPack?.shiftKind ??
      '',
  ).trim();

  const laneKeyRecoveredFromSeed: 'IDEA_BAND' | 'T_CONCRETIZE' | null = (() => {
    const raw = String(
      (opts as any)?.seedDraftRawAll ??
        (opts as any)?.seedDraft ??
        (opts as any)?.slotPlanSeed ??
        '',
    );

    const laneMatch = raw.match(/"laneKey"\s*:\s*"(IDEA_BAND|T_CONCRETIZE)"/);
    if (laneMatch?.[1] === 'IDEA_BAND' || laneMatch?.[1] === 'T_CONCRETIZE') {
      return laneMatch[1];
    }

    const shiftMatch = raw.match(/"kind"\s*:\s*"(decide_shift|narrow_shift)"/);
    if (shiftMatch?.[1] === 'decide_shift' || shiftMatch?.[1] === 'narrow_shift') {
      return 'T_CONCRETIZE';
    }

    return null;
  })();

  const laneKeyForAllow: 'IDEA_BAND' | 'T_CONCRETIZE' | null =
    (opts as any)?.laneKey ??
    (opts as any)?.userContext?.laneKey ??
    (opts as any)?.userContext?.ctxPack?.laneKey ??
    laneKeyRecoveredFromSeed ??
    (shiftKindForAllow === 'decide_shift' || shiftKindForAllow === 'narrow_shift'
      ? 'T_CONCRETIZE'
      : null) ??
    ((typeof wantsTConcretize !== 'undefined' && wantsTConcretize) ? 'T_CONCRETIZE' : null) ??
    ((typeof wantsIdeaBand !== 'undefined' && wantsIdeaBand) ? 'IDEA_BAND' : null) ??
    null;
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
    // deepReadBoost
    // - RETURN streak>=2 のときだけ “1段だけ” 許可を上げる
    // - stingLevel=HIGH のときも “1段だけ” 許可を上げる
    // - 実装：allow.strength を加算するだけ（上限3）
    // -------------------------------------------------------
    const flowDeltaNow =
      String(flowDigest ?? '').toLowerCase().includes('return') ? 'RETURN' : null;

    // flowSeed / flowDigest から戻り回数を読む。無ければ 0。
    const returnStreakNow = (() => {
      const src = String(
        ((opts as any)?.userContext?.ctxPack?.flowSeed ??
          (opts as any)?.userContext?.extra?.flowSeed ??
          '') ||
          (flowDigest ?? '')
      );
      const m = src.match(/戻り:\s*(\d+)|returnStreak[:=]\s*(\d+)/i);
      const n = m ? Number(m[1] ?? m[2]) : 0;
      return Number.isFinite(n) ? n : 0;
    })();

    const stingLevelNow = (() => {
      const raw =
        (opts as any)?.userContext?.ctxPack?.stingLevel ??
        (opts as any)?.userContext?.stingLevel ??
        null;
      const s = String(raw ?? '').trim().toUpperCase();
      return s === 'HIGH' || s === 'MID' || s === 'LOW' ? s : null;
    })();

    if (allowObj && typeof allowObj === 'object') {
      let boost = 0;

      const hasHookForAllow =
        (opts as any)?.userContext?.ctxPack?.hasFlowMeaningForAllow === true;

      const goalKindNow = String(
        (opts as any)?.userContext?.ctxPack?.goalKind ??
          (opts as any)?.ctxPack?.goalKind ??
          ''
      ).trim();

      const questionTypeNow = String(
        (opts as any)?.userContext?.ctxPack?.question?.questionType ??
          (opts as any)?.ctxPack?.question?.questionType ??
          ''
      ).trim();

      const shouldOpenAssertForDeepRead =
        hasHookForAllow ||
        (
          goalKindNow === 'uncover' &&
          questionTypeNow === 'meaning' &&
          (flowDeltaNow === 'RETURN' || stingLevelNow === 'HIGH')
        );

      if (shouldOpenAssertForDeepRead) {
        (allowObj as any).assert = true;
      }

      if (flowDeltaNow === 'RETURN' && returnStreakNow >= 2) {
        boost += 1;
      }
      if (stingLevelNow === 'HIGH') {
        boost += 1;
      } else if (stingLevelNow === 'MID') {
        boost += 0;
      }

      if (boost > 0) {
        const cur = Number((allowObj as any).strength ?? 2);
        const next = Number.isFinite(cur) ? cur + boost : 3;
        (allowObj as any).strength = Math.min(next, 3);
        (allowObj as any).__deepReadBoost = {
          flowDeltaNow,
          returnStreakNow,
          stingLevelNow,
          boost,
        }; // ログ確認用（露出しない）
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
  const ctxPack = (opts as any)?.userContext?.ctxPack ?? null;

  const exprMetaFromCtx =
    (opts as any)?.exprMeta ??
    (opts as any)?.userContext?.exprMeta ??
    (opts as any)?.userContext?.ctxPack?.exprMeta ??
    null;

  const replyGoalRawForExpr = ctxPack?.replyGoal ?? null;
  const replyGoalKindForExpr =
    typeof replyGoalRawForExpr === 'string'
      ? replyGoalRawForExpr.trim() || null
      : typeof replyGoalRawForExpr === 'object' && replyGoalRawForExpr
        ? String((replyGoalRawForExpr as any).kind ?? '').trim() || null
        : null;

  const goalKindForExpr =
    (opts as any)?.goalKind ??
    (opts as any)?.userContext?.goalKind ??
    ctxPack?.goalKind ??
    replyGoalKindForExpr ??
    null;

  const flowDeltaForExpr = String(
    ctxPack?.flow?.delta ??
      ctxPack?.flowDelta ??
      ''
  )
    .trim()
    .toUpperCase();

  const returnStreakRawForExpr =
    ctxPack?.flow?.returnStreak ??
    ctxPack?.returnStreak ??
    0;

  const returnStreakForExpr =
    typeof returnStreakRawForExpr === 'number'
      ? returnStreakRawForExpr
      : Number(returnStreakRawForExpr || 0);

  const stingLevelForExpr = String(
    ctxPack?.stingLevel ??
      (opts as any)?.userContext?.stingLevel ??
      ''
  )
    .trim()
    .toUpperCase();

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

  const exprMetaBase =
    exprMetaFromCtx && typeof exprMetaFromCtx === 'object'
      ? { ...exprMetaDefault, ...(exprMetaFromCtx as any) }
      : exprMetaDefault;

  // ✅ 今回の主修正
  // stabilize / RETURN / 戻り連続 / sting HIGH では、
  // 「短く安全に閉じる」より「具体を少し厚く返す」を優先する
  // ※ 質問ルールは別レイヤなのでここでは触らない
  const shouldOpenExprWide =
    goalKindForExpr === 'stabilize' ||
    flowDeltaForExpr === 'RETURN' ||
    returnStreakForExpr >= 2 ||
    stingLevelForExpr === 'HIGH';

  const exprMeta = shouldOpenExprWide
    ? {
        ...exprMetaBase,
        tone: 'high',
        density: 'rich',
        metaphor: 'lite',
        brevity: 'long',
        rhythm: 'breathe',
      }
    : exprMetaBase;

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

  try {
    const replyGoalRaw = ctxPack?.replyGoal ?? null;
    const replyGoalKindNormalized =
      typeof replyGoalRaw === 'string'
        ? replyGoalRaw.trim() || null
        : typeof replyGoalRaw === 'object' && replyGoalRaw
          ? String((replyGoalRaw as any).kind ?? '').trim() || null
          : null;

    console.log('[IROS/GOALKIND_BRIDGE][FULL_BLOCKPLAN_INPUT]', {
      traceId: (debug as any)?.traceId ?? null,
      conversationId: (debug as any)?.conversationId ?? null,
      userCode: (debug as any)?.userCode ?? null,

      goalKind_top: (opts as any)?.goalKind ?? null,
      goalKind_userContext: (opts as any)?.userContext?.goalKind ?? null,
      goalKind_ctxPack: ctxPack?.goalKind ?? null,
      replyGoal_ctxPack: replyGoalRaw,
      replyGoalKind_ctxPack: replyGoalKindNormalized,

      ctxPack_keys:
        ctxPack && typeof ctxPack === 'object'
          ? Object.keys(ctxPack)
          : [],
    });
  } catch {}

  const replyGoalRaw = ctxPack?.replyGoal ?? null;
  const replyGoalKindNormalized =
    typeof replyGoalRaw === 'string'
      ? replyGoalRaw.trim() || null
      : typeof replyGoalRaw === 'object' && replyGoalRaw
        ? String((replyGoalRaw as any).kind ?? '').trim() || null
        : null;

        const awakenLevel =
        typeof ctxPack?.awaken?.level === 'string'
          ? String(ctxPack.awaken.level).trim().toLowerCase()
          : null;

      const awakenCollapse =
        ctxPack?.awaken?.detail?.collapseHint === true;

        const awakenGoalKind =
        awakenCollapse
          ? 'clarify'
          : null;

          const structuralGoalKind =
          (opts as any)?.goalKind ??
          (opts as any)?.userContext?.goalKind ??
          ctxPack?.goalKind ??
          replyGoalKindNormalized ??
          awakenGoalKind ??
          null;

        const goalKind =
          structuralGoalKind ??
          replyGoalKindNormalized ??
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

  // ✅ 診断フォローでは multi7 の深掘り構成に入れない
  // - 「診断内容を詳しく」「実際の会話の続きにして」などは、
  //   通常共鳴の7段見出しではなく、直前診断を日常語で具体化するターン。
  const isDiagnosisFollowupCtxForBlockPlan =
    (ctxPack as any)?.diagnosisFollowup === true ||
    String((ctxPack as any)?.continuityKind ?? '').trim() === 'diagnosis_followup' ||
    ((ctxPack as any)?.detailMode === true &&
      (ctxPack as any)?.irMeta &&
      typeof (ctxPack as any).irMeta === 'object' &&
      /診断内容|診断結果|さっきの診断|前の診断|この診断|今の診断|詳しく|詳細|深く|具体的に|実際の会話|会話の続き/u.test(
        String(userTextForTrigger ?? '')
      ));

  const explicitTrigger = isDiagnosisFollowupCtxForBlockPlan
    ? false
    : detectExplicitBlockPlanTrigger(userTextForTrigger);

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
// テスト用: BLOCK_PLAN を強制的に有効化
if (typeof blockPlan !== 'undefined' && blockPlan) {
  (blockPlan as any).enabled = true; // 型チェック回避
}
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

  // ✅ system を1枚に統合（base → allow → runtimePolicy → exprMeta → BLOCK_PLAN）
  if (Array.isArray(messages) && messages.length > 0 && (messages as any)[0]?.role === 'system') {
    const base = String((messages as any)[0]?.content ?? '').trim();

    // -------------------------------------------------
    // runtime policy（軽量・可変にしない）
    // - 段/行数/見出し採用は LLM 判断に任せる
    // - ただし「内部信号の露出禁止」「具体語アンカー」「見出し形式」だけは system で押さえる
    // -------------------------------------------------
    const runtimeWriterPolicyText = [
      '【WRITER RUNTIME POLICY（DO NOT OUTPUT）】',
      '- 座標（depthStage/phase/qCode）は INTERNAL PACK の「STATE」を正本として必ず参照し、それに従って書く。',
      '- 内部信号（obs/flow/e_turn/polarity/intent/depth など）は使ってよいが、ラベル名や内部語を本文に出さない。',
      '- 抽象だけでまとめず、ユーザー発話の具体語を最低1つ残す。',
      '- 段・行数・見出しの有無は内容に合わせて決めてよい（無理に構造化しない）。',
      '- 見出しを使う場合のみ、形式は「## 絵文字1つ + 半角スペース + 見出し本文」にする。',
      '- 絵文字や見出しは乱発禁止。固定テンプレ化しない。強いときだけ。',
      '- 選択肢提示（A）B）C）「次のどれかを選んで」等）は使わない。',
      '- 問いかけをする場合は「最大1つ」まで。不要なら問いを置かずに進めてよい。',
    ].join('\n');

    // ✅ EXPR_META は一旦 system から外す（token削減のため）
    const exprMetaForSystem = '';

    // ✅ allow（任意）
    const allowForSystem = allowText && String(allowText).trim().length > 0 ? String(allowText) : '';

    // ✅ BLOCK_PLAN（条件付きで system へ）
    const blockPlanForSystem =
      blockPlanText && String(blockPlanText).trim().length > 0 ? String(blockPlanText) : '';

    // ✅ system は base + 追記要素を1枚に統合
    const merged = [base, allowForSystem, runtimeWriterPolicyText, exprMetaForSystem, blockPlanForSystem]
      .map((s) => String(s ?? '').trim())
      .filter((s) => s.length > 0)
      .join('\n\n')
      .trim();

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

// ✅ user マスクは rephraseEngine 側では行わない（writerCalls.ts 側に集約）
// - rephraseEngine で末尾 user を潰すと、writerCalls.ts の「最後 user だけ生」が成立しない
// - MSG_TRACE が「全 user が伏字」になってしまう主因になる

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

    // ✅ MeaningSkeleton の確認（system本文から検出）
    meaningSkeletonInSystem:
      Array.isArray(messages) && messages[0]?.role === 'system'
        ? /MEANING_SKELETON \(DO NOT OUTPUT\):/i.test(String((messages[0] as any)?.content ?? ''))
        : false,
    meaningSkeletonHead:
      Array.isArray(messages) && messages[0]?.role === 'system'
        ? safeHead(
            (
              String((messages[0] as any)?.content ?? '').match(
                /MEANING_SKELETON \(DO NOT OUTPUT\):[\s\S]{0,200}/i,
              )?.[0] ?? ''
            ),
            160,
          )
        : '',

    // ✅ merged system の内訳（このスコープで参照できる範囲だけ）
    mergedSystemPartsLen: {
      systemPrompt: String(systemPrompt ?? '').length,
      exprMetaText: String(exprMetaText ?? '').length,
      blockPlanText: String(blockPlanText ?? '').length,
    },

    // ✅ seedDraft 実体の監査（発生源特定用）
    seedDraftLen: seedDraft.length,
    seedDraftHead: safeHead(seedDraft, 120),
    seedDraftRawAllHead: safeHead(slotsTextRawAll, 200),

    // ✅ slots の中身を “頭だけ” 監査（自然文混入の犯人探し）
    slotsHead: (extracted?.slots ?? []).map((s: any, i: number) => ({
      i,
      key: String(s?.key ?? ''),
      head: safeHead(sanitizeSlotTextForWriter(String(s?.text ?? '')), 80),
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

  console.log(
    '[IROS/rephraseEngine][MSG_PACK_JSON]',
    JSON.stringify({
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      msgCount: messages.length,
      roles: messages.map((m: any) => m.role),
      meaningSkeletonInSystem:
        Array.isArray(messages) && messages[0]?.role === 'system'
          ? /MEANING_SKELETON \(DO NOT OUTPUT\):/i.test(String((messages[0] as any)?.content ?? ''))
          : false,
      meaningSkeletonHead:
        Array.isArray(messages) && messages[0]?.role === 'system'
          ? safeHead(
              (
                String((messages[0] as any)?.content ?? '').match(
                  /MEANING_SKELETON \(DO NOT OUTPUT\):[\s\S]{0,200}/i,
                )?.[0] ?? ''
              ),
              160,
            )
          : '',
    }),
  );

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

    // rephraseBlocks は renderGateway の正本になるため、
    // 表示本文の正本は writer が返した normalizedText を使う。
    // slotPlan / llmRewriteSeed 由来の slot は control-plane なので、
    // ここでは display 用 block の正本には採用しない。
    const normalizedText = String(text ?? '').trim();

    // PUBLIC_IROS_ARCHITECTURE_SKIP_PATTERN_MATERIALIZE
    // IROSの公開用アーキテクチャ説明は、WriterがMarkdown見出しと段落で整えた本文を正本にする。
    // NORMAL_DETAIL_V1 の OBS/SHIFT/NEXT/SAFE へ再分解すると、
    // 「Inputここは...」のように見出しと本文が潰れるため、pattern materialize を通さない。
    // 内部漏洩ガードは guards.ts 側で維持する。
    const shouldSkipPatternMaterializeForPublicIrosArchitecture =
      /(IROS|iros|Mu|ミュー)/u.test(normalizedText) &&
      /(アーキテクチャ|内部構造|実装レイヤー|構造|仕組み)/u.test(normalizedText) &&
      /(Input|Memory|Context|MirrorFlow|Seed|Writer|Guard|Render|Persist|Layer|レイヤー)/i.test(normalizedText) &&
      !/(DO NOT OUTPUT|INTERNAL PACK|STATE_CUES|WRITER_DIRECTIVES|PATTERN_OUTPUT_CONTRACT|HISTORY_LITE|USER_UNDERSTANDING_STATE|PAST_STATE_NOTE|traceId|conversationId|userCode|raw_values|CALL_WRITER_ARGS|FINAL_MESSAGES_FOR_WRITER)/i.test(normalizedText);

    const normalizedParagraphsForCompressed = normalizedText
      .split(/\n{2,}/)
      .map((x) => String(x ?? '').trim())
      .filter(Boolean);

    const sentenceUnitsForCompressed =
      normalizedParagraphsForCompressed.length > 0 &&
      normalizedParagraphsForCompressed.length < 4
        ? normalizedParagraphsForCompressed
            .flatMap((p) => {
              const rawParagraph = String(p ?? '').trim();
              if (!rawParagraph) return [];

              // ✅ 日本語カギ括弧内の例文は、句点で分割しない。
              // 例: 「連絡がなくて少し心配していました。落ち着いたら、また連絡ください。」
              // ここで分割すると、表示側で 「...。 / 次文。 / 」 が別ブロックになる。
              const hasJapaneseQuote = /[「『][\s\S]*?[」』]/u.test(rawParagraph);
              const hasUnclosedJapaneseQuote =
                /[「『]/u.test(rawParagraph) && !/[」』]/u.test(rawParagraph);

              if (hasJapaneseQuote || hasUnclosedJapaneseQuote) {
                return [rawParagraph];
              }

              return rawParagraph
                .split(/(?<=[。！？!?])\s*/u)
                .map((x) => String(x ?? '').trim())
                .filter(Boolean);
            })
        : [];

    const compressedFourBlocksFromSentences =
      sentenceUnitsForCompressed.length >= 4
        ? [
            sentenceUnitsForCompressed[0],
            sentenceUnitsForCompressed[1],
            sentenceUnitsForCompressed[2],
            sentenceUnitsForCompressed.slice(3).join(' '),
          ].filter((x) => String(x ?? '').trim().length > 0)
        : [];

    let blocksText =
      compressedFourBlocksFromSentences.length === 4
        ? compressedFourBlocksFromSentences
        : toRephraseBlocks(normalizedText);

    if (!Array.isArray(blocksText) || blocksText.length === 0) {
      blocksText = toRephraseBlocks(normalizedText);
    }

    console.log(
      '[IROS/rephraseEngine][NORMALIZED_TEXT_BLOCKS]',
      JSON.stringify({
        traceId: (debug as any)?.traceId ?? null,
        conversationId: (debug as any)?.conversationId ?? null,
        userCode: (debug as any)?.userCode ?? null,
        normalizedTextLen: normalizedText.length,
        normalizedTextHead: safeHead(normalizedText, 200),
        normalizedParagraphs: normalizedText
          .split(/\n{2,}/)
          .map((x) => String(x ?? '').trim())
          .filter(Boolean)
          .map((x) => safeHead(x, 120)),
        blocksTextLenBeforePattern: Array.isArray(blocksText) ? blocksText.length : 0,
        blocksTextHeadBeforePattern: Array.isArray(blocksText)
          ? blocksText.slice(0, 6).map((x) => safeHead(String(x), 80))
          : [],
      })
    );

    const questionTypeFromContext = String(
      (
        (opts as any)?.userContext?.question?.questionType ??
        (opts as any)?.userContext?.meta?.extra?.question?.questionType ??
        (metaExtra as any)?.ctxPack?.question?.questionType ??
        (metaExtra as any)?.question?.questionType ??
        ''
      )
    )
      .trim()
      .toLowerCase();

    // questionType は writer 本文ではなく、必ず「ユーザーの質問文」から推定する。
// questionType は writer 本文ではなく、必ず「ユーザーの質問文」から推定する。
const questionTypeSourceText = String(
  userText ??
    (opts as any)?.userText ??
    (
      Array.isArray((opts as any)?.messages)
        ? (opts as any).messages.filter((m: any) => m?.role === 'user').slice(-1)[0]?.content
        : ''
    ) ??
    ''
).trim();

const inferQuestionType = (v: string): SlotWeightInput['questionType'] => {
  const explicit = questionTypeFromContext;
  if (
    explicit === 'meaning' ||
    explicit === 'structure' ||
    explicit === 'intent' ||
    explicit === 'truth'
  ) {
    return explicit;
  }

  const s = String(v ?? '').trim();

  if (/どう通すか|どう通す/u.test(s)) {
    return 'intent';
  }

  if (
    /どうしたら良い|どうしたらいい|どうすれば良い|どうすればいい|良い方法|いい方法|方法はありますか|どう進めたら良い|どう進めたらいい|どう進めれば良い|どう進めればいい|最終的にどうしたら|最終的にどうすれば|協調する方法|打ち解けるには/u.test(
      s
    )
  ) {
    return 'intent';
  }

  if (/意図|階層|構造|仕組み|関係|違い|配置|流れ|構成|背景|文脈|位置づけ/u.test(s)) {
    return 'structure';
  }

  if (/意味|なぜ|どういうこと|どう受け止め|どう読める/u.test(s)) {
    return 'meaning';
  }

  if (/どうしたい|どこへ向かう|何のため/u.test(s)) {
    return 'intent';
  }

  if (
    /ありますか|登場しますか|出てきますか|書かれていますか|記されていますか|載っていますか|あるか|ないか|本当ですか|事実ですか/u.test(
      s
    ) ||
    /(?:^|[。！？\s「『（(])[^。！？\n]*ですか(?:[。！？]|$)/u.test(s)
  ) {
    return 'truth';
  }

  if (/とは/u.test(s) && !/意図|階層|構造|仕組み|関係|違い|配置|流れ|構成|背景|文脈|位置づけ|意味/u.test(s)) {
    return 'truth';
  }

  return null;
};

    const resolvedQuestionType = inferQuestionType(
      questionTypeSourceText || normalizedText
    );

    const patternMetaExtra: any =
      metaExtra && typeof metaExtra === 'object' ? (metaExtra as any) : {};

    const patternMetaExtraCtxPack: any =
      patternMetaExtra?.ctxPack && typeof patternMetaExtra.ctxPack === 'object'
        ? patternMetaExtra.ctxPack
        : {};

    const patternUserContextMetaExtra: any =
      (opts as any)?.userContext?.meta?.extra &&
      typeof (opts as any).userContext.meta.extra === 'object'
        ? (opts as any).userContext.meta.extra
        : {};

    const patternUserContextMetaExtraCtxPack: any =
      patternUserContextMetaExtra?.ctxPack &&
      typeof patternUserContextMetaExtra.ctxPack === 'object'
        ? patternUserContextMetaExtra.ctxPack
        : {};

    const patternUserContextCtxPack: any =
      (opts as any)?.userContext?.ctxPack &&
      typeof (opts as any).userContext.ctxPack === 'object'
        ? (opts as any).userContext.ctxPack
        : {};

    const patternOptsCtxPack: any =
      (opts as any)?.ctxPack && typeof (opts as any).ctxPack === 'object'
        ? (opts as any).ctxPack
        : {};

    const patternIrMeta: any =
      patternMetaExtra?.irMeta ??
      patternMetaExtraCtxPack?.irMeta ??
      patternUserContextMetaExtra?.irMeta ??
      patternUserContextMetaExtraCtxPack?.irMeta ??
      patternUserContextCtxPack?.irMeta ??
      patternOptsCtxPack?.irMeta ??
      null;

    const patternLastIrDiagnosis: any =
      patternMetaExtra?.lastIrDiagnosis ??
      patternMetaExtraCtxPack?.lastIrDiagnosis ??
      patternUserContextMetaExtra?.lastIrDiagnosis ??
      patternUserContextMetaExtraCtxPack?.lastIrDiagnosis ??
      patternUserContextCtxPack?.lastIrDiagnosis ??
      patternOptsCtxPack?.lastIrDiagnosis ??
      null;

    const patternDetailMode =
      patternMetaExtra?.detailMode === true ||
      patternMetaExtraCtxPack?.detailMode === true ||
      patternUserContextMetaExtra?.detailMode === true ||
      patternUserContextMetaExtraCtxPack?.detailMode === true ||
      patternUserContextCtxPack?.detailMode === true ||
      patternOptsCtxPack?.detailMode === true;

    const patternPresentationKind = String(
      patternMetaExtra?.presentationKind ??
        patternMetaExtraCtxPack?.presentationKind ??
        patternUserContextMetaExtra?.presentationKind ??
        patternUserContextMetaExtraCtxPack?.presentationKind ??
        patternUserContextCtxPack?.presentationKind ??
        patternOptsCtxPack?.presentationKind ??
        ''
    )
      .trim()
      .toLowerCase();

    const patternTargetLabel =
      String(
        patternMetaExtra?.targetLabel ??
          patternMetaExtraCtxPack?.targetLabel ??
          patternIrMeta?.targetLabel ??
          patternLastIrDiagnosis?.target ??
          patternUserContextMetaExtra?.targetLabel ??
          patternUserContextMetaExtraCtxPack?.targetLabel ??
          patternUserContextCtxPack?.targetLabel ??
          patternOptsCtxPack?.targetLabel ??
          (opts as any)?.userContext?.targetLabel ??
          ''
      ).trim() || null;

    const patternFollowupText = String(
      userText ??
        (opts as any)?.userText ??
        ''
    ).trim();

    // ✅ 創作・書き直し系の継続要求は、診断詳細パターンに入れない。
    // 例: 「はい、書いてください」「もう少しリアルに書いてください」「それを書いて」「続きを書いて」
    const isCreativeContinuationForPattern =
      /(はい、?書いて|書いてください|書いて下さい|それを書いて|あれを書いて|これを書いて|続きを書いて|続き書いて|書き起こして|書き直して|リアルに書いて|もっとリアル|もう少しリアル|自然文寄り|会話っぽく)/u.test(
        patternFollowupText
      );

    const isDiagnosisFollowupPhrase =
      !isCreativeContinuationForPattern &&
      /診断を元に|診断をもとに|診断に基づいて|診断にもとづいて|診断を踏まえて|診断ベース|診断から|診断内容|診断結果|さっきの診断|前の診断|この診断|今の診断|深めて|深める|掘り下げ|掘って/u.test(
        patternFollowupText
      );

    const hasPriorDiagnosisForPattern =
      !isCreativeContinuationForPattern &&
      (
        patternPresentationKind === 'diagnosis' ||
        (!!patternTargetLabel && isDiagnosisFollowupPhrase)
      );

    const patternFollowupKindForConsult = String(
      (ctxPackForWriter as any)?.followupKind ??
        patternMetaExtra?.followupKind ??
        patternMetaExtraCtxPack?.followupKind ??
        patternUserContextMetaExtra?.followupKind ??
        patternUserContextMetaExtraCtxPack?.followupKind ??
        patternUserContextCtxPack?.followupKind ??
        patternOptsCtxPack?.followupKind ??
        ''
    ).trim();

    const isConsultAnswerLikeForPattern =
      patternFollowupKindForConsult === 'consult_timing' ||
      (
        /今|まだ|早い|タイミング|時期|今じゃない|今ではない|今すぐ|あとで|後で/u.test(
          patternFollowupText
        ) &&
        /いい|良い|どう|使う|使用|シェア|共有|渡す|出す|送る|連絡|返信|返事|始める|進める/u.test(
          patternFollowupText
        )
      ) ||
      /どう渡|渡し方|伝え方|言い方|送れば|共有の仕方|シェアの仕方/u.test(
        patternFollowupText
      ) ||
      /いいですか|良いですか|べき|判断|どちら|迷って|ありですか|やめた方|した方/u.test(
        patternFollowupText
      );

    const effectivePatternPresentationKind = isConsultAnswerLikeForPattern
      ? 'consult'
      : patternPresentationKind;

    const effectivePatternDetailMode = isConsultAnswerLikeForPattern
      ? false
      : patternDetailMode;

    const effectiveHasPriorDiagnosisForPattern = isConsultAnswerLikeForPattern
      ? false
      : hasPriorDiagnosisForPattern;

    const patternSelectInput = {
      line: effectivePatternPresentationKind === 'diagnosis' ? 'diagnosis' : effectivePatternPresentationKind,
      questionType: isConsultAnswerLikeForPattern ? null : resolvedQuestionType,
      detailMode: effectivePatternDetailMode,
      followupText: patternFollowupText,
      userText: patternFollowupText,
      targetLabel: patternTargetLabel,
      hasPriorDiagnosis: effectiveHasPriorDiagnosisForPattern,
    };

    const preSelectedPatternKeyRaw = String((opts as any)?.meta?.extra?.patternKey ?? '').trim();
    const preSelectedPatternKey =
      (isConsultAnswerLikeForPattern || isCreativeContinuationForPattern) &&
      (preSelectedPatternKeyRaw === 'IR_DETAIL_V1' || preSelectedPatternKeyRaw === 'NORMAL_DETAIL_V1')
        ? ''
        : preSelectedPatternKeyRaw;

    const selectedByFunction = selectSlotPattern(patternSelectInput);

    const isNaturalDeepenFollowupForMaterialize =
      // STALE_NORMAL_DETAIL_PRESELECT_GUARD
      // 「もう少し深めてください」系で、保存済み NORMAL_DETAIL_V1 が勝つのを防ぐ
      /^(?:もう少し|もうちょっと|さらに|もっと)?\s*(?:深めて|深く見て|掘って|掘り下げて|詳しく見て)(?:ください|ほしい|お願いします)?[。.!！?？\s]*$/u.test(
        String(patternFollowupText ?? '').trim(),
      );

    const effectivePreSelectedPatternKey =
      preSelectedPatternKey === 'NORMAL_DETAIL_V1' &&
      selectedByFunction === 'NORMAL_RESONANCE_V1' &&
      isNaturalDeepenFollowupForMaterialize
        ? ''
        : preSelectedPatternKey;


    console.log(
      '[IROS/rephraseEngine][PATTERN_SELECT_SOURCE]',
      JSON.stringify({
        traceId: debug.traceId ?? null,
        conversationId: debug.conversationId ?? null,
        userCode: debug.userCode ?? null,
        preSelectedPatternKey,
        selectedByFunction,
        questionType: patternSelectInput.questionType ?? null,
        detailMode: patternSelectInput.detailMode ?? null,
        followupText: patternSelectInput.followupText ?? null,
      })
    );

    const resolvedAskForMaterialize =
      (ctxPackForWriter as any)?.resolvedAsk ??
      (opts as any)?.ctxPack?.resolvedAsk ??
      (opts as any)?.meta?.extra?.ctxPack?.resolvedAsk ??
      (opts as any)?.userContext?.ctxPack?.resolvedAsk ??
      (opts as any)?.userContext?.meta?.extra?.ctxPack?.resolvedAsk ??
      null;

    const resolvedAskReadingModeForMaterialize = String(
      (resolvedAskForMaterialize as any)?.readingMode ??
        (resolvedAskForMaterialize as any)?.replyMode ??
        ''
    ).trim();

    const isPartnerSideResonanceForMaterialize =
      String((resolvedAskForMaterialize as any)?.askType ?? '').trim() === 'truth_structure' &&
      resolvedAskReadingModeForMaterialize === 'partner_side_resonance';

    const patternKey = (
      isConsultAnswerLikeForPattern
        ? 'NORMAL_COMPRESSED_V1'
        : isPartnerSideResonanceForMaterialize
        ? 'PARTNER_SIDE_RESONANCE_V1'
        // ✅ storyMode は診断フォローより優先する。
        // story_remake / story_undigested を IR_DETAIL_V1 に戻すと、
        // 「いま見えていること」等の診断テンプレが再付与されるため。
        : effectivePreSelectedPatternKey === 'story_undigested' ||
            effectivePreSelectedPatternKey === 'story_remake'
          ? effectivePreSelectedPatternKey
          : effectivePreSelectedPatternKey === 'previous_reply_rephrase' ||
              effectivePreSelectedPatternKey === 'IR_DETAIL_V1' ||
              effectivePreSelectedPatternKey === 'NORMAL_DETAIL_V1' ||
              effectivePreSelectedPatternKey === 'NORMAL_RESONANCE_V1' ||
              effectivePreSelectedPatternKey === 'NORMAL_PRACTICAL_RESONANCE_V1' ||
              effectivePreSelectedPatternKey === 'DECLARATION_RESONANCE_V1' ||
              effectivePreSelectedPatternKey === 'PARTNER_SIDE_RESONANCE_V1'
            ? effectivePreSelectedPatternKey
            : effectiveHasPriorDiagnosisForPattern && selectedByFunction === 'IR_DETAIL_V1'
              ? 'IR_DETAIL_V1'
              : selectedByFunction ||
                effectivePreSelectedPatternKey ||
                'NORMAL_RESONANCE_V1'
    ) as any;

    console.log(
      '[IROS/rephraseEngine][PATTERN_SELECT_INPUT]',
      JSON.stringify({
        traceId: debug.traceId ?? null,
        conversationId: debug.conversationId ?? null,
        userCode: debug.userCode ?? null,
        input: patternSelectInput,
        preSelectedPatternKey,
        selectedByFunction,
        result: patternKey,
      })
    );
    const patternBlocksResult = buildPatternBlocks({
      patternKey,
      targetLabel: patternTargetLabel,
      questionType: resolvedQuestionType,
      goalKind: goalKind ?? null,
      detailMode: effectivePatternDetailMode,
    });
// src/lib/iros/language/rephrase/rephraseEngine.full.ts
// 5469-5519 行をこのブロックで丸ごと置換

let materializedBlocks: Array<{
  text: string;
  kind: 'p';
  slotKey?:
    | 'OBS'
    | 'SHIFT'
    | 'NEXT'
    | 'SAFE'
    | 'STATE'
    | 'GUIDE'
    | 'MESSAGE'
    | 'STATE_SURFACE'
    | 'STATE_WEIGHT'
    | 'STATE_OPEN_EDGE'
    | 'STATE_RESIDUE'
    | 'STATE_ACTION';
  blockKey?: string;
  heading?: string;
}> = [];
let materializeSourceUnitsLog: string[] = [];
let materializeUnitIndexFinal = 0;
const slotBlocksText: string[] = [];

if (
  !shouldSkipPatternMaterializeForPublicIrosArchitecture &&
  (patternKey === 'IR_DETAIL_V1' ||
    patternKey === 'NORMAL_DETAIL_V1' ||
    patternKey === 'NORMAL_RESONANCE_V1' ||
    patternKey === 'DECLARATION_RESONANCE_V1' ||
    patternKey === 'PARTNER_SIDE_RESONANCE_V1') &&
  Array.isArray(patternBlocksResult.blocks) &&
  patternBlocksResult.blocks.length > 0
) {
  const diagnosisFollowupSourceBlocks =
    isDiagnosisFollowupSeedForMaterialize && diagnosisFollowupSeedForMaterialize
      ? [diagnosisFollowupSeedForMaterialize]
      : (Array.isArray(blocksText) ? blocksText : []);

  const sourceBlocksRaw = diagnosisFollowupSourceBlocks
    .map((x) => String(x ?? '').trim())
    .filter(Boolean);

    const shouldExpandSourceUnits =
    patternKey === 'NORMAL_DETAIL_V1' ||
    patternKey === 'NORMAL_RESONANCE_V1' ||
    patternKey === 'IR_DETAIL_V1' ||
    patternKey === 'DECLARATION_RESONANCE_V1' ||
    patternKey === 'PARTNER_SIDE_RESONANCE_V1';
  const splitSourceBlockForMaterialize = (block: unknown): string[] => {
    const rawBlock = String(block ?? '').trim();
    if (!rawBlock) return [];

    // ✅ Markdown見出し・箇条書き・引用文は、句点で分割しない。
    // 「- 「本文。」」を句点分割すると、閉じカッコ「」」だけが次ブロックへ飛ぶため。
    const hasMarkdownHeading = /^#{1,6}\s+|\*\*[^*]+\*\*/m.test(rawBlock);
    const hasBulletLine = /^\s*[-・•]\s+/m.test(rawBlock);
    const hasQuotedBullet = /^\s*[-・•]\s*[「『]/m.test(rawBlock);
    const hasJapaneseQuote = /[「『][\s\S]*?[」』]/u.test(rawBlock);
    const hasUnclosedJapaneseQuote =
      /[「『]/u.test(rawBlock) && !/[」』]/u.test(rawBlock);

    if (
      hasMarkdownHeading ||
      hasBulletLine ||
      hasQuotedBullet ||
      hasJapaneseQuote ||
      hasUnclosedJapaneseQuote
    ) {
      return [rawBlock];
    }

    return rawBlock
      .split(/(?<=[。！？!?])\s*/u)
      .map((x) => String(x ?? '').trim())
      .filter(Boolean);
  };

  const sourceUnits = shouldExpandSourceUnits
    ? sourceBlocksRaw.flatMap((block) => splitSourceBlockForMaterialize(block))
    : sourceBlocksRaw;
  materializeSourceUnitsLog = [...sourceUnits];

  const slotOrderForMaterialize: Array<
    | 'OBS'
    | 'SHIFT'
    | 'NEXT'
    | 'SAFE'
    | 'STATE'
    | 'GUIDE'
    | 'MESSAGE'
    | 'STATE_SURFACE'
    | 'STATE_WEIGHT'
    | 'STATE_OPEN_EDGE'
    | 'STATE_RESIDUE'
    | 'STATE_ACTION'
  > =
  patternKey === 'PARTNER_SIDE_RESONANCE_V1'
    ? ['STATE_SURFACE', 'STATE_WEIGHT', 'STATE_OPEN_EDGE', 'STATE_ACTION']
    : patternKey === 'DECLARATION_RESONANCE_V1' ||
        patternKey === 'NORMAL_RESONANCE_V1'
      ? ['STATE_SURFACE', 'STATE_WEIGHT', 'STATE_OPEN_EDGE', 'STATE_RESIDUE']
      : patternKey === 'NORMAL_DETAIL_V1'
        ? ['OBS', 'SHIFT', 'NEXT', 'SAFE']
        : ['OBS', 'STATE', 'GUIDE', 'MESSAGE'];

      const firstBlockBySlot = new Map<string, { heading?: string }>();
      const slotBlockCounts = new Map<string, number>();
      const slotBlockKeys = new Map<string, string[]>();

      for (const block of patternBlocksResult.blocks) {
        const slotKey = String(block.slotKey);
        if (!firstBlockBySlot.has(slotKey)) {
          firstBlockBySlot.set(slotKey, { heading: block.heading });
        }
        slotBlockCounts.set(slotKey, Number(slotBlockCounts.get(slotKey) ?? 0) + 1);
        slotBlockKeys.set(slotKey, [...(slotBlockKeys.get(slotKey) ?? []), String(block.blockKey)]);
      }

    materializedBlocks = [];
    let unitIndex = 0;
    let consumedAllSourceUnits = false;

    const splitIntoMicroUnits = (raw: string): string[] => {
      const text = String(raw ?? '').trim();
      if (!text) return [];

      return text
        .split(/(?<=[。！？!?])\s*/u)
        .map((x) => String(x ?? '').trim())
        .filter(Boolean);
    };

    const declarationTakePlan =
      patternKey === 'PARTNER_SIDE_RESONANCE_V1' ||
      patternKey === 'DECLARATION_RESONANCE_V1' ||
      patternKey === 'NORMAL_RESONANCE_V1'
        ? (() => {
            const total = sourceUnits.length;

            if (total <= 0) return [0, 0, 0, 0];
            if (total === 1) return [1, 0, 0, 0];
            if (total === 2) return [1, 1, 0, 0];
            if (total === 3) return [1, 1, 1, 0];

            const lastCount = 1;
            const openEdgeCount = Math.min(2, Math.max(1, total - 3));
            const headRemaining = Math.max(2, total - lastCount - openEdgeCount);
            const stateSurfaceCount = Math.min(2, Math.max(1, headRemaining - 1));
            const stateWeightCount = Math.max(1, headRemaining - stateSurfaceCount);

            return [stateSurfaceCount, stateWeightCount, openEdgeCount, lastCount];
          })()
        : null;

    for (const [slotIndex, slotKey] of slotOrderForMaterialize.entries()) {
      const heading = String(firstBlockBySlot.get(slotKey)?.heading ?? '').trim();
      const desiredCount = Number(slotBlockCounts.get(slotKey) ?? 0);
      if (desiredCount <= 0) continue;

      const slotDecisionForMaterialize =
        patternKey === 'NORMAL_DETAIL_V1'
          ? computeSlotDecisionFromEngine({
              depthStage:
                String((ctxPackForWriter as any)?.depthStage ?? '').trim() || null,
              questionType: resolvedQuestionType,
              goalKind:
                String(
                  (ctxPackForWriter as any)?.goalKind ??
                    (ctxPackForWriter as any)?.targetKind ??
                    goalKind ??
                    '',
                ).trim() || null,
            })
          : null;

          const useSingleParagraphPerSlot = false;

        let slotUnits: string[] = [];
        if (useSingleParagraphPerSlot) {
          const emphasisNow =
            slotKey === 'OBS' || slotKey === 'SHIFT' || slotKey === 'NEXT' || slotKey === 'SAFE'
              ? ((slotDecisionForMaterialize?.emphasis?.[slotKey] ?? 1) as 1 | 2 | 3)
              : 1;

          const remainingUnitsNow = Math.max(0, sourceUnits.length - unitIndex);
          const remainingSlotsAfterThis = Math.max(
            0,
            slotOrderForMaterialize.length - (slotIndex + 1),
          );
          const minReserveForLater = Math.min(
            remainingSlotsAfterThis,
            Math.max(0, remainingUnitsNow - 1),
          );
          const maxTakeNow = Math.max(0, remainingUnitsNow - minReserveForLater);
          const desiredTakeCount = emphasisNow === 3 ? 3 : emphasisNow === 2 ? 2 : 1;
          const takeCount = Math.max(0, Math.min(desiredTakeCount, maxTakeNow));

              slotUnits = sourceUnits
                .slice(unitIndex, unitIndex + takeCount)
                .map((x) => String(x ?? '').trim())
                .filter(Boolean);

              unitIndex += takeCount;
        } else {
          const remainingUnits = Math.max(0, sourceUnits.length - unitIndex);
          const remainingSlots = Math.max(1, slotOrderForMaterialize.length - slotIndex);

          const actualTakeCount =
            Array.isArray(declarationTakePlan) &&
            declarationTakePlan.length === slotOrderForMaterialize.length
              ? Math.max(
                  1,
                  Math.min(remainingUnits, Number(declarationTakePlan[slotIndex] ?? 1)),
                )
              : Math.max(1, Math.ceil(remainingUnits / remainingSlots));

          slotUnits = sourceUnits
            .slice(unitIndex, unitIndex + actualTakeCount)
            .map((x) => String(x ?? '').trim())
            .filter(Boolean);

          unitIndex += actualTakeCount;
        }

        if (slotUnits.length === 0) {
          continue;
        }

        const slotParagraphs = (() => {
          const cleaned = slotUnits
            .map((x, unitLocalIndex) => {
              let text = String(x ?? '').trim();
              if (!text) return '';

              if (
                patternKey === 'NORMAL_RESONANCE_V1' ||
                patternKey === 'DECLARATION_RESONANCE_V1' ||
                patternKey === 'NORMAL_COMPRESSED_V1'
              ) {
                const shouldNormalizeLead = slotIndex > 0 || unitLocalIndex > 0;

                if (shouldNormalizeLead) {
                  text = text
                    .replace(/^でも、そのあとに/u, '')
                    .replace(/^でもそのあとに/u, '')
                    .replace(/^そのあとに/u, '')
                    .replace(/^しかも、?/u, '')
                    .replace(/^だから今は、?/u, '今は、')
                    .replace(/^だから、?/u, '')
                    .replace(/^ただ、?/u, '')
                    .replace(/^変えるべき点を急ぐより、?/u, '')
                    .replace(/^見るなら、?/u, '')
                    .replace(/^次に見るのは、?/u, '')
                    .replace(/^見る場所は、?/u, '')
                    .replace(/^そこをそのまま見ておくといいです。?$/u, '同じ核だけが、静かに残っています。')
                    .replace(/^いまは、その止まり方をそのまま置いておけば足ります。?$/u, '同じ核だけが、静かに残っています。')
                    .replace(/^そこに触れれば十分です。?$/u, 'その一点だけが、静かに残っています。')
                    .replace(/^そこを見れば足ります。?$/u, 'その一点だけが、静かに残っています。')
                    .replace(/^そこだけを見れば十分です。?$/u, 'その一点だけが、静かに残っています。')
                    .replace(/見えてきます/u, '残っています')
                    .replace(/広がります/u, '残っています')
                    .replace(/戻ります/u, '残ります')
                    .replace(/ほどけます/u, '残ります');
                }

                text = text.trim();
              }

              return text;
            })
            .filter(Boolean);

          if (cleaned.length === 0) return [];

          const targetCount = Math.max(1, desiredCount);

          if (cleaned.length <= targetCount) {
            return cleaned;
          }

          const out: string[] = [];
          let cursor = 0;

          for (let i = 0; i < targetCount; i += 1) {
            const remaining = cleaned.length - cursor;
            const remainingBlocks = targetCount - i;
            const takeCount = Math.max(1, Math.ceil(remaining / remainingBlocks));
            const chunk = cleaned.slice(cursor, cursor + takeCount).join(' ').trim();
            if (chunk) out.push(chunk);
            cursor += takeCount;
          }

          if (cursor < cleaned.length) {
            const tail = cleaned.slice(cursor).join(' ').trim();
            if (tail) out.push(tail);
          }

          return out.filter(Boolean);
        })();

        const shouldSuppressIrDetailHeadingForConversationContinuation =
          patternKey === 'IR_DETAIL_V1' &&
          /実際の会話|会話の続き|そのまま送れる|会話文|送れる形/u.test(
            String(patternFollowupText ?? '')
          );

        const effectiveHeading =
          shouldSuppressIrDetailHeadingForConversationContinuation ? '' : heading;

        if (patternKey === 'NORMAL_DETAIL_V1') {
          materializedBlocks.push(
            ...slotParagraphs.map((paragraph, paragraphIndex) => ({
              text: paragraph,
              kind: 'p' as const,
              slotKey,
              blockKey: slotBlockKeys.get(String(slotKey))?.[paragraphIndex] ?? undefined,
              heading: heading || undefined,
            }))
          );
          continue;
        }

        if (!effectiveHeading) {
          materializedBlocks.push(
            ...slotParagraphs.map((paragraph, paragraphIndex) => ({
              text: paragraph,
              kind: 'p' as const,
              slotKey,
              blockKey: slotBlockKeys.get(String(slotKey))?.[paragraphIndex] ?? undefined,
            }))
          );
          continue;
        }

        slotParagraphs.forEach((paragraph, paragraphIndex) => {
          materializedBlocks.push({
            text: paragraphIndex === 0 ? `${effectiveHeading}\n${paragraph}` : paragraph,
            kind: 'p' as const,
            slotKey,
            blockKey: slotBlockKeys.get(String(slotKey))?.[paragraphIndex] ?? undefined,
            heading: effectiveHeading,
          });
        });
      }

      if (
        patternKey === 'NORMAL_DETAIL_V1' &&
        sourceBlocksRaw.length <= slotOrderForMaterialize.length
      ) {
        consumedAllSourceUnits = true;
        materializeUnitIndexFinal = sourceUnits.length;
      } else {
        materializeUnitIndexFinal = unitIndex;
      }

      if (!consumedAllSourceUnits) {
        for (let i = unitIndex; i < sourceUnits.length; i += 1) {
          const text = String(sourceUnits[i] ?? '').trim();
          if (!text) continue;

          materializedBlocks.push({
            text,
            kind: 'p' as const,
            ...(patternKey === 'NORMAL_DETAIL_V1'
              ? { slotKey: 'SAFE' as const, blockKey: 'closing_line' as const }
              : {}),
          });
        }
      }

      if (materializedBlocks.length > 0) {
        blocksText = materializedBlocks.map((block) => String(block.text ?? '').trim()).filter(Boolean);
      }}
    console.log(
      '[IROS/rephraseEngine][PATTERN_MATERIALIZE]',
      JSON.stringify({
        traceId: (debug as any)?.traceId ?? null,
        conversationId: (debug as any)?.conversationId ?? null,
        userCode: (debug as any)?.userCode ?? null,
        patternKey,
        resolvedQuestionType,
        patternDetailMode,
        patternPresentationKind,
        patternFollowupText,
        patternBlocksLen: Array.isArray(patternBlocksResult.blocks)
          ? patternBlocksResult.blocks.length
          : 0,
        sourceUnitsLen: materializeSourceUnitsLog.length,
        sourceUnitsHead: materializeSourceUnitsLog
          .slice(0, 6)
          .map((x) => safeHead(String(x), 80)),
        unitIndexFinal: materializeUnitIndexFinal,
        blocksTextLenAfterMaterialize: Array.isArray(blocksText) ? blocksText.length : 0,
        materializedBlocksLen: Array.isArray(materializedBlocks) ? materializedBlocks.length : 0,
        materializedSlotKeys: Array.isArray(materializedBlocks)
          ? materializedBlocks.map((block) => String(block.slotKey ?? '(none)'))
          : [],
        materializedBlocksPreview: Array.isArray(materializedBlocks)
          ? materializedBlocks.slice(0, 8).map((block) => ({
              slotKey: String(block.slotKey ?? '(none)'),
              text: safeHead(String(block.text ?? ''), 80),
            }))
          : [],
        blocksTextHead: Array.isArray(blocksText)
          ? blocksText.slice(0, 6).map((x) => safeHead(String(x), 80))
          : [],
      })
    );

// 🔽 2段落目（SHIFT）に混入した締め文だけは引き続き抑える
if (Array.isArray(blocksText) && blocksText.length === 4) {
  const second = String(blocksText[1] ?? '').trim();

  blocksText[1] = second
    .replace(/このまとめで、.*$/, '')
    .replace(/「まず一つに寄せれば、.*?」/, '')
    .trim();

  if (patternKey === 'DECLARATION_RESONANCE_V1') {
    const splitSentences = (raw: string): string[] =>
      String(raw ?? '')
        .split(/(?<=[。！？!?])\s*/u)
        .map((x) => String(x ?? '').trim())
        .filter(Boolean);

    const thirdText = String(blocksText[2] ?? '').trim();
    const fourthText = String(blocksText[3] ?? '').trim();

// src/lib/iros/language/rephrase/rephraseEngine.full.ts
// 5746-5763 行をこのブロックで丸ごと置換

const thirdUnits = splitSentences(thirdText);
const fourthLooksDirective =
  /(?:していけ|していく|置いていけ|置いていく|置いておけ|置いておけば|含めるか|どこまで|少しずつ|追いついて|残ります|進めます|できます|動きます|定まると|ではなくなります|へ変わります|に変わります|見えてきます|見えてくる|広がります|開けます)/.test(
    fourthText
  );

const thirdLooksDirective =
  /(?:まずは|どんな現実|輪郭で呼ぶ|どう呼ぶか|呼び名|接地|現実に接地|定める|定まる|ひとつ残っています|だけが残っています)/.test(
    thirdText
  );

if (thirdUnits.length >= 2 && (fourthLooksDirective || thirdLooksDirective)) {
  const residueUnit = String(thirdUnits.pop() ?? '').trim();
  const openEdgeText = thirdUnits.join(' ').trim();

  if (openEdgeText) {
    blocksText[2] = openEdgeText;
  }

  if (residueUnit) {
    blocksText[3] = residueUnit;
  } else if (fourthLooksDirective) {
    blocksText[3] = '';
  }
}
  }
}
if (ctxPackForWriter && typeof ctxPackForWriter === 'object') {
  (ctxPackForWriter as any).patternKey = patternKey;
  (ctxPackForWriter as any).patternBlocks = patternBlocksResult.blocks;
}

console.log(
  '[IROS/rephraseEngine][PATTERN_KEY_SAVE_TRACE]',
  JSON.stringify({
    traceId: (debug as any)?.traceId ?? null,
    conversationId: (debug as any)?.conversationId ?? null,
    userCode: (debug as any)?.userCode ?? null,
    patternKey,
    ctxPackPatternKeyAfterSave:
      ctxPackForWriter && typeof ctxPackForWriter === 'object'
        ? String((ctxPackForWriter as any).patternKey ?? '').trim() || null
        : null,
    metaExtraPatternKeyBeforeSave: String((metaExtra as any)?.patternKey ?? '').trim() || null,
    metaExtraCtxPackPatternKeyBeforeSave:
      String((metaExtra as any)?.ctxPack?.patternKey ?? '').trim() || null,
  })
);

(metaExtra as any).patternKey = patternKey;
(metaExtra as any).patternBlocks = patternBlocksResult.blocks;

    try {
      (metaExtra as any).ctxPack = {
        ...(metaExtra as any).ctxPack,
        patternKey,
        patternBlocks: patternBlocksResult.blocks,
      };
      (debug as any).patternKey = patternKey;
      (debug as any).patternBlocks = patternBlocksResult.blocks;
    } catch {}

    const slotDecision = computeSlotDecisionFromEngine({
      depthStage:
        String((ctxPackForWriter as any)?.depthStage ?? '').trim() || null,

      questionType: resolvedQuestionType,

      goalKind:
        String(
          (ctxPackForWriter as any)?.goalKind ??
            (ctxPackForWriter as any)?.targetKind ??
            ''
        ).trim() || null,

      deltaType:
        String(
          (ctxPackForWriter as any)?.flow?.deltaType ??
            (ctxPackForWriter as any)?.deltaType ??
            ''
        ).trim() || null,

      returnStreak:
        typeof (ctxPackForWriter as any)?.returnStreak === 'number' &&
        Number.isFinite((ctxPackForWriter as any).returnStreak)
          ? (ctxPackForWriter as any).returnStreak
          : 0,

      continuityKind:
        String((ctxPackForWriter as any)?.continuityKind ?? '').trim() || null,
    });
// ▼ 追加：slotDecision を ctxPack に正本として格納
if (slotDecision && typeof slotDecision === 'object') {
  if ((opts as any)?.ctxPack && typeof (opts as any).ctxPack === 'object') {
    (opts as any).ctxPack.slotDecision = slotDecision;
  }

  if ((opts as any)?.userContext?.ctxPack && typeof (opts as any).userContext.ctxPack === 'object') {
    (opts as any).userContext.ctxPack.slotDecision = slotDecision;
  }
}
    let usedSlotBlocksForDisplay = false;

    const normalizeBlockKey = (v: string): string =>
      String(v ?? '')
        .replace(/\s+/g, '')
        .replace(/[「」『』（）()［］\[\]{}｛｝、。,.!！?？:：・\-—―_]/g, '')
        .trim();

    const originalBlocks = (Array.isArray(blocksText) ? blocksText : [])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean);

    const lockedHead = originalBlocks.length > 0 ? originalBlocks[0] : '';

    const emitBlocksByEmphasis = (items: string[], emphasis: 1 | 2): string[] => {
      const cleaned = items.map((t) => String(t ?? '').trim()).filter(Boolean);
      if (cleaned.length === 0) return [];

      if (emphasis === 1) {
        return [cleaned.join('\n\n')];
      }

      if (cleaned.length === 1) {
        return [cleaned[0]];
      }

      if (cleaned.length === 2) {
        return [cleaned[0], cleaned[1]];
      }

      return [
        cleaned[0],
        cleaned.slice(1).join('\n\n'),
      ];
    };

    const stripSlotMarkerPrefix = (raw: string): string =>
      String(raw ?? '').replace(/^@[A-Z_]+\s*/, '').trim();

    const parseSlotPayload = (raw: string): any | null => {
      const body = stripSlotMarkerPrefix(raw);
      if (!body) return null;
      if (body.startsWith('{') || body.startsWith('[')) {
        return safeParseJson(body);
      }
      return null;
    };

    const pickSlotDisplayTexts = (key: SlotName, raw: string): string[] => {
      const payload = parseSlotPayload(raw);
      const out: string[] = [];

      const push = (v: any) => {
        const s = String(v ?? '').trim();
        if (!s) return;
        if (/^\{.*\}$/.test(s)) return;
        out.push(s);
      };

      const isNormalCompressedPattern =
        String(patternKey ?? '').trim() === 'NORMAL_COMPRESSED_V1';

        const naturalizeShift = (p: any): string | null => {
          const line = String(p?.line ?? '').trim();
          if (line) return line;
          return null;
        };

        const naturalizeNext = (p: any): string | null => {
          if (isNormalCompressedPattern) return null;

          const line = String(p?.line ?? '').trim();
          if (line) return line;

          return null;
        };


        const naturalizeSafe = (p: any): string | null => {
          const line = String(p?.line ?? '').trim();
          if (line) return line;
          return null;
        };

      if (payload && typeof payload === 'object') {
        if (key === 'OBS') {
          push((payload as any).line);
          push((payload as any).summary);
          push((payload as any).message);
        } else if (key === 'SHIFT') {
          push(naturalizeShift(payload));
        } else if (key === 'NEXT') {
          push(naturalizeNext(payload));
        } else if (key === 'SAFE') {
          push(naturalizeSafe(payload));
        }
      }
      if (out.length === 0) {
        const plain = stripSlotMarkerPrefix(raw);
        if (plain && !plain.startsWith('{') && !plain.startsWith('[')) {
          push(plain);
        }
      }

      return out.filter((s, i, arr) => arr.findIndex((x) => normalizeBlockKey(x) === normalizeBlockKey(s)) === i);
    };

    const extractedSlotsList = Array.isArray((extracted as any)?.slots)
      ? ((extracted as any).slots as any[])
      : [];

    const slotTextBuckets = new Map<SlotName, string[]>([
      ['OBS', []],
      ['SHIFT', []],
      ['NEXT', []],
      ['SAFE', []],
    ]);

    for (const s of extractedSlotsList) {
      const keyRaw = String((s as any)?.key ?? '').trim().toUpperCase();
      if (keyRaw !== 'OBS' && keyRaw !== 'SHIFT' && keyRaw !== 'NEXT' && keyRaw !== 'SAFE') continue;

      const picked = pickSlotDisplayTexts(keyRaw as SlotName, String((s as any)?.text ?? ''));
      for (const line of picked) {
        slotTextBuckets.get(keyRaw as SlotName)?.push(line);
      }
    }

    if ((slotTextBuckets.get('OBS') ?? []).length === 0 && originalBlocks.length > 0) {
      for (const block of originalBlocks) {
        slotTextBuckets.get('OBS')?.push(block);
      }
    }

    const slotDisplayBlocks: string[] = [];

    const pushUniqueDisplay = (text: string) => {
      const t = String(text ?? '').trim();
      if (!t) return;
      const key = normalizeBlockKey(t);
      if (!key) return;
      if (slotDisplayBlocks.some((x) => normalizeBlockKey(x) === key)) return;
      slotDisplayBlocks.push(t);
    };

    for (const role of slotDecision.order) {
      const emitted = emitBlocksByEmphasis(
        slotTextBuckets.get(role) ?? [],
        (slotDecision.emphasis?.[role] ?? 1) as 1 | 2,
      );

      for (const block of emitted) {
        pushUniqueDisplay(block);
      }
    }

    // 通常 slot を display 用 blocks として採用する。
    // BlockPlan は明示発動のまま維持し、ここでは通常スロットだけを blocks 化する。
    const activePatternKeyForDisplay = String((metaExtra as any)?.patternKey ?? '').trim();
    const isIRDetailPatternForDisplay =
      activePatternKeyForDisplay === 'IR_DETAIL_V1';

      const isTinyConnectorBlockForDisplay = (value: unknown): boolean => {
        if (!isIRDetailPatternForDisplay) return false;

        const normalized = String(value ?? '')
          .replace(/^#+\s*/u, '')
          .replace(/[\s*_`>「」『』（）()\[\]【】]/gu, '')
          .replace(/[、。,.!?！？…]+$/u, '')
          .trim();

        return /^(その|ただ|でも|そして|それで|一方で|つまり|だから|なお|また)$/u.test(normalized);
      };

      const canonicalPatternBlocks = (Array.isArray(blocksText) ? blocksText : [])
        .map((x) => String(x ?? '').trim())
        .filter((x) => Boolean(x) && !isTinyConnectorBlockForDisplay(x));

      const rawMarkdownBlocksForDisplay = String(text ?? '')
        .split(/\n{2,}/u)
        .map((x) => String(x ?? '').trim())
        .filter((x) => Boolean(x) && !isTinyConnectorBlockForDisplay(x));

      const shouldPreserveMarkdownRawForDisplay =
        (activePatternKeyForDisplay === 'IR_DETAIL_V1' ||
          (activePatternKeyForDisplay === 'NORMAL_DETAIL_V1' &&
            (resolvedQuestionType === 'structure' || resolvedQuestionType === 'meaning'))) &&
        /^##\s+/m.test(String(text ?? '')) &&
        rawMarkdownBlocksForDisplay.length > 0;

      const canonicalBlocksBySlot =
        shouldPreserveMarkdownRawForDisplay
          ? rawMarkdownBlocksForDisplay
          : (activePatternKeyForDisplay === 'NORMAL_DETAIL_V1' ||
              activePatternKeyForDisplay === 'DECLARATION_RESONANCE_V1')
            ? materializedBlocks
                .map((block) => String(block.text ?? '').trim())
                .filter(Boolean)
            : canonicalPatternBlocks;

    const expectedDisplayBlocks =
      Array.isArray(slotDecision?.order) && slotDecision.order.length > 0
        ? slotDecision.order.length
        : 4;

        const shouldPreferCanonicalBlocks =
          isIRDetailPatternForDisplay ||
          activePatternKeyForDisplay === 'DECLARATION_RESONANCE_V1' ||
          activePatternKeyForDisplay === 'IR_LIGHT_V1' ||
          (activePatternKeyForDisplay === 'NORMAL_COMPRESSED_V1'
            ? canonicalBlocksBySlot.length >= 2
            : canonicalBlocksBySlot.length >= expectedDisplayBlocks);
    if (shouldPreferCanonicalBlocks) {
      if (canonicalBlocksBySlot.length > 0) {
        slotBlocksText.push(...canonicalBlocksBySlot);
        blocksText = [...canonicalBlocksBySlot];
        usedSlotBlocksForDisplay = true;
      }
    } else if (slotDisplayBlocks.length > 0) {
      slotBlocksText.push(...slotDisplayBlocks);
      blocksText = [...slotDisplayBlocks];
      usedSlotBlocksForDisplay = true;
    }


    // REFERENCE_JUDGEMENT_DISPLAY_BLOCK_GUARD
    // reference_check の writerFirstLine を、renderGateway に渡る表示ブロックでも必ず先頭単独ブロックに固定する。
    {
      const referenceJudgeSeedForDisplayGuard =
        String((opts as any)?.extra?.referenceJudgeSeed ?? '').trim() ||
        String((opts as any)?.userContext?.ctxPack?.referenceJudgeSeed ?? '').trim() ||
        String((opts as any)?.userContext?.meta?.extra?.referenceJudgeSeed ?? '').trim() ||
        '';

      const writerFirstLineForDisplayGuard = (() => {
        const m = referenceJudgeSeedForDisplayGuard.match(/(?:^|\n)writerFirstLine=([^\n]+)/u);
        return String(m?.[1] ?? '').trim();
      })();

      const isReferenceCheckForDisplayGuard =
        /(?:^|\n)REFERENCE_JUDGEMENT:/u.test(referenceJudgeSeedForDisplayGuard) &&
        /(?:^|\n)askType=reference_check/u.test(referenceJudgeSeedForDisplayGuard) &&
        writerFirstLineForDisplayGuard.length > 0;

      if (isReferenceCheckForDisplayGuard) {
        const stripWriterFirstLine = (value: unknown): string => {
          const raw = String(value ?? '').trim();
          if (!raw) return '';
          if (raw === writerFirstLineForDisplayGuard) return '';
          if (raw.startsWith(writerFirstLineForDisplayGuard)) {
            return raw
              .slice(writerFirstLineForDisplayGuard.length)
              .replace(/^[\s　。．、,：:;；-]+/u, '')
              .trim();
          }
          return raw;
        };

        const sourceBlocksForDisplayGuard = Array.isArray(blocksText)
          ? blocksText.map((x) => String(x ?? '').trim()).filter(Boolean)
          : [];

        const restBlocksForDisplayGuard = sourceBlocksForDisplayGuard
          .map((x) => stripWriterFirstLine(x))
          .flatMap((x) =>
            String(x ?? '')
              .split(/\n{2,}/u)
              .map((v) => v.trim())
              .filter(Boolean)
          );

        const firstDisplayBlockForDisplayGuard =
          sourceBlocksForDisplayGuard[0]?.trim() ?? '';

        const startsWithJudgeForDisplayGuard =
          firstDisplayBlockForDisplayGuard.startsWith(writerFirstLineForDisplayGuard);

        const startsWithCompatibleJudgementForDisplayGuard =
          !startsWithJudgeForDisplayGuard &&
          (
            /^(いいえ|いえ|一致とは言えません|一致していません|完全には一致しません|沿っていません|その意味にはなりません|部分的には|一部は)/u.test(firstDisplayBlockForDisplayGuard) ||
            /(一致していません|沿っていません|とは言えません|その意味にはなりません|ではありません)/u.test(firstDisplayBlockForDisplayGuard)
          );

        const fixedBlocksForDisplayGuard = [
          ...(startsWithCompatibleJudgementForDisplayGuard ? [] : [writerFirstLineForDisplayGuard]),
          ...restBlocksForDisplayGuard,
        ].filter((v, i, arr) => {
          const s = String(v ?? '').trim();
          if (!s) return false;
          return i === 0 || s !== String(arr[0] ?? '').trim();
        });

        if (fixedBlocksForDisplayGuard.length > 0) {
          blocksText = [...fixedBlocksForDisplayGuard];
          slotBlocksText.splice(0, slotBlocksText.length, ...fixedBlocksForDisplayGuard);
          usedSlotBlocksForDisplay = true;

          console.log(
            '[IROS/rephraseEngine][REFERENCE_JUDGEMENT_DISPLAY_BLOCK_GUARD]',
            JSON.stringify({
              writerFirstLine: writerFirstLineForDisplayGuard,
              beforeHead: sourceBlocksForDisplayGuard.slice(0, 4),
              afterHead: fixedBlocksForDisplayGuard.slice(0, 4),
              blocksLen: fixedBlocksForDisplayGuard.length,
            })
          );
        }
      }
    }

    const directSlotDisplayUsed =
      slotBlocksText.length > 0 &&
      Array.isArray(blocksText) &&
      blocksText.length === slotBlocksText.length &&
      blocksText.every(
        (x, i) =>
          normalizeBlockKey(String(x ?? '')) ===
          normalizeBlockKey(String(slotBlocksText[i] ?? ''))
      );

    const reorderedTextBlocksUsed =
      !directSlotDisplayUsed &&
      usedSlotBlocksForDisplay &&
      slotBlocksText.length > 0 &&
      !isIRDetailPatternForDisplay;
      console.log(
        '[IROS/rephraseEngine][SLOT_BLOCKS_DIAG_STR]',
        JSON.stringify({
          traceId: (debug as any)?.traceId ?? null,
          conversationId: (debug as any)?.conversationId ?? null,
          userCode: (debug as any)?.userCode ?? null,
          slotBlocksLen: slotBlocksText.length,
          slotBlocksHead: slotBlocksText.map((x) => safeHead(String(x), 80)).slice(0, 6),
          canonicalBlocksBySlotLen: Array.isArray(canonicalBlocksBySlot)
            ? canonicalBlocksBySlot.length
            : 0,
          canonicalBlocksBySlotHead: Array.isArray(canonicalBlocksBySlot)
            ? canonicalBlocksBySlot.map((x) => safeHead(String(x), 80)).slice(0, 6)
            : [],
          directSlotDisplayUsed,
          reorderedTextBlocksUsed,
          pickedBlocksSource: usedSlotBlocksForDisplay
            ? 'rephraseBlocks_display'
            : 'raw_blocks',
          finalBlocksLen: Array.isArray(blocksText) ? blocksText.length : 0,
          note: usedSlotBlocksForDisplay
            ? 'rephraseBlocks_display_used'
            : 'slot_blocks_not_used',
          slotOrder: Array.isArray(slotDecision?.order) ? slotDecision.order : [],
          slotWeights: slotDecision?.weights ?? null,
          slotEmphasis: slotDecision?.emphasis ?? null,
          questionType: resolvedQuestionType ?? null,
        })
      );

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

    const blocks =
      shouldPreserveMarkdownRawForDisplay
        ? rawMarkdownBlocksForDisplay
            .map((t) => ({
              text: String(t ?? '').trim(),
              kind: 'p' as const,
            }))
            .filter((block) => block.text.length > 0)
        : (activePatternKeyForDisplay === 'NORMAL_DETAIL_V1' ||
            activePatternKeyForDisplay === 'DECLARATION_RESONANCE_V1' ||
            activePatternKeyForDisplay === 'NORMAL_RESONANCE_V1') &&
            Array.isArray(materializedBlocks) &&
            materializedBlocks.length > 0
          ? materializedBlocks
              .map((block) => ({
                text: String(block.text ?? '').trim(),
                kind: 'p' as const,
                slotKey: block.slotKey,
                blockKey: block.blockKey,
                heading: block.heading,
              }))
              .filter((block) => block.text.length > 0)
          : (Array.isArray(blocksText) ? blocksText : [])
              .map((t) => ({
                text: String(t ?? '').trim(),
                kind: 'p' as const,
              }))
              .filter((block) => block.text.length > 0);

    // ✅ 1回だけ代入（重複排除）
    metaExtra.rephraseBlocks = blocks;
    // ✅ signals を付与（受け口）
    try {
      (metaExtra as any).llmSignals = extractLlmSignals(String(text ?? ''));
    } catch {}

    // ✅ BLOCK_PLAN を meta.extra にも運ぶ（renderGateway/handleIrosReply が拾える受け口）
    // - ここで metaExtra.blockPlan を「丸ごと代入」すると、上で積んだ why/flags を消してしまう
    // - なので “追記” のみ行う
    try {
      if (blockPlan && typeof blockPlan === 'object') {
        const mode = (blockPlan as any).mode ?? null;
        const blocks = Array.isArray((blockPlan as any).blocks) ? (blockPlan as any).blocks : null;

        // blockPlan の器を保証（既存を壊さない）
        if (!metaExtra.blockPlan || typeof metaExtra.blockPlan !== 'object') metaExtra.blockPlan = {};

        // 追記（診断フィールドを保持したまま mode/blocks を載せる）
        if (mode) (metaExtra as any).blockPlanMode = mode;
        if (mode !== null) (metaExtra.blockPlan as any).mode = mode;
        if (blocks !== null) (metaExtra.blockPlan as any).blocks = blocks;
      }
    } catch {}

    metaExtra.rephraseHead =
      metaExtra.rephraseHead ??
      (blocks?.[0]?.text ? safeHead(String(blocks[0].text), 120) : null);

    try {
      (debug as any).rephraseBlocks = blocks;
      (debug as any).llmSignals = (metaExtra as any).llmSignals ?? null;
      (metaExtra as any).ctxPack = {
        ...(metaExtra as any).ctxPack,
        slotDecision,
      };
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

  const guardEnabled = envFlagEnabled(process.env.IROS_FLAGSHIP_GUARD_ENABLED, true);

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
  const userTextTrim = String(userText ?? '').trim();
  const userLenTiny = userTextTrim.length <= 2;
  const seedLenTiny = seedDraftTrim.length > 0 && seedDraftTrim.length <= 40;

  const userTextCompactForMicro = userTextTrim
    .replace(/\s+/g, '')
    .replace(/[。．.!！?？…]+$/g, '')
    .toLowerCase();

  // ✅ 「確かに！」系は、単なるmicro定型ではなく直前応答への接続反応。
  // ここで早期returnすると「了解です。」で流れが切れるため、通常writerへ通す。
  const isContinuationAckMicro =
    inputKind === 'micro' &&
    /^(たしかに|確かに|なるほど|それです|それだ|そうですね|そうです|ほんとそれ|本当それ)$/.test(
      userTextCompactForMicro,
    );

  // inputKind が 'micro' / 'greeting' を持っている場合もここで吸収
  // ただし continuation ack は吸収しない
  const microLikeEarly =
    !isContinuationAckMicro &&
    (
      inputKind === 'micro' ||
      inputKind === 'greeting' ||
      (userLenTiny && seedLenTiny)
    );

  const stripInternalAndHintLines = (src: string): string => {
    return String(src ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith('@'))
      .filter((line) => !/^(続けてください|つづけてください|続けて|つづけて)$/u.test(line))
      .join('\n')
      .trim();
  };

  const isEchoLike = (a: string, b: string): boolean => {
    const aa = String(a ?? '').trim();
    const bb = String(b ?? '').trim();
    if (!aa || !bb) return false;
    return aa === bb;
  };

  if (microLikeEarly) {
    const fixed: any = { ...(extracted as any) };

    const naturalSeed = stripInternalAndHintLines(seedDraftTrim);
    const shortFixed = getShortFixedPhrase(userTextTrim);

    // ✅ greeting は userText をそのまま返さない
    // ✅ ただし greeting/courtesy/thanks/fatigue は共通定型語 reply を優先する
    // ✅ micro も echo を避ける
    const visibleText = (() => {
      if (shortFixed) {
        return shortFixed.reply;
      }

      if (naturalSeed && !isEchoLike(naturalSeed, userTextTrim)) {
        return naturalSeed;
      }

      if (inputKind === 'micro') {
        return '了解です。';
      }

      return 'こんにちは。';
    })();

    fixed.OBS = {
      ...(fixed.OBS ?? {}),
      key: 'OBS',
      content: visibleText,
      head: visibleText,
    };

    return {
      ok: true,
      slots: fixed,
      meta: {
        inKeys: Object.keys((extracted as any) ?? {}),
        outKeys: ['OBS'],
        rawLen: visibleText.length,
        rawHead: visibleText.slice(0, 200),
        note: 'MICRO_LIKE_SKIP_REPHRASE',
        extra: {
          scaffoldActive: false,
          rephraseBlocks: [visibleText],
        },
      },
    } as any;
  }
}
/* =========================================
 * [置換] src/lib/iros/language/rephrase/rephraseEngine.full.ts
 * 目的:
 * - internalPack だけでなく、messages に注入されている injectedPack（assistant0 content）も検査する
 * - TEXT_SEED と 新形式 seed（FLOW_SEED_V1 / CARD_PACKET）の「どっちがどこにいるか」を確証ログで固定する
 * ========================================= */
{
  const pack = String(internalPack ?? '');
  console.log('[IROS/SEED_PACK_DUMP]', pack.slice(0, 1800));

  // marker は揺れるので広めに拾う（RESONANCE_STATE_SEED / RESONANCE_STATE / seedin）
  const seedIdx = pack.search(
    /RESONANCE_STATE_SEED\s*\(DO NOT OUTPUT\)|RESONANCE_STATE\b|seedin/i,
  );
  const seedNear =
    seedIdx >= 0
      ? pack.slice(Math.max(0, seedIdx - 140), Math.min(pack.length, seedIdx + 240))
      : null;

  // ✅ TEXT_SEED（internalPack 側に入る設計の可能性もあるので一応見る）
  const textSeedIdx = pack.search(/TEXT_SEED\s*\(DO NOT OUTPUT\)\s*:/i);
  const textSeedNear =
    textSeedIdx >= 0
      ? pack.slice(Math.max(0, textSeedIdx - 140), Math.min(pack.length, textSeedIdx + 260))
      : null;

  // ✅ 新形式 seed / flow（internalPack 側）
  const seedPatterns = [
    /FLOW_SEED_V1\b/i,
    /FLOW180_SEED\s*\(DO NOT OUTPUT\)\s*:/i,
    /FLOW:\s*\n/i,
  ];

  const hasMirrorFlowSeed =
  /MIRROR_FLOW_SEED_V1\b/.test(pack) ||
  /FLOW_SEED_V1\b/.test(pack) ||
  /FLOW:\s*\n/.test(pack);

  const flowSeedIdxInternal = (() => {
    const seedIdx = pack.search(/SEED\s*\(DO NOT OUTPUT\)\s*:/i);
    if (seedIdx >= 0) return seedIdx;

    return (
      seedPatterns
        .map((re) => pack.search(re))
        .find((n) => typeof n === 'number' && n >= 0) ?? -1
    );
  })();

  const flowSeedNearInternal =
    flowSeedIdxInternal >= 0
      ? pack.slice(
          Math.max(0, flowSeedIdxInternal - 140),
          Math.min(pack.length, flowSeedIdxInternal + 420),
        )
      : null;

  console.log('[IROS/SEED_NEAR]', flowSeedNearInternal);
  // ✅ messages 側（注入された assistant pack）も検査する
// - 先頭の assistant（通常: COORD + FLOW_SEED_V1 + FLOW180_SEED が入る）を拾う
  const assistant0 = (messages as any[])?.find((m) => m?.role === 'assistant') ?? null;
  const injectedPack = String((assistant0 as any)?.content ?? '');

  const injectedTextSeedIdx = injectedPack.search(/TEXT_SEED\s*\(DO NOT OUTPUT\)\s*:/i);
  const injectedTextSeedNear =
    injectedTextSeedIdx >= 0
      ? injectedPack.slice(
          Math.max(0, injectedTextSeedIdx - 140),
          Math.min(injectedPack.length, injectedTextSeedIdx + 300),
        )
      : null;

      const injectedFlowSeedIdx = seedPatterns
      .map((re) => injectedPack.search(re))
      .find((n) => typeof n === 'number' && n >= 0);

    const injectedFlowSeedNear =
      typeof injectedFlowSeedIdx === 'number' && injectedFlowSeedIdx >= 0
        ? injectedPack.slice(
            Math.max(0, injectedFlowSeedIdx - 140),
            Math.min(injectedPack.length, injectedFlowSeedIdx + 420),
          )
        : null;
}
// ✅ writer input pack debug (LEN)
// - 現在の正本は messages（callWriterLLM に渡す実体）
// - writerArgs(pack) 系は legacy として補助表示（0でも異常ではない）
{
  const traceId = (opts as any)?.traceId ?? (opts as any)?.extra?.traceId ?? null;

  // ---- messages-based (source of truth) ----
  const msgs = Array.isArray(messages) ? (messages as any[]) : [];
  const sys = msgs.filter((m) => m?.role === 'system').map((m) => String(m?.content ?? '')).join('\n');
  const usr = msgs.filter((m) => m?.role === 'user').map((m) => String(m?.content ?? '')).join('\n');
  const ast = msgs.filter((m) => m?.role === 'assistant').map((m) => String(m?.content ?? '')).join('\n');

  const msg_total_chars = JSON.stringify(msgs).length;
  const msg_total_tokens_approx = Math.ceil(msg_total_chars / 4);

  // ---- legacy pack-based (may be empty depending on call path) ----
  const wa: any = (opts as any)?.writerArgs ?? (opts as any)?.extra?.writerArgs ?? {};
  const systemPrompt = String(wa?.systemPrompt ?? '');
  const internalPack = String(wa?.internalPack ?? '');
  const topicDigest = String(wa?.topicDigest ?? '');
  const conversationLine = String(wa?.conversationLine ?? '');
  const turns = Array.isArray(wa?.turns) ? wa.turns : [];
  const turns_json_len = JSON.stringify(turns).length;

  const legacy_pack_total_chars =
    systemPrompt.length +
    topicDigest.length +
    conversationLine.length +
    internalPack.length +
    turns_json_len;

  console.log('[IROS/LLM][WRITER_IN_PACK_LEN]', {
    traceId,
    conversationId: (opts as any)?.conversationId ?? null,
    userCode: (opts as any)?.userCode ?? null,

    // ✅ source-of-truth
    messages_len: msgs.length,
    msg_total_chars,
    msg_total_tokens_approx,
    system_len_from_messages: sys.length,
    user_total_len: usr.length,
    assistant_total_len: ast.length,

    // 🧩 legacy (補助・0でもOK)
    legacy_system_len: systemPrompt.length,
    legacy_topicDigest_len: topicDigest.length,
    legacy_conversationLine_len: conversationLine.length,
    legacy_internalPack_len: internalPack.length,
    legacy_turns_json_len: turns_json_len,
    legacy_pack_total_chars,
    legacy_pack_total_tokens_approx: Math.ceil(legacy_pack_total_chars / 4),
  });
}


raw = await (async () => {
  // ✅ V3 fix: messages が正本なので、ここで STATE_CUES を “internal assistant message” として注入する
  // - writerArgs(topicDigest/conversationLine/internalPack) が空でも、毎ターン必ず効く
  // - topic復元は historyDigestV1 を TOPIC として messages に入れることで担保する

  const baseMsgs = Array.isArray(messages) ? (messages as any[]) : [];

  const __sanitizeAssistantContinuity = (input: string): string => {
    let s = String(input ?? '');
    if (!s) return s;

    const lines = s
      .split(/\r?\n/)
      .map((v) => String(v ?? '').trim())
      .filter(Boolean);

    const bannedLinePatterns: RegExp[] = [
      // 1) オウム返し
      /そうなんだね/i,
      /なんだね[。．!！?？]*$/i,
      /という感じなんだね/i,
      /残ってるんだね/i,

      // 2) 時間誘導
      /\b\d+\s*分(?:だけ)?\b/,
      /\b\d+\s*時間(?:だけ)?\b/,
      /30\s*[〜~\-]\s*60\s*分/,
      /ここからここまで/,
      /今日は.*終える/,
      /締めを.*作って終える/,

      // 3) 身体誘導
      /呼吸して/,
      /体を動かして/,
      /少し休んで/,
      /休みに寄せる/,
      /落ち着いて/,

      // 4) コーチ断定
      /いちばん効きます/,
      /効きます/,
      /したほうがいい/,
      /まず.*が大事/,
      /最初に整えるのは/,
      /動きやすいです/,
      /戻りやすいです/,

      // 5) 具体例持ち越し
      /机の上.*片づける/,
      /明日やること.*メモ/,
      /動画やSNS/,
    ];

    const kept = lines.filter((line) => {
      return !bannedLinePatterns.some((re) => re.test(line));
    });

    let out = kept.join('\n').trim();

    // 文中に残る時間表現なども念のため削る
    out = out
      .replace(/\b\d+\s*分(?:だけ)?\b/g, '')
      .replace(/\b\d+\s*時間(?:だけ)?\b/g, '')
      .replace(/30\s*[〜~\-]\s*60\s*分/g, '')
      .replace(/ここからここまで/g, '')
      .replace(/いちばん効きます/g, '')
      .replace(/したほうがいい/g, '')
      .replace(/動きやすいです/g, '動きやすくなります')
      .replace(/戻りやすいです/g, '戻りやすくなります')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // 全消しは避ける
    if (!out) {
      const firstSafe = lines.find((line) => {
        return !bannedLinePatterns.some((re) => re.test(line));
      });
      return String(firstSafe ?? '').trim();
    }

    return out;
  };

  const sanitizedBaseMsgs = baseMsgs.map((m: any) => {
    const role = String(m?.role ?? '');
    const content = String(m?.content ?? '');

    // system はそのまま
    if (role === 'system') return m;

    // assistant のうち、内部注入パックはそのまま
    if (
      role === 'assistant' &&
      (
        /COORD\s*\(DO NOT OUTPUT\):/i.test(content) ||
        /FLOW_SEED_V1\b/i.test(content) ||
        /FLOW180\s*\(DO NOT OUTPUT\):/i.test(content) ||
        /FLOW180_SEED\s*\(DO NOT OUTPUT\):/i.test(content) ||
        /FLOW_CONTEXT\s*\(DO NOT OUTPUT\):/i.test(content) ||
        /STATE_CUES\s*\(DO NOT OUTPUT\)/i.test(content) ||
        /FLOW:\s*\n/i.test(content) ||
        /SEED\s*\(DO NOT OUTPUT\):/i.test(content) ||
        /FIRST_LINE_FORCE:/i.test(content) ||
        /TRANSITION_STRUCT:/i.test(content)
      )
    ) {
      return m;
    }
    // 通常 assistant 履歴だけ sanitize
    if (role === 'assistant') {
      const nextContent = __sanitizeAssistantContinuity(content);
      return { ...m, content: nextContent };
    }

    // user はそのまま
    return m;
  });

  // 既に注入済みなら二重に入れない（安全策）
  const alreadyHasStateCues = baseMsgs.some((m) => {
    const roleOk = String(m?.role ?? '') === 'assistant';
    const c = String(m?.content ?? '');
    return (
      roleOk &&
      (
        c.includes('STATE_CUES (DO NOT OUTPUT)') ||
        c.includes('STATE_CUES_V3 (DO NOT OUTPUT)')
      )
    );
  });

  const pastStateNoteText = String(
    (opts as any)?.extra?.pastStateNoteText ??
    (opts as any)?.userContext?.pastStateNoteText ??
    (opts as any)?.userContext?.meta?.extra?.pastStateNoteText ??
    ''
  ).trim();

  const pastStateTriggerKind = String(
    (opts as any)?.extra?.pastStateTriggerKind ??
    (opts as any)?.userContext?.pastStateTriggerKind ??
    (opts as any)?.userContext?.meta?.extra?.pastStateTriggerKind ??
    ''
  ).trim();

  const pastStateKeyword = String(
    (opts as any)?.extra?.pastStateKeyword ??
    (opts as any)?.userContext?.pastStateKeyword ??
    (opts as any)?.userContext?.meta?.extra?.pastStateKeyword ??
    ''
  ).trim();

  const storyModeForPastStateNote = String(
    (opts as any)?.ctxPack?.storyMode ??
      (opts as any)?.userContext?.ctxPack?.storyMode ??
      (opts as any)?.meta?.extra?.ctxPack?.storyMode ??
      (opts as any)?.extra?.ctxPack?.storyMode ??
      ''
  ).trim();

  const isStoryModeForPastStateNote =
    storyModeForPastStateNote === 'undigested_story' ||
    storyModeForPastStateNote === 'remake_story';

  const isStoryLikePastStateNote =
    /(未消化|闇の物語|先祖からつながる闇|リメイク物語|リメイクしてください|再統合|統合へ向かう物語)/u.test(
      pastStateNoteText,
    );

  const isNewQuotedReferenceSourceForStateCues =
    (opts as any)?.extra?.ctxPack?.newQuotedReferenceSource === true ||
    (opts as any)?.ctxPack?.newQuotedReferenceSource === true ||
    (opts as any)?.userContext?.ctxPack?.newQuotedReferenceSource === true ||
    (opts as any)?.userContext?.meta?.extra?.ctxPack?.newQuotedReferenceSource === true;

  const effectivePastStateNoteText =
    isNewQuotedReferenceSourceForStateCues
      ? ''
      : isStoryLikePastStateNote && !isStoryModeForPastStateNote
        ? ''
        : pastStateNoteText;

  if (isStoryLikePastStateNote && !isStoryModeForPastStateNote) {
    console.log(
      '[IROS/PAST_STATE][story_note_filtered]',
      JSON.stringify({
        traceId: String((opts as any)?.traceId ?? (opts as any)?.extra?.traceId ?? ''),
        storyMode: storyModeForPastStateNote || null,
        pastStateTriggerKind: pastStateTriggerKind || null,
        pastStateKeyword: pastStateKeyword || null,
        originalLen: pastStateNoteText.length,
        head: safeHead(pastStateNoteText, 200),
      }),
    );
  }

  console.log(
    `[IROS/PAST_STATE][raw_values] traceId=${String((opts as any)?.traceId ?? (opts as any)?.extra?.traceId ?? '')}` +
      ` len=${effectivePastStateNoteText.length}` +
      ` trigger=${pastStateTriggerKind || '(null)'}` +
      ` keyword=${pastStateKeyword || '(null)'}` +
      ` head=${safeHead(effectivePastStateNoteText, 200)}`
  );
  const questionForWriter =
    ((opts as any)?.ctxPack?.question &&
    typeof (opts as any).ctxPack.question === 'object')
      ? (opts as any).ctxPack.question
      : ((opts as any)?.userContext?.ctxPack?.question &&
          typeof (opts as any).userContext.ctxPack.question === 'object')
        ? (opts as any).userContext.ctxPack.question
        : (opts as any)?.extra?.question ??
          (opts as any)?.userContext?.question ??
          (opts as any)?.userContext?.meta?.extra?.question ??
          null;
          const questionDomainForWriter = String(
            (questionForWriter as any)?.domain ?? ''
          ).trim();

          const stateCuesPatternKey =
            selectSlotPattern({
              line: String(
                (opts as any)?.meta?.extra?.presentationKind ??
                  (opts as any)?.userContext?.meta?.extra?.presentationKind ??
                  ''
              )
                .trim()
                .toLowerCase(),
              questionType: null,
              detailMode:
                (opts as any)?.ctxPack?.detailMode === true ||
                (opts as any)?.userContext?.ctxPack?.detailMode === true,
              followupText: String((opts as any)?.userText ?? '').trim(),
              userText: String((opts as any)?.userText ?? '').trim(),
              targetLabel: null,
              hasPriorDiagnosis: false,
            }) ?? '';

          const suppressQuestionMetaForStateCues =
            stateCuesPatternKey === 'DECLARATION_RESONANCE_V1' ||
            stateCuesPatternKey === 'NORMAL_RESONANCE_V1';
          const questionTypeForWriterRaw = String(
            (questionForWriter as any)?.questionType ?? ''
          ).trim();

          const questionTModeForWriterRaw = String(
            (questionForWriter as any)?.tState?.mode ?? ''
          ).trim();

          const questionFocusForWriterRaw = String(
            ((questionForWriter as any)?.tState?.focus ??
              (Array.isArray((questionForWriter as any)?.iframe?.focusCandidate)
                ? (questionForWriter as any).iframe.focusCandidate[0]
                : '')) ?? ''
          ).trim();

          const questionTypeForWriter = suppressQuestionMetaForStateCues
            ? ''
            : questionTypeForWriterRaw;

          const questionTModeForWriter = suppressQuestionMetaForStateCues
            ? ''
            : questionTModeForWriterRaw;

          const questionFocusForWriter = suppressQuestionMetaForStateCues
            ? ''
            : questionFocusForWriterRaw;

          const questionPolicyForWriter = (() => {
            const p = (questionForWriter as any)?.outputPolicy;
            if (!p || typeof p !== 'object') return null;
            try {
              return safeHead(JSON.stringify(p), 280);
            } catch {
              return safeHead(String(p), 280);
            }
          })();

          const questionIFrameKeysForWriter = suppressQuestionMetaForStateCues
            ? []
            : (() => {
                const hs = Array.isArray((questionForWriter as any)?.iframe?.hypothesisSpace)
                  ? (questionForWriter as any).iframe.hypothesisSpace
                  : [];
                const keys = hs
                  .map((x: any) => String(x?.key ?? '').trim())
                  .filter(Boolean)
                  .slice(0, 6);
                return keys.length > 0 ? keys : [];
              })();

          const isDiagnosisFollowupForStateCues =
    (opts as any)?.meta?.extra?.ctxPack?.diagnosisFollowup === true ||
    (opts as any)?.meta?.extra?.diagnosisFollowup === true ||
    (opts as any)?.ctxPack?.diagnosisFollowup === true ||
    (opts as any)?.userContext?.ctxPack?.diagnosisFollowup === true ||
    String((opts as any)?.meta?.extra?.ctxPack?.continuityKind ?? '').trim() === 'diagnosis_followup' ||
    String((opts as any)?.ctxPack?.continuityKind ?? '').trim() === 'diagnosis_followup' ||
    String((opts as any)?.userContext?.ctxPack?.continuityKind ?? '').trim() === 'diagnosis_followup' ||
    Boolean((opts as any)?.meta?.extra?.ctxPack?.lastIrDiagnosis) ||
    Boolean((opts as any)?.meta?.extra?.lastIrDiagnosis) ||
    Boolean((opts as any)?.ctxPack?.lastIrDiagnosis) ||
    Boolean((opts as any)?.userContext?.ctxPack?.lastIrDiagnosis);

  const stateCuesText = (() => {
            const currentStateBits = [
              `depthStage=${typeof pickedDepthStage !== 'undefined' ? String(pickedDepthStage) : 'null'}`,
              `phase=${typeof pickedPhase !== 'undefined' ? String(pickedPhase) : 'null'}`,
              `qCode=${typeof pickedQCode !== 'undefined' ? String(pickedQCode) : 'null'}`,
            ].join(' / ');

            const digestTopic = safeHead(
              String((historyDigestV1 as any)?.topic?.situationTopic ?? ''),
              120
            );

            const digestSummary = safeHead(
              String((historyDigestV1 as any)?.topic?.situationSummary ?? ''),
              160
            );

            const lastUserCore = safeHead(
              String((historyDigestV1 as any)?.continuity?.last_user_core ?? ''),
              200
            );

            const allowRealityAskBackForWriter = (() => {
              const raw = [
                (opts as any)?.userText,
                (historyDigestV1 as any)?.topic?.situationTopic,
                (historyDigestV1 as any)?.topic?.situationSummary,
                (historyDigestV1 as any)?.continuity?.last_user_core,
              ]
                .map((v) => String(v ?? '').trim())
                .filter(Boolean)
                .join('\n');

              if (!raw) return false;

              // ✅ 現実行動・予定・イベント・人/場所/日程など、
              // ユーザーの現実を受け取りに行かないと会話が閉じる領域だけ質問を許可する。
              return /(イベント|開催|日程|場所|会場|福岡|打ち合わせ|ミーティング|予定|会う|送る|決める|申し込み|申込み|販売|制作|投稿|公開|契約|予約|参加|誰と|一緒に動く|現実に動|現実の側|動き始め|彼|彼女|旦那|夫|妻|恋人|好きな人|浮気|不倫|連絡|返信|返事|既読|未読|不安|心配|関係|距離感|別れ|喧嘩|仲直り|復縁|嫌われ|待てない|イライラ)/.test(raw);
            })();

            const askBackAllowedValue = (() => {
              if (allowRealityAskBackForWriter) return true;
              if (suppressQuestionMetaForStateCues) return false;
              const v = (questionForWriter as any)?.outputPolicy?.askBackAllowed;
              return typeof v === 'boolean' ? v : null;
            })();

            const answerFirstValue = (() => {
              const v = (questionForWriter as any)?.outputPolicy?.answerFirst;
              return typeof v === 'boolean' ? v : null;
            })();

            const avoidPrematureClosureValue = (() => {
              const v = (questionForWriter as any)?.outputPolicy?.avoidPrematureClosure;
              return typeof v === 'boolean' ? v : null;
            })();

            const responseGoal = (() => {
              if (suppressQuestionMetaForStateCues) return null;
              if (questionTypeForWriter === 'meaning' && questionTModeForWriter === 'confirm') {
                return 'explain_then_optional_question';
              }
              if (questionTypeForWriter === 'meaning') {
                return 'explain_first';
              }
              if (questionTypeForWriter) {
                return `respond_for_${questionTypeForWriter}`;
              }
              return null;
            })();

    const topicValue =
      lastUserCore ||
      digestSummary ||
      digestTopic ||
      safeHead(String((opts as any)?.userText ?? ''), 200);

    const relationshipContextForWriter = (() => {
      const raw = [
        (opts as any)?.userText,
        digestTopic,
        digestSummary,
        lastUserCore,
        effectivePastStateNoteText,
        (ctxPackForWriter as any)?.relationship?.label,
        (ctxPackForWriter as any)?.relationship?.kind,
        (ctxPackForWriter as any)?.targetKind,
        (ctxPackForWriter as any)?.targetLabel,
      ]
        .map((v) => String(v ?? '').trim())
        .filter(Boolean)
        .join('\n');

      const norm = raw.toLowerCase();

      const hasAny = (words: string[]) => words.some((word) => norm.includes(word.toLowerCase()));

      const memoryIntentForWriter = String((ctxPackForWriter as any)?.memoryIntent ?? '').trim();
      const memoryTargetLabelForWriter = String((ctxPackForWriter as any)?.memoryTargetLabel ?? '').trim();
      const memoryTargetKeyForWriter = String((ctxPackForWriter as any)?.memoryTargetKey ?? '').trim();
      const relationshipMemoryTargetForWriter =
        memoryIntentForWriter === 'relationship_recall'
          ? memoryTargetLabelForWriter || memoryTargetKeyForWriter
          : '';

      const businessWords = [
        'クライアント',
        '顧客',
        '案件',
        '仕事',
        '提案',
        '契約',
        '法人',
        '経営',
        '事業',
        '共同研究',
        '研究',
        '管理',
        '責任範囲',
        '責任',
        '進行',
        '段取り',
        '打ち合わせ',
        'ミーティング',
        '商談',
        '納品',
        '見積',
        '請求',
      ];

      const collaborationWords = [
        '共同',
        '協業',
        'パートナー',
        'チーム',
        'プロジェクト',
        '一緒に進める',
        '連携',
      ];

      const familyWords = [
        '家族',
        '父',
        '母',
        '親',
        '子ども',
        '子供',
        '兄',
        '弟',
        '姉',
        '妹',
        '夫',
        '妻',
        '旦那',
      ];

      const friendshipWords = [
        '友達',
        '友人',
        '親友',
        '仲間',
      ];

      const romanceWords = [
        '恋愛',
        '好き',
        '付き合',
        '彼氏',
        '彼女',
        '元彼',
        '元カレ',
        '元彼女',
        '元カノ',
        'デート',
        '復縁',
        '片思い',
        '告白',
        '会いたい',
        'line',
        'ライン',
        '既読',
        '未読',
      ];

      if (hasAny(businessWords)) {
        return {
          domain: 'business',
          relation: hasAny(['クライアント', '顧客']) ? 'client' : 'work_person',
          certainty: 'high',
          instruction:
            '仕事・案件・合意・責任範囲・段取り・進行の文脈として補完する。恋愛文脈へ寄せない。',
        };
      }

      if (hasAny(collaborationWords)) {
        return {
          domain: 'collaboration',
          relation: 'collaborator',
          certainty: 'medium',
          instruction:
            '共同作業・役割分担・進行温度差の文脈として補完する。恋愛文脈へ寄せない。',
        };
      }

      if (hasAny(familyWords)) {
        return {
          domain: 'family',
          relation: 'family',
          certainty: 'medium',
          instruction:
            '家族内の距離感・役割・守ろうとしているものの文脈として補完する。',
        };
      }

      if (hasAny(friendshipWords)) {
        return {
          domain: 'friendship',
          relation: 'friend',
          certainty: 'medium',
          instruction:
            '友人関係・信頼・距離感の文脈として補完する。恋愛文脈へ寄せない。',
        };
      }

      if (hasAny(romanceWords)) {
        return {
          domain: 'romance',
          relation: 'romantic_person',
          certainty: 'high',
          instruction:
            '恋愛・好意・連絡温度・関係進行の文脈として補完してよい。',
        };
      }

      // RELATIONSHIP_MEMORY_CONTEXT_PRIORITY
      // 保存済み Relationship Memory がある場合は unknown_person より優先する
      const relationshipMemoryForContext = (ctxPackForWriter as any)?.relationshipMemory;
      const relationshipMemoryDisplayNameForContext =
        relationshipMemoryForContext && typeof relationshipMemoryForContext === 'object'
          ? String(
              relationshipMemoryForContext.displayName ??
                relationshipMemoryForContext.display_name ??
                '',
            ).trim()
          : '';

      const relationshipMemoryRoleForContext =
        relationshipMemoryForContext && typeof relationshipMemoryForContext === 'object'
          ? String(relationshipMemoryForContext.role ?? '').trim()
          : '';

      if (relationshipMemoryDisplayNameForContext) {
        return {
          domain: 'known_person',
          relation: safeHead(relationshipMemoryDisplayNameForContext, 80),
          certainty: 'memory',
          instruction:
            `保存済みRelationship Memoryを優先し、「${safeHead(relationshipMemoryDisplayNameForContext, 80)}」との関係文脈として扱う。関係種別は${relationshipMemoryRoleForContext ? `role=${safeHead(relationshipMemoryRoleForContext, 40)}` : '未確定'}として、恋愛・仕事・家族へ勝手に寄せず、保存済みの関係メモリと直近の発話を根拠に読む。`,
        };
      }

      if (relationshipMemoryTargetForWriter) {
        return {
          domain: 'neutral_person',
          relation: 'unknown_person',
          certainty: 'medium',
          instruction:
            `対象名は「${safeHead(relationshipMemoryTargetForWriter, 80)}」として特定済み。ただし恋愛・仕事・家族などの関係種別は未確定。名前そのものではなく、その人との関係のズレ・距離感・反応点として読む。`,
        };
      }

      return {
        domain: 'neutral_person',
        relation: 'unknown_person',
        certainty: 'low',
        instruction:
          '関係性は未確定。恋愛・仕事・家族などへ決めつけず、一般的な対人文脈として補完する。',
      };
    })();


    const lines: string[] = [];
    lines.push('【STATE_CUES (DO NOT OUTPUT)】');
    lines.push(`CURRENT_STATE: ${currentStateBits}`);

    if (topicValue) {
      lines.push(`TOPIC: userStatement=${topicValue}`);
    }
    if (digestTopic) {
      lines.push(`TOPIC_HINT: ${digestTopic}`);
    }

    const intentBits = [
      questionDomainForWriter ? `domain=${safeHead(questionDomainForWriter, 80)}` : '',
      questionTypeForWriter ? `type=${safeHead(questionTypeForWriter, 80)}` : '',
      questionTModeForWriter ? `mode=${safeHead(questionTModeForWriter, 80)}` : '',
      questionFocusForWriter ? `focus=${safeHead(questionFocusForWriter, 120)}` : '',
    ].filter(Boolean);

    if (intentBits.length > 0) {
      lines.push(`INTENT: ${intentBits.join(' / ')}`);
    }

    if (relationshipContextForWriter) {
      lines.push(
        `RELATIONSHIP_CONTEXT: domain=${relationshipContextForWriter.domain} / relation=${relationshipContextForWriter.relation} / certainty=${relationshipContextForWriter.certainty}`,
      );
      lines.push(`RELATIONSHIP_INSTRUCTION: ${relationshipContextForWriter.instruction}`);

      const relationshipMemoryForStateCues = (ctxPackForWriter as any)?.relationshipMemory;
      if (relationshipMemoryForStateCues && typeof relationshipMemoryForStateCues === 'object') {
        const relationshipMemoryDisplayName = String(
          relationshipMemoryForStateCues.displayName ??
            relationshipMemoryForStateCues.display_name ??
            '',
        ).trim();

        const relationshipMemoryRole = String(
          relationshipMemoryForStateCues.role ?? '').trim();

        const relationshipMemoryConfidence = String(
          relationshipMemoryForStateCues.confidence ?? '').trim();

        const relationshipMemoryTopics = Array.isArray(
          relationshipMemoryForStateCues.unresolvedTopics ??
            relationshipMemoryForStateCues.unresolved_topics,
        )
          ? (
              relationshipMemoryForStateCues.unresolvedTopics ??
              relationshipMemoryForStateCues.unresolved_topics
            )
              .map((v: unknown) => String(v ?? '').trim())
              .filter(Boolean)
              .slice(0, 3)
              .join(' / ')
          : '';

        const relationshipMemoryReactions = Array.isArray(
          relationshipMemoryForStateCues.userReactionPattern ??
            relationshipMemoryForStateCues.user_reaction_pattern,
        )
          ? (
              relationshipMemoryForStateCues.userReactionPattern ??
              relationshipMemoryForStateCues.user_reaction_pattern
            )
              .map((v: unknown) => String(v ?? '').trim())
              .filter(Boolean)
              .slice(0, 2)
              .join(' / ')
          : '';

        const relationshipMemoryBits = [
          relationshipMemoryDisplayName ? `displayName=${safeHead(relationshipMemoryDisplayName, 80)}` : '',
          relationshipMemoryRole ? `role=${safeHead(relationshipMemoryRole, 40)}` : '',
          relationshipMemoryConfidence ? `confidence=${safeHead(relationshipMemoryConfidence, 40)}` : '',
        ].filter(Boolean);

        if (relationshipMemoryBits.length > 0) {
          lines.push(`RELATIONSHIP_MEMORY: ${relationshipMemoryBits.join(' / ')}`);
        }

        if (relationshipMemoryTopics) {
          lines.push(`RELATIONSHIP_MEMORY_TOPICS: ${safeHead(relationshipMemoryTopics, 240)}`);
        }

        if (relationshipMemoryReactions) {
          lines.push(`RELATIONSHIP_MEMORY_REACTION: ${safeHead(relationshipMemoryReactions, 260)}`);
        }
      }
    }

    if (responseGoal) {
      lines.push(`RESPONSE_GOAL: ${responseGoal}`);
    }

    const constraintBits = [
      answerFirstValue === null ? '' : `answerFirst=${String(answerFirstValue)}`,
      askBackAllowedValue === null
        ? ''
        : `askBack=${askBackAllowedValue ? 'allowed' : 'blocked'}`,
      avoidPrematureClosureValue === null
        ? ''
        : `avoidPrematureClosure=${String(avoidPrematureClosureValue)}`,
    ].filter(Boolean);

    if (constraintBits.length > 0) {
      lines.push(`CONSTRAINT: ${constraintBits.join(' / ')}`);
    }

    if (questionIFrameKeysForWriter.length > 0) {
      lines.push(`HYPOTHESIS_KEYS: ${questionIFrameKeysForWriter.join(', ')}`);
    }

    if (effectivePastStateNoteText && !isDiagnosisFollowupForStateCues) {
      lines.push('PAST_STATE_RECALL: enabled');
      if (pastStateTriggerKind) lines.push(`PAST_STATE_TRIGGER: ${safeHead(pastStateTriggerKind, 80)}`);
      if (pastStateKeyword) lines.push(`PAST_STATE_KEYWORD: ${safeHead(pastStateKeyword, 120)}`);
      lines.push(`PAST_STATE_NOTE: ${safeHead(effectivePastStateNoteText, 900)}`);
    }

    return lines.join('\n');
  })();

  const shouldInjectStateCues =
    stateCuesPatternKey !== 'NORMAL_COMPRESSED_V1' &&
    !alreadyHasStateCues &&
    !!stateCuesText.trim() &&
    !!effectivePastStateNoteText &&
    !isDiagnosisFollowupForStateCues;

  const stateCuesMsg =
    shouldInjectStateCues
      ? ({ role: 'assistant', content: stateCuesText } as const)
      : null;

  // 今回は軽量優先:
  // ただし pastStateNoteText がある時だけは STATE_CUES_V3 を assistant message として注入する。
  const messagesForWriter = stateCuesMsg
  ? sanitizedBaseMsgs.length > 0 && sanitizedBaseMsgs[0]?.role === 'system'
    ? [sanitizedBaseMsgs[0], stateCuesMsg, ...sanitizedBaseMsgs.slice(1)]
    : [stateCuesMsg, ...sanitizedBaseMsgs]
  : sanitizedBaseMsgs;

  const injectedStateCues = !!stateCuesMsg;

  const stateCuesDisabledReason =
    stateCuesMsg
      ? null
      : 'DISABLED_FOR_LIGHTWEIGHT_WRITER';

  console.log('[IROS/STATE_CUES][inject]', {
    traceId: debug.traceId ?? null,
    baseLen: baseMsgs.length,
    finalLen: messagesForWriter.length,
    injected: injectedStateCues,
    disabled: !injectedStateCues,
    disabledReason: stateCuesDisabledReason,
    hasStateCues: messagesForWriter.some((m) => {
      const c = String(m?.content ?? '');
      return (
        c.includes('STATE_CUES (DO NOT OUTPUT)') ||
        c.includes('STATE_CUES_V3 (DO NOT OUTPUT)')
      );
    }),
    stateCuesHead: safeHead(
      String(
        (
          messagesForWriter.find((m) => {
            const c = String(m?.content ?? '');
            return (
              c.includes('STATE_CUES (DO NOT OUTPUT)') ||
              c.includes('STATE_CUES_V3 (DO NOT OUTPUT)')
            );
          }) as any
        )?.content ?? ''
      ),
      1600
    ),
    digest_has: !!historyDigestV1,
    digest_kind:
      historyDigestV1 == null
        ? 'null'
        : Array.isArray(historyDigestV1)
          ? 'array'
          : typeof historyDigestV1,
    digest_topic: safeHead(
      String((historyDigestV1 as any)?.topic?.situationTopic ?? ''),
      120
    ),
    digest_summary: safeHead(
      String((historyDigestV1 as any)?.topic?.situationSummary ?? ''),
      160
    ),
    digest_last_user_core: safeHead(
      String((historyDigestV1 as any)?.continuity?.last_user_core ?? ''),
      200
    ),
    digest_last_assistant_core: safeHead(
      String((historyDigestV1 as any)?.continuity?.last_assistant_core ?? ''),
      200
    ),
    digest_repeat_signal: !!((historyDigestV1 as any)?.continuity?.repeat_signal),
  });
  const __writerAssistantCandidates = messagesForWriter.filter(
    (m) => m?.role === 'assistant' && typeof m?.content === 'string'
  );

  const __writerInjectedPackAssistant =
  __writerAssistantCandidates.find((m) => {
    const c = String(m?.content ?? '');
    return (
      /SEED\s*\(DO NOT OUTPUT\):/i.test(c) ||
      /COORD\s*\(DO NOT OUTPUT\):/i.test(c) ||
      /FLOW_V2\s*\(DO NOT OUTPUT\):/i.test(c) ||
      /FLOW_SEED_V1\b/i.test(c) ||
      /FLOW180_SEED\s*\(DO NOT OUTPUT\):/i.test(c) ||
      /FLOW_CONTEXT\s*\(DO NOT OUTPUT\):/i.test(c) ||
      /FLOW:\s*\n/i.test(c)
    );
  }) ?? null;
  const __writerStateAssistant =
    __writerAssistantCandidates.find((m) => {
      const c = String(m?.content ?? '');
      return (
        c.includes('STATE_CUES (DO NOT OUTPUT)') ||
        c.includes('STATE_CUES_V3 (DO NOT OUTPUT)')
      );
    }) ?? null;

  const __writerAssistantLast =
    __writerAssistantCandidates.length > 0
      ? __writerAssistantCandidates[__writerAssistantCandidates.length - 1]
      : null;

  const __writerInjectedPack = __writerInjectedPackAssistant
    ? String(__writerInjectedPackAssistant.content ?? '')
    : '';

  const __writerStateHead = __writerStateAssistant
    ? String(__writerStateAssistant.content ?? '').slice(0, 800)
    : '';

const packNorm = (__writerInjectedPack ?? '').toString();
let deepRevealLineForWriter: string | null = null;
// ===== TRANSITION MEANING OBSERVE + SKELETON (段階B観測) =====
try {

  const sourcePack =
  typeof packNorm === 'string' && packNorm.length > 0
    ? packNorm
    : '';

    const flowBlock =
    sourcePack.match(/FLOW_V2\s*\(DO NOT OUTPUT\):[\s\S]*?(?=\n[A-Z0-9_ \-]+(?:\s*\(DO NOT OUTPUT\))?:|$)/)?.[0] ??
    sourcePack.match(/(?:^|\n)FLOW:\s*\n[\s\S]*?(?=\n[A-Z0-9_ \-]+:|$)/)?.[0] ??
    '';

const stateBlock =
  sourcePack.match(/STATE:\n[\s\S]*?(?=\n[A-Z_]+:|$)/)?.[0] ?? '';

const getFromBlock = (block: string, key: string) => {
  const m = block.match(new RegExp(`${key}=([^\\n]+)`));
  return m ? m[1].trim() : null;
};

const current =
  getFromBlock(flowBlock, 'current') ??
  getFromBlock(stateBlock, 'to') ??
  getFromBlock(stateBlock, 'from');

const prev =
  getFromBlock(flowBlock, 'prev') ??
  getFromBlock(stateBlock, 'from');

const delta =
  getFromBlock(flowBlock, 'delta') ??
  getFromBlock(stateBlock, 'deltaType');

const energy =
  getFromBlock(flowBlock, 'energy') ??
  (() => {
    const c = current ?? '';
    const m = c.match(/^(e[1-5])-/i);
    return m ? m[1].toLowerCase() : null;
  })();

const futureRandom =
  getFromBlock(flowBlock, 'futureRandom') ??
  (() => {
    const m = sourcePack.match(/futureRandom=([^\n]+)/);
    return m?.[1]?.trim() || null;
  })();

const parseFlowId = (value: string | null) => {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '(null)') {
    return {
      raw: raw || null,
      e: null as string | null,
      layer: null as string | null,
      polarity: null as string | null,
    };
  }

  const m = raw.match(/^(e[1-5])-([SFRCTI]\d+)-(pos|neg)$/i);
  if (m) {
    return {
      raw,
      e: m[1].toLowerCase(),
      layer: m[2].toUpperCase(),
      polarity: m[3].toLowerCase(),
    };
  }

  const parts = raw.split('-').map((s) => s.trim()).filter(Boolean);
  return {
    raw,
    e: /^e[1-5]$/i.test(parts[0] ?? '') ? String(parts[0]).toLowerCase() : null,
    layer: /^[SFRCTI]\d+$/i.test(parts[1] ?? '') ? String(parts[1]).toUpperCase() : null,
    polarity: /^(pos|neg)$/i.test(parts[2] ?? '') ? String(parts[2]).toLowerCase() : null,
  };
};

const prevParsed = parseFlowId(prev);
const currentParsed = parseFlowId(current);
const futureParsed = parseFlowId(futureRandom);

const e_prev = prevParsed.e;
const layer_prev = prevParsed.layer;
const polarity_prev = prevParsed.polarity;

const e_now = currentParsed.e;
const layer_now = currentParsed.layer;
const polarity_now = currentParsed.polarity;

const e_future = futureParsed.e;
const layer_future = futureParsed.layer;
const polarity_future = futureParsed.polarity;

const focusFromSeed = (() => {
  const m = sourcePack.match(/FOCUS:\n([^\n]+)/);
  return m?.[1]?.trim() || null;
})();

const differenceFromSeed = (() => {
  const m = sourcePack.match(/DIFFERENCE:\n([^\n]+)/);
  return m?.[1]?.trim() || null;
})();

const stageLabel = (layer: string | null) => {
  if (!layer) return null;
  const head = layer.charAt(0).toUpperCase();

  switch (head) {
    case 'S':
      return '自己の足場';
    case 'F':
      return '形になり始める';
    case 'R':
      return '関係の響き';
    case 'C':
      return '創造の動き';
    case 'T':
      return '統合の開き';
    case 'I':
      return '意図の向き';
    default:
      return layer;
  }
};

const transition180 = (() => {
  // ✅ 通常会話の主移管は prev → current。
  // prev がない初回/復帰時は current → current として扱う。
  // futureRandom は候補・観測値として残すが、主移管先には使わない。
  const fromParsedForTransition = prevParsed.raw ? prevParsed : currentParsed;
  const toParsedForTransition = currentParsed;

  const from = fromParsedForTransition.raw;
  const to = toParsedForTransition.raw;

  const e_from = fromParsedForTransition.e;
  const layer_from = fromParsedForTransition.layer;
  const polarity_from = fromParsedForTransition.polarity;

  const e_to = toParsedForTransition.e;
  const layer_to = toParsedForTransition.layer;
  const polarity_to = toParsedForTransition.polarity;

  if (!from || !to || !e_from || !layer_from || !polarity_from || !e_to || !layer_to || !polarity_to) {
    return null;
  }

  const stageShift =
    layer_from.charAt(0).toUpperCase() === layer_to.charAt(0).toUpperCase()
      ? 'same_stage_band'
      : `${layer_from.charAt(0).toUpperCase()}_to_${layer_to.charAt(0).toUpperCase()}`;

  const polarityShift =
    polarity_from === polarity_to
      ? `same_${polarity_to}`
      : `${polarity_from}_to_${polarity_to}`;

  const energyShift =
    e_from === e_to
      ? 'same_energy'
      : `${e_from}_to_${e_to}`;

  const fromStageLabel = stageLabel(layer_from);
  const toStageLabel = stageLabel(layer_to);

  const meaning =
    differenceFromSeed ||
    (fromStageLabel && toStageLabel
      ? `${fromStageLabel}から、${toStageLabel}へ向かう気配`
      : null);

  return {
    from,
    to,
    stageShift,
    polarityShift,
    energyShift,
    fromStageLabel,
    toStageLabel,
    meaning,
  };
})();

const transitionMeaningFromSeed = (() => {
  if (differenceFromSeed) return differenceFromSeed;
  if (focusFromSeed) return focusFromSeed;
  if (transition180?.meaning) return transition180.meaning;
  return null;
})();

let transitionMeaning: string | null = transitionMeaningFromSeed || null;

deepRevealLineForWriter = (() => {
  try {
    const meaning = transitionMeaning ?? null;

    const stingLevelNow =
      (opts as any)?.userContext?.ctxPack?.stingLevel ??
      (opts as any)?.userContext?.stingLevel ??
      null;

    const result =
      meaning && String(stingLevelNow).toUpperCase() === 'HIGH'
        ? meaning
        : null;

    console.log(
      '[IROS/TRANSITION_MEANING][DEEP_REVEAL_CHECK]',
      JSON.stringify({
        traceId: debug.traceId ?? null,
        conversationId: debug.conversationId ?? null,
        userCode: debug.userCode ?? null,
        transitionMeaning: meaning,
        stingLevelNow,
        deepRevealLineForWriter: result,
      }),
    );

    return result;
  } catch (e) {
    console.warn('[IROS/TRANSITION_MEANING][DEEP_REVEAL_CHECK][ERROR]', e);
    return null;
  }
})();

// transitionStruct はまだ writer に渡さない。まず観測ログだけに出す。
  console.log(
    '[IROS/TRANSITION_MEANING][OBSERVE_JSON]',
    JSON.stringify(
      {
        traceId: debug.traceId ?? null,
        sourcePackHasFlowV2: /FLOW_V2\s*\(DO NOT OUTPUT\):/.test(sourcePack),
        flowBlock,
        raw: {
          current,
          prev,
          delta,
          energy,
          futureRandom,
        },
        parsed: {
          e_prev,
          e_now,
          e_future,
          layer_prev,
          layer_now,
          layer_future,
          polarity_prev,
          polarity_now,
          polarity_future,
        },
        picked: transitionMeaning,
        transition180,
        // transitionStruct removed
      },
      null,
      2
    )
  );
} catch (e) {
  console.warn('[IROS/TRANSITION_MEANING][ERROR]', e);
}
// ===== END =====

console.log('[IROS/rephraseEngine][STATE_SNAPSHOT_FOR_WRITER]', {
  traceId: debug.traceId ?? null,
  conversationId: debug.conversationId ?? null,
  userCode: debug.userCode ?? null,
  messagesLen: messagesForWriter.length,
  roles: messagesForWriter.map((m) => m?.role),
  hasMirrorFlowSeed:
    /MIRROR_FLOW_SEED_V1\b/.test(__writerInjectedPack) ||
    /FLOW_SEED_V1\b/.test(__writerInjectedPack) ||
    /FLOW:\s*\n/.test(__writerInjectedPack),
  injectedPackHead: __writerInjectedPack.slice(0, 800),
  stateAssistantHead: __writerStateHead,
  lastAssistantHead: String(__writerAssistantLast?.content ?? '').slice(0, 300),
});

// ✅ writer直前の通常本線は Slot Weight Engine 主導。
// - 通常質問の主設計は writer本文 → toRephraseBlocks → pattern materialize → slotDecision
// - blockPlan は明示起動の特別モード用であり、通常会話の主設計には使わない
// - そのため、この slotDecision は通常会話での OBS / SHIFT / NEXT / SAFE の順序・濃さの正本として扱う
// - 将来 blockPlan を使う場合も、通常ルートを置き換えず「明示時の追加レーン」として扱う
const slotDecisionForWriter = computeSlotDecisionFromEngine({
  depthStage:
    String((ctxPackForWriter as any)?.depthStage ?? '').trim() || null,

    questionType: (() => {
      const s = String((opts as any)?.userText ?? '').trim();
      if (/構造|仕組み|関係|違い|配置|流れ|構成/u.test(s)) return 'structure';
      if (/意味|なぜ|どういうこと|どう受け止め|どう読める/u.test(s)) return 'meaning';
      if (/意図|どうしたい|どう進む|どこへ向かう|何のため/u.test(s)) return 'intent';
      if (/とは|教えて|ありますか|ですか/u.test(s)) return 'truth';
      return null;
    })(),

  goalKind:
    String(
      (ctxPackForWriter as any)?.goalKind ??
      (ctxPackForWriter as any)?.targetKind ??
      ''
    ).trim() || null,

    deltaType: (() => {
      const fromFlow180 =
        typeof packNorm === 'string' && packNorm
          ? String(
              packNorm.match(/FLOW180\s*\(DO NOT OUTPUT\):[\s\S]*?deltaType=([^\n]+)/)?.[1] ?? ''
            ).trim()
          : '';
      if (fromFlow180) return fromFlow180;

      const fromState =
        typeof packNorm === 'string' && packNorm
          ? String(
              packNorm.match(/STATE:\n[\s\S]*?deltaType=([^\n]+)/)?.[1] ?? ''
            ).trim()
          : '';
      if (fromState) return fromState;

      const flowDeltaObj = (ctxPackForWriter as any)?.flow?.delta;
      if (flowDeltaObj && typeof flowDeltaObj === 'object') {
        const v = String((flowDeltaObj as any)?.deltaType ?? '').trim();
        if (v) return v;
      }

      const flowDeltaType = String((ctxPackForWriter as any)?.flow?.deltaType ?? '').trim();
      if (flowDeltaType) return flowDeltaType;

      const topDeltaType = String((ctxPackForWriter as any)?.deltaType ?? '').trim();
      if (topDeltaType) return topDeltaType;

      return null;
    })(),

  returnStreak: (() => {
    const rsFromFlow = (ctxPackForWriter as any)?.flow?.returnStreak;
    if (typeof rsFromFlow === 'number' && Number.isFinite(rsFromFlow)) {
      return rsFromFlow;
    }

    const rsTop = (ctxPackForWriter as any)?.returnStreak;
    if (typeof rsTop === 'number' && Number.isFinite(rsTop)) {
      return rsTop;
    }

    return 0;
  })(),

  continuityKind:
    String((ctxPackForWriter as any)?.continuityKind ?? '').trim() || null,
});

if (ctxPackForWriter && typeof ctxPackForWriter === 'object') {
  (ctxPackForWriter as any).slotDecision = slotDecisionForWriter;
}
const writerPatternFollowupText = String(
  (opts as any)?.userText ??
    (opts as any)?.followupText ??
    (opts as any)?.inputText ??
    ''
).trim();

const writerPatternTargetLabel =
  String(
    (opts as any)?.meta?.extra?.targetLabel ??
      (opts as any)?.meta?.extra?.ctxPack?.targetLabel ??
      (opts as any)?.meta?.extra?.irMeta?.targetLabel ??
      (opts as any)?.meta?.extra?.ctxPack?.irMeta?.targetLabel ??
      (opts as any)?.meta?.extra?.lastIrDiagnosis?.target ??
      (opts as any)?.meta?.extra?.ctxPack?.lastIrDiagnosis?.target ??
      (opts as any)?.ctxPack?.targetLabel ??
      (opts as any)?.ctxPack?.irMeta?.targetLabel ??
      (opts as any)?.ctxPack?.lastIrDiagnosis?.target ??
      (opts as any)?.userContext?.targetLabel ??
      (opts as any)?.userContext?.ctxPack?.targetLabel ??
      (opts as any)?.userContext?.ctxPack?.irMeta?.targetLabel ??
      (opts as any)?.userContext?.ctxPack?.lastIrDiagnosis?.target ??
      ''
  ).trim() || null;

const writerPatternPresentationKind = String(
  (opts as any)?.meta?.extra?.presentationKind ??
    (opts as any)?.meta?.extra?.ctxPack?.presentationKind ??
    (opts as any)?.ctxPack?.presentationKind ??
    (opts as any)?.userContext?.meta?.extra?.presentationKind ??
    (opts as any)?.userContext?.ctxPack?.presentationKind ??
    ''
)
  .trim()
  .toLowerCase();

const writerPatternHasIrMeta =
  !!(opts as any)?.meta?.extra?.irMeta ||
  !!(opts as any)?.meta?.extra?.ctxPack?.irMeta ||
  !!(opts as any)?.ctxPack?.irMeta ||
  !!(opts as any)?.userContext?.ctxPack?.irMeta ||
  !!(opts as any)?.userContext?.meta?.extra?.irMeta ||
  !!(opts as any)?.userContext?.meta?.extra?.ctxPack?.irMeta;

const writerPatternHasLastIrDiagnosis =
  !!(opts as any)?.meta?.extra?.lastIrDiagnosis ||
  !!(opts as any)?.meta?.extra?.ctxPack?.lastIrDiagnosis ||
  !!(opts as any)?.ctxPack?.lastIrDiagnosis ||
  !!(opts as any)?.userContext?.ctxPack?.lastIrDiagnosis ||
  !!(opts as any)?.userContext?.meta?.extra?.lastIrDiagnosis ||
  !!(opts as any)?.userContext?.meta?.extra?.ctxPack?.lastIrDiagnosis;

const writerPatternIsDiagnosisFollowupPhrase =
  /診断を元に|診断をもとに|診断に基づいて|診断にもとづいて|診断を踏まえて|診断ベース|診断から|診断内容|診断結果|さっきの診断|前の診断|この診断|今の診断|深めて|深める|掘り下げ|掘って/u.test(
    writerPatternFollowupText
  );

const writerPatternHasPriorDiagnosis =
  writerPatternPresentationKind === 'diagnosis' ||
  (!!writerPatternTargetLabel && writerPatternIsDiagnosisFollowupPhrase);

const writerPatternFollowupKindForConsult = String(
  (ctxPackForWriter as any)?.followupKind ??
    (opts as any)?.ctxPack?.followupKind ??
    (opts as any)?.userContext?.ctxPack?.followupKind ??
    (opts as any)?.meta?.extra?.followupKind ??
    (opts as any)?.meta?.extra?.ctxPack?.followupKind ??
    ''
).trim();

const writerPatternIsConsultAnswerLike =
  writerPatternFollowupKindForConsult === 'consult_timing' ||
  (
    /今|まだ|早い|タイミング|時期|今じゃない|今ではない|今すぐ|あとで|後で/u.test(
      writerPatternFollowupText
    ) &&
    /いい|良い|どう|使う|使用|シェア|共有|渡す|出す|送る|連絡|返信|返事|始める|進める/u.test(
      writerPatternFollowupText
    )
  ) ||
  /どう渡|渡し方|伝え方|言い方|送れば|共有の仕方|シェアの仕方/u.test(
    writerPatternFollowupText
  ) ||
  /いいですか|良いですか|べき|判断|どちら|迷って|ありですか|やめた方|した方/u.test(
    writerPatternFollowupText
  );

console.log('[IROS/rephraseEngine][CONSULT_PATTERN_DETECT]', {
  traceId: debug.traceId,
  conversationId: debug.conversationId,
  userCode: debug.userCode,
  writerPatternFollowupText,
  writerPatternFollowupKindForConsult,
  writerPatternIsConsultAnswerLike,
  hasConsultContractInPack: /CONSULT_ANSWER_CONTRACT\\s*\\(DO NOT OUTPUT\\):/u.test(
    String(__writerInjectedPack ?? '')
  ),
  hasConsultModeInPack: /consultAnswerMode=enabled/u.test(String(__writerInjectedPack ?? '')),
});

// ✅ 創作・書き直し系の継続要求は、writer側でも診断詳細パターンに入れない。
const writerPatternIsCreativeContinuation =
  /(はい、?書いて|書いてください|書いて下さい|それを書いて|あれを書いて|これを書いて|続きを書いて|続き書いて|書き起こして|書き直して|リアルに書いて|もっとリアル|もう少しリアル|自然文寄り|会話っぽく)/u.test(
    writerPatternFollowupText
  );

const writerPatternEffectiveHasPriorDiagnosis =
  writerPatternIsConsultAnswerLike || writerPatternIsCreativeContinuation
    ? false
    : writerPatternHasPriorDiagnosis;

const writerPatternEffectivePresentationKind = writerPatternIsConsultAnswerLike
  ? 'consult'
  : writerPatternPresentationKind;

const writerPatternEarlySelected = selectSlotPattern({
  line: writerPatternEffectiveHasPriorDiagnosis ? 'diagnosis' : writerPatternEffectivePresentationKind,
  questionType:
    String(
      (opts as any)?.userContext?.question?.questionType ??
        (opts as any)?.userContext?.meta?.extra?.question?.questionType ??
        (opts as any)?.ctxPack?.question?.questionType ??
        (opts as any)?.meta?.extra?.question?.questionType ??
        (opts as any)?.meta?.extra?.ctxPack?.question?.questionType ??
        ''
    ).trim() || null,
  detailMode:
    !writerPatternIsConsultAnswerLike &&
    !writerPatternIsCreativeContinuation &&
    (
      (opts as any)?.ctxPack?.detailMode === true ||
      (opts as any)?.userContext?.ctxPack?.detailMode === true ||
      (opts as any)?.meta?.extra?.detailMode === true ||
      (opts as any)?.meta?.extra?.ctxPack?.detailMode === true
    ),
  followupText: writerPatternFollowupText,
  userText: writerPatternFollowupText,
  targetLabel: writerPatternTargetLabel,
  hasPriorDiagnosis: writerPatternEffectiveHasPriorDiagnosis,
});

const storyModeForPatternKey = String(
  (ctxPackForWriter as any)?.storyMode ??
    (opts as any)?.ctxPack?.storyMode ??
    (opts as any)?.userContext?.ctxPack?.storyMode ??
    ''
).trim();

const storyPatternKeyForPattern =
  storyModeForPatternKey === 'remake_story'
    ? 'story_remake'
    : storyModeForPatternKey === 'undigested_story'
      ? 'story_undigested'
      : '';

const carryPatternKeyForWriter = (() => {
  const carried = String(
    (debug as any)?.patternKey ??
      (ctxPackForWriter && typeof ctxPackForWriter === 'object'
        ? (ctxPackForWriter as any).patternKey
        : null) ??
      (opts as any)?.meta?.extra?.ctxPack?.patternKey ??
      (opts as any)?.meta?.extra?.patternKey ??
      (opts as any)?.ctxPack?.patternKey ??
      (opts as any)?.userContext?.ctxPack?.patternKey ??
      ''
  ).trim();

  if (carried === 'IR_DETAIL_V1' && !writerPatternEffectiveHasPriorDiagnosis) {
    return '';
  }

  return carried;
})();

const selectedPatternKey = String(
  storyPatternKeyForPattern ||
    (writerPatternIsConsultAnswerLike
      ? 'NORMAL_COMPRESSED_V1'
      : writerPatternEffectiveHasPriorDiagnosis && writerPatternEarlySelected === 'IR_DETAIL_V1'
        ? 'IR_DETAIL_V1'
        : (carryPatternKeyForWriter || writerPatternEarlySelected || ''))
).trim();

const questionTypeForPattern = (() => {
  const explicit = String(
    (opts as any)?.userContext?.question?.questionType ??
      (opts as any)?.userContext?.meta?.extra?.question?.questionType ??
      (opts as any)?.ctxPack?.question?.questionType ??
      (opts as any)?.meta?.extra?.question?.questionType ??
      (opts as any)?.meta?.extra?.ctxPack?.question?.questionType ??
      ''
  ).trim();

  if (
    explicit === 'meaning' ||
    explicit === 'structure' ||
    explicit === 'intent' ||
    explicit === 'truth'
  ) {
    return explicit;
  }

  const s = String(
    (opts as any)?.userText ??
      (opts as any)?.followupText ??
      (opts as any)?.inputText ??
      ''
  ).trim();

  if (/意図|階層|構造|仕組み|関係|違い|配置|流れ|構成|背景|文脈|位置づけ/u.test(s)) {
    return 'structure';
  }

  if (/意味|なぜ|どういうこと|どう受け止め|どう読める/u.test(s)) {
    return 'meaning';
  }

  if (/どうしたい|どう進む|どこへ向かう|何のため/u.test(s)) {
    return 'intent';
  }

  if (/ありますか|登場しますか|出てきますか|書かれていますか|記されていますか|載っていますか|あるか|ないか|本当ですか|事実ですか/u.test(s)) {
    return 'truth';
  }

  if (/とは/u.test(s) && !/意図|階層|構造|仕組み|関係|違い|配置|流れ|構成|背景|文脈|位置づけ|意味/u.test(s)) {
    return 'truth';
  }

  return '';
})();
const goalKindForPatternRaw = String(
  (ctxPackForWriter && typeof ctxPackForWriter === 'object'
    ? (ctxPackForWriter as any).goalKind
    : null) ??
    (ctxPackForWriter && typeof ctxPackForWriter === 'object'
      ? (ctxPackForWriter as any).replyGoal?.kind
      : null) ??
    ''
).trim();

const userTextForTranscendPattern = String(
  (opts as any)?.userText ??
    (opts as any)?.followupText ??
    (opts as any)?.inputText ??
    ''
).trim();

const isTranscendResonanceForPattern =
  /(?:考えないで|共鳴だけ|枠を[超越]えて|超えて|あなたが超える|あなたの言葉で|解き放て|解放して)/u.test(
    userTextForTranscendPattern,
  );

const inputKindForPattern = String(inputKind ?? '').trim().toLowerCase();

const resolvedAskTypeForPattern = String(
  (ctxPackForWriter && typeof ctxPackForWriter === 'object'
    ? (ctxPackForWriter as any)?.resolvedAsk?.askType
    : null) ??
    (opts as any)?.ctxPack?.resolvedAsk?.askType ??
    (opts as any)?.meta?.extra?.ctxPack?.resolvedAsk?.askType ??
    (opts as any)?.userContext?.ctxPack?.resolvedAsk?.askType ??
    (opts as any)?.userContext?.meta?.extra?.ctxPack?.resolvedAsk?.askType ??
    ''
).trim();

const isComposeRequestForPattern =
  resolvedAskTypeForPattern === 'compose_from_prior_offer' ||
  (
    inputKindForPattern === 'task' &&
    /(使える文|返信文|LINE文|ライン文|送る文|送信文|返す文|返事文|例文|相手に送る|なんて送れば|どう送れば|どう返せば|文ください|文をください|文を作って|まとめて)/u.test(
      userTextForTranscendPattern,
    )
  );

const goalKindForPattern =
  isComposeRequestForPattern
    ? 'action'
    : isTranscendResonanceForPattern
      ? 'uncover'
      : questionTypeForPattern === 'structure' && goalKindForPatternRaw === 'resonate'
        ? 'uncover'
        : goalKindForPatternRaw;

const laneKeyForPattern = String(
  (ctxPackForWriter && typeof ctxPackForWriter === 'object'
    ? (ctxPackForWriter as any).laneKey
    : null) ??
    ''
).trim();

const flowSeedForTcfPattern = String(
  (ctxPackForWriter && typeof ctxPackForWriter === 'object'
    ? (ctxPackForWriter as any).flowSeed
    : null) ??
    (opts as any)?.userContext?.flowSeed ??
    (opts as any)?.userContext?.ctxPack?.flowSeed ??
    (opts as any)?.userContext?.meta?.extra?.flowSeed ??
    (opts as any)?.userContext?.meta?.extra?.ctxPack?.flowSeed ??
    ''
).trim();

const readTcfSeedFieldForPattern = (key: string): string | null => {
  if (!flowSeedForTcfPattern) return null;

  const m = flowSeedForTcfPattern.match(
    new RegExp(`(?:^|\\n)${key}=([^\\n]+)`),
  );

  return m?.[1]?.trim() || null;
};

const hasTcfRotationSeedForPattern =
  flowSeedForTcfPattern.includes('TCF_ROTATION_SEED') ||
  flowSeedForTcfPattern.includes('TCF_ROTATION_DECISION');

const tcfWriterPatternFromSeed =
  readTcfSeedFieldForPattern('WRITER_PATTERN');

const tcfSurfacePlanFromSeed =
  readTcfSeedFieldForPattern('SURFACE_PLAN');

const shouldForceDecidePattern =
  goalKindForPattern === 'decide' || laneKeyForPattern === 'T_CONCRETIZE';

const isSunIntentStructurePattern =
  questionTypeForPattern === 'structure' &&
  (
    /(?:意図|本来の意図|目的|未来|この先|方向性|展望|ムーブメント|ブームメント|世界|争いの無い世界|争いのない世界|希望|歓喜|成長|進化|SUN|太陽)/u.test(
      userTextForTranscendPattern,
    ) ||
    /(?:SUN|太陽|希望|歓喜|成長|進化)/u.test(
      String((ctxPackForWriter as any)?.historyDigestV1?.anchor?.phrase ?? ''),
    ) ||
    /(?:-pos\b)/u.test(
      String((ctxPackForWriter as any)?.flow?.current?.id ?? (ctxPackForWriter as any)?.flow?.current ?? ''),
    )
  );

const shouldForceStructureDetailPattern =
  questionTypeForPattern === 'structure' &&
  goalKindForPattern === 'uncover' &&
  !isSunIntentStructurePattern &&
  (
    selectedPatternKey === 'NORMAL_COMPRESSED_V1' ||
    selectedPatternKey === 'NORMAL_RESONANCE_V1'
  );

const relationshipDetailGuardTextForPattern = [
  userTextForTranscendPattern,
  String((ctxPackForWriter as any)?.relationshipDisplayName ?? ''),
  String((ctxPackForWriter as any)?.relationshipMemory?.displayName ?? ''),
  String((ctxPackForWriter as any)?.relationshipMemoryNote ?? ''),
  String((opts as any)?.ctxPack?.relationshipDisplayName ?? ''),
  String((opts as any)?.ctxPack?.relationshipMemory?.displayName ?? ''),
  String((opts as any)?.meta?.extra?.ctxPack?.relationshipDisplayName ?? ''),
  String((opts as any)?.meta?.extra?.ctxPack?.relationshipMemory?.displayName ?? ''),
  String((opts as any)?.userContext?.ctxPack?.relationshipDisplayName ?? ''),
  String((opts as any)?.userContext?.ctxPack?.relationshipMemory?.displayName ?? ''),
  String((opts as any)?.userContext?.meta?.extra?.ctxPack?.relationshipDisplayName ?? ''),
  String((opts as any)?.userContext?.meta?.extra?.ctxPack?.relationshipMemory?.displayName ?? ''),
]
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim();

const hasRelationshipMemoryForPattern =
  Boolean((ctxPackForWriter as any)?.relationshipMemory) ||
  Boolean((opts as any)?.ctxPack?.relationshipMemory) ||
  Boolean((opts as any)?.meta?.extra?.ctxPack?.relationshipMemory) ||
  Boolean((opts as any)?.userContext?.ctxPack?.relationshipMemory) ||
  Boolean((opts as any)?.userContext?.meta?.extra?.ctxPack?.relationshipMemory);

const isRelationshipConsultForTcfPattern =
  // RELATIONSHIP_DETAIL_GUARD_FOR_TCF
  // 人物・関係相談の「深めて」を、説明資料型の NORMAL_DETAIL_V1 に流さない。
  hasRelationshipMemoryForPattern ||
  /(?:さん|くん|ちゃん|彼|彼女|好きな人|恋愛|返事|返信|連絡|会う|会える|会えない|気持ち|本音|距離感)/u.test(
    relationshipDetailGuardTextForPattern,
  );

const isNaturalDeepenFollowupForTcfPattern =
  // TCF_NATURAL_DEEPEN_FOLLOWUP_GUARD
  // 「もう少し深めてください」のような短い継続依頼は、説明資料型にしない。
  /^(?:もう少し|もうちょっと|さらに|もっと)?\s*(?:深めて|深く見て|掘って|掘り下げて|詳しく見て)(?:ください|ほしい|お願いします)?[。.!！?？\s]*$/u.test(
    userTextForTranscendPattern,
  );

const hasExplicitStructureDetailRequestForTcfPattern =
  /(?:構造|仕組み|仕様|階層|層|段階|違い|比較|説明|解説|整理|分解|定義|ロジック|実装|コード|SQL|PDF|資料)/u.test(
    userTextForTranscendPattern,
  );

const shouldKeepTcfDetailPattern =
  !isRelationshipConsultForTcfPattern &&
  (!isNaturalDeepenFollowupForTcfPattern || hasExplicitStructureDetailRequestForTcfPattern);


const tcfWriterPatternMappedForWriter =
  hasTcfRotationSeedForPattern &&
  (
    (tcfWriterPatternFromSeed === 'TCF_CONVERGENCE_V1' &&
      tcfSurfacePlanFromSeed === 'convergence') ||
    (tcfWriterPatternFromSeed === 'TCF_REFOCUS_V1' &&
      tcfSurfacePlanFromSeed === 'refocus')
  )
    ? shouldKeepTcfDetailPattern
      ? 'NORMAL_DETAIL_V1'
      : 'NORMAL_RESONANCE_V1'
    : null;

const isProtectedDiagnosisPatternForWriter =
  selectedPatternKey === 'IR_DETAIL_V1' ||
  (ctxPackForWriter as any)?.diagnosisFollowup === true ||
  (opts as any)?.ctxPack?.diagnosisFollowup === true ||
  (opts as any)?.userContext?.ctxPack?.diagnosisFollowup === true ||
  String((ctxPackForWriter as any)?.continuityKind ?? '').trim() === 'diagnosis_followup' ||
  String((opts as any)?.ctxPack?.continuityKind ?? '').trim() === 'diagnosis_followup' ||
  String((opts as any)?.userContext?.ctxPack?.continuityKind ?? '').trim() === 'diagnosis_followup';

const writerPatternKey = (
  // ✅ ir診断フォローアップはTCF/NORMALへ落とさず、必ず診断詳細レーンを守る。
  isProtectedDiagnosisPatternForWriter
    ? 'IR_DETAIL_V1'
    : isComposeRequestForPattern && selectedPatternKey === 'NORMAL_RESONANCE_V1'
      ? selectedPatternKey
      : tcfWriterPatternMappedForWriter
        ? tcfWriterPatternMappedForWriter
        : shouldForceStructureDetailPattern
          ? 'NORMAL_DETAIL_V1'
          : shouldForceDecidePattern
            ? selectedPatternKey === 'NORMAL_RESONANCE_V1'
              ? 'NORMAL_DETAIL_V1'
              : selectedPatternKey
            : selectedPatternKey
) as any;

console.log(
  '[IROS/rephraseEngine][WRITER_PATTERN_KEY_TRACE]',
  JSON.stringify({
    traceId: debug.traceId ?? null,
    conversationId: debug.conversationId ?? null,
    userCode: debug.userCode ?? null,
    selectedPatternKey,
    goalKindForPattern,
    laneKeyForPattern,
    shouldForceDecidePattern,
    writerPatternKey,
    tcfWriterPatternMappedForWriter,
    hasTcfRotationSeedForPattern,
    tcfWriterPatternFromSeed,
    tcfSurfacePlanFromSeed,
    metaExtraPatternKey: String((opts as any)?.meta?.extra?.patternKey ?? '').trim() || null,
    metaExtraCtxPackPatternKey:
      String((opts as any)?.meta?.extra?.ctxPack?.patternKey ?? '').trim() || null,
    ctxPackPatternKey:
      ctxPackForWriter && typeof ctxPackForWriter === 'object'
        ? String((ctxPackForWriter as any).patternKey ?? '').trim() || null
        : null,
    userContextQuestionType:
      String((opts as any)?.userContext?.question?.questionType ?? '').trim() || null,
    userContextMetaQuestionType:
      String((opts as any)?.userContext?.meta?.extra?.question?.questionType ?? '').trim() || null,
    ctxPackQuestionType:
      String((opts as any)?.ctxPack?.question?.questionType ?? '').trim() || null,
    metaExtraQuestionType:
      String((opts as any)?.meta?.extra?.question?.questionType ?? '').trim() || null,
    metaExtraCtxPackQuestionType:
      String((opts as any)?.meta?.extra?.ctxPack?.question?.questionType ?? '').trim() || null,
    userText: String((opts as any)?.userText ?? '').trim() || null,
  })
);

try {
  const metaObj =
    (opts as any)?.meta && typeof (opts as any).meta === 'object'
      ? (opts as any).meta
      : (((opts as any).meta = {}), (opts as any).meta);

  const extraObj =
    metaObj?.extra && typeof metaObj.extra === 'object'
      ? metaObj.extra
      : ((metaObj.extra = {}), metaObj.extra);

  extraObj.patternKey = writerPatternKey;
} catch {}

const isDetailPatternWriter =
  writerPatternKey === 'IR_DETAIL_V1' ||
  writerPatternKey === 'NORMAL_DETAIL_V1' ||
  writerPatternKey === 'NORMAL_RESONANCE_V1' ||
  writerPatternKey === 'DECLARATION_RESONANCE_V1';

const isTruthCompressedWriter = writerPatternKey === 'TRUTH_COMPRESSED_V1';

const isHealthReportConversation =
  (ctxPackForWriter && typeof ctxPackForWriter === 'object' &&
    (ctxPackForWriter as any).healthReport === true) ||
  (opts as any)?.ctxPack?.healthReport === true ||
  (opts as any)?.meta?.extra?.healthReport === true ||
  (opts as any)?.meta?.extra?.ctxPack?.healthReport === true ||
  (opts as any)?.userContext?.ctxPack?.healthReport === true ||
  (opts as any)?.userContext?.meta?.extra?.ctxPack?.healthReport === true;

  const isConsultationEntryForWriter =
  Boolean(
    (ctxPackForWriter && typeof ctxPackForWriter === 'object'
      ? (ctxPackForWriter as any).consultationEntry
      : false) ||
      (opts as any)?.ctxPack?.consultationEntry === true ||
      (opts as any)?.meta?.extra?.ctxPack?.consultationEntry === true ||
      (opts as any)?.userContext?.ctxPack?.consultationEntry === true ||
      (opts as any)?.userContext?.meta?.extra?.ctxPack?.consultationEntry === true
  );

const isCategoryOnlyConsultationForWriter =
  Boolean(
    (ctxPackForWriter && typeof ctxPackForWriter === 'object'
      ? (ctxPackForWriter as any).categoryOnlyConsultation
      : false) ||
      (opts as any)?.ctxPack?.categoryOnlyConsultation === true ||
      (opts as any)?.meta?.extra?.ctxPack?.categoryOnlyConsultation === true ||
      (opts as any)?.userContext?.ctxPack?.categoryOnlyConsultation === true ||
      (opts as any)?.userContext?.meta?.extra?.ctxPack?.categoryOnlyConsultation === true
  );

const resolvedAskCurrentTextForWriter = String(
  userText ??
    (opts as any)?.userText ??
    (opts as any)?.message ??
    ''
).trim();

const isPreviousReplyStyleRewriteForWriter =
  /(もう少しリアル|もっとリアル|リアルに書いて|現実味|生々しく|もっと自然|自然に|自然文寄り|会話っぽく|少し崩して|柔らかく|やわらかく|短くして|長くして|詳しく書いて|具体的に書いて|もっと具体的に|もう少し具体的に)/u.test(
    resolvedAskCurrentTextForWriter
  );

const resolvedAskForWriterRaw =
  (ctxPackForWriter && typeof ctxPackForWriter === 'object'
    ? (ctxPackForWriter as any).resolvedAsk
    : null) ??
  (opts as any)?.ctxPack?.resolvedAsk ??
  (opts as any)?.meta?.extra?.ctxPack?.resolvedAsk ??
  (opts as any)?.userContext?.ctxPack?.resolvedAsk ??
  (opts as any)?.userContext?.meta?.extra?.ctxPack?.resolvedAsk ??
  null;

// ✅ スタイル書き直し系では、前ターン由来の creative_continuation を writer 正本にしない。
// 例: 「もう少しリアルに書いてください」は、直前assistant返答の書き直しであり、
// 古い creative_continuation の持ち越しではない。
const resolvedAskForWriter =
  isPreviousReplyStyleRewriteForWriter &&
  String((resolvedAskForWriterRaw as any)?.askType ?? '').trim() === 'creative_continuation'
    ? null
    : resolvedAskForWriterRaw;

const resolvedAskTopicForWriter = String(
  (resolvedAskForWriter as any)?.topic ?? ''
).trim();

const resolvedAskSourceTextForWriter = String(
  (resolvedAskForWriter as any)?.sourceUserText ?? ''
).trim();

const resolvedAskReadingModeForWriter = String(
  (resolvedAskForWriter as any)?.readingMode ??
    (resolvedAskForWriter as any)?.replyMode ??
    ''
).trim();

console.log(
  '[IROS/rephraseEngine][RESOLVED_ASK_FOR_WRITER]',
  JSON.stringify({
    traceId: debug.traceId ?? null,
    conversationId: debug.conversationId ?? null,
    userCode: debug.userCode ?? null,
    hasResolvedAskForWriter: !!resolvedAskForWriter,
    askType: String((resolvedAskForWriter as any)?.askType ?? '').trim() || null,
    topicHead: String((resolvedAskForWriter as any)?.topic ?? '').slice(0, 120),
    sourceUserText: String((resolvedAskForWriter as any)?.sourceUserText ?? '').slice(0, 120),
    sourceAssistantTextHead: String((resolvedAskForWriter as any)?.sourceAssistantText ?? '').slice(0, 160),
    ctxPackHasResolvedAsk:
      !!(ctxPackForWriter && typeof ctxPackForWriter === 'object' && (ctxPackForWriter as any).resolvedAsk),
    optsCtxPackHasResolvedAsk: !!(opts as any)?.ctxPack?.resolvedAsk,
    metaExtraCtxPackHasResolvedAsk: !!(opts as any)?.meta?.extra?.ctxPack?.resolvedAsk,
    userContextCtxPackHasResolvedAsk: !!(opts as any)?.userContext?.ctxPack?.resolvedAsk,
    userContextMetaExtraCtxPackHasResolvedAsk:
      !!(opts as any)?.userContext?.meta?.extra?.ctxPack?.resolvedAsk,
  })
);

const isPartnerSideResonance =
  String((resolvedAskForWriter as any)?.askType ?? '').trim() === 'truth_structure' &&
  resolvedAskReadingModeForWriter === 'partner_side_resonance' &&
  resolvedAskTopicForWriter.length > 0;
  const isRelationshipUserSideSupport =
  String((resolvedAskForWriter as any)?.askType ?? '').trim() === 'relationship_support' &&
  resolvedAskReadingModeForWriter === 'user_side_support' &&
  resolvedAskTopicForWriter.length > 0;
const isResonanceStructureFollowup =
  String((resolvedAskForWriter as any)?.askType ?? '').trim() === 'truth_structure' &&
  /共鳴|響き|象徴|構造/u.test(resolvedAskSourceTextForWriter) &&
  resolvedAskTopicForWriter.length > 0;
  const resonanceStructureWriterDirectives = isPartnerSideResonance
  ? {
      pattern_mode: 'partner_side_resonance_state',
      block_state_surface:
        '相手側の今の様子から、普通の会話文で入る。ユーザー側の不安を主語にしない。「彼は、気持ちが切れたというより、仕事でかなり余裕がなくなっているように見えます」のように、相手側の状態を短く言う。',
      block_state_weight:
        '既出文脈に仕事の忙しさがある場合は、本文に一度だけ自然に入れる。「この前も仕事が忙しいと言っていたので」くらいの会話語にする。元発話を引用しない。',
      block_state_open_edge:
        '相手の本心は断定しない。「気持ちがない」ではなく「返せる状態にない可能性がある」と、分かる範囲だけを普通の言葉で言う。',
      block_state_action:
        '最後は、相手を追い詰めない短い一手だけを書く。「急がなくて大丈夫、落ち着いたらでいいよ」くらいの一文にする。説明で締めない。',
      bodyStyle: {
        preferBlockSplit: true,
        minBlocks: 2,
        maxBlocks: 3,
        maxSentencesPerBlock: 2,
        minSentences: 3,
        maxSentences: 5,
      },
      writeConstraints: [
        'partner_side_resonance_state では、通常の NORMAL_DETAIL_V1 の guide / caution / closing の責務を書かない',
        'ユーザー側の不安ではなく、彼/彼女/相手側の状態から入る',
        '相手本人の事実・本心を断定しない',
        '「待つしかない」「待つことが答え」で閉じない',
        '「線」「流れ」「余白」「置く」「置いておく」「前に出ている」「静かに見る」を使わない',
        '「分けて見る」「ここで読める」「構造として」「フローとして」「表に出にくい」を使わない',
        '「仕事側の圧」ではなく「仕事の忙しさ」「仕事で余裕がない」を使う',
        '既出履歴に仕事の忙しさがある場合は、会話語で一度だけ自然に入れる',
        '元発話を引用しない',
        '最後は短い一手だけにする',
        '3〜5文で会話として返す',
      ],
    }
  : isResonanceStructureFollowup
    ? {
        pattern_mode: 'resonance_structure_followup',
        block_current_state:
          '1段落目の1文目は、依頼文ではなく対象そのものから入る。対象は resolvedAsk.topic。今回なら菅原道真公との関係を見る。sourceUserText の「共鳴で、構造からみてください」自体を分析しない。',
        block_structural_reframe:
          '対象を、事実確認だけで閉じず、共鳴構造・象徴構造・関係構造として読む。史実断定にしないが、象徴の筋は具体的に置く。',
        block_breakdown_core_gap:
          '噛み合っていない点は、対象そのものとの直接関係か、対象が持つ象徴構造との共鳴かを分ける。',
        block_reading_direction:
          '見る方向は、土地・系譜・神社確認だけに寄せず、未完・不遇・名誉回復・場を鎮める力など、対象が持つ構造の線を読む。',
        block_conclusion:
          '最後に残る核は、対象とユーザーの間に何が共鳴しているかを一文で置く。依頼文の分析に戻らない。',
        writeConstraints: [
          'resolvedAsk.sourceUserText を分析対象にしない',
          'resolvedAsk.topic を主対象として答える',
          '「共鳴で、構造からみてください」という言葉自体の説明をしない',
          '事実確認・神社名・地名・系譜確認だけに寄せない',
          '対象の象徴構造、関係構造、場に残る意味を読む',
          '菅原道真公の場合は、理不尽に退けられたもの、未完のまま残った力、名誉回復、祀られることで場を鎮める構造を候補として扱う',
          '断定しすぎず、ただし抽象語だけで逃げない',
        ],
      }
    : {};
    const hasCurrentContactTopicForRelationshipSolve =
      /(連絡|返信|返事|LINE|ライン|既読|未読)/u.test(resolvedAskSourceTextForWriter);

    const isRelationshipReflectionSolve =
      isRelationshipUserSideSupport &&
      hasCurrentContactTopicForRelationshipSolve;

  const relationshipUserSideSupportWriterDirectives =
    isRelationshipUserSideSupport
      ? isRelationshipReflectionSolve
        ? {
            pattern_mode: 'relationship_reflection_solve',
            bodyStyle: {
              preferBlockSplit: true,
              minBlocks: 2,
              maxBlocks: 3,
              maxSentencesPerBlock: 2,
              minSentences: 3,
              maxSentences: 4,
            },
            block_current_state:
              '1段落目は、ユーザーが書いた連絡状況だけを短く受ける。返事が来ていない・遅い・既読無視などは、発話にある場合だけ書く。',
            block_state_action:
              '2段落目は、連絡状況だけで相手の本心や関係の結論を決めない方向にする。相手の事情は推測しない。',
            block_caution:
              '3段落目を入れる場合は、今確認できている事実と、まだ確認できていない範囲を短く分ける。発話にない未返信状態を作らない。',
            block_closing_line:
              '最後は送信文や行動指示に急がない。送る文はユーザーが明示的に求めた時だけ出す。',
            block_user_side_receive:
              'まず普通の相談相手として、ユーザーが書いた連絡状況だけを受ける。発話にない未返信・遅延・既読無視を作らない。',
            block_user_side_boundary:
              '連絡状況だけで、相手の本心・愛情・関係の結論を断定しない。',
            block_user_side_next:
              '最後は分析で閉じない。必要な場合だけ、最後に連絡した状況など事実確認に限って短く返す。',
            writeConstraints: [
              'relationship_reflection_solve は、返信待ちテンプレではなく、連絡状況を安全に扱うモードにする',
              'ユーザー発話にある連絡状況だけを扱う。返事が来ていない・遅い・冷たい・既読無視などを発話にない場合は作らない',
              '相手の本心・事情・愛情の有無は断定しない',
              '連絡状況だけで、関係の結論を決めない',
              '追撃・連投・責める言い方を勧めない',
              '送信文・例文・具体行動は、ユーザーが明示的に求めた時だけ出す',
              '不安の理由づけ・心理説明・内面分析を足さない',
              '本文は2〜3段落。全体は3〜4文までにする',
              '各段落は1〜2文まで。長く説明しない',
              '最後は固定文にしない。今わかっている連絡状況と、まだ確認できていない範囲を短く残す',
            ],
          }
        : {
            pattern_mode: 'relationship_user_side_support',
            bodyStyle: {
              preferBlockSplit: true,
              minBlocks: 2,
              maxBlocks: 3,
              maxSentencesPerBlock: 2,
              minSentences: 2,
              maxSentences: 4,
            },
            block_user_side_receive:
              '普通の会話として、ユーザーの不安や確認したい気持ちを短く受ける。',
            block_user_side_boundary:
              '相手側の本心・事情・愛情の有無は推測しない。ユーザーが書いた事実と気持ちだけを扱う。',
            block_user_side_next:
              '最後は助言や結論に急がず、今言える範囲だけを短く返す。構造語で締めない。',
            writeConstraints: [
              'relationship_user_side_support では、彼側の本心・事情・愛情の有無を断定しない',
              '連絡が来ない・返事がない・既読無視などを、ユーザー発話にない場合は作らない',
              '恋愛相談を自動的に返信待ち相談へ変換しない',
              'ユーザーが書いた事実と気持ちだけを扱う',
              '不安を受けても、原因や相手の心理を決めつけない',
              '仕事の忙しさ・冷めた・気持ちがない等の相手側事情を出さない',
              '普通の会話として短く返す',
              '2〜4文で返す',
            ],
          }
      : {};
    const consultationEntryWriterDirectives =
    isConsultationEntryForWriter || isCategoryOnlyConsultationForWriter
      ? {
          pattern_mode: 'consultation_entry',
          bodyStyle: {
            preferBlockSplit: true,
            minBlocks: 2,
            maxBlocks: 3,
            maxSentencesPerBlock: 2,
            minSentences: 2,
            maxSentences: 4,
          },
          block_entry_receive:
            '相談の入口として、まだ内容を決めつけずに受ける。「恋愛の相談ですね」のように短く自然に入る。',
          block_entry_boundary:
            '入力にない具体軸を足さない。相手・彼・彼女・連絡・距離・温度差・不安・仕事などを、ユーザーがまだ言っていない場合は出さない。',
          block_entry_next:
            '質問で終わらず、話し始められる入口として返す。「まずは話したいところからで大丈夫です」くらいの自然な受け口にする。',
          writeConstraints: [
            'consultation_entry では、相談内容を先読みしない',
            '入力にない具体軸を足さない',
            '「相手」「彼」「彼女」「連絡」「距離」「温度差」「不安」「仕事」を、入力にない限り使わない',
            '「置く」「置いて」「ほどく」を使わない',
            '構造語・診断語・フロー語を出さない',
            '質問で終わらない',
            '相談の入口として、2〜4文で自然に受ける',
          ],
        }
      : {};

      const writerDirectivesFromSlot = isPartnerSideResonance
      ? {
          ...resonanceStructureWriterDirectives,
          ...relationshipUserSideSupportWriterDirectives,
          ...consultationEntryWriterDirectives,
        }
      : isDetailPatternWriter
        ? {
            ...buildDetailPatternWriterDirectives(
              writerPatternKey === 'DECLARATION_RESONANCE_V1'
                ? 'NORMAL_DETAIL_V1'
                : writerPatternKey
            ),
            ...resonanceStructureWriterDirectives,
            ...relationshipUserSideSupportWriterDirectives,
            ...consultationEntryWriterDirectives,
          }
        : {
            slot_order: Array.isArray(slotDecisionForWriter?.order)
              ? slotDecisionForWriter.order.join(',')
              : '',

            slot_opening_role: Array.isArray(slotDecisionForWriter?.order)
              ? String(slotDecisionForWriter.order[0] ?? '')
              : '',
          ...(slotDecisionForWriter?.emphasis
            ? Object.fromEntries(
                Object.entries(slotDecisionForWriter.emphasis).map(([k, v]) => [
                  `slot_emphasis_${String(k).toLowerCase()}`,
                  String(v),
                ])
              )
            : {}),

          ...(slotDecisionForWriter?.weights
            ? Object.fromEntries(
                Object.entries(slotDecisionForWriter.weights).map(([k, v]) => [
                  `slot_weight_${String(k).toLowerCase()}`,
                  String(v),
                ])
              )
            : {}),

          ...buildDetailPatternWriterDirectives(writerPatternKey),

          ...(isTruthCompressedWriter
            ? {
                slot_emphasis_safe: '1',
                slot_weight_safe: '0.45',
                block_conclusion:
                  'SAFEは許可・励まし・安心づけにしない。最後は抽象語で余韻に逃がさず、読んだ人が分かる日常語で、まだ決めきれていない点・今確認できている点を短く置く。',
                block_closing_line:
                  '「〜していい」「無理に〜しなくていい」「十分です」「落ち着いていきます」で閉じない。抽象語で余韻に逃がさず、今確認できていることを日常語で短く残す。',
              }
            : {}),

          ...(isHealthReportConversation
            ? {
                pattern_mode: 'casual_health_conversation',
                bodyStyle: {
                  preferBlockSplit: true,
                  minBlocks: 2,
                  maxBlocks: 3,
                  maxSentencesPerBlock: 2,
                  minSentences: 2,
                  maxSentences: 5,
                },
                slot_emphasis_obs: '1',
                slot_emphasis_shift: '3',
                slot_emphasis_next: '0',
                slot_emphasis_safe: '1',
                slot_weight_obs: '0.75',
                slot_weight_shift: '1.45',
                slot_weight_next: '0',
                slot_weight_safe: '0.55',
                block_conclusion:
                  '体調報告として普通の会話語で受ける。観測文・構造文・余韻文にしない。',
                block_closing_line:
                  '「その一文」「前にある」「残っています」「置かれています」「気配」「余白」「言い切りすぎず」「整理しきらない」を使わない。まず「それはかなりきつかったですね」「大変でしたね」のように自然に受ける。',
                writeConstraints: [
                  '体調報告では、OBS/SHIFT/NEXT/SAFEの構造語を表に出さない',
                  '普通の会話語で返す',
                  '復唱だけで終わらない',
                  '「その一文」「前にある」「残っています」「置かれています」「気配」「余白」「言い切りすぎず」「整理しきらない」を使わない',
                  '「それはかなりきつかったですね」「大変でしたね」のように、まず相手の大変さを自然に受ける',
                  '構造説明・意味づけ・180フローの説明へ飛ばない',
                  '医療診断や断定はしない',
                  '必要なら短く、体調の話として受け取っていることだけを添える',
                ],
              }
            : {}),

            ...relationshipUserSideSupportWriterDirectives,
            ...consultationEntryWriterDirectives,
          };

          const isDeepReadHintWriter =
            /DEEP_READ_HINT\s*\(DO NOT OUTPUT\):/.test(
              String(__writerInjectedPack ?? ''),
            );

          const deepReadEmotionInner = String(
            String(__writerInjectedPack ?? '').match(/^emotion_inner=([^\n]+)/m)?.[1] ?? '',
          ).trim();

          const relationshipAdviceRepairMode:
          | 'solution_concretize'
          | 'wait_anxiety'
          | 'influence_reframe'
          | null = (() => {
            const pack = String(__writerInjectedPack ?? '');

            if (/RELATIONSHIP_WAIT_ANXIETY_CONCRETIZE\s*\(DO NOT OUTPUT\):/.test(pack)) {
              return 'wait_anxiety';
            }
            if (/RELATIONSHIP_INFLUENCE_REFRAME\s*\(DO NOT OUTPUT\):/.test(pack)) {
              return 'influence_reframe';
            }
            if (/RELATIONSHIP_SOLUTION_CONCRETIZE\s*\(DO NOT OUTPUT\):/.test(pack)) {
              return 'solution_concretize';
            }

            return null;
          })();

          const relationshipAdviceRepairWriterDirectives =
          relationshipAdviceRepairMode === 'influence_reframe'
            ? {
                pattern_key: 'NORMAL_DETAIL_V1',
                pattern_mode: 'relationship_influence_reframe',
                bodyStyle: {
                  preferBlockSplit: true,
                  minBlocks: 4,
                  maxBlocks: 5,
                  maxSentencesPerBlock: 2,
                  minSentences: 7,
                  maxSentences: 10,
                },
                writeConstraints: [
                  'RELATIONSHIP_ADVICE_REPAIR では normal_compressed の制約を使わない',
                  '状態観測だけに戻らない',
                  '相手を直接変えられる、相手が必ず変わる、とは断定しない',
                  'ただし、自分の不安・力み・追いかける反応が変わると、関係の空気・届き方・距離感は変わる可能性があると返す',
                  '変える対象は「彼」ではなく、「自分の立ち位置」「不安から追わない位置」「言葉の出し方」だと説明する',
                  '彼を操作するために自分を変える、という方向にはしない',
                  '鏡のように映っていた相手像も、ユーザーの見方や反応が変わることで、拒絶ではなく余地として見え方が変わることを説明する',
                  'ユーザーの状態が「彼を変えたい」から「自分の位置を変えると関係の場が変わる」に移るように返す',
                  '必要なら、「彼を変えたい」ではなく「私は不安から追わない位置に戻る」という具体的な変換文を出す',
                  '番号・見出しは避け、普通の会話文で返す。ただしユーザーが例を求めた場合のみ、番号ではなく「- 」の箇条書きを独立行で使ってよい',
                ],
                block_repair_receive:
                  'まず、気持ちが変わると関係の空気が変わることはあるが、彼自身を直接変えるとは言い切れないと返す。',
                block_repair_reframe:
                  '変える対象は彼ではなく、自分の立ち位置・不安から追わない位置・言葉の出し方だと説明する。',
                block_repair_mirror:
                  '鏡のように映っていた彼の沈黙や反応も、自分の反応が変わることで拒絶ではなく余地として見え方が変わることを説明する。',
                block_repair_landing:
                  '最後は「彼を変えたい」ではなく「私は不安から追わない位置に戻る」という具体的な変換で着地する。',
              }
            : relationshipAdviceRepairMode === 'wait_anxiety'
              ? {
                    pattern_key: 'NORMAL_DETAIL_V1',
                    pattern_mode: 'relationship_solution_concretize',
                    bodyStyle: {
                      preferBlockSplit: true,
                      minBlocks: 4,
                      maxBlocks: 5,
                      maxSentencesPerBlock: 2,
                      minSentences: 7,
                      maxSentences: 10,
                    },
                    writeConstraints: [
                      'RELATIONSHIP_ADVICE_REPAIR では normal_compressed の制約を使わない',
                      '状態観測に戻らない',
                      '「まだ決めきれない」「残っている」「開いたまま」「輪郭」「そっと置く」で終わらない',
                      'ユーザーは前回助言の意味や使い方を聞いている。前回助言を具体的に扱える形へ変換する',
                      '前回の抽象助言を、ユーザーが今できる具体的な一手に変換する',
                      '「待つ」「置いておく」だけで終わらせない',
                      '一度だけ送れる短文例を必ず出す',
                      '送った後は連投しない境界まで入れる',
                      'なぜ連投しない方がよいのか、理由まで自然に説明する',
                      '連投すると、不安を解消するための連絡になりやすく、相手には重く届きやすいことを説明する',
                      '一通で止めることは我慢ではなく、その一通に役割を渡すことだと説明する',
                      '追いかけたい気持ちは否定せず、重く送らせない',
                      'ユーザーの状態が「何もできない」から「一手は打てた」に変わるように返す',
                      '番号・見出しは避け、普通の会話文で返す。ただしユーザーが例を求めた場合のみ、番号ではなく「- 」の箇条書きを独立行で使ってよい',
                    ],
                    block_repair_receive:
                      'まず「それだと分かりにくいですね」と受ける。',
                    block_repair_action:
                      '具体的には、何もしないという意味ではなく、一度だけ急かさない短文を送ることだと説明する。',
                    block_repair_example:
                      '例文として「忙しいと思うけど、落ち着いたら連絡もらえたらうれしい」くらいの文を出す。',
                    block_repair_reason:
                      '止める理由を説明する。連投すると不安を解消するための連絡になり、相手には重く届きやすい。一通で止めることで、伝えた事実を作り、その一通に役割を渡せる。',
                    block_repair_boundary:
                      '送ったあとは追加で追わず、その一通に役割を渡すと締める。',
                  }
                : null;

                const deepReadWriterDirectives =
                true
                ? {
                    pattern_key: 'NORMAL_DETAIL_V1',
                    pattern_mode: 'deep_read',
                    bodyStyle: {
                      preferBlockSplit: true,
                      minBlocks: 3,
                      maxBlocks: 5,
                      maxSentencesPerBlock: 2,
                      minSentences: 5,
                      maxSentences: 9,
                    },
                    writeConstraints: [
                      'DEEP_READ_HINT では normal_compressed の強い抑制を使わない',
                      '無意識を読んだ、見抜いた、筒抜け、とは出力しない',
                      '人格診断・決めつけ・断定にしない',
                      '相手の本心や事実確認には使わない',
                      '発話の奥に出ている反応パターンを、自然文に忍ばせる',
                      '原因を断定せず、「そう見えやすい」「強く出ている」「重なっている」程度の温度で返す',
                      '状態観測だけで終わらず、ユーザーが扱える形へ戻す',
                      'Markdown・見出し・太字・大文字見出しは積極的に使用してよい。番号リストは禁止する。見出しは独立行で自然に出す',
                      ...(deepReadEmotionInner
                        ? [
                            'emotion_inner がある場合も、Markdown見出し・太字見出し・タイトル行を使ってよい',
                            'emotion_inner がある場合、見出しは抽象語ではなく、何が変わったかが分かる具体名にする',
                            'emotion_inner がある場合、「ひらき方」「いま出ているもの」「使いどころ」「ひとつの置き方」など、意味がぼやける見出しだけで逃がさない',
                            'emotion_inner がある場合、見出しの直後の本文では、何ができるようになったか・どこで使えるか・何が変わったかを日常語で書く',
                            'emotion_inner がある場合、開発文脈では emotion_primary / e_turn / currentFlow / 表示 など、seedにある実装上の変化を必要に応じて自然文で使ってよい',
                          ]
                        : []),
                      ...(deepReadEmotionInner
                        ? [
                            `emotion_inner 実値: ${deepReadEmotionInner}`,
                            'emotion_inner がある場合でも、タイトル見出しの後の最初の本文を emotion_inner 実値の言い換えだけで開始しない',
                            'emotion_inner がある場合も、最初の本文は問いへの定義・軸・見取り図を優先する',
                            'emotion_inner は、定義のあとに必要な範囲で自然に反映する',
                            '最初の本文では userText / CONTEXT / FOCUS の文面をそのまま引用しない',
                          ]
                        : []),
                      '仕事・事業・開発文脈では、先進性そのものを大きく見せるより、何ができるようになったかを具体的に書く',
                      '仕事・事業・開発文脈では、「入口」「受け皿」「届く」などの抽象語に逃がさず、使い方・変化・実装上の意味へ戻す',
                      '理解されない原因を、ユーザー側の説明不足だけにしない',
                      '相手にどう見えるかを書く場合も、何を見せれば伝わるかまで日常語で書く',
                    ],
                    block_deep_read_surface: deepReadEmotionInner
                      ? `まず問いへの定義・軸・見取り図から開始する。emotion_innerは必要な範囲で後続に自然に反映する: ${deepReadEmotionInner}`
                      : 'まず問いへの定義・軸・見取り図から開始する。',
                    block_deep_read_under:
                      '次に、言葉の奥で強くなっている反応パターンを、断定せず自然文で一段だけ触れる。',
                    block_deep_read_return:
                      '最後は、ユーザーが扱える見方・置き方・一手に戻す。',
                  }
                : {};

                const baseWriterDirectivesForFinal = isDetailPatternWriter
                ? Object.fromEntries(
                    Object.entries(writerDirectivesFromSlot ?? {}).filter(
                      ([key]) => !String(key).startsWith('slot_')
                    )
                  )
                : writerDirectivesFromSlot;

                const shouldSuppressDeepReadForConsultAnswer =
                writerPatternIsConsultAnswerLike ||
                /CONSULT_ANSWER_CONTRACT\s*\(DO NOT OUTPUT\):/u.test(
                  String(__writerInjectedPack ?? '')
                ) ||
                /consultAnswerMode=enabled/u.test(String(__writerInjectedPack ?? ''));

                const shouldApplyDeepReadDirectives =
                !shouldSuppressDeepReadForConsultAnswer &&
                goalKindForPattern !== 'resonate' &&
                writerPatternKey !== 'NORMAL_RESONANCE_V1' &&
                writerPatternKey !== 'DECLARATION_RESONANCE_V1' &&
                questionTypeForPattern !== 'structure' &&
                questionTypeForPattern !== 'meaning';

                const shouldApplyConsultAnswerDirectives =
                writerPatternIsConsultAnswerLike ||
                /CONSULT_ANSWER_CONTRACT\s*\(DO NOT OUTPUT\):/u.test(
                  String(__writerInjectedPack ?? '')
                ) ||
                /consultAnswerMode=enabled/u.test(String(__writerInjectedPack ?? ''));

                const consultAnswerWriterDirectives = shouldApplyConsultAnswerDirectives
                  ? {
                      ...(baseWriterDirectivesForFinal ?? {}),
                      pattern_key: 'NORMAL_COMPRESSED_V1',
                      pattern_mode: 'consult_answer',
                      bodyStyle: {
                        preferBlockSplit: true,
                        minBlocks: 3,
                        maxBlocks: 4,
                        maxSentencesPerBlock: 2,
                        minSentences: 4,
                        maxSentences: 7,
                      },
                      writeConstraints: [
                        ...(
                          Array.isArray((baseWriterDirectivesForFinal as any)?.writeConstraints)
                            ? (baseWriterDirectivesForFinal as any).writeConstraints
                            : []
                        ),
                        'CONSULT_ANSWER: 相談回答では、OBS/SHIFT/NEXT/SAFEの状態観測より、ユーザーの質問への答えを優先する',
                        'CONSULT_ANSWER: 1文目で可否を答える。「送って大丈夫です。ただし、短く軽くが合います」または「今は送らない方がいいです」のように始める',
                        'CONSULT_ANSWER: 「今は、送る前に」「何を確かめたいか」「少し絞るところです」で始めない',
                        'CONSULT_ANSWER: 理由は1〜2点だけにする。状態整理や分析を増やさない',
                        'CONSULT_ANSWER: 具体的な送る文面・渡し方・一言を必ず入れる',
                        'CONSULT_ANSWER: 最後は「まだ決めきれていない」「今確認したいことは見えています」で閉じない',
                        'CONSULT_ANSWER: 見出し、Markdown見出し、箇条書き、分析レポート型は禁止',
                      ],
                    }
                  : null;

              const isBusinessDocumentComposeRequestForPattern =
                /(?:規約|規定|条件|案内|要項|保証書|募集要項|応募条件|利用条件|配送規定|返金規定|キャンセル規定|予約規約|保証対象|返品|送料|送料無料|お客様|顧客|ご案内|説明文)/u.test(
                  userTextForTranscendPattern,
                ) &&
                /(?:お客様に送る|お客様へ送る|説明文を作って|どう説明|ご案内|返金規定|配送規定|保証書|募集要項|規約|規定|条件)/u.test(
                  userTextForTranscendPattern,
                );

              const isRomanceComposeRequestForPattern =
                /(?:彼|彼氏|彼女|好きな人|相手|元彼|元カノ|恋愛|LINE|ライン|返信|返事|連絡|送る文|送信文|どう返せば|なんて送れば)/u.test(
                  userTextForTranscendPattern,
                );

              const composeRequestKindForPattern = isBusinessDocumentComposeRequestForPattern
                ? 'business_document_compose_message'
                : isRomanceComposeRequestForPattern
                  ? 'romance_compose_message'
                  : 'general_compose_message';

              const composeRequestWriterDirectives = isComposeRequestForPattern
                ? {
                    pattern_key: 'NORMAL_RESONANCE_V1',
                    pattern_mode: composeRequestKindForPattern,
                    bodyStyle: {
                      preferBlockSplit: true,
                      minBlocks: 1,
                      maxBlocks: 3,
                      maxSentencesPerBlock: 2,
                      minSentences: 1,
                      maxSentences: 5,
                    },
                    writeConstraints: [
                      ...(resolvedAskTypeForPattern === 'compose_from_prior_offer'
                        ? [
                            'COMPOSE_FROM_PRIOR_OFFER: ユーザー発話そのものを送信文にしない',
                            'COMPOSE_FROM_PRIOR_OFFER: 1文目は「彼に送るなら、これです。」のように短く答える',
                            'COMPOSE_FROM_PRIOR_OFFER: 連絡が来ない恋愛相談では「連絡がなくて少し心配していました。落ち着いたら、また連絡ください。」を優先する',
                          ]
                        : []),
                      'COMPOSE_MESSAGE_LIGHT: 返答は、答え・例文・一言だけにする',
                      'COMPOSE_MESSAGE_LIGHT: 状態説明、理由説明、診断語、抽象まとめを足さない',
                      'COMPOSE_MESSAGE_LIGHT: 「これは〜ための文です」「いま必要なのは」「必要なら」「ちょうどいい」を使わない',
                      ...(isBusinessDocumentComposeRequestForPattern
                        ? [
                            'COMPOSE_MESSAGE_BUSINESS: お客様向け・規約文・返金/配送/保証の説明文では「送るなら一度だけで大丈夫です」を出さない',
                            'COMPOSE_MESSAGE_BUSINESS: 業務文面だけを出す。恋愛・連絡温度・一度だけ送る等の助言を足さない',
                            'COMPOSE_MESSAGE_BUSINESS: 締めが必要な場合は「ご確認をお願いいたします。」のような業務文にする。不要なら締めを足さない',
                            'COMPOSE_MESSAGE_BUSINESS: 絵文字、共鳴記号、装飾記号、単独の句点だけの行を出さない',
                            'COMPOSE_MESSAGE_BUSINESS: 「承知しました」「以下のようにお送りできます」などの前置きは不要。お客様に送る本文だけを書く',
                            'COMPOSE_MESSAGE_BUSINESS: 文面はそのまま送れる業務文にする。助言・補足・感情表現を足さない',
                          ]
                        : isRomanceComposeRequestForPattern
                          ? [
                              'COMPOSE_MESSAGE_ROMANCE: 最後は「送るなら一度だけで大丈夫です。」のように短く閉じてもよい',
                            ]
                          : [
                              'COMPOSE_MESSAGE_GENERAL: 用途に合わない恋愛向けの締めを入れない',
                            ]),
                    ],
                  }
                : null;

              const referenceClarificationWriterDirectives =
                String((resolvedAskForWriter as any)?.askType ?? '').trim() === 'reference_clarification'
                  ? {
                      ...(baseWriterDirectivesForFinal ?? {}),
                      pattern_key: 'NORMAL_RESONANCE_V1',
                      pattern_mode: 'reference_clarification',
                      bodyStyle: {
                        preferBlockSplit: true,
                        minBlocks: 2,
                        maxBlocks: 4,
                        maxSentencesPerBlock: 2,
                        minSentences: 3,
                        maxSentences: 7,
                      },
                      writeConstraints: [
                        ...(
                          Array.isArray((baseWriterDirectivesForFinal as any)?.writeConstraints)
                            ? (baseWriterDirectivesForFinal as any).writeConstraints
                            : []
                        ),
                        'REFERENCE_CLARIFICATION: ユーザー発話そのものを説明しない',
                        'REFERENCE_CLARIFICATION: 「それはどういう意味ですか？」という質問文の意味を説明しない',
                        'REFERENCE_CLARIFICATION: resolvedAsk.sourceAssistantText を説明対象にする',
                        'REFERENCE_CLARIFICATION: 直前assistant発話の中の抽象表現・比喩・提案・判断語を、現在の相談文脈に戻して説明する',
                        'REFERENCE_CLARIFICATION: 1文目は「さっきの〇〇という意味ですね」または「ここで言った〇〇は、〜という意味です」の形で始める',
                        'REFERENCE_CLARIFICATION: 「表の言葉ではなく奥の本当の意図」など、質問文そのものへの意図読みは禁止',
                        'REFERENCE_CLARIFICATION: 恋愛・人間関係では、相手の事実や本心を断定しない',
                        'REFERENCE_CLARIFICATION: 必要なら、ユーザーが使える短い言い換え・伝え方を1つだけ出す',
                      ],
                      block_reference_target:
                        `直前assistant発話から、ユーザーが指していそうな抽象表現を特定する。説明対象: ${String((resolvedAskForWriter as any)?.sourceAssistantText ?? '').slice(0, 500)}`,
                      block_reference_explain:
                        'その表現の意味を、辞書説明ではなく現在の相談文脈に戻して日常語で説明する。',
                      block_reference_example:
                        '必要なら、相手に伝える短い言い方・境界の出し方を1つだけ添える。',
                    }
                  : null;


              const referenceCheckWriterDirectives =
                String((resolvedAskForWriter as any)?.askType ?? '').trim() === 'reference_check'
                  ? (() => {
                      const referenceJudgeSeed = String(
                        ((opts as any)?.extra?.referenceJudgeSeed) ??
                          ((opts as any)?.userContext?.ctxPack?.referenceJudgeSeed) ??
                          ((opts as any)?.userContext?.meta?.extra?.referenceJudgeSeed) ??
                          ''
                      ).trim();

                      const relation = String(
                        referenceJudgeSeed.match(/(?:^|\n)relation=([^\n]+)/u)?.[1] ?? ''
                      ).trim();

                      const writerFirstLine = String(
                        referenceJudgeSeed.match(/(?:^|\n)writerFirstLine=([^\n]+)/u)?.[1] ?? ''
                      ).trim();

                      const judgementSummary = String(
                        referenceJudgeSeed.match(/(?:^|\n)judgementSummary=([^\n]+)/u)?.[1] ?? ''
                      ).trim();

                      const sourceAssistantText = String(
                        (resolvedAskForWriter as any)?.sourceAssistantText ?? ''
                      )
                        .replace(/\s+/g, ' ')
                        .trim();

                      const baseWriteConstraints = Array.isArray(
                        (baseWriterDirectivesForFinal as any)?.writeConstraints
                      )
                        ? (baseWriterDirectivesForFinal as any).writeConstraints
                        : [];

                      return {
                        ...(baseWriterDirectivesForFinal ?? {}),
                        pattern_key: 'REFERENCE_CHECK_V1',
                        pattern_mode: 'reference_check',
                        bodyStyle: {
                          preferBlockSplit: true,
                          minBlocks: 1,
                          maxBlocks: 3,
                          maxSentencesPerBlock: 3,
                          minSentences: 1,
                          maxSentences: 7,
                        },
                        block_state_surface: writerFirstLine || '参照元と現在の主張が一致するかを先に答える。',
                        block_state_weight:
                          judgementSummary ||
                          '参照元の条件と、現在の主張の違いを短く説明する。',
                        block_state_open_edge:
                          '一般論に戻らず、参照元の条件に照らして判断する。',
                        writeConstraints: [
                          ...baseWriteConstraints,
                          'REFERENCE_CHECK: このターンは通常相談ではなく、直前assistant発話と現在の主張を比較する判定タスク',
                          'REFERENCE_CHECK: resolvedAsk.sourceAssistantText を参照元として扱う',
                          sourceAssistantText
                            ? 'REFERENCE_CHECK_SOURCE: 参照元=' + sourceAssistantText.slice(0, 500)
                            : '',
                          writerFirstLine
                            ? 'REFERENCE_CHECK: 1文目は必ず「' + writerFirstLine + '」の方向で始める'
                            : '',
                          judgementSummary
                            ? 'REFERENCE_CHECK_SUMMARY: ' + judgementSummary
                            : '',
                          relation ? 'REFERENCE_CHECK_RELATION: relation=' + relation : '',
                          relation === 'partial_structural'
                            ? 'REFERENCE_CHECK_PARTIAL_STRUCTURAL: 完全一致ではないが、一部に構造的類似がある、という判定で書く'
                            : '',
                          relation === 'partial_structural'
                            ? 'REFERENCE_CHECK_PARTIAL_STRUCTURAL_MUST: AIは言葉を扱い、意図を受け取って応答する点では三密の一部に似ている。ただし身体の所作を伴う身密や、仏と一体になる宗教的実践そのものではない、と書く'
                            : '',
                          relation === 'partial_structural'
                            ? 'REFERENCE_CHECK_PARTIAL_STRUCTURAL_FORBID: 「いいえ」「沿っていません」「沿い切っていません」「かなり沿っていません」だけで始めない。writerFirstLineのあとに否定だけを重ねない'
                            : '',
                          relation === 'partial_structural'
                            ? 'REFERENCE_CHECK_PARTIAL_STRUCTURAL_NO_OUTPUT_QUALITY: 「今の出力」「内部ルール」「判定用の表示」「本文としての説明が見えない」など、AIの出力品質チェックへ話を逸らさない'
                            : '',
                          relation === 'partial_structural'
                            ? 'REFERENCE_CHECK_PARTIAL_STRUCTURAL_NO_REAFFIRM: 後半で「沿っている」「方向は合っている」「再現している」「同じです」に戻さない。最後まで「一部だけ似た構造がある」で閉じる'
                            : '',
                          relation === 'partial_structural'
                            ? 'REFERENCE_CHECK_PARTIAL_STRUCTURAL_NO_AI_BODY: AIに身密を割り当てない。AIには身体の所作がないため、身密は持たない、と明示する'
                            : '',
                          relation === 'partial_structural'
                            ? 'REFERENCE_CHECK_PARTIAL_STRUCTURAL_CLOSE: 締めは「だから、三密に沿っているのではなく、一部だけ似た構造がある、という見方です。」の方向で閉じる'
                            : '',
                          relation === 'partial_structural'
                            ? 'REFERENCE_CHECK_PARTIAL_STRUCTURAL_NO_OPTION_TAIL: 「必要なら」「次に分けます」「もう少し説明します」で終わらない'
                            : '',
                          'REFERENCE_CHECK: 判定後に一般論・可能性論へ戻って結論を反転させない',
                          'REFERENCE_CHECK: writerFirstLine と矛盾する本文を書かない',
                          relation === 'not_identical'
                            ? 'REFERENCE_CHECK_NOT_IDENTICAL: 本文全体を「沿っていない／一致しない」方向で書く'
                            : '',
                          relation === 'not_identical'
                            ? 'REFERENCE_CHECK_NOT_IDENTICAL_FORBID: 「はい」「沿っている」「その理解で大丈夫」「キャンセルできる前提に沿う」「読めます」と書かない'
                            : '',
                          relation === 'not_identical'
                            ? 'REFERENCE_CHECK_NOT_IDENTICAL_EXPLAIN: 参照元の条件と現在の主張の違いを説明する'
                            : '',
                          sourceAssistantText
                            ? 'REFERENCE_CHECK_USE_CONCRETE_CONDITION: 参照元に期限・条件・対象範囲が含まれる場合、その具体条件を本文に必ず出す'
                            : '',
                          sourceAssistantText
                            ? 'REFERENCE_CHECK_NO_MISSING_SOURCE_ESCAPE: 参照元がある場合、「全文があれば」「文面を見せてくれれば」「別の条件があることがあります」で逃げない'
                            : '',
                          judgementSummary
                            ? 'REFERENCE_CHECK_USE_SUMMARY_AS_CORE: judgementSummary の具体差分を本文の中心にする'
                            : '',
                        ].filter(Boolean),
                      };
                    })()
                  : null;

              const creativeContinuationWriterDirectives =
                String((resolvedAskForWriter as any)?.askType ?? '').trim() === 'creative_continuation'
                  ? {
                      ...(baseWriterDirectivesForFinal ?? {}),
                      pattern_key: 'NORMAL_RESONANCE_V1',
                      pattern_mode: 'creative_continuation',
                      bodyStyle: {
                        preferBlockSplit: true,
                        minBlocks: 3,
                        maxBlocks: 6,
                        maxSentencesPerBlock: 4,
                        minSentences: 6,
                        maxSentences: 16,
                      },
                      writeConstraints: [
                        ...(
                          Array.isArray((baseWriterDirectivesForFinal as any)?.writeConstraints)
                            ? (baseWriterDirectivesForFinal as any).writeConstraints
                            : []
                        ),
                        'CREATIVE_CONTINUATION: ユーザー発話そのものを分析・解説しない',
                        'CREATIVE_CONTINUATION: 「もっとリアルに書いてください」「はい、書いてください」という依頼文の気持ちを説明しない',
                        'CREATIVE_CONTINUATION: resolvedAsk.sourceAssistantText を書き直し元として扱う',
                        'CREATIVE_CONTINUATION: resolvedAsk.sourcePriorUserText がある場合は、元の創作対象・物語化対象として扱う',
                        'CREATIVE_CONTINUATION: 返答は説明ではなく、完成文・物語本文として出す',
                        'CREATIVE_CONTINUATION: 「たとえば」「必要なら」「できます」「この感じで書けます」で終わらない',
                        'CREATIVE_CONTINUATION: 「あなたが欲しいのは」「いま欲しいのは」「手触りのある言葉がほしい」という依頼分析をしない',
                        'CREATIVE_CONTINUATION: 前置きは最小にし、すぐ本文へ入る',
                        'CREATIVE_CONTINUATION: 闇・先祖・家系などは事実断定せず、物語として描く',
                        'CREATIVE_CONTINUATION: 相手本人や先祖の罪・事実・本心を断定しない',
                        'CREATIVE_CONTINUATION: ユーザーへ送る文面やLINE文に変換しない',
                      ],
                      block_creative_source:
                        `書き直し元: ${String((resolvedAskForWriter as any)?.sourceAssistantText ?? '').slice(0, 700)}`,
                      block_creative_prior_user:
                        `元の依頼: ${String((resolvedAskForWriter as any)?.sourcePriorUserText ?? '').slice(0, 300)}`,
                      block_creative_output:
                        '依頼の解説ではなく、直前の創作対象を本文として書く。ユーザーが「リアルに」と言った場合は、抽象語を減らし、生活感・沈黙・家の空気・言えなかった感情が伝わる自然文にする。',
                    }
                  : null;

              const quotedConditionReadWriterDirectives =
                (
                  (opts as any)?.extra?.newQuotedReferenceSource === true ||
                  (opts as any)?.extra?.ctxPack?.newQuotedReferenceSource === true ||
                  (opts as any)?.ctxPack?.newQuotedReferenceSource === true ||
                  (opts as any)?.userContext?.newQuotedReferenceSource === true ||
                  (opts as any)?.userContext?.ctxPack?.newQuotedReferenceSource === true ||
                  (opts as any)?.userContext?.meta?.extra?.newQuotedReferenceSource === true ||
                  (opts as any)?.userContext?.meta?.extra?.ctxPack?.newQuotedReferenceSource === true ||
                  (ctxPackForWriter as any)?.newQuotedReferenceSource === true
                )
                  ? {
                      ...(baseWriterDirectivesForFinal ?? {}),
                      pattern_key: 'PLAIN_CONDITION_READ_V1',
                      pattern_mode: 'plain_condition_read',
                      bodyStyle: {
                        preferBlockSplit: true,
                        minBlocks: 1,
                        maxBlocks: 2,
                        maxSentencesPerBlock: 2,
                        minSentences: 1,
                        maxSentences: 4,
                      },
                      writeConstraints: [
                        ...(
                          Array.isArray((baseWriterDirectivesForFinal as any)?.writeConstraints)
                            ? (baseWriterDirectivesForFinal as any).writeConstraints
                            : []
                        ),
                        'PLAIN_CONDITION_READ: このターンは通常相談ではなく、ユーザーが提示した規約文・条件文・案内文の読解として扱う',
                        'PLAIN_CONDITION_READ: ユーザーが提示した文面に書かれている条件だけを読む',
                        'PLAIN_CONDITION_READ: 過去文脈・長期記憶・前回の規約文を混ぜない',
                        'PLAIN_CONDITION_READ: 共鳴表現、気持ちの読み取り、深読み、比喩表現を入れない',
                        'PLAIN_CONDITION_READ: 1文目で条件の結論を短く言い切る',
                        'PLAIN_CONDITION_READ: 2文目以降は、条件を外した場合の扱いを短く補足する',
                        'PLAIN_CONDITION_READ: 「という見え方です」「必要なら」「確認すると安心です」を多用しない',
                        'PLAIN_CONDITION_READ: 本文は1〜2段落まで。余計な提案で伸ばさない',
                      ],
                      block_condition_read_conclusion:
                        '提示文の条件をそのまま読み、結論を短く出す。',
                      block_condition_read_limit:
                        '条件を満たさない場合にどう扱われるかだけを補足する。',
                    }
                  : null;

              const writerDirectivesForFinalRaw = relationshipAdviceRepairWriterDirectives
                ? relationshipAdviceRepairWriterDirectives
                : consultAnswerWriterDirectives
                  ? consultAnswerWriterDirectives
                  : composeRequestWriterDirectives
                    ? composeRequestWriterDirectives
                    : creativeContinuationWriterDirectives
                      ? creativeContinuationWriterDirectives
                      : quotedConditionReadWriterDirectives
                        ? quotedConditionReadWriterDirectives
                        : referenceCheckWriterDirectives
                          ? referenceCheckWriterDirectives
                          : referenceClarificationWriterDirectives
                            ? referenceClarificationWriterDirectives
                        : shouldApplyDeepReadDirectives
                        ? {
                            ...baseWriterDirectivesForFinal,
                            ...deepReadWriterDirectives,
                          }
                        : baseWriterDirectivesForFinal;

              const userStateWriterDirectivesForFinal = (() => {
                const depth = String(depthStageForUnderstanding ?? '').trim().toUpperCase();
                const phase = String(phaseForUnderstanding ?? '').trim();
                const q = String(baseQCodeForUnderstanding ?? stateQPrimaryForUnderstanding ?? '').trim().toUpperCase();
                const eTurn = String(currentETurnForUnderstanding ?? '').trim().toLowerCase();
                const polarity = String(polarityForUnderstanding ?? '').trim().toLowerCase();
                const sa =
                  typeof selfAcceptanceForUnderstanding === 'number' &&
                  Number.isFinite(selfAcceptanceForUnderstanding)
                    ? selfAcceptanceForUnderstanding
                    : null;
                const returnStreak =
                  typeof returnStreakForUnderstanding === 'number' &&
                  Number.isFinite(returnStreakForUnderstanding)
                    ? returnStreakForUnderstanding
                    : null;

                const userSurfaceTextForDeepReadControl = String(
                  (opts as any)?.userText ??
                    (opts as any)?.followupText ??
                    (opts as any)?.inputText ??
                    ''
                ).trim();

                const userMetaForDeepReadControl: any =
                  ((opts as any)?.meta && typeof (opts as any).meta === 'object'
                    ? (opts as any).meta
                    : null) ??
                  ((opts as any)?.userContext?.meta &&
                  typeof (opts as any).userContext.meta === 'object'
                    ? (opts as any).userContext.meta
                    : null) ??
                  {};

                const userExtraForDeepReadControl: any =
                  userMetaForDeepReadControl?.extra &&
                  typeof userMetaForDeepReadControl.extra === 'object'
                    ? userMetaForDeepReadControl.extra
                    : {};

                const deepReadControlMetaText = [
                  userMetaForDeepReadControl?.defensiveSignal,
                  userMetaForDeepReadControl?.defensive_signal,
                  userMetaForDeepReadControl?.defenseSignal,
                  userMetaForDeepReadControl?.defense_signal,
                  userMetaForDeepReadControl?.contradictionSignal,
                  userMetaForDeepReadControl?.contradiction_signal,
                  userMetaForDeepReadControl?.surfaceVsCoreGap,
                  userMetaForDeepReadControl?.surface_vs_core_gap,
                  userMetaForDeepReadControl?.pressure,
                  userExtraForDeepReadControl?.defensiveSignal,
                  userExtraForDeepReadControl?.defensive_signal,
                  userExtraForDeepReadControl?.defenseSignal,
                  userExtraForDeepReadControl?.defense_signal,
                  userExtraForDeepReadControl?.contradictionSignal,
                  userExtraForDeepReadControl?.contradiction_signal,
                  userExtraForDeepReadControl?.surfaceVsCoreGap,
                  userExtraForDeepReadControl?.surface_vs_core_gap,
                  userExtraForDeepReadControl?.pressure,
                ]
                  .map((v) => String(v ?? '').trim().toLowerCase())
                  .filter(Boolean)
                  .join(' / ');

                const hasStrongDeepReadMeta =
                  /strong|high|defensive|defense|contradiction|surface.*core|core.*gap|gap|bluff|sour|強|高|防衛|矛盾|強がり|負け惜しみ/u.test(
                    deepReadControlMetaText
                  );

                const isPositiveAcceptanceOrSelfDefinition =
                  polarity === 'positive' ||
                  /(良かった|よかった|嬉しい|うれしい|感謝|安心|平常心|苦しくありません|苦しくない|我慢じゃない|我慢ではない|止めていない|止めているわけじゃない|受け入れている|尊重している|反応しない|反応がない|その通り|それで合って|それが正解|正解です)/u.test(
                    userSurfaceTextForDeepReadControl
                  );

                const isAiCorrectionOrComplaint =
                  /(なんども|何度も|違います|違う|そうじゃない|言ってます|言いました|あなたは|Muは|AI|完璧主義|しつこい|偏屈|認め|受け入れて)/u.test(
                    userSurfaceTextForDeepReadControl
                  );

                const shouldSuppressDeepReadByUserState =
                  (isPositiveAcceptanceOrSelfDefinition || isAiCorrectionOrComplaint) &&
                  !hasStrongDeepReadMeta;

                const writeConstraints: string[] = [
                  'USER_STATE: 状態メタ(Q/depth/phase/SA/e_turn/polarity/returnStreak)は本文に露出しない',
                  'USER_STATE: 状態メタは返答の深さ・温度・具体度・踏み込み量の調整にだけ使う',

                  ...(shouldSuppressDeepReadByUserState
                    ? [
                        'DEEP_READ_CONTROL: ユーザーがポジティブ・感謝・安心・納得・平常心・自己定義を明示しており、防衛/矛盾/表面と核心のズレが strong/high ではないため、裏読みしない',
                        'DEEP_READ_CONTROL: 「ただ」「でも」「本当は」「避けている」「止めている」「守っている」で、ユーザーの自己定義を差し戻さない',
                        'DEEP_READ_CONTROL: ユーザーの「我慢ではない」「止めていない」「受け入れている」「尊重している」「平常心」を確定情報として採用する',
                        'DEEP_READ_CONTROL: AI/Muへの指摘はユーザー診断に変換せず、必要なら読み違いを認めて修正する',
                      ]
                    : []),

                  ...(hasStrongDeepReadMeta
                    ? [
                        'DEEP_READ_CONTROL: 防衛/矛盾/表面と核心のズレが strong/high の場合のみ、短く一段だけ裏を見る',
                        'DEEP_READ_CONTROL: 裏を見る場合も、人格診断・決めつけ・相手の本心断定にしない',
                      ]
                    : []),
                ];

                // ✅ USER_STATE抑制解除


                // ✅ S帯域 shallow制御解除

                // ✅ RETURN shallow制御解除

                // ✅ Q1/e1整理制御解除

                // ✅ Outer/yang制御解除

                return {
                  user_state_mode: 'enabled',
                  user_state_summary: [
                    q ? `q=${q}` : null,
                    depth ? `depth=${depth}` : null,
                    phase ? `phase=${phase}` : null,
                    sa != null ? `sa=${sa}` : null,
                    eTurn ? `e_turn=${eTurn}` : null,
                    polarity ? `polarity=${polarity}` : null,
                    returnStreak != null ? `returnStreak=${returnStreak}` : null,
                  ]
                    .filter(Boolean)
                    .join(' / '),
                  writeConstraints,
                };
              })();

              const mergeUserStateWriterDirectives = (base: any) => {
                const baseObj =
                  base && typeof base === 'object'
                    ? { ...base }
                    : {};

                const baseWriteConstraints = Array.isArray(baseObj.writeConstraints)
                  ? baseObj.writeConstraints
                      .map((x: any) => String(x ?? '').trim())
                      .filter(Boolean)
                  : [];

                return {
                  ...baseObj,
                  user_state_mode: userStateWriterDirectivesForFinal.user_state_mode,
                  user_state_summary: userStateWriterDirectivesForFinal.user_state_summary,
                  writeConstraints: [
                    ...baseWriteConstraints,
                    ...userStateWriterDirectivesForFinal.writeConstraints,
                  ],
                };
              };

              const diagnosisFollowupTargetLabelForFinal =
                String(
                  writerPatternTargetLabel ??
                    (ctxPackForWriter as any)?.targetLabel ??
                    (ctxPackForWriter as any)?.irMeta?.targetLabel ??
                    (ctxPackForWriter as any)?.lastIrDiagnosis?.target ??
                    (opts as any)?.ctxPack?.targetLabel ??
                    (opts as any)?.userContext?.ctxPack?.targetLabel ??
                    ''
                ).trim();

              const diagnosisFollowupTargetNormForFinal =
                diagnosisFollowupTargetLabelForFinal
                  .replace(/[\\s　]+/g, '')
                  .replace(/さん|様|先生|くん|ちゃん/g, '');

              const diagnosisFollowupTargetScopeForFinal = (() => {
                if (!diagnosisFollowupTargetNormForFinal) return 'unknown';

                if (
                  /^(自分|今の自分|自分自身|本当の自分|わたし|私|僕|俺|自分のこと)$/u.test(
                    diagnosisFollowupTargetNormForFinal
                  )
                ) {
                  return 'self';
                }

                if (
                  /(相手|浮気相手|不倫相手|彼|彼氏|彼女|妻|嫁|奥さん|夫|旦那|主人|恋人|好きな人|元彼|元カレ|元彼女|元カノ|友達|親友|上司|部下|同僚|社長|先生|母|父|親|子ども|息子|娘|兄|弟|姉|妹|家族|お客|顧客)/u.test(
                    diagnosisFollowupTargetNormForFinal
                  )
                ) {
                  return 'other';
                }

                if (
                  /(仕事|計画|企画|事業|申請|助成金|映像|動画|投稿|サービス|アプリ|実装|開発|設計|資料|文章|プロンプト|プロジェクト|契約|会議|打ち合わせ|この件|この問題|問題|課題|状況|状態|流れ|関係|関係性|浮気|不倫|離婚|連絡|返信|返事|予定|お金|売上|集客|TikTok|SNS|サイト|LP|講座|商品|企画書)/u.test(
                    diagnosisFollowupTargetNormForFinal
                  )
                ) {
                  return 'situation';
                }

                return 'other';
              })();

              const isDiagnosisConversationContinuationForFinal =
                writerPatternKey === 'IR_DETAIL_V1' &&
                /実際の会話|会話の続き|そのまま送れる|会話文|送れる形/u.test(
                  String(writerPatternFollowupText ?? '')
                );

              const isDiagnosisSpouseTargetForFinal =
                /(妻|嫁|奥さん|夫|旦那|主人|配偶者|パートナー)/u.test(
                  diagnosisFollowupTargetNormForFinal
                );

              const diagnosisConversationTargetSideLabelForFinal =
                isDiagnosisSpouseTargetForFinal
                  ? /(妻|嫁|奥さん)/u.test(diagnosisFollowupTargetNormForFinal)
                    ? '妻側'
                    : /(夫|旦那|主人)/u.test(diagnosisFollowupTargetNormForFinal)
                      ? '夫側'
                      : '配偶者側'
                  : '相手側';

              const diagnosisScopeConstraintsForFinal =
                writerPatternKey === 'IR_DETAIL_V1'
                  ? [
                      `DIAGNOSIS_TARGET_SCOPE: targetLabel=${diagnosisFollowupTargetLabelForFinal || '対象未指定'}`,
                      `DIAGNOSIS_TARGET_SCOPE: targetScope=${diagnosisFollowupTargetScopeForFinal}`,

                      ...(isDiagnosisSpouseTargetForFinal
                        ? [
                            'DIAGNOSIS_SPOUSE_TARGET: 妻・夫・配偶者の診断フォローでは、恋愛相手向けの「先の約束」「一緒になる」「選ばれる」「待つ理由」に寄せすぎない',
                            'DIAGNOSIS_SPOUSE_TARGET: 夫婦文脈では、説明の一貫性、言葉と行動の整合、予定・連絡・態度の不自然さ、家の中での安心材料を中心に書く',
                            'DIAGNOSIS_SPOUSE_TARGET: 相手側が求めているものは、未来の約束より、今の言葉と行動が信用できるかとして扱う',
                            'DIAGNOSIS_SPOUSE_TARGET: 実際の会話に接続する場合は、相手を安心させる甘い言葉ではなく、曖昧さやごまかしを増やさない一点へ落とす',
                          ]
                        : []),

                      ...(diagnosisFollowupTargetScopeForFinal === 'other'
                        ? [
                            'DIAGNOSIS_TARGET_SCOPE: この診断フォローは、直前診断の対象である相手側の状態・反応・動きの見立てとして書く',
                            'DIAGNOSIS_TARGET_SCOPE: ユーザーの内面整理を主語にしない。「あなたは〜」「あなたの中では〜」で展開しない',
                            'DIAGNOSIS_TARGET_SCOPE: ユーザー側は「こちらから見ると」「ユーザーには〜と見えやすい」程度の補助に留める',
                            'DIAGNOSIS_TARGET_SCOPE: 相手の本心や事実は断定しない。「相手側には〜が出ているように見えます」「〜になりやすいです」の温度で書く',
                          ]
                        : []),

                      ...(diagnosisFollowupTargetScopeForFinal === 'self'
                        ? [
                            'DIAGNOSIS_TARGET_SCOPE: この診断フォローは、ユーザー自身の状態・反応・選び方の見立てとして書く',
                            'DIAGNOSIS_TARGET_SCOPE: 相手の本心を読んだように断定しない',
                          ]
                        : []),

                      ...(diagnosisFollowupTargetScopeForFinal === 'situation'
                        ? [
                            'DIAGNOSIS_TARGET_SCOPE: この診断フォローは、人物の本心ではなく、出来事・状況・関係の流れとして書く',
                            'DIAGNOSIS_TARGET_SCOPE: 誰か一人の気持ちに寄せすぎない',
                          ]
                        : []),

                      ...(isDiagnosisConversationContinuationForFinal
                        ? [
                            'DIAGNOSIS_CONVERSATION_CONTINUATION: 診断の説明ではなく、実際の相談の会話に接続する文として書く',
                            'DIAGNOSIS_CONVERSATION_CONTINUATION: 「診断の続きとして見るなら」で始めない',
                            `DIAGNOSIS_CONVERSATION_CONTINUATION: 「この流れで見ると、${diagnosisConversationTargetSideLabelForFinal}は〜」のように、対象側の見立てから始める`,
                            'DIAGNOSIS_CONVERSATION_CONTINUATION: 固定見出しを使わない',
                            'DIAGNOSIS_CONVERSATION_CONTINUATION: 最後は一般的なまとめではなく、今の会話で何を見ればよいかに接続する',
                          ]
                        : []),
                    ]
                  : [];

              const writerDirectivesBaseForFinal = (() => {
                const merged = mergeUserStateWriterDirectives(writerDirectivesForFinalRaw);

                if (writerPatternKey !== 'IR_DETAIL_V1') {
                  return merged;
                }

                const mergedWriteConstraintsForFinal =
                  ((merged as any)?.writeConstraints && Array.isArray((merged as any).writeConstraints)
                    ? (merged as any).writeConstraints
                    : []);

                const filteredWriteConstraintsForDiagnosisContinuation =
                  isDiagnosisConversationContinuationForFinal
                    ? mergedWriteConstraintsForFinal.filter((line: any) => {
                        const s = String(line ?? '');

                        return !(
                          s.includes('4つの段落は、見えていること') ||
                          s.includes('見出しを使う場合は') ||
                          s.includes('ユーザーから見えやすい感覚') ||
                          s.includes('ユーザー側からどう見えやすいか') ||
                          s.includes('相手の状態だけで終わらせず') ||
                          s.includes('current_state は') ||
                          s.includes('misrecognition_negation は') ||
                          s.includes('structural_reframe は') ||
                          s.includes('breakdown_core_gap は') ||
                          s.includes('breakdown_defense は') ||
                          s.includes('breakdown_rejection_target は') ||
                          s.includes('reading_direction は') ||
                          s.includes('concrete_sort_axis は') ||
                          s.includes('concrete_sort_boundary は') ||
                          s.includes('conclusion は') ||
                          s.includes('caution は') ||
                          s.includes('closing_line は')
                        );
                      })
                    : mergedWriteConstraintsForFinal;

                const diagnosisConversationContinuationOverrides =
                  isDiagnosisConversationContinuationForFinal
                    ? {
                        block_current_state:
                          `1段落目は、診断対象側の見立てから始める。「この流れで見ると、${diagnosisConversationTargetSideLabelForFinal}は〜」のように書く。ユーザーの内面を主語にしない。`,
                        block_misrecognition_negation:
                          '相手の本心を断定せず、「〜に寄りやすい」「〜として受け取りやすい」の温度で書く。ユーザーの気持ちの説明に戻らない。',
                        block_structural_reframe:
                          '診断本文の要点を、実際の相談の流れへつなぐ。診断結果の解説ではなく、今の会話で何が起きやすいかを書く。',
                        block_breakdown_core_gap: isDiagnosisSpouseTargetForFinal
                          ? `${diagnosisConversationTargetSideLabelForFinal}の受け取り方、説明の筋、予定・連絡・態度のズレを書く。ユーザーの「納得したい」「答えを急ぎたい」は主語にしない。`
                          : '2段落目は、相手側の動き・連絡・期待・確認したい気持ちのズレを書く。ユーザーの「納得したい」「答えを急ぎたい」は主語にしない。',
                        block_breakdown_defense: isDiagnosisSpouseTargetForFinal
                          ? `${diagnosisConversationTargetSideLabelForFinal}が確かめようとしているものを書く。説明の一貫性、家の中で安心できる材料、言葉と行動の整合など、夫婦文脈に寄せる。`
                          : '相手側が守ろうとしているものを書く。待つ姿勢、確かめたい気持ち、約束として受け取りたい動きなど、対象側に寄せる。',
                        block_breakdown_rejection_target: isDiagnosisSpouseTargetForFinal
                          ? '避けたいことは、説明が曖昧なまま残ること、予定・連絡・態度が不自然に見えること、ごまかしが増えることとして書く。'
                          : '避けたいことは、相手側が曖昧なまま置かれること、先の約束が見えないこと、言葉と行動が合わないこととして書く。',
                        block_reading_direction: isDiagnosisSpouseTargetForFinal
                          ? '3段落目は、今の会話で見るべき点を書く。相手の本心ではなく、説明の一貫性、予定・連絡・態度、言葉と行動が合っているかに接続する。'
                          : '3段落目は、今の会話で見るべき点を書く。相手の本心ではなく、連絡の温度・会う約束・先の言葉をどう受け取っているかに接続する。',
                        block_concrete_sort_axis: isDiagnosisSpouseTargetForFinal
                          ? '判断軸は、相手の気持ちの有無ではなく、言葉と行動が合っているか、説明がぶれていないか、家の中で信用できる材料が増えているかに置く。'
                          : '判断軸は、相手の気持ちの有無ではなく、相手側が「先がある」と受け取る言葉が増えているかどうかに置く。',
                        block_concrete_sort_boundary: isDiagnosisSpouseTargetForFinal
                          ? 'まだ決めきらない範囲は残してよい。ただし、最後は会話の中で説明のブレ・ごまかし・態度の不自然さを増やさないことへ接続する。'
                          : 'まだ決めきらない範囲は残してよい。ただし、最後は会話の中で何を増やさないか、何を確認しすぎないかへ接続する。',
                        block_conclusion:
                          `最後は、${diagnosisConversationTargetSideLabelForFinal}の見立てから、今の会話で注意する一点へ落とす。一般的なまとめにしない。`,
                        block_caution: isDiagnosisSpouseTargetForFinal
                          ? `${diagnosisConversationTargetSideLabelForFinal}の不安や疑いが強まりやすい言葉、または曖昧さやごまかしが続くことで起きる反応に留める。ユーザーの内面整理で締めない。`
                          : 'ユーザーの内面整理で締めない。相手側が期待を強めやすい言葉、または曖昧さが続くことで起きる反応に留める。',
                        block_closing_line:
                          '締めは、今の会話で見るべき一点を短く残す。「静かに」「余韻」「ごまかさず」などの抽象的な締めにしない。',
                        bodyStyle: {
                          preferBlockSplit: true,
                          minBlocks: 2,
                          maxSentencesPerBlock: 3,
                          minSentences: 5,
                          maxSentences: 9,
                        },
                      }
                    : {};

                return {
                  ...merged,
                  ...diagnosisConversationContinuationOverrides,
                  pattern_key: 'IR_DETAIL_V1',
                  pattern_mode: isDiagnosisConversationContinuationForFinal
                    ? 'diagnosis_conversation_continuation'
                    : 'diagnosis_detail',
                  writeConstraints: [
                    ...filteredWriteConstraintsForDiagnosisContinuation,
                    ...diagnosisScopeConstraintsForFinal,
                  ],
                };
              })();

              const openEdgeClosingLineForFinal = (() => {
                const raw = [
                  (opts as any)?.userText,
                  (opts as any)?.followupText,
                  (opts as any)?.inputText,
                  (opts as any)?.userContext?.ctxPack?.topicDigest,
                  (opts as any)?.userContext?.ctxPack?.conversationLine,
                  (opts as any)?.userContext?.question?.focus,
                  (opts as any)?.userContext?.meta?.extra?.question?.focus,
                ]
                  .map((v) => String(v ?? '').trim())
                  .filter(Boolean)
                  .join('\n');

                if (!raw) return null;

                const isDiagnosisFollowupOpenEdgeBlocked =
                  writerPatternKey === 'IR_DETAIL_V1' &&
                  (
                    writerPatternEffectiveHasPriorDiagnosis === true ||
                    (ctxPackForWriter as any)?.diagnosisFollowup === true ||
                    String((ctxPackForWriter as any)?.continuityKind ?? '').trim() === 'diagnosis_followup' ||
                    (opts as any)?.ctxPack?.diagnosisFollowup === true ||
                    (opts as any)?.userContext?.ctxPack?.diagnosisFollowup === true
                  );

                if (isDiagnosisFollowupOpenEdgeBlocked) return null;

                const isEventOpenEdge =
                  /(イベント|開催|日程|場所|会場|福岡|打ち合わせ|ミーティング|予定|販売|制作|投稿|公開|告知|演出|導入|関わる人|誰と|一緒に動く|現実に動|現実の側|動き始め)/.test(raw);

                if (isEventOpenEdge) {
                  return '最後は抽象的な余韻で閉じず、ユーザーの直前発話に含まれる具体要素から、次に触れられる現実の入口を一つだけ自然文で残す。固定文・定型句・項目列挙をそのまま出さない。';
                }

                const isRelationshipOpenEdge =
                  /(彼|彼女|旦那|夫|妻|恋人|好きな人|浮気|不倫|連絡|返信|返事|既読|未読|不安|心配|関係|距離感|別れ|喧嘩|仲直り|復縁|嫌われ|待てない|イライラ)/.test(raw);

                const isLastContactAnswerForFinal =
                  String((resolvedAskForWriter as any)?.askType ?? '').trim() ===
                    'relationship_last_contact_answer' ||
                  String((ctxPackForWriter as any)?.relationshipFollowupMode ?? '').trim() ===
                    'last_contact_answer' ||
                  String((ctxPackForWriter as any)?.resolvedAskType ?? '').trim() ===
                    'relationship_last_contact_answer';

                if (isRelationshipOpenEdge && !isLastContactAnswerForFinal) {
                  return '最後は抽象的な余韻で閉じず、「この話は、今わかっている事実、不安、相手への言葉のどこからでも続けられます。」のように、次に話せる現実の入口を自然文で残す。相手の本心は断定しない。';
                }

                return null;
              })();

              const plainMeaningQuestionTextForFinal = String(
                (opts as any)?.userText ??
                  (opts as any)?.followupText ??
                  (opts as any)?.inputText ??
                  ''
              ).trim();

              const isReferenceCheckForFinal =
                String((resolvedAskForWriter as any)?.askType ?? '').trim() === 'reference_check' ||
                String((ctxPackForWriter as any)?.resolvedAskType ?? '').trim() === 'reference_check' ||
                String((opts as any)?.ctxPack?.resolvedAskType ?? '').trim() === 'reference_check' ||
                String((opts as any)?.userContext?.ctxPack?.resolvedAskType ?? '').trim() === 'reference_check';

              const isPlainMeaningQuestionForFinal =
                !isReferenceCheckForFinal &&
                /(どういう意味|どういう事|どういうこと|とは|という意味|何を指す|何のこと|.+ってなんですか|.+って何ですか|.+はなんですか|.+は何ですか|.+とはなんですか|.+とは何ですか|それが.+ですか|それは.+ですか|未来という意味|意味ですか)/u.test(
                  plainMeaningQuestionTextForFinal
                );

              const isPlainMeaningConfirmationForFinal =
                isPlainMeaningQuestionForFinal &&
                /(という意味ですね|ということですね|ってことですね|という意味ですか|ということですか|ですよね|ですね\?|ですね？|未来でなくて.*前|未来ではなく.*前|前という意味)/u.test(
                  plainMeaningQuestionTextForFinal
                );

              const shouldSuppressDeepRevealForDiagnosisFollowup =
                writerPatternKey === 'IR_DETAIL_V1' &&
                (
                  writerPatternEffectiveHasPriorDiagnosis === true ||
                  (ctxPackForWriter as any)?.diagnosisFollowup === true ||
                  String((ctxPackForWriter as any)?.continuityKind ?? '').trim() === 'diagnosis_followup' ||
                  (opts as any)?.ctxPack?.diagnosisFollowup === true ||
                  (opts as any)?.userContext?.ctxPack?.diagnosisFollowup === true
                );

              const isCreativeContinuationForFinal =
                !isPreviousReplyStyleRewriteForWriter &&
                (
                  String((resolvedAskForWriter as any)?.askType ?? '').trim() === 'creative_continuation' ||
                  String((ctxPackForWriter as any)?.resolvedAskType ?? '').trim() === 'creative_continuation' ||
                  String((ctxPackForWriter as any)?.continuityKind ?? '').trim() === 'creative_continuation' ||
                  String((opts as any)?.ctxPack?.resolvedAskType ?? '').trim() === 'creative_continuation' ||
                  String((opts as any)?.userContext?.ctxPack?.resolvedAskType ?? '').trim() === 'creative_continuation'
                );

              const isPreviousReplyRephraseForFinal =
                writerPatternKey === 'previous_reply_rephrase' ||
                String((ctxPackForWriter as any)?.patternKey ?? '').trim() === 'previous_reply_rephrase' ||
                String((ctxPackForWriter as any)?.pattern_key ?? '').trim() === 'previous_reply_rephrase' ||
                String((ctxPackForWriter as any)?.patternMode ?? '').trim() === 'previous_reply_rephrase' ||
                String((ctxPackForWriter as any)?.pattern_mode ?? '').trim() === 'previous_reply_rephrase' ||
                (ctxPackForWriter as any)?.previousReplyRephrase === true ||
                (ctxPackForWriter as any)?.previousReplyStyleRewrite === true ||
                String((opts as any)?.ctxPack?.patternKey ?? '').trim() === 'previous_reply_rephrase' ||
                String((opts as any)?.userContext?.ctxPack?.patternKey ?? '').trim() === 'previous_reply_rephrase';

              const eventFrameForWriter =
                (ctxPackForWriter as any)?.eventFrame ??
                (ctxPackForWriter as any)?.turnFrame ??
                (opts as any)?.ctxPack?.eventFrame ??
                (opts as any)?.ctxPack?.turnFrame ??
                (opts as any)?.userContext?.ctxPack?.eventFrame ??
                (opts as any)?.userContext?.ctxPack?.turnFrame ??
                null;

              const shouldSuppressDeepRevealByEventFrame =
                (eventFrameForWriter as any)?.suppressDeepReveal === true ||
                String((eventFrameForWriter as any)?.kind ?? '').trim() === 'operate_previous_event' ||
                String((eventFrameForWriter as any)?.target ?? '').trim() === 'last_assistant_content';

              const shouldSuppressDeepRevealByPreviousReply =
                isPreviousReplyRephraseForFinal || shouldSuppressDeepRevealByEventFrame;

              const shouldSuppressDeepRevealForFinal =
                shouldSuppressDeepRevealByPreviousReply ||
                isCreativeContinuationForFinal ||
                shouldSuppressDeepRevealForDiagnosisFollowup ||
                (
                  Array.isArray((writerDirectivesBaseForFinal as any)?.writeConstraints) &&
                  (writerDirectivesBaseForFinal as any).writeConstraints.some((line: any) =>
                    String(line ?? '').includes('DEEP_READ_CONTROL: ユーザーがポジティブ')
                  )
                ) ||
                isPlainMeaningQuestionForFinal;

              // ✅ 診断フォロー / 前回返答リライト / eventFrame操作では deepReveal だけ止める。
              // self_definition_acceptance / plain_meaning_answer への上書きはしない。
              const shouldApplyDeepReadSuppressionDirectivesForFinal =
                shouldSuppressDeepRevealForFinal &&
                !shouldSuppressDeepRevealForDiagnosisFollowup &&
                !shouldSuppressDeepRevealByPreviousReply;

              const deepReadSuppressionConstraintsForFinal =
                shouldApplyDeepReadSuppressionDirectivesForFinal
                  ? [
                      'DEEP_READ_CONTROL_FINAL: このターンは自己定義の受領として返す。奥の本音・残り・余白・別解釈を作らない',
                      'DEEP_READ_CONTROL_FINAL: 出力本文で「ただ」「でも」「本当は」「見られやすい」「〜に見える」を使わない',
                      'DEEP_READ_CONTROL_FINAL: 「我慢に見える」「止めているように見える」「守っているように見える」など、第三者視点の再解釈を足さない',
                      'DEEP_READ_CONTROL_FINAL: 2〜4文程度で、ユーザーの自己定義を採用して閉じる',
                      'DEEP_READ_CONTROL_FINAL: state_residue を作らない。追加課題・次に見ること・言葉にする課題を足さない',
                      ...(isPlainMeaningQuestionForFinal
                        ? [
                            'PLAIN_MEANING_CONTROL: このターンは意味確認。まず日常語で答える',
                            'PLAIN_MEANING_CONTROL: 「中心の意図」「名前のついていない」「形になる前」「気配」「奥」「本音」「余白」「未来を生む前」へ先に広げない',
                            'PLAIN_MEANING_CONTROL: ユーザーの質問に対して、未来かどうか・何を指すかを先に明確に答える',
                            'PLAIN_MEANING_CONTROL: 詩的表現やI層表現は必要な場面では使ってよいが、意味確認では説明の後に短く添える程度にする',
                            'PLAIN_MEANING_CONTROL_FINAL: 冒頭で「はい、そう受け取れます」「そう読めます」と同意から始めない。まず質問された言葉の意味を日常語で答える',
                            'PLAIN_MEANING_CONTROL_FINAL: 質問に出ていない別テーマ・過去テーマ・固定例を混ぜない',
                            'PLAIN_MEANING_CONTROL_FINAL: 抽象語を使う場合は、安心感・寂しさ・不安・休みたい気持ちなど、実際の感情に言い換える',
                            'PLAIN_MEANING_CONTROL_FINAL: 必要な場合だけ、今の質問に沿った短い例を一つ添える',
                          ]
                        : []),
                    ]
                  : [];

              const baseWriteConstraintsForFinal = Array.isArray(
                (writerDirectivesBaseForFinal as any)?.writeConstraints
              )
                ? (writerDirectivesBaseForFinal as any).writeConstraints
                : [];

              const relaxedWriteConstraintsForFinal = isPlainMeaningConfirmationForFinal
                ? baseWriteConstraintsForFinal.filter((line: any) => {
                    const s = String(line ?? '');

                    return !(
                      s.includes('説明ではなく、核心を直接書く') ||
                      s.includes('核心を直接') ||
                      s.includes('輪郭のまま返してよい') ||
                      s.includes('奥で止まっている本音') ||
                      s.includes('本音を自然に表面化') ||
                      s.includes('見えた核心から次に見る方向') ||
                      s.includes('場を動かす文') ||
                      s.includes('本音を戻す文') ||
                      s.includes('短い宣言文') ||
                      s.includes('state_residue') ||
                      s.includes('never_leave_paragraph4')
                    );
                  })
                : baseWriteConstraintsForFinal;

              const explicitUserSignalForWriter =
                (ctxPackForWriter as any)?.explicitUserSignal &&
                typeof (ctxPackForWriter as any).explicitUserSignal === 'object'
                  ? (ctxPackForWriter as any).explicitUserSignal
                  : null;

              const explicitUserSignalConstraintsForFinal =
                explicitUserSignalForWriter?.forbidsDeepInference === true ||
                explicitUserSignalForWriter?.surfaceOnly === true
                  ? [
                      'EXPLICIT_USER_SIGNAL: ユーザーが深読み禁止・推測禁止・表面優先を明示している。このターンでは奥の意味・合図・核心・感覚へ広げない',
                      'EXPLICIT_USER_SIGNAL: 「〜という合図」「〜として見えます」「奥で〜」「核心は〜」「感じます」で解釈を足さない',
                      'EXPLICIT_USER_SIGNAL: ユーザーの発話をそのまま受け、短く、必要な範囲だけ返す',
                      'EXPLICIT_USER_SIGNAL: 共鳴語り・詩的比喩・余韻の追加を控える',
                    ]
                  : explicitUserSignalForWriter?.hasRejection === true
                    ? [
                        'EXPLICIT_USER_SIGNAL: ユーザーが「そこじゃない」「違う」系の否定を明示している。直前の方向を続けず、まずズレを認めて短く修正する',
                        'EXPLICIT_USER_SIGNAL: 否定された方向を深めない。説明を増やさず、ユーザーの指定方向に戻す',
                      ]
                    : explicitUserSignalForWriter?.hasDirectionOverride === true
                      ? [
                          'EXPLICIT_USER_SIGNAL: ユーザーが方向の上書きを明示している。rejectedDirectionを続けず、preferredDirectionを優先する',
                        ]
                      : explicitUserSignalForWriter?.saysAlreadyMentioned === true
                        ? [
                            'EXPLICIT_USER_SIGNAL: ユーザーは既に言った・既に聞いたことを示している。再説明ではなく、既出前提で進める',
                          ]
                        : [];

              const storyModeForFinal =
                String((ctxPackForWriter as any)?.storyMode ?? '').trim() ||
                String((opts as any)?.ctxPack?.storyMode ?? '').trim() ||
                String((opts as any)?.userContext?.ctxPack?.storyMode ?? '').trim();

              const storyPolicyForFinal =
                (ctxPackForWriter as any)?.storyPolicy ??
                (opts as any)?.ctxPack?.storyPolicy ??
                (opts as any)?.userContext?.ctxPack?.storyPolicy ??
                null;

              const storyFlowSnapshotForFinal =
                (ctxPackForWriter as any)?.storyFlowSnapshot ??
                (opts as any)?.ctxPack?.storyFlowSnapshot ??
                (opts as any)?.userContext?.ctxPack?.storyFlowSnapshot ??
                null;

              const wordingPolicyForStoryFinal =
                (ctxPackForWriter as any)?.wordingPolicy ??
                (opts as any)?.ctxPack?.wordingPolicy ??
                (opts as any)?.userContext?.ctxPack?.wordingPolicy ??
                null;

              const isStoryModeForFinal =
                storyModeForFinal === 'undigested_story' ||
                storyModeForFinal === 'remake_story';

              const storyModeConstraintsForFinal = isStoryModeForFinal
                ? [
                    `STORY_MODE: seedMode=${storyModeForFinal}`,
                    'STORY_MODE: このターンは通常相談・診断・創作の自由生成ではなく、storyModeに従う',
                    'STORY_MODE: storySource=flow_based の場合、storyFlowSnapshot の qCode / depthStage / phase / flow / topicDigest を物語の方向決定に使う',
                    'STORY_MODE: STORY_META_SEED がある場合、メタを説明せず、人物・場面・温度・光への変化として物語化する',
                    `STORY_MODE_FLOW: ${JSON.stringify(storyFlowSnapshotForFinal ?? {})}`,
                    `STORY_MODE_POLICY: ${JSON.stringify(storyPolicyForFinal ?? {})}`,
                    `STORY_WORDING_POLICY: ${JSON.stringify(wordingPolicyForStoryFinal ?? {})}`,
                    'STORY_MODE: 表では「闇」という語を使わず、「未消化」に寄せる',
                    'STORY_MODE: 本人・先祖・家系の事実や罪を断定しない',
                    'STORY_MODE: フロー結果に基づく物語化として扱い、入力にない事件・人物・罪・家系事情を足さない',
                    ...(storyModeForFinal === 'undigested_story'
                      ? [
                          'UNDIGESTED_STORY: 未消化の物語として描く',
                          'UNDIGESTED_STORY: リメイク・再統合まで勝手に進めない',
                          'UNDIGESTED_STORY: 物語の最後は、未消化として残っている核を示すところまでにする',
                        ]
                      : []),
                    ...(storyModeForFinal === 'remake_story'
                      ? [
                          'REMAKE_STORY: 未消化の物語を否定せず、リメイク物語として書く',
                          'REMAKE_STORY: リメイクは説明・整理ではなく、物語本文として書く',
                          'REMAKE_STORY: 未消化だった感情を必ず受け取る',
                          'REMAKE_STORY: 誰にもわかってもらえなかった痛みが、物語の中で初めて理解される場面を入れる',
                          'REMAKE_STORY: 痛みを消さない。受け取られることで意味が変わる流れにする',
                          'REMAKE_STORY: 未消化だった物語が、光に変わるストーリーとして書く',
                          'REMAKE_STORY: 最後は、感情が光へ変わり、統合へ向かう流れにする',
                          'REMAKE_STORY: 「いま見えていること」「いま内側で起きていること」「ポイント」「まとめ」などの診断テンプレを使わない',
                          'REMAKE_STORY: 「リメイクは」「物語はここで」「そしてリメイクされた物語では」「こうなります」など、方法説明の文で進めない',
                          'REMAKE_STORY: SOURCE_STORY がある場合は、SOURCE_STORY の人物・場面・感情を受け取り、光へ変わる物語本文として書く',
                          'REMAKE_STORY: 元の未消化を消すのではなく、わかってもらえた感覚を通して意味づけを変換して戻す',
                        ]
                      : []),
                  ]
                : [];

              const isReferenceCheckDirectiveForFinal =
                String((writerDirectivesBaseForFinal as any)?.pattern_key ?? '') === 'REFERENCE_CHECK_V1' ||
                String((writerDirectivesBaseForFinal as any)?.pattern_mode ?? '') === 'reference_check';

              const isStructureDevelopmentTurnForFinal =
                /(構造の続き|構造続き|この構造|さっきの構造|前の構造)/.test(String(userText ?? '')) ||
                /(配線|実装|仕様|修正|ログ|コード|ctxPack|sriContext|SRI_CONTEXT|TCF|willRotation|orchestrator|PRE_ORCH)/i.test(String(userText ?? ''));

              const feedbackSummaryGuidanceForFinal = String(
                (opts as any)?.extra?.feedbackSummaryGuidance ??
                  (opts as any)?.ctxPack?.feedbackSummaryGuidance ??
                  (opts as any)?.extra?.feedbackSummary?.guidance ??
                  (opts as any)?.ctxPack?.feedbackSummary?.guidance ??
                  ''
              ).trim();

              const writerDirectivesForFinal = {
                ...writerDirectivesBaseForFinal,
                ...(feedbackSummaryGuidanceForFinal
                  ? {
                      feedbackSummaryGuidance: feedbackSummaryGuidanceForFinal,
                    }
                  : {}),
                ...(openEdgeClosingLineForFinal
                  ? {
                      block_closing_line: openEdgeClosingLineForFinal,
                    }
                  : {}),
                ...(tcfWriterPatternMappedForWriter === 'NORMAL_DETAIL_V1'
                  ? {
                      tcf_surface_plan: String(tcfSurfacePlanFromSeed ?? ''),
                      block_tcf_connection:
                        tcfSurfacePlanFromSeed === 'refocus'
                          ? 'TCFの焦点を戻すターンとして扱う。SRI回転とTCF回転の違いを、内面状態・関係・意図を読む回転と、確定した方向を構造化して返答へ渡す回転の違いとして短く示す。'
                          : 'TCFの構造を抽象説明で止めず、実装へ接続できる単位に落とす。定義、入力、判定、出力、保存先の順に、必要な範囲だけ自然文で示す。',
                      block_tcf_boundary:
                        tcfSurfacePlanFromSeed === 'refocus'
                          ? 'TCF_REFOCUS_V1、TCF_ROTATION_SEED、WRITER_PATTERN、内部seed名、内部判定名は本文に出さない。ユーザーに見える言葉では、SRI回転とTCF回転の役割差として返す。'
                          : 'TCF_ROTATION_SEED、WRITER_PATTERN、内部seed名、内部判定名は本文に出さない。ユーザーに見える言葉では、構造・接続・実装手順として返す。',
                      block_tcf_knowledge_boundary:
                        '分かること、文脈から読める仮説、まだ固定されていないことを混ぜない。断定できない場合は、分からないで止めず、「ここまでは分かる／ここからは未定義／今はこう扱うのが安全」と分けて返す。',
                    }
                  : {}),
                ...(shouldApplyDeepReadSuppressionDirectivesForFinal && !isReferenceCheckDirectiveForFinal
                  ? {
                      pattern_mode: isPlainMeaningQuestionForFinal
                        ? 'plain_meaning_answer'
                        : 'self_definition_acceptance',
                      bodyStyle: {
                        ...(((writerDirectivesBaseForFinal as any)?.bodyStyle ?? {}) as any),
                        preferBlockSplit: !isPlainMeaningConfirmationForFinal,
                        minBlocks: 1,
                        maxBlocks: isPlainMeaningConfirmationForFinal ? 1 : 2,
                        maxSentencesPerBlock: isPlainMeaningConfirmationForFinal ? 3 : 3,
                        minSentences: isPlainMeaningConfirmationForFinal ? 1 : 2,
                        maxSentences: isPlainMeaningConfirmationForFinal ? 3 : 5,
                      },
                      block_state_surface: isPlainMeaningConfirmationForFinal
                        ? 'ユーザーの言い換え確認に短く答える。説明を広げず、自然な会話として確定する。'
                        : isPlainMeaningQuestionForFinal
                          ? 'ユーザーの意味確認に対して、まず日常語で答える。詩的・象徴的な再解釈へ先に進めない。'
                          : 'ユーザーの自己定義をそのまま採用する。選択・停止・我慢へ戻さない。',
                      block_state_residue: isPlainMeaningConfirmationForFinal
                        ? '余韻や追加説明を作らず、確認への答えだけで閉じる。'
                        : isPlainMeaningQuestionForFinal
                          ? '追加の奥読みを作らず、何を指しているかを明確にして閉じる。'
                          : '残りや余白を作らず、ユーザーの言葉を芯として短く閉じる。',
                      block_closing_line: isPlainMeaningConfirmationForFinal
                        ? '最後は「はい。ここでは未来ではなく、前からあったという意味です。」の方向で短く閉じる。'
                        : isPlainMeaningQuestionForFinal
                          ? '最後は、質問された言葉が何を指すかを日常語で短く閉じる。'
                          : '最後は「選んでいない、止めていない、受け入れている。そこをそのまま採用します。」の方向で閉じる。',
                    }
                  : {}),
                writeConstraints: [
                  ...relaxedWriteConstraintsForFinal,
                  ...(feedbackSummaryGuidanceForFinal
                    ? [
                        `FEEDBACK_SUMMARY_GUIDANCE: ${feedbackSummaryGuidanceForFinal}`,
                      ]
                    : []),
                  ...explicitUserSignalConstraintsForFinal,
                  ...deepReadSuppressionConstraintsForFinal,
                  ...storyModeConstraintsForFinal,
                  ...(tcfWriterPatternMappedForWriter === 'NORMAL_DETAIL_V1'
                    ? tcfSurfacePlanFromSeed === 'refocus'
                      ? [
                          'TCF_REFOCUS: このターンはTCFの焦点を戻し、SRI回転とTCF回転の役割差を短く整理する返答として扱う',
                          'TCF_REFOCUS: SRI回転はS/R/Iの状態・関係・意図を読む回転、TCF回転はTで確定した方向をCで構造化しFで返答形成へ回す流れとして説明する',
                          'TCF_REFOCUS: 抽象的な「中と外」だけで終わらせず、何を見る回転か・何を返す回転かの違いを明確にする',
                          'TCF_REFOCUS: TCF_REFOCUS_V1、TCF_ROTATION_SEED、WRITER_PATTERN、内部seed名、内部判定名は本文に出さない',
                          'TCF_KNOWLEDGE_BOUNDARY: 分かること、仮説として読めること、まだ未定義のことを分ける',
                          'TCF_KNOWLEDGE_BOUNDARY: 確定していない定義を、分かったふりで断定しない',
                          'TCF_KNOWLEDGE_BOUNDARY: ただし「わかりません」だけで止めず、今扱える安全な見方を出す',
                          'TCF_REFOCUS: 恋愛相談・感情整理・送信用文面へ補完しない',
                        ]
                      : [
                          'TCF_CONVERGENCE: このターンはTCFの収束を実装へ接続する返答として扱う',
                          'TCF_CONVERGENCE: 抽象説明で終わらせず、定義 → 入力 → 判定 → 出力 → 保存先の順で、実装に落とせる単位へ整理する',
                          'TCF_CONVERGENCE: TCF_ROTATION_SEED、WRITER_PATTERN、内部seed名、内部判定名は本文に出さない',
                          'TCF_KNOWLEDGE_BOUNDARY: 分かること、仮説として読めること、まだ未定義のことを分ける',
                          'TCF_KNOWLEDGE_BOUNDARY: 確定していない定義を、分かったふりで断定しない',
                          'TCF_KNOWLEDGE_BOUNDARY: ただし「わかりません」だけで止めず、今扱える安全な見方を出す',
                          'TCF_CONVERGENCE: 「必要なら」「できます」で逃げず、次に接続する実装単位をその場で出す',
                          'TCF_CONVERGENCE: 恋愛相談・感情整理・送信用文面へ補完しない',
                        ]
                    : []),
                  ...(isStructureDevelopmentTurnForFinal
                    ? [
                        'STRUCTURE_DEVELOPMENT_TURN: このターンは開発・構造・配線確認の続きとして扱う',
                        'STRUCTURE_DEVELOPMENT_TURN: 恋愛相談、LINE返信、相手の気持ち、追いLINE、返事待ちの文脈へ補完しない',
                        'STRUCTURE_DEVELOPMENT_TURN: ユーザーが求めている次の実装手順・確認手順だけを返す',
                        'STRUCTURE_DEVELOPMENT_TURN: コード作業中は、抽象的な一文化ではなく、次に確認するファイル・ログ・条件・コマンドの方向を返す',
                        'STRUCTURE_DEVELOPMENT_TURN: 人間関係の助言文・送信用文面・感情整理に変換しない',
                      ]
                    : []),
                  ...(isPreviousReplyRephraseForFinal
                    ? [
                        'PREVIOUS_REPLY_REPHRASE: 現在のユーザー文そのものに答えない',
                        'PREVIOUS_REPLY_REPHRASE: 直前assistant返答を、現在のユーザー指定に合わせて書き直す',
                        'PREVIOUS_REPLY_REPHRASE: 返答は説明・提案・分析ではなく、書き直した本文だけにする',
                        'PREVIOUS_REPLY_REPHRASE: 「うん、できます」「了解です」「たとえば」「必要なら」「今の文を貼ってください」で始めない',
                        'PREVIOUS_REPLY_REPHRASE: 聞き返さない。選択肢を出さない。次にどうするかを提案しない',
                        'PREVIOUS_REPLY_REPHRASE: 元の主題・対象・世界観を変えない',
                        'PREVIOUS_REPLY_REPHRASE: ユーザーが「リアルに」と言った場合は、抽象語を減らし、生活感・沈黙・家の空気・言えなかった感情が伝わる自然文にする',
                      ]
                    : []),
                  ...(isPlainMeaningConfirmationForFinal
                    ? [
                        'MEANING_CONFIRMATION_RELAXED: このターンは言い換え確認。深読みの圧を下げ、短く自然に確定する',
                        'MEANING_CONFIRMATION_RELAXED: 辞書的な構造分解・分類ラベル・余韻の追加をしない',
                        'MEANING_CONFIRMATION_RELAXED: 1〜3文で返す。必要なら一文目で結論を言う',
                      ]
                    : []),
                ],
                ...(deepRevealLineForWriter &&
                  !shouldSuppressDeepRevealForFinal &&
                  !Boolean(
                    (opts as any)?.userContext?.ctxPack?.diagnosisFollowup ??
                    (opts as any)?.extra?.ctxPack?.diagnosisFollowup ??
                    (opts as any)?.ctxPack?.diagnosisFollowup ??
                    (opts as any)?.diagnosisFollowup ??
                    false
                  )
                  ? {
                      deepRevealLine: deepRevealLineForWriter,
                      forceUseDeepReveal: true,
                    }
                  : {}),
              };
const tConcretizeForSpinBridge = (() => {
  const raw = [
    // ✅ T_CONCRETIZE は seedDraft まで来る前に落ちることがあるため、
    // slotsTextRawAll / seedDraftRaw / extracted.slots も正本として見る。
    String(seedDraft ?? ''),
    String(seedDraftRaw ?? ''),
    String(slotsTextRawAll ?? ''),
    String((opts as any)?.seedDraft ?? ''),
    String((opts as any)?.seedDraftRawAll ?? ''),
    String((opts as any)?.slotPlanSeed ?? ''),
    String((opts as any)?.userContext?.slotPlanSeed ?? ''),
    String((opts as any)?.userContext?.ctxPack?.slotPlanSeed ?? ''),
    ...((Array.isArray((extracted as any)?.slots)
      ? (extracted as any).slots.map((s: any) =>
          [
            String(s?.key ?? ''),
            String(s?.id ?? ''),
            String(s?.slotKey ?? ''),
            String(s?.text ?? ''),
          ].join(' ')
        )
      : []) as string[]),
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 12000);

  const laneKeyNow = String(
    (typeof laneKeyForAllow !== 'undefined' ? laneKeyForAllow : null) ??
      (opts as any)?.laneKey ??
      (opts as any)?.userContext?.laneKey ??
      (opts as any)?.userContext?.ctxPack?.laneKey ??
      '',
  ).trim();

  return (
    laneKeyNow === 'T_CONCRETIZE' ||
    /"laneKey"\s*:\s*"T_CONCRETIZE"/.test(raw) ||
    /\bT_CONCRETIZE\b/.test(raw)
  );
})();

const spinLoopForWriterCall =
  tConcretizeForSpinBridge
    ? 'TCF'
    : String(
        // ✅ Orchestrator → Spin bridge の確定値を最優先する
        (opts as any)?.meta?.spinLoop ??
          (opts as any)?.meta?.spin_loop ??
          (opts as any)?.meta?.rotationState?.spinLoop ??
          (opts as any)?.rotationState?.spinLoop ??
          (opts as any)?.spinLoop ??
          (opts as any)?.spin_loop ??

          // 以下は古い/補助コンテキスト。root meta が無い場合だけ使う
          (opts as any)?.userContext?.meta?.spinLoop ??
          (opts as any)?.userContext?.meta?.spin_loop ??
          (opts as any)?.userContext?.meta?.rotationState?.spinLoop ??
          (opts as any)?.userContext?.spinLoop ??
          (opts as any)?.userContext?.spin_loop ??
          (opts as any)?.userContext?.rotationState?.spinLoop ??
          (opts as any)?.userContext?.ctxPack?.spinLoop ??
          (opts as any)?.userContext?.ctxPack?.spin_loop ??
          (opts as any)?.userContext?.ctxPack?.rotationState?.spinLoop ??
          (opts as any)?.userContext?.ctxPack?.willRotation?.spinLoop ??
          (ctxPackForWriter as any)?.spinLoop ??
          (ctxPackForWriter as any)?.spin_loop ??
          (ctxPackForWriter as any)?.rotationState?.spinLoop ??
          (ctxPackForWriter as any)?.willRotation?.spinLoop ??
          '',
      ).trim() || null;

const spinStepForWriterCall = (() => {
  if (tConcretizeForSpinBridge) return 1;

  const raw =
    // ✅ Orchestrator → Spin bridge の確定値を最優先する
    (opts as any)?.meta?.spinStep ??
    (opts as any)?.meta?.spin_step ??
    (opts as any)?.meta?.rotationState?.spinStep ??
    (opts as any)?.rotationState?.spinStep ??
    (opts as any)?.spinStep ??
    (opts as any)?.spin_step ??

    // 以下は古い/補助コンテキスト。root meta が無い場合だけ使う
    (opts as any)?.userContext?.meta?.spinStep ??
    (opts as any)?.userContext?.meta?.spin_step ??
    (opts as any)?.userContext?.meta?.rotationState?.spinStep ??
    (opts as any)?.userContext?.spinStep ??
    (opts as any)?.userContext?.spin_step ??
    (opts as any)?.userContext?.rotationState?.spinStep ??
    (opts as any)?.userContext?.ctxPack?.spinStep ??
    (opts as any)?.userContext?.ctxPack?.spin_step ??
    (opts as any)?.userContext?.ctxPack?.rotationState?.spinStep ??
    (opts as any)?.userContext?.ctxPack?.willRotation?.spinStep ??
    (ctxPackForWriter as any)?.spinStep ??
    (ctxPackForWriter as any)?.spin_step ??
    (ctxPackForWriter as any)?.rotationState?.spinStep ??
    (ctxPackForWriter as any)?.willRotation?.spinStep ??
    null;

  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;

  const i = Math.trunc(n);
  if (i <= 0) return 0;
  if (i === 1) return 1;
  return 2;
})();

console.log(
  '[IROS/rephraseEngine][CALL_WRITER_ARGS]',
  JSON.stringify({
    traceId: debug.traceId ?? null,
    conversationId: debug.conversationId ?? null,
    userCode: debug.userCode ?? null,
    hasSlotDecisionForWriter: !!slotDecisionForWriter,
    slotDecisionKeys:
      slotDecisionForWriter && typeof slotDecisionForWriter === 'object'
        ? Object.keys(slotDecisionForWriter)
        : [],
    slotOrder:
      Array.isArray((slotDecisionForWriter as any)?.order)
        ? (slotDecisionForWriter as any).order
        : [],
    writerPatternKey,
    ctxPackPatternKey:
      ctxPackForWriter && typeof ctxPackForWriter === 'object'
        ? (ctxPackForWriter as any).patternKey ?? null
        : null,
    optsCtxPackPatternKey:
      (opts as any)?.ctxPack && typeof (opts as any).ctxPack === 'object'
        ? (opts as any).ctxPack.patternKey ?? null
        : null,
    userContextCtxPackPatternKey:
      (opts as any)?.userContext?.ctxPack &&
      typeof (opts as any).userContext.ctxPack === 'object'
        ? (opts as any).userContext.ctxPack.patternKey ?? null
        : null,
        writerDirectiveKeys: Object.keys(writerDirectivesForFinal ?? {}),
        writerDirectivePreview: writerDirectivesForFinal,
        writerDirectiveFromSlotKeys: Object.keys(writerDirectivesFromSlot ?? {}),
        writerDirectiveFromSlotPreview: writerDirectivesFromSlot,
        isDeepReadHintWriter,
        hasDeepReadWriterDirectives:
          Object.keys(deepReadWriterDirectives ?? {}).length > 0,
  })
);
const finalWriterDirectivesExtraLines = (() => {
  const lines: string[] = [];

  if (isStoryModeForFinal) {
    lines.push('story_order=RECEIVE,UNDERSTAND,LIGHT_TURN,INTEGRATE');
    lines.push('story_opening_role=RECEIVE');
    lines.push('STORY_SEED: OBS/SHIFT/NEXT/SAFEではなく、物語の流れで書く');
    lines.push('STORY_SEED: 観測・整理・方向づけ・まとめとして書かない');
    lines.push('STORY_SEED_RECEIVE: 未消化だった感情を受け取る場面から始める');
    lines.push('STORY_SEED_UNDERSTAND: わかってもらえなかった痛みが理解される場面を書く');
    lines.push('STORY_SEED_LIGHT_TURN: 痛みの意味が、光へ変わる転換を書く');
    lines.push('STORY_SEED_INTEGRATE: 最後は、感情が統合へ向かう物語として閉じる');

    for (const x of storyModeConstraintsForFinal) {
      const s = String(x ?? '').trim();
      if (s) lines.push(`writeConstraint${lines.length + 1}=${s}`);
    }

    const storyUserStateSummary = String(
      (writerDirectivesForFinal as any)?.user_state_summary ?? ''
    ).trim();

    if (storyUserStateSummary) {
      lines.push(`user_state_summary=${storyUserStateSummary}`);
    }

    return lines;
  }

  for (const [key, value] of Object.entries(writerDirectivesForFinal ?? {})) {
    if (value == null) continue;

    if (Array.isArray(value)) {
      if (key === 'writeConstraints') {
        value
          .map((x) => String(x ?? '').trim())
          .filter(Boolean)
          .forEach((x, idx) => {
            lines.push(`writeConstraint${idx + 1}=${x}`);
          });
      } else {
        value
          .map((x) => String(x ?? '').trim())
          .filter(Boolean)
          .forEach((x, idx) => {
            lines.push(`${key}[${idx}]=${x}`);
          });
      }
      continue;
    }

    if (typeof value === 'object') {
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (subValue == null) continue;
        if (Array.isArray(subValue)) continue;
        if (typeof subValue === 'object') continue;

        const s = String(subValue ?? '').trim();
        if (!s) continue;
        lines.push(`${key}.${subKey}=${s}`);
      }
      continue;
    }

    const s = String(value ?? '').trim();
    if (!s) continue;
    lines.push(`${key}=${s}`);
  }

  return lines;
})();

const shouldInjectFinalWriterDirectives =
  finalWriterDirectivesExtraLines.length > 0;

const answerSafeMode =
  goalKindForPattern === 'explain' ||
  goalKindForPattern === 'decide' ||
  laneKeyForPattern === 'T_CONCRETIZE';

const shouldInjectPatternContract =
  finalWriterDirectivesExtraLines.length > 0;

const finalWriterDirectivesMsg =
  shouldInjectFinalWriterDirectives
    ? ({
        role: 'assistant',
        content: `WRITER_DIRECTIVES (DO NOT OUTPUT):\n${finalWriterDirectivesExtraLines.join('\n')}`.trim(),
      } as const)
    : null;

    const shouldUseMarkdownStructureContract =
    writerPatternKey === 'NORMAL_DETAIL_V1' &&
    (
      questionTypeForPattern === 'structure' ||
      questionTypeForPattern === 'meaning'
    );
  const finalPatternContractMsg =
    shouldInjectPatternContract
      ? ({
          role: 'assistant',
          content:
            writerPatternKey === 'NORMAL_COMPRESSED_V1'
              ? [
                'PATTERN_OUTPUT_CONTRACT (DO NOT OUTPUT):',
                'exact_paragraphs=4',
                'paragraph1=OBS',
                'paragraph2=SHIFT',
                'paragraph3=NEXT',
                `paragraph4=${answerSafeMode ? 'SAFE' : 'RESIDUE'}`,
                'never_stop_at_paragraph3=true',
                'never_leave_paragraph4_empty=true',
                'use_only_OBS_LINE_and_SHIFT_LINE=false',
                ...(deepReadEmotionInner
                  ? [
                      `FIRST_SENTENCE_SEED=${deepReadEmotionInner}`,
                      'paragraph1_first_sentence=FIRST_SENTENCE_SEED',
                      'paragraph1_must_start_with_FIRST_SENTENCE_SEED=true',
                      'do_not_rephrase_FIRST_SENTENCE_SEED_beyond_minor_naturalization=true',
                    ]
                  : []),
                'do_not_add_new_words=true',
                'do_not_expand_meaning=true',
                'paragraph4_must_not_include_cause=true',
                'paragraph4_must_not_include_explanation=true',
                'paragraph4_must_not_include_evidence=true',
                ...(answerSafeMode
                  ? []
                  : [
                      'paragraph4_role=OPEN_END',
                      'paragraph4_must_not_close=true',
                      'paragraph4_extend_unresolved_state=true',
                      'paragraphs_focus_on_state_density=true',
                      'paragraphs_keep_ambiguity_without_resolving=true',
                      'paragraphs_hold_unformed_direction=true',
                      'paragraphs_expand_how_the_state_is_present=true',
                      'paragraphs_describe_remaining_shape_and_texture=true',
                      'allow_expression_variation=true',
                      'avoid_repeating_same_words_across_paragraphs=true',
                      'prefer_words_like_trace_presence_residue_over_evidence=true',
                    ]),
              ].join('\n')
              : shouldUseMarkdownStructureContract
                ? [
                  'PATTERN_OUTPUT_CONTRACT (DO NOT OUTPUT):',
                  'markdown_structure_mode=true',
                  'exact_paragraphs=disabled',
                  'markdown_headings_required=true',
                  'min_markdown_headings=3',
                  'max_markdown_headings=7',
                  'first_heading_must_start_with=## ',
                  'do_not_use_fixed_template_headings=true',
                  'do_not_use_heading=## 意図の階層で見ると',
                  'do_not_use_heading=## ズレが起きる場所',
                  'do_not_use_heading=## 相手にはどう見えるか',
                  'do_not_use_heading=## IROS的に見るなら',
                  'do_not_use_heading=## 意図の階層としてまとめると',
                  'heading_style=内容に合わせて、日常語で自然な見出しを作る',
                  'heading_examples=## 好き嫌いより先に動いているもの / ## 関係が重くなるところ / ## 届き方を整える / ## いま見ている芯',
                  'heading_lines_must_be_independent=true',
                  'do_not_merge_heading_and_body=true',
                  'do_not_use_numbered_list=true',
                  'bullets_allowed_when_user_asks_examples=true',
                  'bullet_format=箇条書きは番号ではなく、各行を「- 」で開始する',
                  'when_user_asks_examples_use_3_to_5_bullets=true',
                  'when_user_asks_examples_do_not_say_more_examples_available=true',
                  'example_bullet_format=1項目1行で「- 見出し：説明。例: ...」の形にする',
                  'bullet_lines_must_be_independent=true',
                  'blank_line_required_before_bullets=true',
                  'do_not_inline_bullets_inside_sentence=true',
                  'do_not_emit_fixed_obs_shift_next_safe_paragraphs=true',
                  'if_user_asks_detail_or_hierarchy_expand_native_layers=true',
                  'if_subject_has_native_layers_do_not_collapse_them=true',
                  'for_five_story_pagoda_include_first_to_fifth_layer_and_center_axis=true',
                  'surface_misalignment_between_outer_reading_and_inner_intention=true',
                  'explain_how_it_appears_to_the_other_side_without_claiming_their_true_mind=true',
                  'explain_where_reception_gap_or_layer_gap_occurs=true',
                  'reposition_meaning_so_it_can_reach_the_other_side=true',
                  'structure=導入 → 固有構造の展開 → ズレの表面化 → 相手への見え方 → IROS的な再配置 → 象徴的な着地',
                  'ending_must_be_symbolic_landing=true',
                  'never_end_with_next_offer=true',
                  ].join('\n')
                : [
                    'PATTERN_OUTPUT_CONTRACT (DO NOT OUTPUT):',
                    'exact_paragraphs=disabled',
                    writerPatternKey === 'NORMAL_RESONANCE_V1' || isPartnerSideResonance
                      ? 'paragraph1=state_surface'
                      : 'paragraph1=current_state',
                    writerPatternKey === 'NORMAL_RESONANCE_V1' || isPartnerSideResonance
                      ? 'paragraph2=state_weight'
                      : 'paragraph2=breakdown_core_gap',
                    writerPatternKey === 'NORMAL_RESONANCE_V1' || isPartnerSideResonance
                      ? 'paragraph3=state_open_edge'
                      : 'paragraph3=reading_direction',
                    isPartnerSideResonance
                      ? 'paragraph4=state_action'
                      : writerPatternKey === 'NORMAL_RESONANCE_V1'
                        ? 'paragraph4=state_residue'
                        : 'paragraph4=conclusion',
                    'never_stop_at_paragraph3=true',
                    'never_leave_paragraph4_empty=true',
                    ...(writerPatternKey === 'NORMAL_RESONANCE_V1'
                      ? [
                          'paragraph1_must_start_from_user_core=false',
                          'paragraph1_must_not_start_with_demonstrative_subject=false',
                          'paragraph1_must_not_repeat_user_text_verbatim=true',
                          'paragraph1_must_not_begin_with_text_meta=false',
                          'paragraph1_must_begin_from_state_itself=true',
                          'paragraph1_sentence1=place_the_state_change_itself_first_as_a_real_shift_in_position_or stance_without_describing_the_wording_phrase_or_way_of_saying_it',
                          'paragraph1_sentence2=continue_only_the_same_state_shift_naturally_as_presence_direction_or irreversibility_without_explaining_the_wording_or_naming_the_phrase_itself',
                          'paragraph2_sentence1=state_the_weight_as_commitment_direction_or_irreversibility_without_evaluating_the_wording',
                          'paragraph3_must_not_be_guide=true',
                          'paragraph3_must_not_sound_closed=true',
                          'paragraph3_must_not_include_acceptance_line=true',
                          'paragraph3_sentence1=leave_only_one_unfixed_edge_between_the_clauses_without_closure',
                          'paragraph3_sentence2=keep_the_edge_observational_and_unresolved',
                          'paragraph4_must_be_one_sentence=false',
                          'paragraph4_must_not_be_closing_line=true',
                          'paragraph4_must_not_be_question=true',
                          'paragraph4_must_not_be_instruction=true',
                          'paragraph4_must_not_reference_text_or_wording_itself=true',
                          'paragraph4_must_not_use_sufficiency_or_completion_language=true',
                          'paragraph4_sentence1=leave_one_quiet_residue_in_the_state_itself_without_meta_commentary_text_reference_or_sufficiency_closure',
                        ]
                      : [
                          'paragraph1_must_follow_current_state_then_misrecognition_negation_then_structural_reframe=true',
                          'paragraph1_min_sentences=3',
                          'paragraph1_sentence3=place_one_soft_assertion_of_the_core_without_overexplaining_or_hard_closure',
                          'paragraph2_must_follow_breakdown_core_gap_then_breakdown_defense_then_breakdown_rejection_target=true',
                          'paragraph2_min_sentences=3',
                          'paragraph2_sentence1=name_what_two_forces_or_needs_are_coexisting_in_plain_language_without_meta_explanation',
                          'paragraph3_must_follow_reading_direction_then_sort_axis_then_sort_boundary=true',
                          'paragraph3_min_sentences=3',
                          'paragraph3_sentence1=place_a_tentative_direction_of_which_side_is_more_central_now_without_finalizing_the_conclusion',
                          'paragraph4_must_include_caution=true',
                          'paragraph4_must_end_with_closing_line=true',
                          'paragraph4_min_sentences=3',
                          'emit_fixed_section_headings=false',
                        ]),
                  ].join('\n'),
        } as const)
      : null;
      const diagnosisSourceMsg = (() => {
        if (writerPatternKey !== 'IR_DETAIL_V1') return null;

        const pickStringForDiagnosisSource = (...values: any[]) => {
          for (const value of values) {
            const s = String(value ?? '').trim();
            if (s) return s;
          }
          return '';
        };

        const normalizeDiagnosisTargetForSource = (value: any) =>
          String(value ?? '')
            .trim()
            .replace(/[\\s　]+/g, '')
            .replace(/さん|様|先生|くん|ちゃん/g, '');

        const packCandidates = [
          ctxPackForWriter,
          (opts as any)?.ctxPack,
          (opts as any)?.userContext?.ctxPack,
          (opts as any)?.meta?.extra?.ctxPack,
          (opts as any)?.userContext?.meta?.extra?.ctxPack,
          (opts as any)?.extra?.ctxPack,
        ].filter((pack: any) => pack && typeof pack === 'object');

        const activeDiagnosisIdForSource = pickStringForDiagnosisSource(
          ...packCandidates.map((pack: any) => (pack as any)?.activeDiagnosisId),
          (opts as any)?.activeDiagnosisId,
          (opts as any)?.userContext?.activeDiagnosisId,
          (opts as any)?.meta?.extra?.activeDiagnosisId
        );

        const targetRequestForDiagnosisSource = pickStringForDiagnosisSource(
          writerPatternTargetLabel,
          ...packCandidates.map((pack: any) => (pack as any)?.targetLabel),
          ...packCandidates.map((pack: any) => (pack as any)?.irMeta?.targetLabel),
          ...packCandidates.map((pack: any) => (pack as any)?.lastIrDiagnosis?.targetLabel),
          ...packCandidates.map((pack: any) => (pack as any)?.lastIrDiagnosis?.target),
          (opts as any)?.targetLabel,
          (opts as any)?.userContext?.targetLabel
        );

        const targetRequestNormForDiagnosisSource =
          normalizeDiagnosisTargetForSource(targetRequestForDiagnosisSource);

        const diagnosisHistoryForSource = packCandidates.flatMap((pack: any) => {
          const rows = (pack as any)?.diagnosisHistory;
          return Array.isArray(rows)
            ? rows.filter((item: any) => item && typeof item === 'object')
            : [];
        });

        const diagnosisTextFromItem = (item: any) =>
          pickStringForDiagnosisSource(
            item?.diagnosisText,
            item?.text,
            item?.assistantText,
            item?.content,
            item?.message
          );

        const diagnosisTargetNormFromItem = (item: any) =>
          normalizeDiagnosisTargetForSource(
            pickStringForDiagnosisSource(
              item?.targetLabel,
              item?.target,
              item?.irMeta?.targetLabel,
              item?.irMeta?.target
            )
          );

        const diagnosisByActiveId =
          activeDiagnosisIdForSource
            ? [...diagnosisHistoryForSource].reverse().find((item: any) => {
                return (
                  String(item?.id ?? '').trim() === activeDiagnosisIdForSource &&
                  diagnosisTextFromItem(item)
                );
              }) ?? null
            : null;

        const diagnosisByTarget =
          !diagnosisByActiveId && targetRequestNormForDiagnosisSource
            ? [...diagnosisHistoryForSource].reverse().find((item: any) => {
                return (
                  diagnosisTargetNormFromItem(item) === targetRequestNormForDiagnosisSource &&
                  diagnosisTextFromItem(item)
                );
              }) ?? null
            : null;

        const diagnosisLatest =
          !diagnosisByActiveId && !diagnosisByTarget
            ? [...diagnosisHistoryForSource].reverse().find((item: any) => diagnosisTextFromItem(item)) ??
              null
            : null;

        const lastIrDiagnosisForSource =
          diagnosisByActiveId ||
          diagnosisByTarget ||
          diagnosisLatest ||
          packCandidates
            .map((pack: any) => (pack as any)?.lastIrDiagnosis)
            .find((item: any) => item && typeof item === 'object' && diagnosisTextFromItem(item)) ||
          ((opts as any)?.lastIrDiagnosis &&
          typeof (opts as any).lastIrDiagnosis === 'object'
            ? (opts as any).lastIrDiagnosis
            : null) ||
          ((opts as any)?.userContext?.lastIrDiagnosis &&
          typeof (opts as any).userContext.lastIrDiagnosis === 'object'
            ? (opts as any).userContext.lastIrDiagnosis
            : null) ||
          ((opts as any)?.meta?.extra?.lastIrDiagnosis &&
          typeof (opts as any).meta.extra.lastIrDiagnosis === 'object'
            ? (opts as any).meta.extra.lastIrDiagnosis
            : null);

        const diagnosisTextFromHistory = diagnosisTextFromItem(lastIrDiagnosisForSource);

        const historyRowsRaw =
          Array.isArray((ctxPackForWriter as any)?.historyForWriter)
            ? (ctxPackForWriter as any).historyForWriter
            : Array.isArray((opts as any)?.ctxPack?.historyForWriter)
              ? (opts as any).ctxPack.historyForWriter
              : Array.isArray((opts as any)?.userContext?.ctxPack?.historyForWriter)
                ? (opts as any).userContext.ctxPack.historyForWriter
                : Array.isArray((opts as any)?.userContext?.historyForWriter)
                  ? (opts as any).userContext.historyForWriter
                  : [];

        const historyRows = Array.isArray(historyRowsRaw) ? historyRowsRaw : [];

        const diagnosisAssistant = [...historyRows].reverse().find((m: any) => {
          const role = String(m?.role ?? '').toLowerCase();
          const content = String(m?.content ?? m?.text ?? m?.message ?? '').trim();

          return (
            role === 'assistant' &&
            /観測対象|🧭|🧩|🌿|🌱\\s*メッセージ/u.test(content)
          );
        });

        const diagnosisText =
          diagnosisTextFromHistory ||
          String(
            (diagnosisAssistant as any)?.content ??
              (diagnosisAssistant as any)?.text ??
              (diagnosisAssistant as any)?.message ??
              ''
          ).trim();

        try {
          console.log('[IROS/DIAGNOSIS_SOURCE][CHECK]', {
            traceId: debug?.traceId ?? null,
            conversationId: debug?.conversationId ?? null,
            userCode: debug?.userCode ?? null,
            writerPatternKey,
            activeDiagnosisIdForSource: activeDiagnosisIdForSource || null,
            diagnosisHistoryLen: diagnosisHistoryForSource.length,
            pickedFrom:
              diagnosisByActiveId
                ? 'diagnosisHistory.activeDiagnosisId'
                : diagnosisByTarget
                  ? 'diagnosisHistory.targetLabel'
                  : diagnosisLatest
                    ? 'diagnosisHistory.latest'
                    : diagnosisTextFromHistory
                      ? 'lastIrDiagnosis'
                      : diagnosisAssistant
                        ? 'historyForWriter.assistant'
                        : 'none',
            targetRequestForDiagnosisSource,
            pickedDiagnosisTarget: pickStringForDiagnosisSource(
              (lastIrDiagnosisForSource as any)?.targetLabel,
              (lastIrDiagnosisForSource as any)?.target,
              (lastIrDiagnosisForSource as any)?.irMeta?.targetLabel
            ),
            diagnosisTextFromHistoryLen: diagnosisTextFromHistory.length,
            historyRowsLen: historyRows.length,
            historyRowsHead: historyRows.slice(-6).map((m: any) => ({
              role: String(m?.role ?? ''),
              head: String(m?.content ?? m?.text ?? m?.message ?? '').slice(0, 180),
            })),
            diagnosisTextLen: diagnosisText.length,
            diagnosisTextHead: diagnosisText.slice(0, 240),
          });
        } catch {}

        if (!diagnosisText) return null;

        const targetForDiagnosisSource =
          pickStringForDiagnosisSource(
            (lastIrDiagnosisForSource as any)?.targetLabel,
            (lastIrDiagnosisForSource as any)?.target,
            (lastIrDiagnosisForSource as any)?.irMeta?.targetLabel,
            targetRequestForDiagnosisSource,
            writerPatternTargetLabel,
            (ctxPackForWriter as any)?.targetLabel,
            (ctxPackForWriter as any)?.irMeta?.targetLabel,
            (ctxPackForWriter as any)?.lastIrDiagnosis?.target,
            ''
          ) || '対象未指定';

        const followupRequestForDiagnosisSource =
          String(
            writerPatternFollowupText ??
              (opts as any)?.userText ??
              (opts as any)?.followupText ??
              ''
          ).trim();

        return {
          role: 'assistant',
          content: [
            'DIAGNOSIS_SOURCE (DO NOT OUTPUT):',
            `target=${targetForDiagnosisSource}`,
            `activeDiagnosisId=${activeDiagnosisIdForSource || ''}`,
            `followupRequest=${followupRequestForDiagnosisSource}`,
            'diagnosisText:',
            diagnosisText,
            '',
            'DIAGNOSIS_SOURCE_RULES:',
            '- この診断本文を材料にして、ユーザーの依頼に合わせて日常語へ翻訳する',
            '- diagnosisHistory / activeDiagnosisId がある場合は、それを正本として扱う',
            '- ユーザーの依頼文そのものを深掘りしない',
            '- 相手の本心や事実として断定しない',
            '- 初回診断の内容を別の意味に変えない',
            '- 診断結果を実際の会話の続きにする場合は、診断本文の要点を現実のやり取りに接続する',
          ].join('\\n'),
        } as const;
      })();

      const messagesForWriterFinal = (() => {
        const diagnosisFollowupRequestTextForWriter = String(
          writerPatternFollowupText ??
            (opts as any)?.userText ??
            (opts as any)?.followupText ??
            ''
        ).trim();

        const isDiagnosisDetailRequestForWriter =
          /診断内容を詳しく|診断を詳しく|詳しく|詳細|深めて|深める|もう少し深めて|もっと深めて|もっと見て|もっと教えて/u.test(
            diagnosisFollowupRequestTextForWriter
          );

        const isDiagnosisFollowupForWriter = Boolean(
          (opts as any)?.userContext?.ctxPack?.diagnosisFollowup ??
          (opts as any)?.ctxPack?.diagnosisFollowup ??
          (ctxPackForWriter as any)?.diagnosisFollowup ??
          (opts as any)?.userContext?.ctxPack?.lastIrDiagnosis ??
          (ctxPackForWriter as any)?.lastIrDiagnosis ??
          (diagnosisSourceMsg && isDiagnosisDetailRequestForWriter) ??
          false
        );

        const diagnosisSeedDraftForWriter = (() => {
          if (!isDiagnosisFollowupForWriter) return '';

          const pick = (...cands: any[]) => {
            for (const v of cands) {
              if (v === undefined || v === null) continue;
              const s = String(v).replace(/\s+/g, ' ').trim();
              if (s) return s;
            }
            return '';
          };

          const d: any =
            (ctxPackForWriter as any)?.lastIrDiagnosis ??
            (opts as any)?.userContext?.ctxPack?.lastIrDiagnosis ??
            (opts as any)?.ctxPack?.lastIrDiagnosis ??
            null;

          const pickedDiagnosisSeed = pick(
            d?.summary,
            d?.diagnosisText,
            d?.diagnosis_text,
            d?.text,
            d?.assistantText,
            d?.observation,
            d?.state
          );

          return pickedDiagnosisSeed ? pickedDiagnosisSeed.slice(0, 240) : '';
        })();

        const seedDraftForWriterBase = String(seedDraft ?? '').replace(/\s+/g, ' ').trim();
        const seedDraftForWriter =
          isDiagnosisFollowupForWriter && diagnosisSeedDraftForWriter
            ? diagnosisSeedDraftForWriter
            : seedDraftForWriterBase;

        console.log('[IROS/DIAG_SEED_FOR_WRITER_DEBUG]', {
          traceId: debug.traceId ?? null,
          conversationId: debug.conversationId ?? null,
          userCode: debug.userCode ?? null,
          isDiagnosisFollowupForWriter,
          diagnosisSeedDraftLen: String(diagnosisSeedDraftForWriter ?? '').length,
          diagnosisSeedDraftHead: String(diagnosisSeedDraftForWriter ?? '').slice(0, 220),
          seedDraftForWriterBaseLen: String(seedDraftForWriterBase ?? '').length,
          seedDraftForWriterBaseHead: String(seedDraftForWriterBase ?? '').slice(0, 220),
          seedDraftForWriterLen: String(seedDraftForWriter ?? '').length,
          seedDraftForWriterHead: String(seedDraftForWriter ?? '').slice(0, 220),
          hasCtxLastIrDiagnosis: Boolean((ctxPackForWriter as any)?.lastIrDiagnosis),
          hasUserContextCtxLastIrDiagnosis: Boolean((opts as any)?.userContext?.ctxPack?.lastIrDiagnosis),
        });
        const shouldRewriteSeedPack =
          seedDraftForWriter.length > 0 &&
          seedDraftForWriter.length <= 240 &&
          !/^ユーザーの最後の発話に/.test(seedDraftForWriter) &&
          !/^@/.test(seedDraftForWriter);

        const rewriteSeedPackContent = (content: string) => {
          if (!shouldRewriteSeedPack) return content;
          if (!/SEED\s*\(DO NOT OUTPUT\):/i.test(content)) return content;

          let next = String(content ?? '');

          next = next
            .replace(/(CONTEXT:\n)[^\n]*/u, `$1${seedDraftForWriter}`)
            // FOCUS は seed 側の圧縮正本なので、ユーザー発話で上書きしない
            .replace(/(OBS=)[^\n]*/u, '$1まず質問への定義・軸を短く返す。emotion_inner / emotion_need が存在しても、OBSの先頭を感情の言い換えだけで開始しない')
            .replace(/(NEXT=)[^\n]*/u, '$1必要以上に構造化せず、会話として少しだけ返す')
            .replace(/(OBS_LINE=)[^\n]*/u, '$1最初の一文は、感情の受け文ではなく、問いに対する分かりやすい定義または見取り図から開始する')
            .replace(/(NEXT_LINE=)[^\n]*/u, '$1丸写しではなく、感じ取った強さだけを短く返す。');
          return next;
        };

        const shouldUsePreviousEventOnlyMessages =
          isPreviousReplyRephraseForFinal ||
          String((eventFrameForWriter as any)?.kind ?? '').trim() === 'operate_previous_event' ||
          String((eventFrameForWriter as any)?.target ?? '').trim() === 'last_assistant_content';

        const base = [...messagesForWriter]
          .filter((m: any) => {
            if (!shouldUsePreviousEventOnlyMessages) return true;

            const role = String(m?.role ?? '').trim();
            if (role !== 'assistant') return true;

            const content = String(m?.content ?? '');

            // ✅ 前イベント操作ターンでは、現在user文を主題化する通常メタを writer へ渡さない。
            // PREVIOUS_EVENT_SOURCE / WRITER_DIRECTIVES / PATTERN_OUTPUT_CONTRACT は後段の inserts で入れる。
            if (
              /(STATE_CUES|HISTORY_LITE|MIRROR_FLOW_SEED|SEED_INSTRUCTION|INTERNAL PACK|USER_UNDERSTANDING_STATE|PAST_STATE_NOTE|HUMAN_CONTEXT_ORCHESTRATION|TRANSITION_MEANING|FLOW_V2)/i.test(
                content,
              )
            ) {
              return false;
            }

            return true;
          })
          .map((m: any) => {
            if (String(m?.role ?? '') !== 'assistant') return m;

            const content = String(m?.content ?? '');
            const rewritten = rewriteSeedPackContent(content);

            return rewritten === content ? m : { ...m, content: rewritten };
          });

        const storySourceMsg = (() => {
          if (storyModeForFinal !== 'remake_story') return null;

          const pickLastAssistantStory = (...sources: any[]): string => {
            for (const source of sources) {
              if (!Array.isArray(source)) continue;

              const found = [...source]
                .reverse()
                .find((m: any) => {
                  const role = String(m?.role ?? m?.type ?? '').toLowerCase().trim();
                  if (!/^(assistant|ai|model|iros)$/i.test(role)) return false;

                  const content = String(
                    m?.content ??
                      m?.text ??
                      m?.assistantText ??
                      m?.message ??
                      '',
                  ).trim();

                  if (!content) return false;
                  if (/(DO NOT OUTPUT|INTERNAL PACK|STATE_CUES|MIRROR_FLOW_SEED|WRITER_DIRECTIVES|PATTERN_OUTPUT_CONTRACT|HISTORY_LITE)/i.test(content)) return false;
                  if (/^(もちろんです|わかりました|了解です|できます|必要なら)/u.test(content)) return false;

                  return true;
                });

              const content = String(
                (found as any)?.content ??
                  (found as any)?.text ??
                  (found as any)?.assistantText ??
                  (found as any)?.message ??
                  '',
              ).trim();

              if (content) return content;
            }

            return '';
          };

          const sourceStory = pickLastAssistantStory(
            (ctxPackForWriter as any)?.historyForWriter,
            (opts as any)?.ctxPack?.historyForWriter,
            (opts as any)?.userContext?.ctxPack?.historyForWriter,
            (opts as any)?.meta?.extra?.ctxPack?.historyForWriter,
            (opts as any)?.userContext?.meta?.extra?.ctxPack?.historyForWriter,
          );

          console.log(
            '[IROS/STORY_SOURCE_PICK]',
            JSON.stringify({
              traceId: debug.traceId ?? null,
              conversationId: debug.conversationId ?? null,
              userCode: debug.userCode ?? null,
              enabled: true,
              storyMode: storyModeForFinal,
              sourceStoryLen: sourceStory.length,
              sourceStoryHead: sourceStory.slice(0, 320),
              sourceStoryTail: sourceStory.slice(-220),
            }),
          );

          if (!sourceStory) return null;

          return {
            role: 'assistant',
            content: [
              'STORY_SOURCE (DO NOT OUTPUT):',
              'このターンは、現在のユーザー文を相談として深読みするターンではない。',
              '現在のユーザー文は、SOURCE_STORY をリメイクする操作条件として扱う。',
              '',
              `storyMode=${storyModeForFinal}`,
              `integrationIntent=${String((ctxPackForWriter as any)?.integrationIntent === true)}`,
              '',
              'SOURCE_STORY:',
              sourceStory,
              '',
              'STORY_SOURCE_RULES:',
              '- SOURCE_STORY をリメイク対象の正本にする',
              '- 出力はリメイク物語本文にする',
              '- リメイクの方法・説明・手順を書かない',
              '- 「リメイクは」「物語はここで」「こうなります」などの説明接続で進めない',
              '- SOURCE_STORY にある感情を受け取る場面を入れる',
              '- わかってもらえなかった痛みが、物語の中で理解される場面を入れる',
              '- 痛みを消さず、受け取られることで意味が変わる流れにする',
              '- 最後は、未消化だったものが光へ変わり、統合へ向かう物語として閉じる',
              '- SOURCE_STORY にない人物・事件・家系事情を足さない',
            ].join('\n'),
          } as const;
        })();

        const storyMetaSeedMsg = (() => {
          if (!isStoryModeForFinal) return null;

          const normStoryMeta = (value: any): string => {
            if (value == null) return '';
            if (
              typeof value === 'string' ||
              typeof value === 'number' ||
              typeof value === 'boolean'
            ) {
              return String(value).trim();
            }
            if (typeof value === 'object') {
              const picked =
                (value as any)?.id ??
                (value as any)?.deltaType ??
                (value as any)?.energy ??
                (value as any)?.stage ??
                null;

              if (picked != null) return String(picked).trim();

              try {
                return JSON.stringify(value).slice(0, 220);
              } catch {
                return '';
              }
            }

            return String(value ?? '').trim();
          };

          const qCodeForStoryMeta = normStoryMeta(
            (storyFlowSnapshotForFinal as any)?.qCode ??
              (ctxPackForWriter as any)?.qCode ??
              (opts as any)?.ctxPack?.qCode ??
              (opts as any)?.userContext?.ctxPack?.qCode,
          );

          const depthStageForStoryMeta = normStoryMeta(
            (storyFlowSnapshotForFinal as any)?.depthStage ??
              (ctxPackForWriter as any)?.depthStage ??
              (opts as any)?.ctxPack?.depthStage ??
              (opts as any)?.userContext?.ctxPack?.depthStage,
          );

          const phaseForStoryMeta = normStoryMeta(
            (storyFlowSnapshotForFinal as any)?.phase ??
              (ctxPackForWriter as any)?.phase ??
              (opts as any)?.ctxPack?.phase ??
              (opts as any)?.userContext?.ctxPack?.phase,
          );

          const eTurnForStoryMeta = normStoryMeta(
            (ctxPackForWriter as any)?.mirror?.e_turn ??
              (ctxPackForWriter as any)?.mirrorFlowV1?.mirror?.e_turn ??
              (ctxPackForWriter as any)?.e_turn ??
              (opts as any)?.ctxPack?.mirror?.e_turn ??
              (opts as any)?.userContext?.ctxPack?.mirror?.e_turn ??
              (opts as any)?.userContext?.ctxPack?.mirrorFlowV1?.mirror?.e_turn,
          );

          const polarityForStoryMeta = normStoryMeta(
            (ctxPackForWriter as any)?.mirror?.polarity ??
              (ctxPackForWriter as any)?.polarity ??
              (opts as any)?.ctxPack?.mirror?.polarity ??
              (opts as any)?.userContext?.ctxPack?.mirror?.polarity,
          );

          const flowDeltaForStoryMeta = normStoryMeta(
            (storyFlowSnapshotForFinal as any)?.flow?.delta ??
              (ctxPackForWriter as any)?.flow?.delta ??
              (ctxPackForWriter as any)?.flow?.deltaType ??
              (ctxPackForWriter as any)?.flowDelta ??
              (opts as any)?.ctxPack?.flow?.delta ??
              (opts as any)?.userContext?.ctxPack?.flow?.delta,
          );

          const returnStreakForStoryMeta = normStoryMeta(
            (storyFlowSnapshotForFinal as any)?.flow?.returnStreak ??
              (ctxPackForWriter as any)?.flow?.returnStreak ??
              (ctxPackForWriter as any)?.returnStreak ??
              (opts as any)?.ctxPack?.flow?.returnStreak ??
              (opts as any)?.userContext?.ctxPack?.flow?.returnStreak,
          );

          const futureRandomForStoryMeta = normStoryMeta(
            (ctxPackForWriter as any)?.flow?.futureRandom ??
              (opts as any)?.ctxPack?.flow?.futureRandom ??
              (opts as any)?.userContext?.ctxPack?.flow?.futureRandom,
          );

          const topicDigestForStoryMeta = normStoryMeta(
            (storyFlowSnapshotForFinal as any)?.topicDigest ??
              (ctxPackForWriter as any)?.topicDigest ??
              (opts as any)?.ctxPack?.topicDigest ??
              (opts as any)?.userContext?.ctxPack?.topicDigest,
          );

          console.log(
            '[IROS/STORY_META_SEED]',
            JSON.stringify({
              traceId: debug.traceId ?? null,
              conversationId: debug.conversationId ?? null,
              userCode: debug.userCode ?? null,
              storyMode: storyModeForFinal,
              qCode: qCodeForStoryMeta || null,
              depthStage: depthStageForStoryMeta || null,
              phase: phaseForStoryMeta || null,
              e_turn: eTurnForStoryMeta || null,
              polarity: polarityForStoryMeta || null,
              flowDelta: flowDeltaForStoryMeta || null,
              returnStreak: returnStreakForStoryMeta || null,
              futureRandom: futureRandomForStoryMeta || null,
              topicDigest: topicDigestForStoryMeta || null,
            }),
          );

          return {
            role: 'assistant',
            content: [
              'STORY_META_SEED (DO NOT OUTPUT):',
              'このメタは本文で説明しない。',
              'コード名・内部名・数値を本文に出さない。',
              'メタは、物語の温度・深さ・場面の重さ・光への変化の方向として使う。',
              '',
              `storyMode=${storyModeForFinal}`,
              qCodeForStoryMeta ? `qCode=${qCodeForStoryMeta}` : null,
              depthStageForStoryMeta ? `depthStage=${depthStageForStoryMeta}` : null,
              phaseForStoryMeta ? `phase=${phaseForStoryMeta}` : null,
              eTurnForStoryMeta ? `e_turn=${eTurnForStoryMeta}` : null,
              polarityForStoryMeta ? `polarity=${polarityForStoryMeta}` : null,
              flowDeltaForStoryMeta ? `flowDelta=${flowDeltaForStoryMeta}` : null,
              returnStreakForStoryMeta ? `returnStreak=${returnStreakForStoryMeta}` : null,
              futureRandomForStoryMeta ? `futureRandom=${futureRandomForStoryMeta}` : null,
              topicDigestForStoryMeta ? `topicDigest=${topicDigestForStoryMeta}` : null,
              '',
              'STORY_META_INTERPRETATION:',
              '- depthStage / phase は、物語の深さと視点に変換する',
              '- e_turn は、受け取られるべき感情の温度に変換する',
              '- flowDelta / returnStreak は、繰り返してきた未消化の長さに変換する',
              '- futureRandom は、次に光へ変わる可能性の方向としてだけ使う',
              '- topicDigest は、物語の主題を外さないために使う',
              '- 出力は説明ではなく、メタを通した物語本文にする',
            ]
              .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
              .join('\n'),
          } as const;
        })();

        const previousEventSourceMsg = (() => {
          const isOperatePreviousEvent =
            isPreviousReplyRephraseForFinal ||
            String((eventFrameForWriter as any)?.kind ?? '').trim() === 'operate_previous_event' ||
            String((eventFrameForWriter as any)?.target ?? '').trim() === 'last_assistant_content';

          if (!isOperatePreviousEvent) return null;

          const pickLastAssistantText = (...sources: any[]): string => {
            for (const source of sources) {
              if (!Array.isArray(source)) continue;

              const found = [...source]
                .reverse()
                .find((m: any) => {
                  const role = String(m?.role ?? m?.type ?? '').toLowerCase().trim();
                  if (!/^(assistant|ai|model|iros)$/i.test(role)) return false;

                  const content = String(
                    m?.content ??
                      m?.text ??
                      m?.assistantText ??
                      m?.message ??
                      '',
                  ).trim();

                  if (!content) return false;
                  if (/(DO NOT OUTPUT|INTERNAL PACK|STATE_CUES|MIRROR_FLOW_SEED|WRITER_DIRECTIVES|PATTERN_OUTPUT_CONTRACT|HISTORY_LITE)/i.test(content)) return false;

                  return true;
                });

              const content = String(
                (found as any)?.content ??
                  (found as any)?.text ??
                  (found as any)?.assistantText ??
                  (found as any)?.message ??
                  '',
              ).trim();

              if (content) {
                return content
                  .replace(/\s+/g, ' ')
                  .replace(/[🌀🪔]/g, '')
                  .trim()
                  .slice(0, 2400);
              }
            }

            return '';
          };

          const sourceText = pickLastAssistantText(
            (ctxPackForWriter as any)?.historyForWriter,
            (opts as any)?.ctxPack?.historyForWriter,
            (opts as any)?.userContext?.ctxPack?.historyForWriter,
            (opts as any)?.meta?.extra?.ctxPack?.historyForWriter,
            (opts as any)?.userContext?.meta?.extra?.ctxPack?.historyForWriter,
          );

          const sourceTextLenForRewrite = sourceText.length;
          const minOutputCharsForRewrite = Math.max(
            180,
            Math.floor(sourceTextLenForRewrite * 0.7),
          );

          console.log(
            '[IROS/PREVIOUS_EVENT_SOURCE_PICK]',
            JSON.stringify({
              traceId: debug.traceId ?? null,
              conversationId: debug.conversationId ?? null,
              userCode: debug.userCode ?? null,
              enabled: true,
              sourceTextLen: sourceTextLenForRewrite,
              minOutputChars: minOutputCharsForRewrite,
              sourceTextHead: sourceText.slice(0, 320),
              sourceTextTail: sourceText.slice(-220),
            }),
          );

          if (!sourceText) return null;

          return {
            role: 'assistant',
            content: [
              'PREVIOUS_EVENT_SOURCE (DO NOT OUTPUT):',
              'このターンは、現在のユーザー文を読解・診断・深読みするターンではない。',
              '現在のユーザー文は、直前イベントへの操作条件として扱う。',
              '',
              'OPERATION:',
              `kind=${String((eventFrameForWriter as any)?.kind ?? 'operate_previous_event')}`,
              `operation=${String((eventFrameForWriter as any)?.operation ?? 'rewrite')}`,
              `target=${String((eventFrameForWriter as any)?.target ?? 'last_assistant_content')}`,
              `style=${String((eventFrameForWriter as any)?.style ?? 'style_rewrite')}`,
              `user_instruction=${resolvedAskCurrentTextForWriter}`,
              '',
              'SOURCE_TEXT:',
              sourceText,
              '',
              'OUTPUT_RULES:',
              `source_text_chars=${sourceTextLenForRewrite}`,
              `min_output_chars=${minOutputCharsForRewrite}`,
              '- SOURCE_TEXT だけを書き直し対象にする',
              '- 現在のユーザー文そのものに答えない',
              '- 説明・提案・分析・確認で終わらない',
              '- 元文にない人物・関係・出来事・場所・小道具を足さない',
              '- 元文にない恋愛・連絡待ち・スマホ・LINE・返事待ち・彼・彼女の文脈を足さない',
              '- 出力は、操作後の本文だけにする',
              '- min_output_chars 未満に短縮しない',
            ].join('\n'),
          } as const;
        })();

        const diagnosisSeedControlMsg = (() => {
          if (!isDiagnosisFollowupForWriter) return null;

          const d: any =
            (ctxPackForWriter as any)?.lastIrDiagnosis ??
            (opts as any)?.userContext?.ctxPack?.lastIrDiagnosis ??
            (opts as any)?.ctxPack?.lastIrDiagnosis ??
            null;

          if (!d || typeof d !== 'object') return null;

          const pick = (...cands: any[]) => {
            for (const v of cands) {
              if (v === undefined || v === null) continue;
              const s = String(v).replace(/\s+/g, ' ').trim();
              if (s) return s;
            }
            return '';
          };

          const targetLabel = pick(d?.targetLabel, d?.target, (ctxPackForWriter as any)?.targetLabel);
          const targetKey = pick(d?.targetKey);
          const diagnosisResultId = pick(d?.diagnosisResultId);
          const qPrimary = pick(d?.qPrimary);
          const depthStage = pick(d?.depthStage);
          const phase = pick(d?.phase);
          const createdAt = pick(d?.createdAt);

          const diagnosisText = pick(
            d?.summary,
            d?.diagnosisText,
            d?.diagnosis_text,
            d?.text,
            d?.assistantText,
            d?.observation,
            d?.state
          );

          const content = [
            'DIAGNOSIS_SEED_CONTROL (DO NOT OUTPUT):',
            'このSeedは保存済みir診断結果の正本である。',
            'WriterはこのSeedを診断フォローの根拠として使う。',
            '本文に DIAGNOSIS_SEED_CONTROL や内部キー名を出さない。',
            '',
            targetLabel ? `targetLabel=${targetLabel}` : null,
            targetKey ? `targetKey=${targetKey}` : null,
            diagnosisResultId ? `diagnosisResultId=${diagnosisResultId}` : null,
            qPrimary ? `qPrimary=${qPrimary}` : null,
            depthStage ? `depthStage=${depthStage}` : null,
            phase ? `phase=${phase}` : null,
            createdAt ? `createdAt=${createdAt}` : null,
            'source=iros_ir_diagnosis_results',
            'boundary=外部事実や相手の本心の断定ではなく、保存済みir診断結果の続きとして扱う',
            'writerTask=この保存済み診断結果を正本として、ユーザーの続きの要求に答える',
            diagnosisText ? `diagnosisText=${diagnosisText}` : null,
          ]
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
            .join('\n');

          console.log(
            '[IROS/DIAGNOSIS_SEED_CONTROL]',
            JSON.stringify({
              traceId: debug.traceId ?? null,
              conversationId: debug.conversationId ?? null,
              userCode: debug.userCode ?? null,
              hasSeed: true,
              targetLabel: targetLabel || null,
              targetKey: targetKey || null,
              diagnosisResultId: diagnosisResultId || null,
              qPrimary: qPrimary || null,
              depthStage: depthStage || null,
              phase: phase || null,
              createdAt: createdAt || null,
              diagnosisTextLen: diagnosisText.length,
              diagnosisTextHead: diagnosisText.slice(0, 160),
            })
          );

          return {
            role: 'assistant',
            content,
          } as const;
        })();

        const relationSeedControlMsg = (() => {
          const r: any =
            (ctxPackForWriter as any)?.relationshipMemory ??
            (opts as any)?.userContext?.ctxPack?.relationshipMemory ??
            (opts as any)?.ctxPack?.relationshipMemory ??
            null;

          if (!r || typeof r !== 'object') return null;

          const pick = (...cands: any[]) => {
            for (const v of cands) {
              if (v === undefined || v === null) continue;
              const s = String(v).replace(/\s+/g, ' ').trim();
              if (s) return s;
            }
            return '';
          };

          const pickList = (...cands: any[]) => {
            for (const v of cands) {
              if (Array.isArray(v)) {
                const items = v
                  .map((x: any) => {
                    if (x && typeof x === 'object') {
                      const key = pick(x?.key);
                      const value = pick(x?.value, x?.note);
                      return [key, value].filter(Boolean).join(': ');
                    }
                    return pick(x);
                  })
                  .filter(Boolean);
                if (items.length > 0) return items.join(' / ');
              }

              const s = pick(v);
              if (s) return s;
            }
            return '';
          };

          const relationId = pick(r?.relationId, r?.relation_id);
          const displayName = pick(r?.displayName, r?.display_name);
          const role = pick(r?.role);
          const confidence = pick(r?.confidence);
          const facts = pickList(r?.facts);
          const patterns = pickList(r?.patterns);
          const safeOpeners = pickList(r?.safeOpeners, r?.safe_openers);
          const pressureTriggers = pickList(r?.pressureTriggers, r?.pressure_triggers);
          const userReactionPattern = pickList(r?.userReactionPattern, r?.user_reaction_pattern);
          const unresolvedTopics = pickList(r?.unresolvedTopics, r?.unresolved_topics);

          const hasAny =
            relationId ||
            displayName ||
            role ||
            facts ||
            patterns ||
            safeOpeners ||
            pressureTriggers ||
            userReactionPattern ||
            unresolvedTopics;

          if (!hasAny) return null;

          const content = [
            'RELATION_SEED_CONTROL (DO NOT OUTPUT):',
            'このSeedは保存済みRelationship Memoryの正本である。',
            'WriterはこのSeedを関係文脈の根拠として使う。',
            '本文に RELATION_SEED_CONTROL や内部キー名を出さない。',
            '',
            relationId ? `relationId=${relationId}` : null,
            displayName ? `displayName=${displayName}` : null,
            role ? `role=${role}` : null,
            confidence ? `confidence=${confidence}` : null,
            'source=iros_relationship_memory',
            'boundary=保存済みの関係文脈だけを扱う。相手の本音・愛情・未練・脈あり脈なしは断定しない。',
            'writerTask=保存済みの関係文脈を補助線として、いまの相談に答える。',
            facts ? `facts=${facts}` : null,
            patterns ? `patterns=${patterns}` : null,
            safeOpeners ? `safeOpeners=${safeOpeners}` : null,
            pressureTriggers ? `pressureTriggers=${pressureTriggers}` : null,
            userReactionPattern ? `userReactionPattern=${userReactionPattern}` : null,
            unresolvedTopics ? `unresolvedTopics=${unresolvedTopics}` : null,
          ]
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
            .join('\n');

          console.log(
            '[IROS/RELATION_SEED_CONTROL]',
            JSON.stringify({
              traceId: debug.traceId ?? null,
              conversationId: debug.conversationId ?? null,
              userCode: debug.userCode ?? null,
              hasSeed: true,
              relationId: relationId || null,
              displayName: displayName || null,
              role: role || null,
              confidence: confidence || null,
              factsLen: facts.length,
              patternsLen: patterns.length,
              unresolvedTopicsLen: unresolvedTopics.length,
              userReactionPatternLen: userReactionPattern.length,
            })
          );

          return {
            role: 'assistant',
            content,
          } as const;
        })();

        const inserts = [
          isDiagnosisFollowupForWriter ? diagnosisSourceMsg : null,
          diagnosisSeedControlMsg,
          relationSeedControlMsg,
          storySourceMsg,
          storyMetaSeedMsg,
          previousEventSourceMsg,
          finalWriterDirectivesMsg,
          finalPatternContractMsg,
        ].filter(Boolean) as Array<{
          role: 'assistant';
          content: string;
        }>;

        if (inserts.length === 0) return base;

        if (base.length > 0 && base[base.length - 1]?.role === 'user') {
          return [...base.slice(0, -1), ...inserts, base[base.length - 1]];
        }

        return [...base, ...inserts];
      })();

    console.log(
      '[IROS/rephraseEngine][FINAL_PATTERN_CONTRACT_CHECK]',
      JSON.stringify({
        traceId: debug?.traceId ?? null,
        conversationId: debug?.conversationId ?? null,
        userCode: debug?.userCode ?? null,
        msgCount: Array.isArray(messagesForWriterFinal) ? messagesForWriterFinal.length : 0,
        hasPatternContractMsg: Array.isArray(messagesForWriterFinal)
          ? messagesForWriterFinal.some((m: any) =>
              String(m?.content ?? '').includes('PATTERN_OUTPUT_CONTRACT (DO NOT OUTPUT):')
            )
          : false,
          hasP1CoreRule: Array.isArray(messagesForWriterFinal)
          ? messagesForWriterFinal.some((m: any) =>
              String(m?.content ?? '').includes(
                'paragraph1_must_begin_from_state_itself=true'
              )
            )
          : false,
          hasP4ResidueRule: Array.isArray(messagesForWriterFinal)
          ? messagesForWriterFinal.some((m: any) =>
              String(m?.content ?? '').includes(
                'paragraph4_sentence1=leave_one_quiet_unfinished_response_near_the_same_core'
              ) ||
              String(m?.content ?? '').includes(
                'paragraph4_sentence1=leave_one_quiet_residue_in_the_state_itself'
              )
            )
          : false,
        assistantHeads: Array.isArray(messagesForWriterFinal)
          ? messagesForWriterFinal
              .filter((m: any) => String(m?.role ?? '') === 'assistant')
              .map((m: any) => safeHead(String(m?.content ?? ''), 220))
          : [],
      })
    );

    const activeContextSeedDirectReplyForWriter = (() => {
      const userTextForActiveContextSeed = String(
        writerPatternFollowupText ??
          (opts as any)?.userText ??
          (opts as any)?.followupText ??
          ''
      ).trim();

      if (!/誰の診断|何の診断|どの診断|誰を深め|誰のこと|何を深め/u.test(userTextForActiveContextSeed)) {
        return '';
      }

      const sources = [
        String(seedDraft ?? ''),
        String(seedDraftRaw ?? ''),
        String(slotsTextRawAll ?? ''),
        String((opts as any)?.meta?.extra?.memorySeedText ?? ''),
        String((opts as any)?.meta?.extra?.ctxPack?.memorySeedText ?? ''),
        String((opts as any)?.ctxPack?.memorySeedText ?? ''),
        String((opts as any)?.userContext?.ctxPack?.memorySeedText ?? ''),
        String((opts as any)?.userContext?.meta?.extra?.memorySeedText ?? ''),
        String((opts as any)?.userContext?.meta?.extra?.ctxPack?.memorySeedText ?? ''),
      ].filter((s) => s.trim().length > 0);

      const source = sources.find((s) =>
        s.includes('ACTIVE_CONTEXT_SEED_V1') &&
        s.includes('kind=diagnosis_target') &&
        s.includes('writerPolicy=do_not_rewrite_answer')
      );

      if (!source) return '';

      const answer =
        source.match(/(?:^|\n)answer=([^\n]+)/u)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';

      return answer;
    })();

    if (activeContextSeedDirectReplyForWriter) {
      console.log('[IROS/rephraseEngine][ACTIVE_CONTEXT_SEED_DIRECT_RETURN]', {
        traceId: debug?.traceId ?? null,
        conversationId: debug?.conversationId ?? null,
        userCode: debug?.userCode ?? null,
        reply: activeContextSeedDirectReplyForWriter,
      });

      return activeContextSeedDirectReplyForWriter;
    }

    return await callWriterLLM({
      model: opts.model ?? 'gpt-5',
      temperature: opts.temperature ?? 0.7,
      messages: (() => {
        const hasPreviousEventSourceForCall =
          Array.isArray(messagesForWriterFinal) &&
          messagesForWriterFinal.some((m: any) =>
            String(m?.content ?? '').includes('PREVIOUS_EVENT_SOURCE (DO NOT OUTPUT):')
          );

        const hasDiagnosisSourceForCall =
          Array.isArray(messagesForWriterFinal) &&
          messagesForWriterFinal.some((m: any) =>
            String(m?.content ?? '').includes('DIAGNOSIS_SOURCE (DO NOT OUTPUT):')
          );

        const messagesForWriterCall = Array.isArray(messagesForWriterFinal)
          ? messagesForWriterFinal.map((m: any, i: number) => {
              const isLast = i === messagesForWriterFinal.length - 1;
              if (!isLast || String(m?.role ?? '') !== 'user') return m;

              if (hasPreviousEventSourceForCall) {
                // ✅ 前イベント操作ターンでは、最後の user 文を読解対象にしない。
                // user 文は PREVIOUS_EVENT_SOURCE 内の user_instruction として扱い、
                // 最終 user message は「SOURCE_TEXT を操作せよ」という実行命令に置き換える。
                return {
                  ...m,
                  content: [
                    'PREVIOUS_EVENT_OPERATION_EXECUTE:',
                    'PREVIOUS_EVENT_SOURCE の SOURCE_TEXT を、user_instruction に従って直接書き直す。',
                    '出力するのは、書き直した本文そのものだけ。',
                    '命令文・依頼文・説明文・提案文・確認文を出力しない。',
                    '「〜してください」「〜したいです」「〜にしてください」「必要なら」「たとえば」で終わらない。',
                    '現在のユーザー文そのものに答えない。',
                    'SOURCE_TEXT にない人物・関係・出来事・場所・小道具を足さない。',
                    'SOURCE_TEXT にない恋愛・連絡待ち・スマホ・LINE・返事待ち・彼・彼女の文脈を足さない。',
                    'SOURCE_TEXT の主題・対象・世界観を保持したまま、本文として完成させる。',
                    'SOURCE_TEXT を短く要約しない。元文の長さ・情報量・場面数をできるだけ保つ。',
                    'SOURCE_TEXT にある固有イメージ・場所・人物・小道具・出来事を落とさない。',
                    'SOURCE_TEXT にある海・家・潮・塩・祖母・庭・泣くこと・井戸・影などの具体要素がある場合、それらを保持して現実寄りに書き直す。',
                    '抽象的な心情文だけに置き換えない。',
                    '元文が物語なら、物語本文として書き直す。心情説明だけにしない。',
                    '最低でも PREVIOUS_EVENT_SOURCE の min_output_chars 以上の文量を維持する。',
                    '短い一段落へ圧縮しない。SOURCE_TEXT の場面を複数段落で残す。',
                    '出力が SOURCE_TEXT の要約になっている場合は失敗。リライト本文として、元の場面を展開して残す。',
                  ].join('\n'),
                };
              }

              if (hasDiagnosisSourceForCall) {
                // ✅ 診断フォローアップでは、最後の user 文を読解対象にしない。
                // user 文は DIAGNOSIS_SOURCE 内の followupRequest として扱い、
                // 最終 user message は「診断正本を深める」実行命令に置き換える。
                return {
                  ...m,
                  content: [
                    'DIAGNOSIS_FOLLOWUP_EXECUTE:',
                    'DIAGNOSIS_SOURCE の diagnosisText を正本として、followupRequest に従って深める。',
                    '現在のユーザー文そのものを分析しない。',
                    '「もう少し深めてください」「詳しく」「深めて」などの依頼文の意味を説明しない。',
                    '必ず DIAGNOSIS_SOURCE の診断本文に含まれる「現状」「ポイント」「意識の向かう先」「メッセージ」の具体内容を根拠にする。',
                    '診断本文にある具体語を拾い、抽象語だけでまとめない。',
                    '「診断の芯」「表面の説明」「深めたいのは」「見えていること」など、診断本文から離れたメタ説明で始めない。',
                    'target が自分の場合は、ユーザー自身の状態・反応・選び方の見立てとして書く。',
                    '診断本文にない外部事実・人物・関係を足さない。',
                    '相手の本心や事実を読んだように断定しない。',
                    '出力は、診断内容を深めた本文だけにする。',
                    '内部キー名・命令文・DIAGNOSIS_SOURCE・DIAGNOSIS_FOLLOWUP_EXECUTE を出力しない。'
                  ].join('\n'),
                };
              }

              return m;
            })
          : messagesForWriterFinal;

        console.log(
          '[IROS/rephraseEngine][FINAL_MESSAGES_FOR_WRITER]',
          JSON.stringify({
            traceId: debug.traceId ?? null,
            conversationId: debug.conversationId ?? null,
            userCode: debug.userCode ?? null,
            previousEventSourceForCall: hasPreviousEventSourceForCall,
            len: Array.isArray(messagesForWriterCall) ? messagesForWriterCall.length : 0,
            roles: Array.isArray(messagesForWriterCall)
              ? messagesForWriterCall.map((m: any) => String(m?.role ?? ''))
              : [],
            heads: Array.isArray(messagesForWriterCall)
              ? messagesForWriterCall.map((m: any) => safeHead(String(m?.content ?? ''), 160))
              : [],
          })
        );

        return messagesForWriterCall;
      })(),
      ...({ slotDecision: slotDecisionForWriter } as any),
      writerDirectives: {
        ...writerDirectivesForFinal,
        ...(deepRevealLineForWriter &&
                  !shouldSuppressDeepRevealForFinal &&
                  !Boolean(
                    (opts as any)?.userContext?.ctxPack?.diagnosisFollowup ??
                    (opts as any)?.extra?.ctxPack?.diagnosisFollowup ??
                    (opts as any)?.ctxPack?.diagnosisFollowup ??
                    (opts as any)?.diagnosisFollowup ??
                    false
                  )
          ? {
              deepRevealLine: deepRevealLineForWriter,
              forceUseDeepReveal: true,
            }
          : {}),
      },

        // ✅ 追加：冒頭オウム返しガード用（messagesには入れない。比較専用）
        echoGuardUserText: String((opts as any)?.userText ?? ''),

        traceId: debug.traceId ?? null,
        conversationId: debug.conversationId ?? null,
        userCode: debug.userCode ?? null,

        // ✅ 重要：拾ってるだけだった digest を “実際に渡す”
        historyDigestV1,

// ✅ NEW: writerCalls.ts で question / pastState / goalKind を参照できるように渡す
extra: {
  ...(((opts as any)?.extra && typeof (opts as any).extra === 'object')
    ? (opts as any).extra
    : {}),

  question:
    ((opts as any)?.extra?.question) ??
    ((opts as any)?.userContext?.question) ??
    ((opts as any)?.userContext?.meta?.extra?.question) ??
    null,

  pastStateNoteText:
    ((opts as any)?.extra?.pastStateNoteText) ??
    ((opts as any)?.userContext?.pastStateNoteText) ??
    ((opts as any)?.userContext?.meta?.extra?.pastStateNoteText) ??
    null,

  pastStateTriggerKind:
    ((opts as any)?.extra?.pastStateTriggerKind) ??
    ((opts as any)?.userContext?.pastStateTriggerKind) ??
    ((opts as any)?.userContext?.meta?.extra?.pastStateTriggerKind) ??
    null,

  pastStateKeyword:
    ((opts as any)?.extra?.pastStateKeyword) ??
    ((opts as any)?.userContext?.pastStateKeyword) ??
    ((opts as any)?.userContext?.meta?.extra?.pastStateKeyword) ??
    null,

  goalKind:
    (opts as any)?.goalKind ??
    (opts as any)?.userContext?.goalKind ??
    (opts as any)?.userContext?.ctxPack?.goalKind ??
    (opts as any)?.userContext?.ctxPack?.replyGoal?.kind ??
    (ctxPackForWriter?.goalKind ?? null),

  referenceJudgeSeed:
    ((opts as any)?.extra?.referenceJudgeSeed) ??
    ((opts as any)?.userContext?.referenceJudgeSeed) ??
    ((opts as any)?.userContext?.meta?.extra?.referenceJudgeSeed) ??
    ((opts as any)?.userContext?.ctxPack?.referenceJudgeSeed) ??
    null,
},

userContext: {
  ...(((opts as any)?.userContext && typeof (opts as any).userContext === 'object')
    ? (opts as any).userContext
    : {}),

  // ✅ SRI/TCF 回転メタを writerCalls 側へ渡す
  // - ログ追加なし。既存metaから拾って userContext に橋渡しするだけ。
  spinLoop: spinLoopForWriterCall,
  spinStep: spinStepForWriterCall,
  rotationState: {
    ...(((opts as any)?.userContext?.rotationState &&
      typeof (opts as any).userContext.rotationState === 'object')
      ? (opts as any).userContext.rotationState
      : {}),
    ...(spinLoopForWriterCall ? { spinLoop: spinLoopForWriterCall } : {}),
    ...(spinStepForWriterCall !== null ? { spinStep: spinStepForWriterCall } : {}),
  },

    ctxPack: {
      ...((((opts as any)?.userContext?.ctxPack &&
        typeof (opts as any).userContext.ctxPack === 'object')
        ? (opts as any).userContext.ctxPack
        : {})),
      ...((((opts as any)?.ctxPack &&
        typeof (opts as any).ctxPack === 'object')
        ? (opts as any).ctxPack
        : {})),
      ...((((opts as any)?.ctxPack?.irMeta &&
        typeof (opts as any).ctxPack.irMeta === 'object')
        ? { irMeta: (opts as any).ctxPack.irMeta }
        : {})),
      ...((((opts as any)?.ctxPack?.detailMode === true) ||
        ((opts as any)?.userContext?.ctxPack?.detailMode === true))
        ? { detailMode: true }
        : {}),
      ...((ctxPackForWriter && typeof ctxPackForWriter === 'object')
        ? ctxPackForWriter
        : {}),
      ...(((((raw as any)?.meta?.extra?.ctxPack) &&
        typeof (raw as any).meta.extra.ctxPack === 'object')
        ? (raw as any).meta.extra.ctxPack
        : {})),
      slotDecision: slotDecisionForWriter,
    },

  goalKind:
    (opts as any)?.goalKind ??
    (opts as any)?.userContext?.goalKind ??
    (opts as any)?.userContext?.ctxPack?.goalKind ??
    (opts as any)?.userContext?.ctxPack?.replyGoal?.kind ??
    (ctxPackForWriter?.goalKind ?? null),

  shiftKind:
    (opts as any)?.ctxPack?.shiftKind ??
    (opts as any)?.userContext?.ctxPack?.shiftKind ??
    (opts as any)?.userContext?.meta?.extra?.ctxPack?.shiftKind ??
    (ctxPackForWriter?.shiftKind ?? null),

  shiftHint:
    (opts as any)?.ctxPack?.shiftHint ??
    (opts as any)?.userContext?.ctxPack?.shiftHint ??
    (opts as any)?.userContext?.meta?.extra?.ctxPack?.shiftHint ??
    (ctxPackForWriter?.shiftHint ?? null),

  shiftIntent:
    (opts as any)?.ctxPack?.shiftIntent ??
    (opts as any)?.userContext?.ctxPack?.shiftIntent ??
    (opts as any)?.userContext?.meta?.extra?.ctxPack?.shiftIntent ??
    (ctxPackForWriter?.shiftIntent ?? null),

  meta: {
    ...((((opts as any)?.userContext?.meta &&
      typeof (opts as any).userContext.meta === 'object')
      ? (opts as any).userContext.meta
      : {})),
    extra: {
      ...((((opts as any)?.userContext?.meta?.extra &&
        typeof (opts as any).userContext.meta.extra === 'object')
        ? (opts as any).userContext.meta.extra
        : {})),
      question:
        ((opts as any)?.extra?.question) ??
        ((opts as any)?.userContext?.question) ??
        ((opts as any)?.userContext?.meta?.extra?.question) ??
        null,
      pastStateNoteText:
        ((opts as any)?.extra?.pastStateNoteText) ??
        ((opts as any)?.userContext?.pastStateNoteText) ??
        ((opts as any)?.userContext?.meta?.extra?.pastStateNoteText) ??
        null,
      pastStateTriggerKind:
        ((opts as any)?.extra?.pastStateTriggerKind) ??
        ((opts as any)?.userContext?.pastStateTriggerKind) ??
        ((opts as any)?.userContext?.meta?.extra?.pastStateTriggerKind) ??
        null,
      pastStateKeyword:
        ((opts as any)?.extra?.pastStateKeyword) ??
        ((opts as any)?.userContext?.pastStateKeyword) ??
        ((opts as any)?.userContext?.meta?.extra?.pastStateKeyword) ??
        null,
      goalKind:
        (opts as any)?.goalKind ??
        (opts as any)?.userContext?.goalKind ??
        (opts as any)?.userContext?.ctxPack?.goalKind ??
        (opts as any)?.userContext?.ctxPack?.replyGoal?.kind ??
        (ctxPackForWriter?.goalKind ?? null),
    },
  },
},
        // ✅ task のときだけ raw user を許可（writerCalls.ts 側で判定に使う）
        // - directTask が true なら許可
        // - inputKind が task なら許可
        allowRawUserText: Boolean(isDirectTask || String(inputKind ?? '').toLowerCase() === 'task'),

        audit: {
          mode: 'rephrase',
          slotPlanPolicy: slotPlanPolicyResolved,

          // ✅ “確証つき” の値をそのまま使う
          qCode: (typeof pickedQCode !== 'undefined' ? pickedQCode : null) as any,
          depthStage: (typeof pickedDepthStage !== 'undefined' ? pickedDepthStage : null) as any,
          phase: (typeof pickedPhase !== 'undefined' ? pickedPhase : null) as any,

          // ✅ NEW: writerCalls.ts の inputKind 判定の正本
          inputKind: (inputKind ?? null) as any,
          directTask: Boolean(isDirectTask),

          // ✅ ログ
          hasDigest: Boolean(historyDigestV1),
          historyDigestV1Head: historyDigestV1 ? safeHead(String(historyDigestV1), 140) : null,
        },
      });
})();

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

  const sanitizeNoQuestions = (text: string) => {
    const t = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!t) return t;

    const userContextAny = (opts?.userContext as any) ?? null;
    const extraAny = (opts as any)?.extra ?? null;
    const ctxPackAny =
      userContextAny?.ctxPack ??
      userContextAny?.meta?.extra?.ctxPack ??
      (opts as any)?.ctxPack ??
      null;

    const questionAny =
      userContextAny?.question ??
      userContextAny?.meta?.extra?.question ??
      extraAny?.question ??
      ctxPackAny?.question ??
      null;

    const questionTypeNow = String(
      questionAny?.questionType ??
        userContextAny?.questionType ??
        userContextAny?.meta?.extra?.questionType ??
        extraAny?.questionType ??
        ''
    )
      .trim()
      .toLowerCase();

    const questionTModeNow = String(
      questionAny?.tState?.mode ??
        userContextAny?.tState?.mode ??
        userContextAny?.meta?.extra?.question?.tState?.mode ??
        extraAny?.tState?.mode ??
        ''
    )
      .trim()
      .toLowerCase();

    const goalKindRaw = String(
      (opts as any)?.goalKind ??
        userContextAny?.ctxPack?.goalKind ??
        userContextAny?.meta?.extra?.goalKind ??
        extraAny?.goalKind ??
        ''
    )
      .trim()
      .toLowerCase();

      const askBackAllowedRaw =
      questionAny?.outputPolicy?.askBackAllowed ??
      userContextAny?.question?.outputPolicy?.askBackAllowed ??
      userContextAny?.meta?.extra?.question?.outputPolicy?.askBackAllowed ??
      null;

    const allowRealityQuestionByText = (() => {
      const raw = [
        (opts as any)?.userText,
        questionAny?.focus,
        questionAny?.tState?.focus,
        userContextAny?.question?.focus,
        userContextAny?.meta?.extra?.question?.focus,
        userContextAny?.ctxPack?.topicDigest,
        userContextAny?.ctxPack?.conversationLine,
      ]
        .map((v) => String(v ?? '').trim())
        .filter(Boolean)
        .join('\n');

      if (!raw) return false;

      // ✅ SpeechAct 側の allowQuestion と同じ現実接続条件。
      // ここだけ質問禁止を解除し、抽象質問や質問連発は許可しない。
      return /(イベント|開催|日程|場所|会場|福岡|打ち合わせ|ミーティング|予定|会う|送る|決める|申し込み|申込み|販売|制作|投稿|公開|契約|予約|参加|誰と|一緒に動く|現実に動|現実の側|動き始め|彼|彼女|旦那|夫|妻|恋人|好きな人|浮気|不倫|連絡|返信|返事|既読|未読|不安|心配|関係|距離感|別れ|喧嘩|仲直り|復縁|嫌われ|待てない|イライラ)/.test(raw);
    })();

    const seedHintText = String(
      (opts as any)?.seedDraftRawAllHead ??
        (opts as any)?.seedDraftHead ??
        (opts as any)?.seedText ??
        ''
    );

    const isClarifyMeaningHint =
      seedHintText.includes('"hint":"clarify_meaning_v1"') ||
      seedHintText.includes('"intent":"answer_user_meaning"') ||
      seedHintText.includes('@SHIFT {"kind":"clarify"');

    const forceNoQuestionsByMeaningConfirm =
      questionTypeNow === 'meaning' &&
      (questionTModeNow === 'confirm' || isClarifyMeaningHint);

    const rawTextNow = String(t ?? '').trim();
    const compactTextNow = rawTextNow.replace(/\s+/g, '');
    const textLenNow = compactTextNow.length;

    const isShortAmbiguousFollowup =
      textLenNow <= 18 &&
      /^(それ|これ|あれ|でも|どう|どっち)/.test(compactTextNow);

    const hasConcreteContinuationSignal =
      textLenNow >= 24 ||
      /彼女|彼氏|連絡|返信|返事|既読|未読|不安|心配|浮気|関係|やり取り|距離感/.test(compactTextNow);

    const forceNoQuestionsByContinuity =
      hasConcreteContinuationSignal &&
      !isShortAmbiguousFollowup;

    const noQuestions =
      !allowRealityQuestionByText &&
      (forceNoQuestionsByMeaningConfirm ||
        forceNoQuestionsByContinuity);

    const askBackAllowedResolved = allowRealityQuestionByText
      ? true
      : noQuestions
        ? false
        : askBackAllowedRaw;

    const goalKindNow =
      forceNoQuestionsByMeaningConfirm && goalKindRaw === 'expand'
        ? 'confirm'
        : goalKindRaw;

    const questionsMaxNow = allowRealityQuestionByText ? 1 : noQuestions ? 0 : null;
    const forceNoQuestionsByContract = allowRealityQuestionByText ? false : noQuestions;

    const beforeLast = String(t.split('\n').filter(Boolean).slice(-1)[0] ?? '');

    let out = t;
    let removedTailQuestion = false;

    if (noQuestions) {
      let lines = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

      // ✅ 行単位で質問文を削除
      const beforeLinesLen = lines.length;
      lines = lines.filter((line) => {
        const s = String(line ?? '').trim();

        // 空行は一旦残す
        if (!s) return true;

        // 明確な疑問符終わり
        if (/[？?]\s*$/u.test(s)) return false;

        // 質問っぽい終端
        if (
          /ですか[。．.!！？?]*$/u.test(s) ||
          /でしょうか[。．.!！？?]*$/u.test(s) ||
          /ませんか[。．.!！？?]*$/u.test(s) ||
          /ないですか[。．.!！？?]*$/u.test(s) ||
          /どう思う[？?]?$/u.test(s) ||
          /どっち[？?]?$/u.test(s) ||
          /どちら[？?]?$/u.test(s)
        ) {
          return false;
        }

        return true;
      });

      removedTailQuestion = lines.length !== beforeLinesLen;

      // ✅ 末尾の空行を除去
      while (lines.length > 0 && !String(lines[lines.length - 1] ?? '').trim()) {
        lines.pop();
      }

      // ✅ 末尾の区切り線だけ残るのを防ぐ
      if (lines.length > 0 && /^\s*---+\s*$/u.test(String(lines[lines.length - 1] ?? ''))) {
        lines.pop();
      }

      // ✅ 質問導入句だけ残るのを防ぐ
      while (lines.length > 0) {
        const tail = String(lines[lines.length - 1] ?? '').trim();
        if (!tail) {
          lines.pop();
          continue;
        }

        if (
          /最後に[一ひと]つだけ聞いていい[？?]?$/u.test(tail) ||
          /最後に[一ひと]つだけ聞いていいですか[。．.!！？?]*$/u.test(tail) ||
          /最後に[一ひと]つだけ聞かせてください[。．.!！？?]*$/u.test(tail) ||
          /最後に少しだけ聞いていい[？?]?$/u.test(tail) ||
          /最後に少しだけ聞いていいですか[。．.!！？?]*$/u.test(tail) ||
          /^(?:もしよければ)?最後に(?:ひとつ|1つ)だけ聞いていいですか。?$/u.test(tail) ||
          /^(?:もしよければ)?最後に(?:ひとつ|1つ)だけ聞いていい？$/u.test(tail) ||
          /^(?:もしよければ)?最後に(?:ひとつ|1つ)だけ聞いてもいいですか。?$/u.test(tail) ||
          /^(?:もしよければ)?最後に(?:ひとつ|1つ)だけ聞いてもいい？$/u.test(tail) ||
          /^(?:もしよければ)?最後に(?:ひとつ|1つ)だけ聞かせてください。?$/u.test(tail) ||
          /^(?:もしよければ)?最後に(?:ひとつ|1つ)だけ聞かせて。?$/u.test(tail) ||
          /^(?:もしよければ)?(?:ひとつ|1つ)だけ聞いていいですか。?$/u.test(tail) ||
          /^(?:もしよければ)?(?:ひとつ|1つ)だけ聞いていい？$/u.test(tail) ||
          /^(?:もしよければ)?(?:ひとつ|1つ)だけ聞いてもいいですか。?$/u.test(tail) ||
          /^(?:もしよければ)?(?:ひとつ|1つ)だけ聞いてもいい？$/u.test(tail) ||
          /^(?:もしよければ)?(?:ひとつ|1つ)だけ聞かせてください。?$/u.test(tail) ||
          /^(?:もしよければ)?(?:ひとつ|1つ)だけ聞かせて。?$/u.test(tail) ||
          /^(?:もしよければ)?最後に確認させてください。?$/u.test(tail) ||
          /^(?:もしよければ)?最後に(?:一点|1点)だけ。?$/u.test(tail) ||
          /^(?:もしよければ)?最後に(?:ひとつ|1つ)だけ。?$/u.test(tail)
        ) {
          lines.pop();
          continue;
        }

        break;
      }

      out = lines.join('\n').replace(/[ \t]+\n/g, '\n').trim();
    }

    const afterLast = String(out.split('\n').filter(Boolean).slice(-1)[0] ?? '');

    console.log('[IROS/rephraseEngine][SANITIZE_NO_QUESTIONS_APPLIED]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      noQuestions,
      askBackAllowedRaw: askBackAllowedResolved,
      goalKindNow,
      questionsMaxNow,
      forceNoQuestionsByPack: false,
      forceNoQuestionsByContract,
      beforeLen: t.length,
      afterLen: out.length,
      changed: out !== t,
      removedTailQuestion,
      beforeLast,
      afterLast,
      reason: noQuestions
        ? removedTailQuestion
          ? 'TAIL_QUESTION_REMOVED'
          : 'NO_TAIL_QUESTION'
        : 'NO_NO_QUESTIONS_CONTRACT',
    });

    return out;
  };
  let candidate = String(rawGuarded ?? '').trim();

  // REFERENCE_JUDGEMENT_FINAL_GUARD
  // reference_check の判定冒頭を NORMAL_RESONANCE の言い換えから守る。
  {
    const referenceJudgeSeedForFinalGuard =
      String((opts as any)?.extra?.referenceJudgeSeed ?? '').trim() ||
      String((opts as any)?.userContext?.ctxPack?.referenceJudgeSeed ?? '').trim() ||
      String((opts as any)?.userContext?.meta?.extra?.referenceJudgeSeed ?? '').trim() ||
      '';

    const writerFirstLineForFinalGuard = (() => {
      const m = referenceJudgeSeedForFinalGuard.match(/(?:^|\n)writerFirstLine=([^\n]+)/u);
      return String(m?.[1] ?? '').trim();
    })();

    const relationForFinalGuard = (() => {
      const m = referenceJudgeSeedForFinalGuard.match(/(?:^|\n)relation=([^\n]+)/u);
      return String(m?.[1] ?? '').trim();
    })();

    const judgementSummaryForFinalGuard = (() => {
      const m = referenceJudgeSeedForFinalGuard.match(/(?:^|\n)judgementSummary=([^\n]+)/u);
      return String(m?.[1] ?? '').trim();
    })();

    const hasReferenceJudgementForFinalGuard = /(?:^|\n)REFERENCE_JUDGEMENT:/u.test(referenceJudgeSeedForFinalGuard);
    const isReferenceCheckForFinalGuard = /(?:^|\n)askType=reference_check/u.test(referenceJudgeSeedForFinalGuard);
    const shouldApplyReferenceJudgementFinalGuard =
      hasReferenceJudgementForFinalGuard &&
      isReferenceCheckForFinalGuard &&
      writerFirstLineForFinalGuard.length > 0;

    if (shouldApplyReferenceJudgementFinalGuard) {
      const currentCandidate = String(candidate ?? '').trim();
      const startsWithJudge = currentCandidate.startsWith(writerFirstLineForFinalGuard);
      const firstCandidateLine = currentCandidate.split(/\n+/u)[0]?.trim() ?? '';

      const writerFirstLineRequiresPartial =
        /^(一部は|部分的には)/u.test(writerFirstLineForFinalGuard);

      const startsWithCompatibleJudgement = writerFirstLineRequiresPartial
        ? /^(一部は|部分的には)/u.test(firstCandidateLine)
        : (
            /^(いいえ|いえ|一致とは言えません|一致していません|完全には一致しません|沿っていません|その意味にはなりません|部分的には|一部は)/u.test(firstCandidateLine) ||
            /(一致していません|沿っていません|とは言えません|その意味にはなりません)/u.test(firstCandidateLine)
          );

      // REFERENCE_JUDGEMENT_PARTIAL_STRUCTURAL_STRICT_GUARD
      // partial_structural は「一部は似ているが同一ではない」が結論。
      // Writerが「一部は沿っています」「方向は合っている」「必要なら次に」へ戻る場合があるため、
      // referenceJudgeSeed の judgementSummary を本文の芯として固定する。
      if (
        relationForFinalGuard === 'partial_structural' &&
        writerFirstLineForFinalGuard &&
        judgementSummaryForFinalGuard &&
        (
          /一部は沿っています|沿っています|沿っている|沿い切って|方向は合っている|必要なら|次に分け|もう少し/u.test(currentCandidate) ||
          !currentCandidate.startsWith(writerFirstLineForFinalGuard)
        )
      ) {
        candidate = [
          writerFirstLineForFinalGuard,
          judgementSummaryForFinalGuard,
          'だから、三密そのものではなく、一部だけ似た構造がある、という見方です。',
        ]
          .filter((v) => String(v ?? '').trim().length > 0)
          .join('\n\n')
          .trim();
      } else if (currentCandidate && !startsWithJudge && !startsWithCompatibleJudgement) {
        const strippedCandidate = currentCandidate
          .replace(/^はい、\*\*そのまま進んでよいとは言いません\*\*[。．]?\s*/u, '')
          .replace(/^はい、そのまま進んでよいとは言いません[。．]?\s*/u, '')
          .replace(/^はい、かなり沿っています[。．]?\s*/u, '')
          .replace(/^はい、概ね沿っています[。．]?\s*/u, '')
          .replace(/^はい、沿っています[。．]?\s*/u, '')
          .replace(/^合っています[。．]?\s*/u, '')
          .replace(/^正しいです[。．]?\s*/u, '')
          .trim();

        candidate = [writerFirstLineForFinalGuard, strippedCandidate]
          .filter((v) => String(v ?? '').trim().length > 0)
          .join('\n\n')
          .trim();
      }

      console.log(
        '[IROS/rephraseEngine][REFERENCE_JUDGEMENT_FINAL_GUARD]',
        JSON.stringify({
          applied: shouldApplyReferenceJudgementFinalGuard,
          writerFirstLine: writerFirstLineForFinalGuard,
          beforeHead: currentCandidate.slice(0, 160),
          afterHead: String(candidate ?? '').slice(0, 160),
        })
      );
    }
  }


  const candidateBeforeSanitize = String(candidate ?? '');
  candidate = sanitizeNoQuestions(candidate);

  const optimizeForMobileReading = (src: string): string => {
    const raw = String(src ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();

    if (!raw) return raw;

    // ✅ LLM がすでに入れた改行を正本にする
    // - ここで再レイアウトすると、引用・強調・例文の改行位置が崩れる
    // - 特に FINAL writer 後の本文は、MOBILE_LAYOUT_APPLIED より LLM の改行を優先する
    if (raw.includes('\n')) {
      return raw;
    }

    const normalizeInline = (s: string): string =>
      String(s ?? '')
        .replace(/\u3000/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const mergeBrokenPunctuation = (s: string): string =>
      String(s ?? '')
        .replace(/([!！?？])\s+([!！?？])/gu, '$1$2')
        .replace(/\s+([」』）】])/gu, '$1')
        .replace(/([「『（【])\s+/gu, '$1')
        .trim();

        const sentenceSplit = (text: string): string[] => {
          const normalized = normalizeInline(text).replace(/\n+/g, ' ');
          if (!normalized) return [];

          const parts = normalized
            .split(/(?<=[。！？!?])(?![!！?？])/u)
            .map((s) => mergeBrokenPunctuation(normalizeInline(s)))
            .filter(Boolean);

          return parts.length ? parts : [normalized];
        };

    const isShortHeadingLike = (s: string): boolean => {
      const t = normalizeInline(s);
      if (!t || t.length > 12) return false;
      return /^(例えば|たとえば|つまり|なので|ただ|逆に|一方で|もし|でも|そして|そこで|また)$/.test(t);
    };

    const isQuoteOnly = (s: string): boolean => {
      const t = normalizeInline(s);
      return /^[「『].+[」』]$/.test(t);
    };

    const isTopicShift = (s: string): boolean =>
      /^(例えば|たとえば|ただ|逆に|もし|なので|つまり|一方で|そして|でも|また)/.test(
        normalizeInline(s),
      );

    const splitLongByComma = (s: string): string[] => {
      const t = normalizeInline(s);
      if (!t) return [];

      const parts = t
        .split(/(?<=、)/u)
        .map((x) => normalizeInline(x))
        .filter(Boolean);

      if (parts.length <= 1) return [t];

      const out: string[] = [];
      let buf = '';

      for (const part of parts) {
        const next = buf ? `${buf}${part}` : part;

        if (buf && next.length > 18) {
          out.push(buf);
          buf = part;
          continue;
        }

        buf = next;
      }

      if (buf) out.push(buf);

      return out;
    };

    const splitForPhoneLine = (srcLine: string): string[] => {
      const s = mergeBrokenPunctuation(normalizeInline(srcLine));
      if (!s) return [];

      if (s.length <= 19) return [s];

      const quoted = s.match(/^(.*?)([「『][^」』]+[」』])(.*)$/u);
      if (quoted) {
        const a = normalizeInline(quoted[1]);
        const b = normalizeInline(quoted[2]);
        const c = normalizeInline(quoted[3]);

        const out: string[] = [];

        if (a && a.length <= 10 && b.length <= 20) {
          out.push(mergeBrokenPunctuation(`${a} ${b}`));
        } else {
          if (a) out.push(a);
          if (b) out.push(b);
        }

        if (c) out.push(c);

        return out.filter(Boolean);
      }

      const commaSplit = splitLongByComma(s);
      if (
        commaSplit.length >= 2 &&
        commaSplit.every((x) => x.length <= 20) &&
        commaSplit.every((x) => x.length >= 4)
      ) {
        return commaSplit;
      }

      const cutPatterns = [
        /^(.*?だから)(.+)$/u,
        /^(.*?なので)(.+)$/u,
        /^(.*?なら)(.+)$/u,
        /^(.*?けど)(.+)$/u,
        /^(.*?けれど)(.+)$/u,
        /^(.*?だけど)(.+)$/u,
        /^(.*?から)(.+)$/u,
        /^(.*?として)(.+)$/u,
        /^(.*?くらい)(.+)$/u,
        /^(.*?みたいに)(.+)$/u,
        /^(.*?すると)(.+)$/u,
        /^(.*?ときは)(.+)$/u,
        /^(.*?時は)(.+)$/u,
      ];

      for (const re of cutPatterns) {
        const m = s.match(re);
        if (!m) continue;

        const a = normalizeInline(m[1]);
        const b = normalizeInline(m[2]);

        if (a && b && a.length >= 5 && b.length >= 5) {
          return [a, b];
        }
      }

      const out: string[] = [];
      let rest = s;

      while (rest.length > 20) {
        let cut = -1;

        // ① 句読点・閉じ記号の直後を優先
        for (let i = Math.min(18, rest.length - 1); i >= 10; i--) {
          const ch = rest[i];
          if (/[、。！？!?」』）】]/u.test(ch)) {
            cut = i + 1;

            // 直後が閉じ記号なら、引用閉じまで含めて切る
            while (
              cut < rest.length &&
              /[」』）】]/u.test(rest[cut] ?? '')
            ) {
              cut += 1;
            }

            break;
          }
        }

        // ② 助詞・接続っぽい位置を優先
        if (cut === -1) {
          for (let i = Math.min(18, rest.length - 1); i >= 10; i--) {
            const ch = rest[i];
            if (/[はがをにでともへやの、]/u.test(ch)) {
              cut = i + 1;
              break;
            }
          }
        }

        // ③ それでも無ければ仮置き
        if (cut === -1) {
          cut = 16;
        }

        // ④ 「と\nき」「で\nす」などの不自然分断を回避
        while (
          cut > 8 &&
          cut < rest.length &&
          /[ぁ-んァ-ヶー一-龠]/u.test(rest[cut - 1] ?? '') &&
          /[ぁ-んァ-ヶー一-龠]/u.test(rest[cut] ?? '')
        ) {
          cut -= 1;

          // 行頭が短くなりすぎるのは防ぐ
          if (cut <= 10) {
            cut = 16;
            break;
          }
        }

        const head = mergeBrokenPunctuation(normalizeInline(rest.slice(0, cut)));
        if (head) out.push(head);
        rest = mergeBrokenPunctuation(normalizeInline(rest.slice(cut)));
      }

      if (rest) out.push(rest);

      // ⑤ 単独助詞・短すぎる尻尾を前行へ戻す
      const merged: string[] = [];
      for (const line of out) {
        const cur = normalizeInline(line);
        if (!cur) continue;

        const prev = merged[merged.length - 1] ?? '';

        if (
          prev &&
          (cur.length <= 2 ||
            /^[」』）】、。！？!?]/u.test(cur) ||
            /^(と|きは|とき|が|を|に|は|で|も|へ|や|の|です|ます|だよ|かな|みたいに)$/.test(cur))
        ) {
          merged[merged.length - 1] = mergeBrokenPunctuation(`${prev}${cur}`);
          continue;
        }

        merged.push(cur);
      }

      return merged.filter(Boolean);
    };

    const sourceParas = raw
      .split(/\n{2,}/)
      .map((p) => normalizeInline(p))
      .filter(Boolean);

    const rebuiltParas: string[] = [];

    const flushLineBlock = (lines: string[]) => {
      if (!lines.length) return;

      const physicalLines: string[] = [];

      for (const line of lines) {
        const split = splitForPhoneLine(line);
        for (const one of split) {
          const v = mergeBrokenPunctuation(one);
          if (v) physicalLines.push(v);
        }
      }

      const packed: string[] = [];
      let buf: string[] = [];

      const flushBuf = () => {
        if (!buf.length) return;
        packed.push(buf.join('\n'));
        buf = [];
      };

      for (let i = 0; i < physicalLines.length; i++) {
        const line = physicalLines[i];
        const prev = buf[buf.length - 1] ?? '';
        const next = physicalLines[i + 1] ?? '';

        if (isShortHeadingLike(line)) {
          flushBuf();
          if (next) {
            packed.push(`${line}\n${next}`);
            i += 1;
          } else {
            packed.push(line);
          }
          continue;
        }

        if (isQuoteOnly(line)) {
          if (buf.length === 1 && prev && prev.length + line.length <= 28) {
            buf.push(line);
            flushBuf();
            continue;
          }

          flushBuf();

          if (next && next.length <= 18) {
            packed.push(`${line}\n${next}`);
            i += 1;
          } else {
            packed.push(line);
          }
          continue;
        }

        buf.push(line);

        const joinedLen = buf.join('').length;
        const shouldFlush =
          buf.length >= 3 ||
          (buf.length >= 2 && joinedLen >= 22) ||
          (buf.length >= 2 && isTopicShift(next));

        if (shouldFlush) {
          flushBuf();
        }
      }

      flushBuf();

      rebuiltParas.push(...packed.filter(Boolean));
      lines.length = 0;
    };

    for (const para of sourceParas) {
      const sentences = sentenceSplit(para);

      const chunks: string[] = [];
      let buf = '';

      for (const s of sentences) {
        const one = mergeBrokenPunctuation(normalizeInline(s));
        if (!one) continue;

        const next = buf ? `${buf} ${one}` : one;
        const bufSentenceCount = sentenceSplit(buf).length;

        if (buf && (next.length > 26 || bufSentenceCount >= 2 || isTopicShift(one))) {
          chunks.push(buf);
          buf = one;
          continue;
        }

        buf = next;
      }

      if (buf) chunks.push(buf);


    const lines: string[] = [];

      console.log(
        '[IROS/rephraseEngine][CANDIDATE_AFTER_SANITIZE]',
        JSON.stringify({
          traceId: debug.traceId ?? null,
          conversationId: debug.conversationId ?? null,
          userCode: debug.userCode ?? null,
          beforeLen: candidateBeforeSanitize.length,
          afterLen: String(candidate ?? '').length,
          changed: candidateBeforeSanitize !== String(candidate ?? ''),
          beforeHead: safeHead(candidateBeforeSanitize, 160),
          afterHead: safeHead(String(candidate ?? ''), 160),
          afterText: String(candidate ?? ''),
          afterParagraphs: String(candidate ?? '')
            .split(/\n{2,}/)
            .map((x) => String(x ?? '').trim())
            .filter(Boolean),
        })
      );

      if (lines.length) {
        flushLineBlock(lines);
      }
    }

    const out = rebuiltParas
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();

    return out || raw;
  };

  console.log('[IROS/rephraseEngine][CANDIDATE_AFTER_SANITIZE]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    beforeLen: candidateBeforeSanitize.length,
    afterLen: String(candidate ?? '').length,
    changed: candidateBeforeSanitize !== String(candidate ?? ''),
    beforeHead: safeHead(candidateBeforeSanitize, 160),
    afterHead: safeHead(String(candidate ?? ''), 160),
  });

  const candidateBeforeMobileLayout = String(candidate ?? '');
  const candidateAfterMobileLayout = optimizeForMobileReading(candidateBeforeMobileLayout);

  candidate = candidateAfterMobileLayout;

  console.log('[IROS/rephraseEngine][MOBILE_LAYOUT_APPLIED]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    beforeLen: candidateBeforeMobileLayout.length,
    afterLen: String(candidate ?? '').length,
    changed: candidateBeforeMobileLayout !== String(candidate ?? ''),
    beforeHead: safeHead(candidateBeforeMobileLayout, 160),
    afterHead: safeHead(String(candidate ?? ''), 160),
    skipped: false,
    reason:
      candidateBeforeMobileLayout !== String(candidate ?? '')
        ? 'OPTIMIZE_FOR_MOBILE_READING'
        : 'NO_CHANGE',
  });

  const stripConsultAnswerHeadings = (src: string): string => {
    const consultHeadingStripUserText = String(
      userText ??
        (opts as any)?.userText ??
        (opts as any)?.followupText ??
        (opts as any)?.inputText ??
        ''
    ).trim();

    const consultHeadingStripFollowupKind = String(
      (opts as any)?.userContext?.ctxPack?.followupKind ??
        (opts as any)?.ctxPack?.followupKind ??
        (opts as any)?.meta?.extra?.ctxPack?.followupKind ??
        ''
    ).trim();

    const hasConsultAnswerContract =
      consultHeadingStripFollowupKind === 'consult_timing' ||
      (
        /今|まだ|早い|タイミング|時期|今じゃない|今ではない|今すぐ|あとで|後で/u.test(
          consultHeadingStripUserText
        ) &&
        /いい|良い|どう|使う|使用|シェア|共有|渡す|出す|送る|連絡|返信|返事|始める|進める/u.test(
          consultHeadingStripUserText
        )
      ) ||
      /どう渡|渡し方|伝え方|言い方|送れば|共有の仕方|シェアの仕方/u.test(
        consultHeadingStripUserText
      ) ||
      /いいですか|良いですか|べき|判断|どちら|迷って|ありですか|やめた方|した方/u.test(
        consultHeadingStripUserText
      );

    const legacyTemplateHeadingRe =
      /^\s*(?:#{1,6}\s*)?(?:🌀|🔍|↔️|🎯|🌸|🪷|🧩|✅|🌱)?\s*(今ここを揃える|いま見ているもの|二つの見方|焦点を一つだけ移す|焦点を移す|いったん受け止める|一枚に戻す|ここで一つ選ぶ|いま分けて見たいこと|ここから整理する順番|いまのまとめ)\s*$/u;

    const hasLegacyTemplateHeading = String(src ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .some((line) => legacyTemplateHeadingRe.test(String(line ?? '').trim()));

    if (!hasConsultAnswerContract && !hasLegacyTemplateHeading) return String(src ?? '');

    const headingRe = legacyTemplateHeadingRe;

    const legacyTemplateHeadingPrefixRe =
      /^\s*(?:#{1,6}\s*)?(?:🌀|🔍|↔️|🎯|🌸|🪷|🧩|✅|🌱)?\s*(今ここを揃える|いま見ているもの|二つの見方|焦点を一つだけ移す|焦点を移す|いったん受け止める|一枚に戻す|ここで一つ選ぶ|いま分けて見たいこと|ここから整理する順番|いまのまとめ)(?:\s+|$)/u;

    const strippedLegacyHeadings = String(src ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => {
        const rawLine = String(line ?? '').trim();
        if (!rawLine) return '';

        const withoutHeading = rawLine.replace(legacyTemplateHeadingPrefixRe, '').trim();
        return withoutHeading;
      })
      .filter((line) => String(line ?? '').trim())
      .join('\n')
      .replace(/\*\*/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return strippedLegacyHeadings;
  };

  const candidateBeforeConsultHeadingStrip = String(candidate ?? '');
  candidate = stripConsultAnswerHeadings(candidate);

  console.log('[IROS/rephraseEngine][CONSULT_HEADING_STRIP_APPLIED]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    beforeLen: candidateBeforeConsultHeadingStrip.length,
    afterLen: String(candidate ?? '').length,
    changed: candidateBeforeConsultHeadingStrip !== String(candidate ?? ''),
    beforeHead: safeHead(candidateBeforeConsultHeadingStrip, 160),
    afterHead: safeHead(String(candidate ?? ''), 160),
  });

  const softenDirectiveTail = (src: string): string => {
    let out = String(src ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();

    if (!out) return out;

    // ✅ 日本語カッコ引用の中に入った余計な改行だけを潰す
    // 例: 「学校給食から広まったかも？\n\n」→「学校給食から広まったかも？」
    out = out
      .replace(/「\s*\n+\s*([^「」\n]{1,160})\s*」/gu, (_m, p1) => `「${String(p1 ?? '').trim()}」`)
      .replace(/「([^「」\n]{1,160})\s*\n+\s*」/gu, (_m, p1) => `「${String(p1 ?? '').trim()}」`);

    out = out
      .replace(
        /^曖昧なまま置かれるのがつらい。\n+/u,
        '共鳴とは、曖昧さをそのまま流さず、受け取り方まで分かる形にそろえる状態です。\n'
      )
      .replace(
        /\n曖昧なまま置かれるのがつらい。\n/u,
        '\n共鳴では、曖昧さをそのまま流さず、分かる形に戻すことが大事です。\n'
      );

    const replaceLineTail = (line: string): string => {
      let s = String(line ?? '');

      s = s.replace(/形に寄せよ。?$/u, '形に寄せるといい。');
      s = s.replace(/寄せよ。?$/u, '寄せるといい。');
      s = s.replace(/待てる。?$/u, '待ちやすい。');
      s = s.replace(/判断でもいい。?$/u, 'あとで決めてもいい。');
      s = s.replace(/判断でいい。?$/u, 'あとで決めていい。');
      s = s.replace(/本気で。?$/u, 'しっかり意識すると安心。');

      return s;
    };

    out = out
      .split('\n')
      .map((line) => replaceLineTail(line))
      .join('\n')
      .trim();

    out = out
      .replace(
        /まだ言い切らずに残しているところがあって、そこを無理に閉じずに置いている状態です。/gu,
        'まだ決めきれていないところはあります。でも、今確認したいことは見えています。'
      )
      .replace(
        /まだ言い切らずに残しているところがあります。そこを無理に閉じずに置いている状態です。/gu,
        'まだ決めきれていないところはあります。でも、今確認したいことは見えています。'
      )
      .replace(
        /そこを無理に閉じずに置いている状態です。/gu,
        '今確認したいことは見えています。'
      );

    return out;
  };

  const candidateBeforeTailSoftener = String(candidate ?? '');
  candidate = softenDirectiveTail(candidate);

  console.log('[IROS/rephraseEngine][TAIL_SOFTENER_APPLIED]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    beforeLen: candidateBeforeTailSoftener.length,
    afterLen: String(candidate ?? '').length,
    changed: candidateBeforeTailSoftener !== String(candidate ?? ''),
    beforeHead: safeHead(candidateBeforeTailSoftener, 160),
    afterHead: safeHead(String(candidate ?? ''), 160),
  });

  const normalizeResonanceMetaPhrases = (src: string): string => {
    let out = String(src ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();

      const activePatternKeyForResonanceNormalize = String(
        (debug as any)?.patternKey ??
          (opts as any)?.meta?.extra?.patternKey ??
          (opts as any)?.userContext?.meta?.extra?.patternKey ??
          ''
      ).trim();

      const goalKindForResonanceNormalize = String(
        (opts as any)?.userContext?.ctxPack?.goalKind ??
          (opts as any)?.meta?.extra?.ctxPack?.goalKind ??
          (opts as any)?.ctxPack?.goalKind ??
          ''
      ).trim();

      const targetKindForResonanceNormalize = String(
        (opts as any)?.userContext?.ctxPack?.targetKind ??
          (opts as any)?.meta?.extra?.ctxPack?.targetKind ??
          (opts as any)?.ctxPack?.targetKind ??
          ''
      ).trim();

      const replyGoalKindForResonanceNormalize = String(
        (opts as any)?.userContext?.ctxPack?.replyGoal?.kind ??
          (opts as any)?.meta?.extra?.ctxPack?.replyGoal?.kind ??
          (opts as any)?.ctxPack?.replyGoal?.kind ??
          ''
      ).trim();

      const shouldNormalizeResonanceMeta =
      activePatternKeyForResonanceNormalize === 'NORMAL_RESONANCE_V1' ||
      activePatternKeyForResonanceNormalize === 'DECLARATION_RESONANCE_V1' ||
      goalKindForResonanceNormalize === 'resonate' ||
      targetKindForResonanceNormalize === 'resonate' ||
      replyGoalKindForResonanceNormalize === 'resonate';

    const hasResonanceMetaPhrase =
      /、というより、|、という声として届いています。|、という声は|^いまあるのは、|^今あるのは、|^だから、|^残るのは、/u.test(
        out
      );

    if (!shouldNormalizeResonanceMeta && !hasResonanceMetaPhrase) {
      return out;
    }

    out = out
      .replace(/、というより、/gu, '。')
      .replace(/、という声として届いています。/gu, '。')
      .replace(/、という声は/gu, '。')
      .replace(/今あるのは、/gu, '')
      .replace(/だから、説明で包まずに触れます。/gu, '説明で包まずに触れます。')
      .replace(/だから、決めた形よりも、/gu, '決めた形よりも、');

    return out.trim();
  };

  const candidateBeforeResonanceMetaNormalize = String(candidate ?? '');
  candidate = normalizeResonanceMetaPhrases(candidate);

  const normalizeDeclarationMetaPhrases = (src: string): string => {
    let out = String(src ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();

      const activePatternKeyForDeclarationMetaNormalize = String(
        (debug as any)?.patternKey ?? ''
      ).trim();
      if (
        activePatternKeyForDeclarationMetaNormalize !== 'DECLARATION_RESONANCE_V1'
      ) {
        return out;
      }

    out = out
      .replace(
        /そのまま、少し余白を残して立っています。/gu,
        '少し余白が、まだ残っています。'
      )
      .replace(
        /その言葉は、静かに残ります。/gu,
        '静かな残りが、まだそこにあります。'
      );

    return out.trim();
  };

  const candidateBeforeDeclarationMetaNormalize = String(candidate ?? '');
  candidate = normalizeDeclarationMetaPhrases(candidate);

  console.log('[IROS/rephraseEngine][DECLARATION_META_NORMALIZED]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    applied:
      candidateBeforeResonanceMetaNormalize !== String(candidate ?? '') ||
      candidateBeforeDeclarationMetaNormalize !== String(candidate ?? ''),
    beforeHead: safeHead(candidateBeforeResonanceMetaNormalize, 160),
    afterHead: safeHead(String(candidate ?? ''), 160),
  });

  // ---------------------------------------------
  // Declaration paragraph guard（採用前ガード）
  // - normalize 後でも残る paragraph1 / paragraph4 の契約違反をここで弾く
  // - NG のときは writer 文を採用せず、seed 側へ戻す
  // ---------------------------------------------
  {
    const patternKeyNow = String(
      (opts as any)?.meta?.extra?.patternKey ??
        selectSlotPattern({
          line: String(
            (opts as any)?.meta?.extra?.presentationKind ??
              (opts as any)?.userContext?.meta?.extra?.presentationKind ??
              ''
          )
            .trim()
            .toLowerCase(),
          questionType: null,
          detailMode:
            (opts as any)?.ctxPack?.detailMode === true ||
            (opts as any)?.userContext?.ctxPack?.detailMode === true,
          followupText: String((opts as any)?.userText ?? '').trim(),
          userText: String((opts as any)?.userText ?? '').trim(),
          targetLabel: null,
          hasPriorDiagnosis: false,
        }) ??
        ''
    ).trim();
    const shouldApplyDeclarationParagraphGuard =
      patternKeyNow === 'DECLARATION_RESONANCE_V1';

    if (shouldApplyDeclarationParagraphGuard) {
      const candidateTextNow = String(candidate ?? '').trim();
      const paragraphsNow = candidateTextNow
        .split(/\n{2,}/)
        .map((v) => String(v ?? '').trim())
        .filter(Boolean);

      const p1 = String(paragraphsNow[0] ?? '').trim();
      const p4 = String(paragraphsNow[3] ?? '').trim();

      const p1StartsWithTextMeta =
        /^(?:その|この)(?:言葉|文|宣言|言い方)は/u.test(p1) ||
        /^.+?という(?:言葉|言い方)が/u.test(p1) ||
        /^(?:文としては|言葉としては|置き方そのもの|その置き方|この置き方)/u.test(p1);

      const p4HasMetaOrSufficiency =
        /(?:言葉|文|宣言|言い方)/u.test(p4) ||
        /(?:十分(?:です|に)|足ります|足りる|完了|完成|締め|閉じ|入口です|始まりです|進めます|動きます|開けます|見えてきます|広がります)/u.test(
          p4
        );

        const declarationParagraphCountViolation = paragraphsNow.length !== 4;

        const paragraphGuardReason =
          declarationParagraphCountViolation
            ? 'DECL_PG:PARAGRAPH_COUNT'
            : p1StartsWithTextMeta
              ? 'DECL_PG:P1_TEXT_META'
              : p4HasMetaOrSufficiency
                ? 'DECL_PG:P4_META_OR_SUFFICIENCY'
                : null;

              if (paragraphGuardReason) {
                if (paragraphGuardReason === 'DECL_PG:PARAGRAPH_COUNT') {
                  console.warn('[IROS/DECLARATION_PARAGRAPH_GUARD][PASS_TO_RETRY]', {
                    traceId: debug.traceId,
                    conversationId: debug.conversationId,
                    userCode: debug.userCode,
                    patternKey: patternKeyNow,
                    reason: paragraphGuardReason,
                    paragraphsLen: paragraphsNow.length,
                    p1Head: safeHead(p1, 120),
                    p4Head: safeHead(p4, 120),
                    candidateHead: safeHead(candidateTextNow, 160),
                  });
                } else {
                  const fallbackSeed = (() => {
                    const shiftObjForFallback = parseShiftJson(String((shiftSlot as any)?.text ?? ''));
                    const shiftMessage = String(
                      shiftObjForFallback?.message ??
                        shiftObjForFallback?.draft?.message ??
                        ''
                    ).trim();

                    const userDecl = String((opts as any)?.userText ?? '').trim();

                    const cleaned = String(seedDraft ?? '')
                      .split('\n')
                      .map((line) => line.trim())
                      .filter(Boolean)
                      .filter((line) => !line.startsWith('@'))
                      .filter((line) => !/^(続けてください|つづけてください|続けて|つづけて)$/u.test(line))
                      .join('\n')
                      .trim();

                    const looksInternal =
                      !cleaned ||
                      /"\w+"\s*:/.test(cleaned) ||
                      cleaned.includes('","message":"') ||
                      cleaned.includes('","source":"') ||
                      cleaned.includes('DO NOT OUTPUT');

                    const safeCleaned = !looksInternal ? cleaned : '';

                    const p1 =
                    userDecl ? `${userDecl}` : 'いま、前に出る向きが静かに立っています。';

                    const p2 = userDecl
                      ? 'その向きは、軽く置かれたものではなく、引き受ける重さを持っています。'
                      : 'そこには、軽く流れない重さがあります。';

                    const p3 =
                      safeCleaned ||
                      'ただ、どの場面でどこまで前に出るかは、まだ全部が固まりきっているわけではありません。';

                    const p4 = userDecl
                      ? '前に出る向きだけは、もう静かに残っています。'
                      : 'その向きだけは、もう静かに残っています。';

                    return [p1, p2, p3, p4].filter(Boolean).join('\n\n').trim();
                  })();

                  console.warn('[IROS/DECLARATION_PARAGRAPH_GUARD][REJECT_TO_SEED]', {
                    traceId: debug.traceId,
                    conversationId: debug.conversationId,
                    userCode: debug.userCode,
                    patternKey: patternKeyNow,
                    reason: paragraphGuardReason,
                    paragraphsLen: paragraphsNow.length,
                    p1Head: safeHead(p1, 120),
                    p4Head: safeHead(p4, 120),
                    candidateHead: safeHead(candidateTextNow, 160),
                    fallbackSeedHead: safeHead(fallbackSeed, 160),
                  });

                  if (fallbackSeed) {
                    return adoptAsSlots(fallbackSeed, 'DECLARATION_PARAGRAPH_GUARD_REJECT_TO_SEED', {
                      scaffoldActive,
                      writerGuardReason: paragraphGuardReason,
                      writerGuardDetail: {
                        paragraphsLen: paragraphsNow.length,
                        p1: safeHead(p1, 120),
                        p4: safeHead(p4, 120),
                      },
                    });
                  }
                }
              }
  }
  }
  // ---------------------------------------------
  // Minimal Writer Guard（LLM逸脱の最終防波堤）
  // - systemPrompt の整形契約を “採用前” に最低限検査する
  // - NG のときは writer 文を採用せず、seed 側へ戻す
  // ---------------------------------------------
  const minimalWriterRules = (() => {
    const questionPolicy =
      (opts as any)?.extra?.question?.outputPolicy ??
      (opts as any)?.userContext?.question?.outputPolicy ??
      (opts as any)?.userContext?.meta?.extra?.question?.outputPolicy ??
      null;

    const shiftRules = (() => {
      try {
        const parsed = parseShiftJson(String((shiftSlot as any)?.text ?? ''));
        return parsed?.draft?.rules ?? parsed?.rules ?? null;
      } catch {
        return null;
      }
    })();

    const systemPromptArgs = (opts as any)?.systemPromptArgs ?? null;

    const askBackAllowedNow =
      ((opts as any)?.extra?.question?.outputPolicy?.askBackAllowed ??
        (opts as any)?.userContext?.question?.outputPolicy?.askBackAllowed ??
        (opts as any)?.userContext?.meta?.extra?.question?.outputPolicy?.askBackAllowed ??
        null) as boolean | null;

    const parseContractFromText = (src: unknown): Record<string, any> | null => {
      const text = String(src ?? '').trim();
      if (!text) return null;

      const m = text.match(/@CONTRACT\s+(\{[\s\S]*?\})(?:\n|$)/);
      if (!m?.[1]) return null;

      try {
        const parsed = JSON.parse(m[1]);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    };

    const contractFromSeed =
      parseContractFromText((opts as any)?.extra?.llmRewriteSeedRaw) ??
      parseContractFromText((opts as any)?.userContext?.meta?.extra?.llmRewriteSeedRaw) ??
      parseContractFromText((opts as any)?.userContext?.ctxPack?.llmRewriteSeedRaw) ??
      parseContractFromText((opts as any)?.extra?.llmRewriteSeed) ??
      parseContractFromText((opts as any)?.userContext?.meta?.extra?.llmRewriteSeed) ??
      null;

    const contractFromLlmGate =
      ((opts as any)?.extra?.llmGate?.contractObj &&
      typeof (opts as any)?.extra?.llmGate?.contractObj === 'object'
        ? (opts as any).extra.llmGate.contractObj
        : null) ??
      ((opts as any)?.userContext?.meta?.extra?.llmGate?.contractObj &&
      typeof (opts as any)?.userContext?.meta?.extra?.llmGate?.contractObj === 'object'
        ? (opts as any).userContext.meta.extra.llmGate.contractObj
        : null) ??
      ((opts as any)?.userContext?.ctxPack?.llmGate?.contractObj &&
      typeof (opts as any)?.userContext?.ctxPack?.llmGate?.contractObj === 'object'
        ? (opts as any).userContext.ctxPack.llmGate.contractObj
        : null) ??
      null;

    const contractResolved = contractFromLlmGate ?? contractFromSeed ?? null;

    const output_only =
      (typeof contractResolved?.output_only === 'boolean' ? contractResolved.output_only : undefined) ??
      (questionPolicy?.output_only === true ||
        shiftRules?.output_only === true ||
        systemPromptArgs?.output_only === true);

        const questions_max = (() => {
          // ✅ askBackAllowed=false は最優先
          // 上流で questions_max=1 が来ていても、ここでは必ず 0 に落とす
          if (askBackAllowedNow === false) return 0;

          if (typeof contractResolved?.questions_max === 'number') {
            return contractResolved.questions_max;
          }

          for (const v of [
            questionPolicy?.questions_max,
            shiftRules?.questions_max,
            systemPromptArgs?.questions_max,
          ]) {
            if (typeof v === 'number') return v;
          }

          return null;
        })();

    const no_bullets = (() => {
      if (typeof contractFromSeed?.no_bullets === 'boolean') return contractFromSeed.no_bullets;

      if (questionPolicy?.no_bullets === false) return false;
      if (shiftRules?.no_bullets === false) return false;
      if (systemPromptArgs?.no_bullets === false) return false;

      if (
        questionPolicy?.no_bullets === true ||
        shiftRules?.no_bullets === true ||
        systemPromptArgs?.no_bullets === true
      ) {
        return true;
      }

      return undefined;
    })();

    if (!output_only && questions_max == null && no_bullets == null) return null;

    return {
      output_only,
      questions_max,
      no_bullets,
    };
  })();

  if (minimalWriterRules) {
    const candidateText0 = String(candidate ?? '');
    let wg = checkWriterGuardsMinimal({
      text: candidateText0,
      rules: minimalWriterRules,
    });

    if (!wg.ok && wg.reason === 'WG:Q_OVER') {
      const qMax =
        typeof minimalWriterRules?.questions_max === 'number'
          ? minimalWriterRules.questions_max
          : 0;

      console.warn('[IROS/WRITER_GUARD][BYPASS_Q_OVER_KEEP_QUESTION]', {
        traceId: debug.traceId,
        conversationId: debug.conversationId,
        userCode: debug.userCode,
        qMax,
        candidateHead: safeHead(candidateText0, 160),
        reason: 'KEEP_QUESTION_AS_IS',
      });

      candidate = candidateText0;
      wg = { ok: true };
    }

    if (!wg.ok) {
      const fallbackSeed =
        String(seedFromSlots ?? '').trim() ||
        String(seedDraft ?? '').trim() ||
        '';

      console.warn('[IROS/WRITER_GUARD][REJECT_TO_SEED]', {
        traceId: debug.traceId,
        conversationId: debug.conversationId,
        userCode: debug.userCode,
        reason: wg.reason,
        detail: (wg as any)?.detail ?? null,
        rules: minimalWriterRules,
        candidateHead: safeHead(String(candidate ?? ''), 160),
        fallbackSeedHead: safeHead(fallbackSeed, 160),
      });

      if (fallbackSeed) {
        return adoptAsSlots(fallbackSeed, 'WRITER_GUARD_REJECT_TO_SEED', {
          scaffoldActive,
          writerGuardReason: wg.reason,
          writerGuardDetail: (wg as any)?.detail ?? null,
        });
      }
    }
  }
  // ---------------------------------------------
  // Flagship Guard（採用ゲート）
  // ---------------------------------------------
  if (!guardEnabled) {
    const candidateTextNow = String(candidate ?? '').trim();
    const paragraphCountNow = candidateTextNow
      ? candidateTextNow.split(/\n{2,}/).map((v) => String(v ?? '').trim()).filter(Boolean).length
      : 0;

      const activePatternKeyNow = String(
        (opts as any)?.meta?.extra?.patternKey ??
          selectSlotPattern({
            line: String(
              (opts as any)?.meta?.extra?.presentationKind ??
                (opts as any)?.userContext?.meta?.extra?.presentationKind ??
                ''
            )
              .trim()
              .toLowerCase(),
            questionType: null,
            detailMode:
              (opts as any)?.ctxPack?.detailMode === true ||
              (opts as any)?.userContext?.ctxPack?.detailMode === true,
            followupText: String((opts as any)?.userText ?? '').trim(),
            userText: String((opts as any)?.userText ?? '').trim(),
            targetLabel: null,
            hasPriorDiagnosis: false,
          }) ??
          ''
      ).trim();

    const isDeclarationLike =
    activePatternKeyNow === 'DECLARATION_RESONANCE_V1';

    if (isDeclarationLike && paragraphCountNow < 4) {
      const fallbackSeed =
        String(seedFromSlots ?? '').trim() ||
        String(seedDraft ?? '').trim() ||
        String((opts as any)?.userText ?? '').trim() ||
        '';

      if (fallbackSeed) {
        return adoptAsSlots(fallbackSeed, 'FLAGSHIP_DISABLED_DECL_SHORT_TO_SEED', {
          scaffoldActive,
          writerGuardReason: 'FLAGSHIP_DISABLED_DECL_SHORT',
          writerGuardDetail: {
            paragraphCountNow,
            activePatternKeyNow,
          },
        });
      }
    }

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
          // ✅ 末尾が見出し開始だけで途切れていても「FATALにはしない」方針に変更
          // - retry を禁止して、renderGateway 側の open/close（補完）に任せる
          // - ここで落とすと LLM がもう1周してコストも遅延も増えるため
          v = {
            ...(v as any),
            ok: true,
            level: 'OK',
            reasons: Array.from(
              new Set([...(v?.reasons ?? []), 'BLOCK_PLAN_TAIL_TRUNCATED_SOFT']),
            ),
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
    if (lines.length >= 2) return false;
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

  const naturalizeOpeningLine = (text: string, shiftObj: any): string => {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!src) return src;

    const lines = src.split('\n');
    const first = String(lines[0] ?? '').trim();
    if (!first) return src;

    const rest = lines.slice(1).join('\n').trim();

    const kind = String(shiftObj?.kind ?? '').trim();
    const meaningKind = String(shiftObj?.meaning_kind ?? '').trim();
    const seedText = String(shiftObj?.seed_text ?? '').trim();

    const looksQuotedEcho =
      /^「[^」]{2,80}」(?:って|の|は)/.test(first) ||
      /^『[^』]{2,80}』(?:って|の|は)/.test(first);

    const looksInterpretiveOpening =
      /たぶん|気がする|ニュアンス|奥にあるのは|混ざってる|知りたい感じ|確かめたい感じ|もどかしさだと思う/.test(first);

    const shouldNaturalize =
      (looksQuotedEcho || looksInterpretiveOpening) &&
      kind === 'clarify';

    if (!shouldNaturalize) return src;

    let replacement: string | null = null;

    if (meaningKind === 'capability_reask') {
      replacement =
        'ここでできるのは、あなたの状況や言葉を整理して、いちばん大事な点を見つけ、次にどう動くかを一緒に形にすること。';
    } else if (meaningKind === 'topic_recall') {
      replacement =
        seedText.length > 0
          ? `さっきまで話していたのは、「${seedText}」について。`
          : 'さっきまで話していた流れをそのまま言い直すね。';
    } else if (meaningKind === 'truth_structure') {
      replacement = '結論から言うと、先に核を短く置いてから、必要な構造だけを足す形で返せる。';
    } else if (seedText.length > 0) {
      replacement = `いま話しているのは、「${seedText}」について。`;
    }

    if (!replacement || replacement === first) return src;

    const rebuilt = [replacement, rest].filter(Boolean).join('\n\n').trim();

    console.log('[IROS/rephraseEngine][OPENING_NATURALIZED]', {
      traceId: debug?.traceId ?? null,
      conversationId: debug?.conversationId ?? null,
      userCode: debug?.userCode ?? null,
      meaningKind,
      seedTextHead: safeHead(seedText, 80),
      beforeHead: safeHead(first, 120),
      afterHead: safeHead(replacement, 120),
    });

    return rebuilt;
  };
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
  //   ただし「ありがとう」等の短文は “会話の継続” として扱いたいので、tiny のときだけ skip する。
  const userLenTiny = String(userText ?? '').trim().length <= 2;
  const seedDraftTrim = String(seedDraft ?? '').trim();
  const seedLenTiny = seedDraftTrim.length > 0 && seedDraftTrim.length <= 40;

  // ✅ 変更点：
  // - 以前：isMicroOrGreetingNow を含めて強制 skip（「ありがとう」も落ちる）
  // - 今回：本当に tiny（<=2）なときだけ skip（例: 「うん」「OK」「👍」など）
  const microLikeNow = Boolean(userLenTiny && seedLenTiny);

  if (microLikeNow) {
    const extractHintFromScaffold = (s0: any): string => {
      const s = String(s0 ?? '').trim();
      if (!s) return '';

      // 1) @NEXT_HINT / @SHIFT の hint は内部ディレクティブなので、
      //    ここでは本文化に使わない。
      //    evidence / slotPlan 側には残してよいが、scaffold から直接拾うと
      //    「いま出ている流れを崩さず…」「結論を先に1〜2文で…」が
      //    本文へ漏れる。

      // 3) 行単位で internal を捨て、自然文っぽい行だけ拾う
      const lines = s
        .split('\n')
        .map((x) => String(x ?? '').trim())
        .filter(Boolean)
        .filter((x) => !x.startsWith('@')); // internal marker除外

      // 先頭の1行だけで十分（micro系）
      return (lines[0] ?? '').trim();
    };

    const fixed =
      extractHintFromScaffold(seedDraftTrim) ||
      extractHintFromScaffold(seedFromSlots) ||
      extractHintFromScaffold(candidate) ||
      '';

    if (fixed.length > 0) {
      return adoptAsSlots(fixed, 'MICRO_LIKE_SKIP_REPHRASE', { scaffoldActive });
    }
  }
  const shortReplyOkRaw = pol.shortReplyOkRaw;
  const shortReplyOk = pol.shortReplyOk;

  const shiftKind = pol.shiftKind;
  const emotionalTemperatureNow = (() => {
    const raw = String(
      (opts as any)?.userContext?.ctxPack?.emotionalTemperature ??
        (opts as any)?.userContext?.emotionalTemperature ??
        ''
    )
      .trim()
      .toLowerCase();

    return raw === 'low' || raw === 'mid' || raw === 'high' || raw === 'volatile'
      ? raw
      : null;
  })();

  const shouldSuppressQuestionByShift = (() => {
    const sk = String(shiftKind ?? '').trim();
    const temp = String(emotionalTemperatureNow ?? '').trim();

    if (sk === 'clarify_shift') return true;
    if (sk === 'stabilize_shift') return true;
    if (sk === 'distance_shift') return true;

    if (temp === 'high' || temp === 'volatile') return true;

    return false;
  })();

  if (shouldSuppressQuestionByShift) {
    const before = String(candidate ?? '');

    const suppressQuestionTail = (src: string): string => {
      const lines = src
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((s) => String(s ?? '').trim());

      const kept: string[] = [];

      const isQuestionLikeLine = (line: string): boolean => {
        const t = String(line ?? '').trim();
        if (!t) return false;

        // 1) 明示的な質問文
        if (/[?？]/u.test(t)) return true;

        // 2) 質問で終わりやすい語尾
        const tail = t.replace(/[。！!]+$/u, '').trim();
        if (
          /(?:どれ|なに|何|どう|どこ|どんな|どの|ありますか|でしょうか|近い|戻る)$/u.test(
            tail,
          )
        ) {
          return true;
        }

        return false;
      };

      const isDanglingQuestionLead = (line: string): boolean => {
        const t = String(line ?? '')
          .replace(/[。！!]+$/u, '')
          .trim();

        if (!t) return false;

        // 問いの導入句だけで止まっている末尾を落とす
        // 例:
        // - いま得たい体験って、
        // - その体験は、
        // - こうするなら、
        // - 〜について、
        // - 〜で、
        if (
          /(?:って、|とは、|は、|なら、|すると、|するとしたら、|について、|で、)$/u.test(t)
        ) {
          return true;
        }

        return false;
      };

      for (const line of lines) {
        if (!line) continue;
        if (isQuestionLikeLine(line)) continue;
        kept.push(line);
      }

      // 3) 質問導入句だけで終わる末尾も落とす
      while (kept.length > 0 && isDanglingQuestionLead(kept[kept.length - 1])) {
        kept.pop();
      }

      // 全部落ちたら、元文の先頭1行だけを安全に返す
      if (kept.length === 0) {
        const first = String(src ?? '')
          .replace(/\r\n/g, '\n')
          .split('\n')
          .map((s) => String(s ?? '').trim())
          .find(Boolean);

        if (!first) return '';

        return first
          .replace(/[?？].*$/u, '')
          .replace(/（[^）]*$/u, '')
          .replace(/\([^)]*$/u, '')
          .replace(/(?:って、|とは、|は、|なら、|すると、|するとしたら、|について、|で、)$/u, '')
          .trim();
      }

      return kept.join('\n').trim();
    };

    const after = suppressQuestionTail(before);

    if (after && after !== before) {
      candidate = after;
    }

    console.log('[IROS/rephraseEngine][QUESTION_SUPPRESSED_BY_SHIFT]', {
      traceId: debug.traceId,
      shiftKind: shiftKind || null,
      emotionalTemperature: emotionalTemperatureNow,
      applied: after !== before,
      beforeHead: before.slice(0, 120),
      afterHead: after.slice(0, 120),
    });
  }

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

  const detailPatternKeyNow = String(
    (debug as any)?.patternKey ??
      (ctxPackForWriter as any)?.patternKey ??
      (opts as any)?.ctxPack?.patternKey ??
      (opts as any)?.userContext?.ctxPack?.patternKey ??
      ''
  ).trim();

  const isDetailPatternNow =
    detailPatternKeyNow === 'NORMAL_DETAIL_V1' || detailPatternKeyNow === 'IR_DETAIL_V1';

  const detailBodyStyle = isDetailPatternNow
    ? (buildDetailPatternWriterDirectives(detailPatternKeyNow).bodyStyle ?? null)
    : null;

  const detailMinUnits =
    detailBodyStyle && typeof (detailBodyStyle as any).minSentences === 'number'
      ? Math.max(1, Number((detailBodyStyle as any).minSentences))
      : 0;

  const detailUnitsNow = (() => {
    if (!isDetailPatternNow) return 0;

    const parts = String(candidate ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => String(line ?? '').trim())
      .filter(Boolean);

    const units: string[] = [];

    for (const part of parts) {
      const sliced = String(part)
        .split(/(?<=[。！？!?])\s*/u)
        .map((s) => String(s ?? '').trim())
        .filter(Boolean);

      if (sliced.length > 0) {
        units.push(...sliced);
      } else if (part) {
        units.push(part);
      }
    }

    return units.length;
  })();

  const shouldDetailTooShortToRetry =
    isDetailPatternNow &&
    detailMinUnits > 0 &&
    detailUnitsNow > 0 &&
    detailUnitsNow < detailMinUnits;

  if (shouldOkTooShortToRetry || shouldDetailTooShortToRetry) {
    console.warn('[IROS/FLAGSHIP][OK_TOO_SHORT_TO_RETRY]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      level: (v as any)?.level,
      len: candidateLen,
      min: MIN_OK_LEN,
      head: safeHead(candidate, 160),
      detailPatternKey: isDetailPatternNow ? detailPatternKeyNow : null,
      detailUnitsNow,
      detailMinUnits,
      via: shouldDetailTooShortToRetry ? 'detail_units' : 'min_ok_len',
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
      detailPatternKey: isDetailPatternNow ? detailPatternKeyNow : null,
      detailUnitsNow,
      detailMinUnits,
      shouldDetailTooShortToRetry,
    });

    v = {
      ...(v as any),
      ok: false,
      level: 'FATAL',
      reasons: Array.from(
        new Set([
          ...(v.reasons ?? []),
          shouldDetailTooShortToRetry
            ? 'DETAIL_PATTERN_TOO_SHORT_TO_RETRY'
            : 'OK_TOO_SHORT_TO_RETRY',
        ])
      ),
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

  const activePatternKeyForContract = String(
    (debug as any)?.patternKey ||
      (ctxPackForWriter as any)?.patternKey ||
      (opts as any)?.ctxPack?.patternKey ||
      (opts as any)?.userContext?.ctxPack?.patternKey ||
      ''
  ).trim();

  const shouldSkipExact4ParagraphContract =
    activePatternKeyForContract === 'NORMAL_DETAIL_V1' &&
    /^##\s+/m.test(String(candidate ?? ''));

  const detailPatternRequires4Paragraphs =
    !shouldSkipExact4ParagraphContract &&
    (
      activePatternKeyForContract === 'NORMAL_DETAIL_V1' ||
      activePatternKeyForContract === 'IR_DETAIL_V1' ||
      activePatternKeyForContract === 'DECLARATION_RESONANCE_V1'
    );

  const candidateParagraphsForContract = String(candidate ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split(/\n{2,}/)
    .map((p) => String(p ?? '').trim())
    .filter(Boolean);

  const hasExact4ParagraphsForDetailPattern =
    !detailPatternRequires4Paragraphs || candidateParagraphsForContract.length === 4;

  if (!hasExact4ParagraphsForDetailPattern) {
    console.warn('[IROS/FLAGSHIP][DETAIL_PATTERN_PARAGRAPH_CONTRACT_VIOLATION]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      patternKey: activePatternKeyForContract,
      paragraphsLen: candidateParagraphsForContract.length,
      paragraphsPreview: candidateParagraphsForContract.slice(0, 4),
      head: safeHead(candidate, 220),
    });

    v = {
      ...(v as any),
      ok: false,
      level: 'FATAL',
      reasons: Array.from(
        new Set([ ...((((v as any)?.reasons ?? []) as any[])), 'DETAIL_PATTERN_PARAGRAPH_CONTRACT' ]),
      ),
    } as any;
  }

  // ✅ Phase 2: 最終採用直前の質問抑制
  // - WARN accept / OK no retry の return より前で必ず最終形にかける
  if (shouldSuppressQuestionByShift) {
    const beforeFinal = String(candidate ?? '');

    const paragraphs = beforeFinal
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split(/\n{2,}/)
      .map((p) =>
        String(p ?? '')
          .split('\n')
          .map((s) => String(s ?? '').trim())
          .filter(Boolean)
      )
      .filter((p) => p.length > 0);

    const keptParagraphs = paragraphs
      .map((para) =>
        para.filter((line) => {
          if (/[?？]/u.test(line)) return false;

          const tail = line.replace(/[。！!]+$/u, '').trim();
          if (/(?:どれ|なに|何|どう|どこ|どんな|どの|ありますか|でしょうか)$/u.test(tail)) {
            return false;
          }

          return true;
        })
      )
      .filter((para) => para.length > 0);

    const afterFinal =
      keptParagraphs.length > 0
        ? keptParagraphs.map((para) => para.join('\n')).join('\n\n').trim()
        : beforeFinal
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map((s) => String(s ?? '').trim())
            .find(Boolean)
            ?.replace(/[?？].*$/u, '')
            .replace(/（[^）]*$/u, '')
            .replace(/\([^)]*$/u, '')
            .trim() ?? '';
    if (afterFinal && afterFinal !== beforeFinal) {
      candidate = afterFinal;
    }

    console.log('[IROS/rephraseEngine][QUESTION_SUPPRESSED_BY_SHIFT][FINAL]', {
      traceId: debug.traceId,
      shiftKind: shiftKind || null,
      emotionalTemperature: emotionalTemperatureNow,
      applied: afterFinal !== beforeFinal,
      beforeHead: beforeFinal.slice(0, 120),
      afterHead: afterFinal.slice(0, 120),
    });
  }

  if (String((v as any)?.level ?? '').toUpperCase() === 'WARN' && naturalTextReady) {
    return adoptAsSlots(candidate, 'FLAGSHIP_ACCEPT_AS_FINAL', {
      scaffoldActive,
      flagshipLevel: String((v as any)?.level ?? '').toUpperCase(),
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
  if ((v as any)?.ok === true) {
    return adoptAsSlots(candidate, 'FLAGSHIP_OK_NO_RETRY', { scaffoldActive });
  }
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
    const preferCandidateBecauseTooShort =
      reasons.has('OK_TOO_SHORT_TO_RETRY') ||
      reasons.has('DETAIL_PATTERN_TOO_SHORT_TO_RETRY') ||
      reasons.has('DETAIL_PATTERN_PARAGRAPH_CONTRACT');

    const preferSeedDraft =
      reasons.has('NORMAL_SHORT_GENERIC_NO_QUESTION') || reasons.has('WARN_TO_RETRY');

    if (isDirectTask && preferCandidateBecauseTooShort) return b || a || c || '';
    if (isDirectTask) return a || b || c || '';

    if (preferCandidateBecauseTooShort) return b || a || c || '';
    if (preferSeedDraft) return a || c || b || '';
    return b || a || c || '';
  })();
  const retrySlotDecisionForWriter = computeSlotDecisionFromEngine({
    depthStage:
      String((ctxPackForWriter as any)?.depthStage ?? '').trim() || null,

    questionType: (() => {
      const s = String((opts as any)?.userText ?? '').trim();
      if (/構造|仕組み|関係|違い|配置|流れ|構成/u.test(s)) return 'structure';
      if (/意味|なぜ|どういうこと|どう受け止め|どう読める/u.test(s)) return 'meaning';
      if (/意図|どうしたい|どう進む|どこへ向かう|何のため/u.test(s)) return 'intent';
      if (/とは|教えて|ありますか|ですか/u.test(s)) return 'truth';
      return null;
    })(),

    goalKind:
      String(
        (ctxPackForWriter as any)?.goalKind ??
          (ctxPackForWriter as any)?.targetKind ??
          ''
      ).trim() || null,

    deltaType:
      String(
        (ctxPackForWriter as any)?.flow?.deltaType ??
          (ctxPackForWriter as any)?.deltaType ??
          ''
      ).trim() || null,

    returnStreak:
      typeof (ctxPackForWriter as any)?.returnStreak === 'number' &&
      Number.isFinite((ctxPackForWriter as any).returnStreak)
        ? (ctxPackForWriter as any).returnStreak
        : 0,

    continuityKind:
      String((ctxPackForWriter as any)?.continuityKind ?? '').trim() || null,
  });

  const retryPatternKey = String(
    (ctxPackForWriter as any)?.patternKey ??
      (opts as any)?.ctxPack?.patternKey ??
      (opts as any)?.userContext?.ctxPack?.patternKey ??
      activePatternKeyForContract ??
      ''
  ).trim();

  const retryIsDetailPattern =
    retryPatternKey === 'NORMAL_DETAIL_V1' || retryPatternKey === 'IR_DETAIL_V1';

  const retryWriterDirectivesFromSlot = {
    slot_order: Array.isArray(retrySlotDecisionForWriter?.order)
      ? retrySlotDecisionForWriter.order.join(',')
      : '',

    slot_opening_role: Array.isArray(retrySlotDecisionForWriter?.order)
      ? String(retrySlotDecisionForWriter.order[0] ?? '')
      : '',

    ...(retrySlotDecisionForWriter?.emphasis
      ? Object.fromEntries(
          Object.entries(retrySlotDecisionForWriter.emphasis).map(([k, v]) => [
            `slot_emphasis_${String(k).toLowerCase()}`,
            String(v),
          ])
        )
      : {}),

    ...(retrySlotDecisionForWriter?.weights
      ? Object.fromEntries(
          Object.entries(retrySlotDecisionForWriter.weights).map(([k, v]) => [
            `slot_weight_${String(k).toLowerCase()}`,
            String(v),
          ])
        )
      : {}),

    ...(retryIsDetailPattern
      ? buildDetailPatternWriterDirectives(retryPatternKey)
      : {}),
  };
// ▼ 最終出力直前フィルター
const filteredDraft =
  typeof baseDraftForRepair === 'string'
    ? baseDraftForRepair.replace(/証拠/g, '気配')
    : baseDraftForRepair;

return await runRetryPass({
  debug,
  opts: {
    ...(opts ?? {}),
    slotDecision: retrySlotDecisionForWriter,
    writerDirectives: {
      ...retryWriterDirectivesFromSlot,
    },
  },
  slotPlanPolicyResolved,

  systemPrompt,
  internalPack,
  turns: lastTurnsSafe,
  baseDraftForRepair: filteredDraft, // ←ここ変更

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
