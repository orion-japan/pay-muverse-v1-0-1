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

import crypto from 'node:crypto';
import { chatComplete } from '../../llm/chatComplete';

import { recallGuardOk, shouldEnforceRecallGuard } from './rephrase/guards';
import { containsForbiddenLeakText, extractDirectTask } from './rephrase/leak';
import { extractLockedILines, verifyLockedILinesPreserved, buildLockRuleText } from './rephrase/ilineLock';
import { finalizeLamp } from './rephrase/lamp';
import { extractHistoryTextFromContext, extractLastTurnsFromContext } from './rephrase/history';

import { flagshipGuard } from '../quality/flagshipGuard';

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
 */
function buildSlotsWithFirstText(inKeys: string[], firstText: string): Slot[] {
  const ZWSP = '\u200b';
  if (inKeys.length === 0) return [];

  const full = norm(firstText);

  if (!full) {
    return [
      { key: inKeys[0], text: '' },
      ...inKeys.slice(1).map((k) => ({ key: k, text: ZWSP })),
    ];
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

  for (let i = 0; i < takeN; i++) out.push({ key: inKeys[i], text: blocks[i] });

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
  // - ここは writer の振る舞いを縛るだけ（意味判断はしない）
  // - 「かもしれない」等を出した瞬間に FlagshipGuard WARN で seed に戻るため、
  //   先に system で禁止して WARN を出させない
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
  // ただし picked.onePoint が旧ラベルでも restore が正規化する
  if (out.includes(normLite(picked.onePoint))) {
    return { ok: true, out: out0, missing: [], needles: picked };
  }

  const restored = restoreOnePointInOutput({ llmOut: out0, onePoint: picked.onePoint });

  // ✅ 最終確認：差し戻した onePoint 本文（ラベル込み）が入っていること
  // restore で LABEL を固定するので、picked.onePoint ではなく restored 内の検査でOK
  const restoredNorm = normLite(restored);
  const bodyNorm = normLite(String(picked.onePoint).replace(/^(いまの一点|今の状況|ワンポイント|ポイント|足場)[:：]\s*/u, '').trim());
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
    // onePointNeedle は「今の状況：」「いまの一点：」どっちでも来るので両対応で剥がす
    const base = onePointNeedle
      ? onePointNeedle
          .replace(/^今の状況[:：]\s*/u, '')
          .replace(/^いまの一点[:：]\s*/u, '')
          .trim()
      : '';

    // ✅ 追記で「焦点タグ」を足すのをやめる
    // - “ラベル/見出し”を本文に出さない
    // - base があるなら、その語彙を使った「自然な1文」を1つだけ足す（命令口調にしない）
    // - base が無いなら、固定テンプレを足さず、何もしない（観測なしは短く留める方針）
    if (!base) return;

    // ✅ 同じ言い回しの固定化を避けるため、3種をローテ（k を流用）
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
  // if (miss.has('SCAFFOLD_NEED_ONE_POINT')) addOnePoint(); // ← ❌ 削除
  if (miss.has('SCAFFOLD_NEED_AXES')) addAxes();

  return out;
}

// ---------------------------------------------
// IT成立（証拠）/ intentBand / shouldRaiseFlag を userContext から読む
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

function readShouldRaiseFlagFromContext(
  userContext: unknown,
): { on: boolean; reason: string | null } {
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

  let out = s;

  // seedDraft に find_trigger_point の痕跡が混ざる場合の保険
  if (/find_trigger_point/i.test(out)) {
    out = out.replace(/.*find_trigger_point.*(\n|$)/gi, '').trim();
    const hint = directTask
      ? '（内部ヒント：ユーザーは「具体的なコツ/手順」を求めている。最初に使える具体策を短く出す）'
      : '（内部ヒント：ユーザーが求めている一点を「軸」として置く）';
    return [hint, out].filter(Boolean).join('\n');
  }

  if (directTask) return ['（内部ヒント：具体策を先に。一般論は足さない）', out].join('\n');
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

// ---------------------------------------------
// system prompt（方向づけ / 露出禁止）
// ---------------------------------------------
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
  metaText?: string | null;
  historyText?: string | null;
  seedDraftHint?: string | null;
  lastTurnsCount?: number | null;
  directTask?: boolean | null;
  inputKind?: string | null;
  itOk?: boolean | null;
  intentBand?: string | null;
  tLayerHint?: string | null;

  onePointText?: string | null;
  situationSummary?: string | null;
  depthStage?: string | null;
  phase?: string | null;
  qCode?: string | null;
}) {
  const obsOnePoint = String(args.onePointText ?? '').trim();
  const obsSummary = String(args.situationSummary ?? '').trim();

  // ✅ まずは “一点（ONE_POINT）” を最優先、無ければ summary
  const obsPick =
    obsOnePoint.length >= 6 ? obsOnePoint :
    obsSummary.length >= 6 ? obsSummary :
    '';

  // ✅ LLMに「ラベルを出すな」「自然文に変換しろ」「毎回同じ言い回しを避けろ」を明示
  const obsCard = [
    '【観測ルール（重要 / 背景禁止）】',
    '- obsPick は「このターンの userText / seedDraft / ONE_POINT から取れた観測」だけ。',
    '- 長期履歴・Q遷移・深度・IT/T・Anchor・RETURN 等の“背景”はここでは使わない（混ぜない）。',
    '',
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

  const isFlagReplyLike = Array.isArray(inKeys) && inKeys.length > 0 && inKeys.every((k) => String(k).startsWith('FLAG_'));
  const isStabilizePack = Array.isArray(inKeys) && inKeys.includes('OBS') && inKeys.includes('SHIFT') && inKeys.includes('NEXT');

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

  // (A) FIXED
  if (mode === 'FIXED') {
    const fixedTexts = buildFixedBoxTexts(inKeys.length);
    const out: Slot[] = inKeys.map((k, i) => ({ key: k, text: fixedTexts[i] ?? 'ここで止める。' }));

    logRephraseOk(debug, out.map((x) => x.key), out[0]?.text ?? '', 'FIXED');
    logRephraseAfterAttach(debug, out.map((x) => x.key), out[0]?.text ?? '', 'FIXED');

    return { ok: true, slots: out, meta: { inKeys, outKeys: out.map((x) => x.key), rawLen: 0, rawHead: '' } };
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
// - seedDraft は「露出してもいい本文素材」だけを集める（TASK/CONSTRAINTS などのメタは禁止）
// - recallMust は “全量” から拾って system で強制する（seedDraft とは分離）
const seedDraftRawAll = extracted.slots.map((s) => s.text).filter(Boolean).join('\n');

const seedDraftRaw = extracted.slots
  .filter((s) => {
    const k = String((s as any)?.key ?? '');
    // ✅ seed に残してよいものだけ
    if (k === 'OBS') return true;
    if (k === 'DRAFT') return true;
    if (k.startsWith('FLAG_')) return true;
    // （必要ならここに 'END' / 'NEXT_HINT' 等を追加）
    return false;
  })
  .map((s) => s.text)
  .filter(Boolean)
  .join('\n');

// recall-guard must include を “全量” から抽出して system に強制する
const recallMust = extractRecallMustIncludeFromSeed(seedDraftRawAll);
const mustIncludeRuleText = buildMustIncludeRuleText(recallMust);


// ILINE抽出：slot + userText 両方から拾う
const lockSourceRaw = [seedDraftRaw, userText].filter(Boolean).join('\n');
const { locked: lockedFromAll } = extractLockedILines(lockSourceRaw);

// ✅ LLMに渡す素材は slot 由来のみ（重複防止）
// - ただし slot の中に @OBS/@SH などが混ざると、LLMが「メタ」を要約し始めて
//   一般論/ヘッジ/質問過多→Flagship FATAL に寄るため、LLM投入前に除去する
const { cleanedForModel: seedDraft0 } = extractLockedILines(seedDraftRaw);
const lockedILines = Array.from(new Set(lockedFromAll));

// ✅ “内部マーカー” だけ落とす（ユーザーの @mention 等は落とさない）
const INTERNAL_LINE_MARKER = /^@(OBS|SHIFT|SH|RESTORE|Q|SAFE|NEXT|END|TASK)\b/;

const sanitizeSeedDraftForLLM = (s: string) => {
  const lines = String(s ?? '')
    .split('\n')
    .map((x) => String(x ?? '').trimEnd());

  const kept = lines.filter((line) => {
    const t = String(line ?? '').trim();
    if (!t) return false;

    // 行頭内部マーカー（構造）を落とす
    if (INTERNAL_LINE_MARKER.test(t)) return false;

    // ILINEタグは lockedILines 側で別管理（LLM本文の保持対象）なので seedDraft からは落としてOK
    if (/\[\[ILINE\]\]/.test(t) || /\[\[\/ILINE\]\]/.test(t)) return false;

    return true;
  });

  return kept.join('\n').trim();
};

const seedDraft = sanitizeSeedDraftForLLM(seedDraft0);

const seedDraftHint = adaptSeedDraftHintForWriter(seedDraft, isDirectTask);
const itOk = readItOkFromContext(opts?.userContext ?? null);
const band = extractIntentBandFromContext(opts?.userContext ?? null);

// lastTurns は「assistantで終わる」形に正規化
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
  {
    role: 'system',
    content: buildInternalPackText({
      metaText,
      historyText,
      seedDraftHint,
      lastTurnsCount: lastTurnsSafe.length,
      itOk,
      directTask: isDirectTask,
      inputKind,
      intentBand: band.intentBand,
      tLayerHint: band.tLayerHint,
    }),
  },
  ...(seedDraft
    ? [{ role: 'system' as const, content: `【内部素材：下書き（露出禁止）】\n${seedDraft}` }]
    : []),
  ...(lastTurnsSafe as Array<{ role: 'user' | 'assistant'; content: string }>),
  { role: 'user', content: userText || '（空）' },
];

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

    // ✅ FATAL_TO_SEED で返す “種” には内部マーカーを混ぜない
    // - @OBS / @SH / @RESTORE / @Q など renderGateway が剥がす行が入ると、
    //   返却が空に近くなる
    if (INTERNAL_LINE_MARKER.test(line)) return false;

    // ILINEタグも seed側には不要（保持は lockedILines で担保する）
    if (/\[\[ILINE\]\]/.test(line) || /\[\[\/ILINE\]\]/.test(line)) return false;

    return true;
  })
  .join('\n');

