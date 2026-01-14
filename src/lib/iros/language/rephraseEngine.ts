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

import crypto from 'node:crypto';
import { chatComplete } from '../../llm/chatComplete';

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
// 🪔 normalization (renderGateway unification)
// -------------------------------
function stripLampEverywhere(text: string): string {
  let t = String(text ?? '');

  // 単独行の🪔を削除
  t = t.replace(/^\s*🪔\s*$(\r?\n)?/gm, '');

  // 行末・末尾に付いた🪔を削除
  t = t.replace(/[ \t]*🪔[ \t]*$/gm, '');

  // "\n🪔\n" 形式を削除
  t = t.replace(/\n[ \t]*🪔[ \t]*(\n|$)/g, '\n');

  // ✅ “。”だけが残る事故（例：\n。\n🪔）の単独行を削除
  t = t.replace(/^\s*[。．\.]\s*$(\r?\n)?/gm, '');

  // 空行を整理
  t = t.replace(/\n{3,}/g, '\n\n').trimEnd();

  return t;
}

// renderEngine=true のときは🪔を絶対に出さない
// renderEngine=false のときだけ互換のため末尾🪔を1回だけ付ける（この関数内で完結させる）
function finalizeLamp(text: string, renderEngine: boolean): string {
  const base = stripLampEverywhere(text);

  if (renderEngine) return base;

  const t = String(base ?? '').replace(/\r\n/g, '\n').trim();
  if (!t) return '🪔';

  // 末尾の🪔は1回に正規化
  const stripped = t.replace(/\n?🪔\s*$/u, '').trimEnd();
  return stripped + '\n🪔';
}

// -------------------------------
// history extraction (for LLM only / non-exposed)
// -------------------------------
function extractHistoryTextFromContext(userContext: unknown): string {
  if (!userContext || typeof userContext !== 'object') return '';
  const uc: any = userContext as any;

  const candidates = [
    tryGet(uc, ['historyText']),
    tryGet(uc, ['history_text']),
    tryGet(uc, ['history']),
    tryGet(uc, ['messages']),
    tryGet(uc, ['historyMessages']),
    tryGet(uc, ['historyX']),
    tryGet(uc, ['ctxPack', 'history']),
    tryGet(uc, ['ctx_pack', 'history']),
    tryGet(uc, ['contextPack', 'history']),
  ];

  const raw = candidates.find((x) => x != null);
  if (!raw) return '';

  if (typeof raw === 'string') return clampChars(raw, 1800);

  if (Array.isArray(raw)) {
    const items = raw
      .filter(Boolean)
      .slice(-12)
      .map((m: any) => {
        const role = String(m?.role ?? m?.speaker ?? m?.type ?? '').toLowerCase();
        const body = norm(m?.text ?? m?.content ?? m?.message ?? '');
        if (!body) return '';
        const tag = role.startsWith('a') ? 'A' : role.startsWith('u') ? 'U' : 'M';
        return `${tag}: ${body}`;
      })
      .filter(Boolean);

    return clampChars(items.join('\n'), 1800);
  }

  try {
    return clampChars(JSON.stringify(raw), 1800);
  } catch {
    return clampChars(String(raw), 1800);
  }
}