const seedFromSlots = seedFromSlotsRaw
  ? makeCandidate(seedFromSlotsRaw, maxLines, renderEngine)
  : '';



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

// ✅ counsel: 「相談ですが」みたいな“相談入口だけ”のターンは、LLMに上書きさせない。
// - FINAL_FORCE_CALL でも、最終テキストは DRAFT を採用して会話を噛ませる
// - ここで質問/説明が出ると「テンプレ質問」に戻るので強制的に塞ぐ
function forceDraftForCounselConsultOpen(args: {
  slotKeys: string[];
  slotsForGuard: Array<{ key?: string; text?: string; content?: string; value?: string }> | null;
  llmOut: string;
}): { used: boolean; text: string } {
  const keys = Array.isArray(args.slotKeys) ? args.slotKeys : [];
  const slots = Array.isArray(args.slotsForGuard) ? args.slotsForGuard : [];

  // counsel 4スロット構成を検知（OBS/TASK/CONSTRAINTS/DRAFT）
  const isCounselPack =
    keys.includes('OBS') && keys.includes('TASK') && keys.includes('CONSTRAINTS') && keys.includes('DRAFT');

  if (!isCounselPack) return { used: false, text: args.llmOut };

  // OBS から userText を取る（@OBS JSON）
  const obs = slots.find((s) => String(s?.key ?? '') === 'OBS');
  const obsText = String(obs?.content ?? obs?.text ?? obs?.value ?? '');

  // userText 抽出（安全側に：失敗したら空）
  let userText = '';
  try {
    const m = obsText.match(/@OBS\s+(\{.*\})/);
    if (m && m[1]) {
      const j = JSON.parse(m[1]);
      userText = String(j?.userText ?? '');
    }
  } catch {
    userText = '';
  }

  const t = String(userText ?? '').replace(/\r\n/g, '\n').trim();

  // 「相談ですが / ちょっと相談 / 相談です」等の“入口だけ”かつ短文
  const isConsultOpenShort =
    t.length > 0 &&
    t.length <= 12 &&
    /(相談(ですが|です)?|ちょっと相談|相談なんだけど|相談したい)/.test(t);

  if (!isConsultOpenShort) return { used: false, text: args.llmOut };

  // DRAFT を最終採用
  const draft = slots.find((s) => String(s?.key ?? '') === 'DRAFT');
  const draftText = String(draft?.content ?? draft?.text ?? draft?.value ?? '').trim();

  if (!draftText) return { used: false, text: args.llmOut };

  return { used: true, text: draftText };
}



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
    let v = flagshipGuard(String(text ?? ''), {
      slotKeys: Array.isArray(inKeys) ? inKeys : null,
      slotsForGuard: Array.isArray(slotsForGuard) ? slotsForGuard : null,
    });

// ==============================
// ✅ scaffold必須の自動復元（LLMが落としてもFATALにしない）
// ==============================
function extractSlotText(
  slots: Array<{ key?: string; text?: string; content?: string; value?: string }> | null,
  keyPrefix: string,
): string {
  const arr = Array.isArray(slots) ? slots : [];
  const hit = arr.find((s) => String(s?.key ?? '').startsWith(keyPrefix));
  return String(hit?.text ?? hit?.content ?? hit?.value ?? '').trim();
}

function isScaffoldSlotKeys(slotKeys: string[] | null | undefined): boolean {
  const keys = Array.isArray(slotKeys) ? slotKeys : [];
  // scaffold(ONE_POINT pack)が入っているなら true
  return (
    keys.some((k) => String(k).includes('FLAG_PURPOSE')) ||
    keys.some((k) => String(k).includes('FLAG_ONE_POINT')) ||
    keys.some((k) => String(k).includes('FLAG_POINTS_3')) ||
    keys.some((k) => String(k).includes('FLAG_PREFACE')) ||
    keys.some((k) => String(k).includes('FLAG_NEXT_1'))
  );
}

function hasLineLike(hay: string, needle: string): boolean {
  const a = String(hay ?? '').replace(/\s+/g, ' ').trim();
  const n = String(needle ?? '').replace(/\s+/g, ' ').trim();
  if (!a || !n) return false;
  // 完全一致要求ではなく「含む」でOK（微修正で落ちないように）
  return a.includes(n);
}