function extractHistoryMessagesFromContext(
  userContext: unknown,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!userContext || typeof userContext !== 'object') return [];
  const uc: any = userContext as any;

  const raw =
    tryGet(uc, ['historyMessages']) ??
    tryGet(uc, ['history_messages']) ??
    tryGet(uc, ['messages']) ??
    tryGet(uc, ['history']) ??
    null;

  if (!Array.isArray(raw)) return [];

  // ---- helpers ----
  const pickIn = (m: any) =>
    norm(
      m?.in_text ??
        m?.inText ??
        m?.in_head ??
        m?.inHead ??
        m?.in ??
        m?.userText ??
        m?.user_text ??
        '',
    );

  const pickOut = (m: any) =>
    norm(
      m?.out_text ??
        m?.outText ??
        m?.out_head ??
        m?.outHead ??
        m?.out ??
        m?.assistantText ??
        m?.assistant_text ??
        m?.assistant ??
        '',
    );

  const pickGeneric = (m: any) => norm(m?.content ?? m?.text ?? m?.message ?? '');

  const isSystemish = (m: any) => {
    const roleRaw = norm(m?.role ?? m?.speaker ?? m?.type ?? '').toLowerCase();
    const fromRaw = norm(m?.from ?? m?.author ?? m?.kind ?? '').toLowerCase();
    return roleRaw === 'system' || fromRaw === 'system';
  };

  const inferIsAssistant = (m: any, hasOutLike: boolean, hasInLike: boolean) => {
    const roleRaw = norm(m?.role ?? m?.speaker ?? m?.type ?? '').toLowerCase();
    const agentRaw = norm(m?.agent ?? m?.provider ?? m?.source ?? '').toLowerCase();
    const fromRaw = norm(m?.from ?? m?.author ?? m?.kind ?? '').toLowerCase();

    const isIrosAgent = agentRaw === 'iros' || agentRaw.includes('iros');

    const isAssistantByRole =
      roleRaw === 'assistant' ||
      roleRaw === 'bot' ||
      roleRaw === 'ai' ||
      roleRaw === 'iros' ||
      roleRaw.startsWith('assistant') ||
      roleRaw === 'a';

    const isAssistantByFrom =
      fromRaw === 'assistant' ||
      fromRaw === 'bot' ||
      fromRaw === 'ai' ||
      fromRaw === 'iros' ||
      fromRaw.startsWith('assistant') ||
      fromRaw === 'a';

    const isAssistantByAgent =
      isIrosAgent || agentRaw === 'assistant' || agentRaw === 'bot' || agentRaw === 'ai';

    if (isAssistantByRole || isAssistantByFrom || isAssistantByAgent) return true;

    // role/agentが空なら、in/out の形で推定
    if (!roleRaw && !fromRaw && !agentRaw) {
      if (hasOutLike && !hasInLike) return true;
      if (!hasOutLike && hasInLike) return false;
      if (hasOutLike && hasInLike) return true;
    }

    return false;
  };

  const out = raw
    .filter(Boolean)
    .flatMap((m: any) => {
      // system レコードは丸ごと捨てる（履歴汚染防止）
      if (isSystemish(m)) return [];

      const hasOutLike =
        m?.out_text != null ||
        m?.outText != null ||
        m?.out_head != null ||
        m?.outHead != null ||
        m?.out != null ||
        m?.assistantText != null ||
        m?.assistant_text != null ||
        m?.assistant != null;

      const hasInLike =
        m?.in_text != null ||
        m?.inText != null ||
        m?.in_head != null ||
        m?.inHead != null ||
        m?.in != null ||
        m?.userText != null ||
        m?.user_text != null;

      // ✅ in/out 同居レコードは 2件に分割（ここで generic を混ぜない）
      if (hasInLike && hasOutLike) {
        const inBody = pickIn(m);
        const outBody = pickOut(m);

        const res: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        if (inBody) res.push({ role: 'user', content: inBody });
        if (outBody) res.push({ role: 'assistant', content: outBody });
        return res;
      }

      // 片側しか無い場合は、推定して拾う
      const isAssistant = inferIsAssistant(m, hasOutLike, hasInLike);

      const body = isAssistant
        ? pickOut(m) || (!hasOutLike ? pickGeneric(m) : '')
        : pickIn(m) || (!hasInLike ? pickGeneric(m) : '');

      if (!body) return [];
      return [{ role: isAssistant ? ('assistant' as const) : ('user' as const), content: body }];
    });

  return out.filter((x) => !!x?.content);
}

function pickArray(v: any): any[] | null {
  return Array.isArray(v) ? v : null;
}

/**
 * ✅ 直近2往復（最大4メッセージ）を抽出（固定）
 * - turns/chat があれば優先
 * - 無ければ historyMessages/messages から組み立てる
 */