function restoreScaffoldMustHave(args: {
  slotKeys: string[];
  slotsForGuard: Array<{ key?: string; text?: string; content?: string; value?: string }> | null;
  llmOut: string;
}): { text: string; restored: string[] } {
  const out = String(args.llmOut ?? '').trim();
  const restored: string[] = [];

  // scaffoldじゃないなら何もしない
  if (!isScaffoldSlotKeys(args.slotKeys)) return { text: out, restored };

  const preface = extractSlotText(args.slotsForGuard, 'FLAG_PREFACE');
  const purpose = extractSlotText(args.slotsForGuard, 'FLAG_PURPOSE');
  const onePoint = extractSlotText(args.slotsForGuard, 'FLAG_ONE_POINT');
  const points3 = extractSlotText(args.slotsForGuard, 'FLAG_POINTS_3');

  // LLM出力に「必須3点」が欠けていたら、seed由来のslotを前段に合成する
  // ※ “タグ”は出さない。本文として自然に差し込む。
  const headParts: string[] = [];

  // PURPOSE
  if (purpose && !hasLineLike(out, purpose)) {
    headParts.push(purpose);
    restored.push('PURPOSE');
  }

  // ONE_POINT（slotは「意味だけ」なので、短い接続語を付けて本文化）
  if (onePoint) {
    const onePointAsSentence = `焦点はひとつ：${onePoint}`;
    const hit = hasLineLike(out, onePoint) || hasLineLike(out, onePointAsSentence);
    if (!hit) {
      headParts.push(onePointAsSentence);
      restored.push('ONE_POINT');
    }
  }

  // POINTS_3（これはブロックごと残す）
  if (points3 && !hasLineLike(out, points3)) {
    headParts.push(points3);
    restored.push('POINTS_3');
  }

  // PREFACEは“必須”ではないが、本文がいきなり硬い時のクッションとして差し戻す（欠けてたら）
  if (preface && !hasLineLike(out, preface)) {
    // 先頭に入れると強すぎるので、headPartsの一番前にだけ置く（ただし復元が他にある時）
    if (headParts.length > 0) {
      headParts.unshift(preface);
      restored.push('PREFACE');
    }
  }

  if (headParts.length === 0) return { text: out, restored };

  // 合成：復元ブロック + 改行 + LLM本文
  const merged = `${headParts.join('\n')}\n\n${out}`.trim();
  return { text: merged, restored };
}



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

  // ✅ scaffoldActive を外から渡す版（ここなら上に置ける）
  const shouldRejectWarnToSeedByVerdict = (verdict: any, scaffoldActive: boolean) => {
    if (!verdict || verdict.level !== 'WARN') return false;

    // ✅ scaffold中はWARN拒否を無効化（FATALは別）
    if (scaffoldActive) return false;

    const reasons = Array.isArray(verdict.reasons) ? verdict.reasons.map(String) : [];

    const hasGeneric = reasons.some((r) => r.includes('GENERIC'));
    const hasHedge = reasons.some((r) => r.includes('HEDGE'));
    const hasCheer = reasons.some((r) => r.includes('CHEER'));
    const hasBullet = reasons.some((r) => r.includes('BULLET'));

    // ✅ GENERIC単独では戻さない（会話が死ぬ）
    if (hasGeneric && (hasHedge || hasCheer || hasBullet)) return true;

    // ✅ hedge/cheer 単独でも戻す（好み）
    if (hasHedge || hasCheer) return true;

    return false;
  };


  // ---------------------------------------------
  // LLM call (1st)
  // ---------------------------------------------
  let raw = '';
  let raw2 = '';
  try {
    raw = await chatComplete({
      purpose: 'reply',
      model: opts.model,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
      max_tokens: 700,
      messages,
      extraBody: { __flagship_pass: 1 },
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      trace: { traceId: debug.traceId, conversationId: debug.conversationId, userCode: debug.userCode },
      audit: {
        slotPlanPolicy: 'FINAL',
        mode: (debug as any)?.mode ?? null,
        qCode: (debug as any)?.qCode ?? null,
        depthStage: (debug as any)?.depthStage ?? null,
      },
    } as any);
  } catch (e: any) {
    console.error('[IROS/REPHRASE_FINAL][LLM] failed', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      message: String(e?.message ?? e),
    });
    logRephraseOk(debug, extracted.keys, '', 'LLM_FAIL');
    return { ok: false, reason: 'LLM_CALL_FAILED', meta: { inKeys, rawLen: 0, rawHead: '' } };
  }

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
  const scaffoldActive =
  isScaffoldActive(slotsForGuard) && shouldEnforceOnePointGuard(inKeys);
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
      return { ok: false, reason: 'ONE_POINT_GUARD_REJECT', meta: { inKeys, rawLen: rawGuarded.length, rawHead: safeHead(rawGuarded, 80) } };
    }

    rawGuarded = onePointFix.out;

    // must-have（意味）: 欠落があれば復元→その後の判定を採用
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

  // scaffold時：clamp後に must-have が壊れたら復元→再clamp
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

  // scaffold must-have が最後まで満たせないなら seedFromSlots に戻す（PDF手順）
  if (scaffoldActive && scaffoldMissingAfterRestore.length > 0 && seedFromSlots) {
    console.warn('[IROS/REPHRASE][SCAFFOLD_MUST_HAVE_TO_SEED]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      missing: scaffoldMissingAfterRestore,
    });
    return adoptAsSlots(seedFromSlots, 'SCAFFOLD_TO_SEED', { scaffoldActive: true, scaffoldMissing: scaffoldMissingAfterRestore });
  }