function extractLastTurnsFromContext(
  userContext: unknown,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!userContext || typeof userContext !== 'object') return [];
  const ctx: any = userContext as any;

  const rawTurns =
    pickArray(ctx?.turns) ||
    pickArray(ctx?.chat) ||
    pickArray(ctx?.ctxPack?.turns) ||
    pickArray(ctx?.ctxPack?.chat) ||
    pickArray(ctx?.ctx_pack?.turns) ||
    pickArray(ctx?.ctx_pack?.chat) ||
    null;

  const normalizeTurnsArray = (
    raw: any[],
  ): Array<{ role: 'user' | 'assistant'; content: string }> => {
    return raw
      .map((m) => {
        const roleRaw = String(m?.role ?? m?.r ?? '').trim().toLowerCase();
        const role =
          roleRaw === 'assistant' || roleRaw === 'a'
            ? ('assistant' as const)
            : roleRaw === 'user' || roleRaw === 'u'
              ? ('user' as const)
              : null;

        const content = norm(m?.content ?? m?.text ?? m?.message ?? '');
        if (!role || !content) return null;
        return { role, content };
      })
      .filter(Boolean) as Array<{ role: 'user' | 'assistant'; content: string }>;
  };

  let normalized: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  if (rawTurns) normalized = normalizeTurnsArray(rawTurns);
  if (normalized.length === 0) normalized = extractHistoryMessagesFromContext(ctx);
  if (normalized.length === 0) return [];

  // ✅ 末尾から最大4つ（直近2往復）固定
  let tail = normalized.slice(Math.max(0, normalized.length - 4));

  const hasAssistant = tail.some((m) => m.role === 'assistant');
  const hasUser = tail.some((m) => m.role === 'user');

  // user-only / assistant-only を避ける（保険：最後6件まで）
  if (!(hasAssistant && hasUser)) {
    tail = normalized.slice(Math.max(0, normalized.length - 6));
  }

  // 1メッセージ爆長の事故を避ける（writerが迷うのを防ぐ）
  tail = tail.map((m) => ({ ...m, content: clampChars(m.content, 600) }));

  return tail;
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

function buildSlotsWithFirstText(inKeys: string[], firstText: string): Slot[] {
  const ZWSP = '\u200b';
  if (inKeys.length === 0) return [];
  const out: Slot[] = [{ key: inKeys[0], text: firstText }];
  for (let i = 1; i < inKeys.length; i++) out.push({ key: inKeys[i], text: ZWSP });
  return out;
}

// -------------------------------
// ✅ IT成立（条件が揃った証拠）を userContext から読む
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

  if (reason.includes('IT_TRIGGER_OK')) return true;
  if (reason.includes('IT_HOLD')) return true;
  if (tLayerModeActive) return true;

  return false;
}

// -------------------------------
// ✅ intentBand / tLayerHint を userContext から抽出（Iは成立後のみ使う）
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
        '',
    ) || null;

  const tLayerHint =
    norm(
      tryGet(uc, ['tLayerHint']) ??
        tryGet(uc, ['t_layer_hint']) ??
        tryGet(uc, ['ctxPack', 'tLayerHint']) ??
        tryGet(uc, ['ctxPack', 't_layer_hint']) ??
        tryGet(uc, ['ctx_pack', 'tLayerHint']) ??
        tryGet(uc, ['ctx_pack', 't_layer_hint']) ??
        '',
    ) || null;

  const bandOk = intentBand && /^[SRICT][123]$/u.test(intentBand) ? intentBand : null;
  const hintOk = tLayerHint && /^[SRICT][123]$/u.test(tLayerHint) ? tLayerHint : null;

  return { intentBand: bandOk, tLayerHint: hintOk };
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
// ✅ I-LINE ロック（改変禁止）サポート
// -------------------------------
const ILINE_OPEN = '[[ILINE]]';
const ILINE_CLOSE = '[[/ILINE]]';

function extractLockedILines(text: string): { locked: string[]; cleanedForModel: string } {
  const locked: string[] = [];
  let cleaned = String(text ?? '');

  const re = new RegExp(
    ILINE_OPEN.replace(/[[\]]/g, '\\$&') + '([\\s\\S]*?)' + ILINE_CLOSE.replace(/[[\]]/g, '\\$&'),
    'g',
  );

  cleaned = cleaned.replace(re, (_m, p1) => {
    const exact = String(p1 ?? '').replace(/\r\n/g, '\n');
    if (exact.trim().length > 0) locked.push(exact);
    // モデルには “中身だけ” を見せる（マーカーは露出禁止）
    return exact;
  });

  return { locked, cleanedForModel: cleaned.replace(/\r\n/g, '\n') };
}

function verifyLockedILinesPreserved(output: string, locked: string[]): boolean {
  if (!locked.length) return true;

  // マーカー混入は即アウト（露出禁止）
  if (output.includes(ILINE_OPEN) || output.includes(ILINE_CLOSE)) return false;

  const out = String(output ?? '').replace(/\r\n/g, '\n');
  return locked.every((s) => out.includes(String(s ?? '').replace(/\r\n/g, '\n')));
}

function buildLockRuleText(locked: string[]): string {
  if (!locked.length) return '';
  return [
    '',
    '【改変禁止行（最重要）】',
    '次の各行は、一字一句そのまま本文に含めてください（句読点・助詞・改行も維持）。',
    'ただし制御マーカー（[[ILINE]] など）は出力に絶対に含めないでください。',
    '改変禁止行：',
    ...locked.map((s, i) => `- (${i + 1}) ${s}`),
    '',
  ].join('\n');
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

  // ✅ directTask は「完成（解決）」ではなく「送れる文面（主権の余白あり）」を作る
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

  return base + bandInfo + directTaskRule + lockRule + iStyleRule;
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

function containsForbiddenLeakText(output: string): boolean {
  const t = String(output ?? '');
  // 露出禁止：制御マーカー / internal pack ラベル
  if (t.includes(ILINE_OPEN) || t.includes(ILINE_CLOSE)) return true;
  if (/INTERNAL PACK\s*\(DO NOT OUTPUT\)/i.test(t)) return true;
  if (/META\s*\(DO NOT OUTPUT\)/i.test(t)) return true;
  if (/HISTORY_HINT\s*\(DO NOT OUTPUT\)/i.test(t)) return true;
  if (/SEED_DRAFT_HINT\s*\(DO NOT OUTPUT\)/i.test(t)) return true;
  return false;
}

// -------------------------------
// Recall-check hard guard (Phase11)
// -------------------------------
function normLite(s: any): string {
  return String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function extractJsonTail(line: string): any | null {
  const t = normLite(line);
  const m = t.match(/^\s*@\w+\s+(\{[\s\S]*\})\s*$/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function shouldEnforceRecallGuard(slotKeys: string[]): boolean {
  const set = new Set(slotKeys.map((k) => String(k).toUpperCase()));
  // recall-check は RESTORE + Q が揃ってるときにだけ強制（他の通常会話には影響させない）
  return set.has('RESTORE') && set.has('Q');
}

function getRecallMustHaveFromSlots(
  slots: Array<{ key: string; text?: string; content?: string; value?: string }> | null,
): { restoreNeedle: string | null; questionNeedle: string | null } {
  if (!Array.isArray(slots) || slots.length === 0) return { restoreNeedle: null, questionNeedle: null };

  const byKey = (k: string) =>
    slots.find((s) => String((s as any)?.key ?? '').toUpperCase() === k.toUpperCase()) ?? null;

  const restore = byKey('RESTORE');
  const q = byKey('Q');

  const restoreText = normLite(
    (restore as any)?.text ?? (restore as any)?.content ?? (restore as any)?.value ?? '',
  );
  const qText = normLite((q as any)?.text ?? (q as any)?.content ?? (q as any)?.value ?? '');

  // RESTORE: JSONが取れれば last / summary 系を優先
  const rj = extractJsonTail(restoreText);
  const restoreNeedleRaw =
    normLite(rj?.last ?? rj?.summary ?? rj?.head ?? rj?.topic ?? '') ||
    normLite(restoreText.replace(/^@RESTORE\s*/i, ''));

  // Q: JSONが取れれば ask を優先
  const qj = extractJsonTail(qText);
  const questionNeedleRaw =
    normLite(qj?.ask ?? qj?.q ?? qj?.question ?? '') || normLite(qText.replace(/^@Q\s*/i, ''));

  // needle が短すぎると誤判定するので最低長を持たせる
  // ✅ ただし “取れない” 場合に備えて、先頭40字フォールバックを入れておく
  const restoreNeedle =
    restoreNeedleRaw && restoreNeedleRaw.length >= 4
      ? restoreNeedleRaw
      : restoreText
        ? restoreText.slice(0, 40)
        : null;

  const questionNeedle =
    questionNeedleRaw && questionNeedleRaw.length >= 4
      ? questionNeedleRaw
      : qText
        ? qText.slice(0, 40)
        : null;

  // それでも短いならガードを弱める（事故で全部捨てるのを防ぐ）
  const rn = restoreNeedle && restoreNeedle.length >= 4 ? restoreNeedle : null;
  const qn = questionNeedle && questionNeedle.length >= 4 ? questionNeedle : null;

  return { restoreNeedle: rn, questionNeedle: qn };
}

function recallGuardOk(args: {
  slotKeys: string[];
  slotsForGuard: Array<{ key: string; text?: string; content?: string; value?: string }> | null;
  llmOut: string;
}): { ok: boolean; missing: string[]; needles: { restore: string | null; q: string | null } } {
  const out = normLite(args.llmOut);
  if (!out) return { ok: false, missing: ['OUT_EMPTY'], needles: { restore: null, q: null } };

  if (!shouldEnforceRecallGuard(args.slotKeys)) {
    return { ok: true, missing: [], needles: { restore: null, q: null } };
  }

  const { restoreNeedle, questionNeedle } = getRecallMustHaveFromSlots(args.slotsForGuard);

  // ✅ 「質問が入っているか」の緩い判定（現状維持）
  // - FLAG_TRUE_QUESTION_* による “問い” は、? が無い場合もあるので
  //   ここでは疑問語も含めて拾う（needle の完全一致は下で別途見る）
  const hasQuestion = (() => {
    if (/[？?]/.test(out)) return true;
    if (/(どの|どれ|どっち|どこ|いつ|だれ|誰|なぜ|なんで|どうして|どう|何|どんな)/.test(out)) {
      return true;
    }
    return false;
  })();

  // ✅ RESTORE の“起きてる”判定を、完全一致→部分一致/短縮一致/トークン一致に緩める
  const hasRestore = (() => {
    if (!restoreNeedle) return true; // needle が取れないならガードしない

    const needle = normLite(restoreNeedle);
    if (!needle) return true;

    // 1) そのまま含まれていればOK
    if (out.includes(needle)) return true;

    // 2) 長い needle は先頭だけでも一致すればOK（言い換え事故を吸収）
    const short = needle.length >= 10 ? needle.slice(0, 10) : needle;
    if (short.length >= 6 && out.includes(short)) return true;

    // 3) 「」の中身があれば、それで一致判定
    const m = needle.match(/「([^」]{4,})」/);
    if (m?.[1]) {
      const inner = normLite(m[1]);
      if (inner.length >= 4 && out.includes(inner)) return true;
    }

    // 4) トークン一致（日本語でも壊れにくい最小実装）
    //    - 2文字以上の断片を拾って、2個以上が本文に含まれれば「復元できてる」とみなす
    const tokens = needle
      .replace(/[。、・,.\(\)\[\]\{\}「」『』"'\s]+/g, ' ')
      .split(' ')
      .map((x) => x.trim())
      .filter((x) => x.length >= 2)
      .slice(0, 8);

    if (tokens.length === 0) return true;

    let hit = 0;
    for (const t of tokens) {
      if (out.includes(t)) hit++;
      if (hit >= 2) return true;
    }

    return false;
  })();

  const missing: string[] = [];

  // RESTORE: “復元が起きてるか” を見る（完全一致は要求しない）
  if (!hasRestore) missing.push('RESTORE');

  // Q:
  // - needle があるなら「含まれていれば最高」(完全一致)。
  // - ただし、言い換えで needle が崩れることがあるので、
  //   “質問の存在” があれば OK に倒す（全部破棄事故を防ぐ）
  if (questionNeedle) {
    const qNeedle = normLite(questionNeedle);
    const hasExactNeedle = qNeedle ? out.includes(qNeedle) : false;
    if (!hasExactNeedle && !hasQuestion) missing.push('Q');
  } else {
    if (!hasQuestion) missing.push('Q');
  }

  return {
    ok: missing.length === 0,
    missing,
    needles: { restore: restoreNeedle, q: questionNeedle },
  };
}
// ✅ writer guard (minimal)
// - DRAFT.output_only: bullets / extra commentary を拒否
// - questions_max: ? / ？ を数えて超過を拒否
// - NG のときは理由コードを返す（ログ用）

type WriterGuardRules = {
  output_only?: boolean;
  questions_max?: number;
  no_bullets?: boolean; // DRAFT.rules.no_bullets を尊重
};

export function checkWriterGuardsMinimal(args: {
  text: string;
  rules?: WriterGuardRules | null;
}): { ok: true } | { ok: false; reason: string; detail?: any } {
  const text = String(args.text ?? '');
  const rules = args.rules ?? null;

  if (!text.trim()) return { ok: false, reason: 'WG:OUT_EMPTY' };

  const outputOnly = !!rules?.output_only;
  const noBullets = rules?.no_bullets !== false; // デフォ true 扱い
  const qMax = typeof rules?.questions_max === 'number' ? rules?.questions_max : null;

  // 1) questions_max
  if (qMax != null) {
    const qCount = (text.match(/[?？]/g) ?? []).length;
    if (qCount > qMax) return { ok: false, reason: 'WG:Q_OVER', detail: { qCount, qMax } };
  }

  // 2) output_only
  // 「本文だけ」を要求しているのに、箇条書き・見出し・解説っぽい前置きが混ざる事故を止める
  if (outputOnly) {
    // bullets
    if (noBullets) {
      const hasBullets =
        /(^|\n)\s*[-*•●▪︎◦]\s+/.test(text) || /(^|\n)\s*\d+\.\s+/.test(text);
      if (hasBullets) return { ok: false, reason: 'WG:BULLETS' };
    }

    // “解説します/ポイント/以下/まとめ/結論から” などのメタ文章（強すぎない範囲で最小）
    const hasMeta =
      /解説|ポイント|まとめ|結論から|要約|箇条書き|チェックリスト|手順|まずは|次に|以下/.test(text);

    // output_only でも「短い導入1行」までは許容したいが、
    // 2行以上のメタ構造になっている場合だけ落とす（最小）
    if (hasMeta) {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const metaLines = lines.filter((l) => /解説|ポイント|まとめ|結論から|要約|以下/.test(l));
      if (metaLines.length >= 1 && lines.length >= 5) {
        return { ok: false, reason: 'WG:OUTPUT_ONLY_META', detail: { metaLines: metaLines.slice(0, 2) } };
      }
    }
  }

  return { ok: true };
}

// ---------------------------------------------
// leak safety
// ---------------------------------------------
function extractDirectTask(userText: string, inputKind: string | null): boolean {
  // ✅ 「まとめて/要約/整理して」も “直接タスク” として扱う（要約吸い込みを防ぐ）
  const isDirectTaskByPhrase =
    /(本文だけ|文面|短文|そのまま使える|作って|出して|まとめて|要約|要約して|整理して|箇条書き|要点|ポイント|結論)/.test(
      userText,
    );

  const isHowtoLike =
    /(教えて|教えてください|アドバイス|具体的|提案|やり方|方法|手順|どうやって|どうしたら|進め方|コツ|秘技|tips|howto|おすすめ|選び方|例を|例:|サンプル)/i.test(
      userText,
    );

  const isDirectTaskByKind =
    inputKind === 'howto' || inputKind === 'task' || inputKind === 'request' || inputKind === 'qa';

  return Boolean(isDirectTaskByPhrase || isDirectTaskByKind || isHowtoLike);
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

  // ✅ ILINE抽出（slot由来に含まれるのが主ルート）
  const { locked: lockedILines, cleanedForModel: seedDraft } = extractLockedILines(seedDraftRaw);

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
      content: systemPromptForFullReply({
        directTask: isDirectTask,
        itOk,
        band,
        lockedILines,
      }),
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
    lastTurns: lastTurns.length,
    hasHistoryText: Boolean(historyText),
    msgCount: messages.length,
    roles: messages.map((m) => m.role),
    itOk,
    intentBand: band.intentBand,
    tLayerHint: band.tLayerHint,
    directTask: isDirectTask,
    inputKind,
    inputKindFromMeta,
    inputKindFromCtx,
    lockedILines: lockedILines.length,
  });

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

  // ✅ raw段階ログ（keysはslotPlan由来を明示）
  logRephraseOk(debug, extracted.keys, raw, 'LLM');

  // ✅ 出力に internal pack ラベル等が混入した場合は破棄（露出禁止）
  if (containsForbiddenLeakText(raw)) {
    logRephraseOk(debug, extracted.keys, raw, 'INTERNAL_MARKER_LEAKED');
    return {
      ok: false,
      reason: 'INTERNAL_MARKER_LEAKED',
      meta: {
        inKeys,
        rawLen: String(raw ?? '').length,
        rawHead: safeHead(String(raw ?? ''), 80),
      },
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
      meta: {
        inKeys,
        rawLen: String(raw ?? '').length,
        rawHead: safeHead(String(raw ?? ''), 80),
      },
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
        outHead: normLite(raw).slice(0, 120),
      });

      return {
        ok: false,
        reason: 'RECALL_GUARD_REJECT',
        meta: {
          inKeys,
          rawLen: String(raw ?? '').length,
          rawHead: safeHead(String(raw ?? ''), 80),
        },
      };
    }
  }

  // ================================
  // ✅ writer guard (minimal)
  // ================================
  {
    const rules: WriterGuardRules = isDirectTask
      ? { output_only: true, no_bullets: true, questions_max: 1 }
      : { output_only: false, no_bullets: true, questions_max: 1 };

    const wg = checkWriterGuardsMinimal({ text: raw, rules });

    console.log('[IROS/REPHRASE][WRITER_GUARD]', {
      traceId: debug.traceId,
      conversationId: debug.conversationId,
      userCode: debug.userCode,
      ok: wg.ok,
      reason: (wg as any).reason ?? null,
      detail: (wg as any).detail ?? null,
      directTask: isDirectTask,
    });

    if (!wg.ok) {
      console.warn('[IROS/REPHRASE][WRITER_GUARD_REJECT]', {
        traceId: debug.traceId,
        conversationId: debug.conversationId,
        userCode: debug.userCode,
        reason: (wg as any).reason,
        detail: (wg as any).detail ?? null,
        outHead: normLite(raw).slice(0, 160),
      });

      return {
        ok: false,
        reason: 'WRITER_GUARD_REJECT',
        meta: {
          inKeys,
          rawLen: String(raw ?? '').length,
          rawHead: safeHead(String(raw ?? ''), 80),
        },
      };
    }
  }

  // ✅ 仕上げ：行数制限→🪔正規化
  const renderEngine = Boolean(debug.renderEngine ?? true);
  const cleaned = finalizeLamp(clampLines(raw, maxLines), renderEngine);

  if (!cleaned) {
    logRephraseOk(debug, extracted.keys, '', 'LLM_EMPTY');
    return {
      ok: false,
      reason: 'LLM_EMPTY',
      meta: { inKeys, rawLen: 0, rawHead: '' },
    };
  }

  // ✅ 出力にマーカー/内部ラベルが混入した場合は破棄（最終安全）
  if (containsForbiddenLeakText(cleaned)) {
    logRephraseOk(debug, extracted.keys, cleaned, 'FINAL_LEAKED');
    return {
      ok: false,
      reason: 'FINAL_LEAKED',
      meta: {
        inKeys,
        rawLen: cleaned.length,
        rawHead: safeHead(cleaned, 80),
      },
    };
  }

  const outSlots = buildSlotsWithFirstText(inKeys, cleaned);

  // ✅ slotへ載せた後ログ
  logRephraseAfterAttach(debug, inKeys, outSlots[0]?.text ?? '', 'LLM');

  return {
    ok: true,
    slots: outSlots,
    meta: {
      inKeys,
      outKeys: outSlots.map((x) => x.key),
      rawLen: String(raw ?? '').length,
      rawHead: safeHead(String(raw ?? ''), 80),
    },
  };
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