// ---------------------------------------------
// Flagship Guard（採用ゲート）
// ---------------------------------------------
if (!guardEnabled) {
  return adoptAsSlots(candidate, 'FLAGSHIP_DISABLED', { scaffoldActive });
}

// ✅ 上位からの介入要求は、OKでも握り潰さない
const raise = readShouldRaiseFlagFromContext(opts?.userContext ?? null);
const forceIntervene = raise.on === true;

// ✅ verdict(WARN) を seed に戻す判定関数（このスコープで確定させる）
const shouldRejectWarnToSeed = shouldRejectWarnToSeedFactory({ inKeys, scaffoldActive });

// まず verdict
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


  // WARN薄逃げ → seedへ戻す（対象だけ）
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

  // OKなら採用
  if (v?.ok) return adoptAsSlots(candidate, 'FLAGSHIP_OK', { scaffoldActive });

  // ---------------------------------------------
  // FATAL → 1回だけ再生成（2ndは“再作文”ではなく“編集/復元+整形”）
  // ---------------------------------------------
  const baseDraftForRepair =
    (seedFromSlots && seedFromSlots.trim())
      ? seedFromSlots
      : (candidate && candidate.trim())
        ? candidate
        : seedDraft;

  const retryMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    // ✅ 1回目の system を流用しつつ、2回目は「編集タスク」に切り替える
    {
      role: 'system',
      content:
        systemPromptForFullReply({
          directTask: isDirectTask,
          itOk,
          band,
          lockedILines,
        }) +
        mustIncludeRuleText +
        [
          '',
          '【2nd PASS: 編集モード（重要）】',
          '- これは「新規に書く」ではなく「下書き本文を壊さずに整える」タスク。',
          '- 下書きに無い新しい背景・助言・一般論は足さない。',
          '- 下書きの“具体語”は必ず残す（減らさない）。',
          '- 旗印NG（応援定型/推量逃げ/便利テンプレ/薄い質問逃げ）だけを除去し、読み手が考えられる足場に寄せる。',
          '- 質問は0〜1個（できれば0）。',
          '',
        ].join('\n'),
    },

    // ✅ 内部パックも「編集」に寄せる（露出禁止のまま）
    {
      role: 'system',
      content: buildInternalPackText({
        metaText,
        historyText,
        seedDraftHint,
        lastTurnsCount: lastTurnsSafe.length,
        itOk,
        directTask: isDirectTask,
        inputKind,
        intentBand: band.intentBand,
        tLayerHint: band.tLayerHint,
      }),
    },

    // ✅ 2回目は「固定下書き」を“編集対象”として明示
    {
      role: 'system',
      content:
        [
          '【編集対象（この本文をベースに、壊さずに整える。露出禁止）】',
          '---BEGIN_DRAFT---',
          baseDraftForRepair,
          '---END_DRAFT---',
          '',
          '【出力ルール】',
          '- 出力は「整えた完成文のみ」。BEGIN/END や見出し、内部情報は出さない。',
          '- 下書きの構造を保持する（削り過ぎない）。',
        ].join('\n'),
    },

    // lastTurns は残してOK（ただし“新規生成”ではなく“編集”に従う）
    ...(lastTurnsSafe as Array<{ role: 'user' | 'assistant'; content: string }>),

    // ユーザーの直前入力は保持（編集の方向づけ）
    { role: 'user', content: userText || '（空）' },
  ];

  console.log('[IROS/FLAGSHIP][RETRY]', {
    traceId: debug.traceId,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    reason: v?.reasons,
  });

  try {
    raw2 = await chatComplete({
      purpose: 'reply',
      model: opts.model,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
      max_tokens: 700,
      messages: retryMessages,
      extraBody: { __flagship_pass: 2 },
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      trace: { traceId: debug.traceId, conversationId: debug.conversationId, userCode: debug.userCode },
      audit: {
        slotPlanPolicy: 'FINAL',
        mode: (debug as any)?.mode ?? null,
        qCode: (debug as any)?.qCode ?? null,
        depthStage: (debug as any)?.depthStage ?? null,
        note: 'FLAGSHIP_RETRY',
      },
    } as any);
  } catch (e: any) {
    console.error('[IROS/FLAGSHIP][RETRY] failed', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      err: e?.message ?? String(e),
    });
    if (seedFromSlots) return adoptAsSlots(seedFromSlots, 'FLAGSHIP_RETRY_FAIL_TO_SEED', { scaffoldActive });
    return adoptAsSlots(candidate, 'FLAGSHIP_RETRY_FAIL_USE_CANDIDATE', { scaffoldActive });
  }

  // retry raw validation（最低限の安全）
  {
    const v2 = validateOutput(raw2);
    if (!v2.ok) {
      // ✅ 2nd pass が「安全条件」を満たせない場合だけ seed に戻す（ここは必要）
      if (seedFromSlots) return adoptAsSlots(seedFromSlots, `RETRY_${v2.reason}_TO_SEED`, { scaffoldActive });
      return adoptAsSlots(candidate, `RETRY_${v2.reason}_USE_CANDIDATE`, { scaffoldActive });
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

  if (!retryCandidate || !retryCandidate.trim()) {
    // ✅ retryCandidate が空になるのは clamp 等の副作用なので、ここは candidate を返す（seedへ落とさない）
    console.warn('[IROS/FLAGSHIP][RETRY_EMPTY_AFTER_CLAMP]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
    });
    return adoptAsSlots(candidate, 'FLAGSHIP_RETRY_EMPTY_USE_CANDIDATE', { scaffoldActive });
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

      // 復元→再clamp で空になった場合も candidate を返す（seedへ落とさない）
      if (!retryCandidate || !retryCandidate.trim()) {
        console.warn('[IROS/FLAGSHIP][RETRY_EMPTY_AFTER_RESTORE_CLAMP]', {
          traceId: debug.traceId,
          conversationId: debug.conversationId,
          userCode: debug.userCode,
        });
        return adoptAsSlots(candidate, 'FLAGSHIP_RETRY_EMPTY_AFTER_RESTORE_USE_CANDIDATE', { scaffoldActive });
      }
    }
  }

// verdict（retry）
const vRetry = runFlagship(retryCandidate, slotsForGuard, scaffoldActive);

console.log('[IROS/FLAGSHIP][RETRY_VERDICT]', {
  traceId: debug.traceId,
  conversationId: debug.conversationId,
  userCode: debug.userCode,
  level: vRetry?.level,
  reasons: vRetry?.reasons,
  head: safeHead(retryCandidate, 160),
});

// OKなら採用
if (vRetry?.ok) return adoptAsSlots(retryCandidate, 'FLAGSHIP_RETRY_OK', { scaffoldActive });

// retryでもWARN薄逃げ → seed
if (
  vRetry &&
  String(vRetry.level ?? '').toUpperCase() === 'WARN' &&
  shouldRejectWarnToSeed(vRetry) &&
  seedFromSlots
) {
  return adoptAsSlots(seedFromSlots, 'FLAGSHIP_RETRY_WARN_TO_SEED', { scaffoldActive });
}

// ✅ ここが肝：retryでFATALなら “必ず seed優先” に戻す（薄い局面を安定させる）
if (seedFromSlots) return adoptAsSlots(seedFromSlots, 'FLAGSHIP_RETRY_FATAL_TO_SEED', { scaffoldActive });

// seedが無い時だけ候補を返す
return adoptAsSlots(candidate, 'FLAGSHIP_RETRY_FATAL_USE_CANDIDATE', { scaffoldActive });


  // ✅ retryでも WARN/FATAL で seed に戻さない（LLMは落とさない）
  // - meta に「FATAL採用」を残して追跡できるようにする
  return adoptAsSlots(retryCandidate, 'FLAGSHIP_RETRY_FATAL_ACCEPT', {
    scaffoldActive,
    flagshipFatal: true,
    flagshipLevel: vRetry?.level ?? 'FATAL',
    flagshipReasons: Array.isArray(vRetry?.reasons) ? vRetry.reasons : [],
  });
}
