// src/lib/iros/language/rephraseEngine.ts
// ✅ 追加/変更点：
// - userContext を unknown で受け、JSONでも安全に文字列化
// - opts.debug に traceId / conversationId / userCode を受けて、監査ログに載せる
// - [IROS/rephraseEngine][OK] と [IROS/rephraseEngine][AFTER_ATTACH] をここで確実に出す
// ✅ 追加：
// - userContext から "履歴っぽいもの" を自動抽出して LLM に注入（露出禁止）
//   → LLM が「履歴を感じない」問題の最短改善

import { chatComplete } from '../../llm/chatComplete';

type Slot = { key: string; text: string };

type ExtractedSlots = {
  slots: Slot[];
  keys: string[];
  source: string;
} | null;

function norm(s: unknown) {
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
}

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

  if (!slotsRaw) return null;

  const out: Slot[] = [];

  if (Array.isArray(slotsRaw)) {
    for (const s of slotsRaw) {
      const key = String(s?.key ?? s?.id ?? s?.slotId ?? s?.name ?? '').trim();
      const text = norm(s?.text ?? s?.value ?? s?.content ?? s?.message ?? s?.out ?? '');
      if (!key || !text) continue;
      out.push({ key, text });
    }
  } else if (typeof slotsRaw === 'object') {
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

export type RephraseOptions = {
  model: string;
  temperature?: number;
  maxLinesHint?: number;

  /** 直前ユーザー入力（推奨） */
  userText?: string | null;

  /**
   * 3軸メタ/状態など（unknown で受ける）
   * - LLMには見せるが、本文に露出させない（ルールで禁止）
   */
  userContext?: unknown | null;

  /** ✅ ログ用（chatComplete の trace に渡す） */
  debug?: {
    traceId?: string | null;
    conversationId?: string | null;
    userCode?: string | null;
    renderEngine?: boolean | null; // 必要なら残す
  } | null;
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

function envFlagEnabled(raw: unknown, defaultEnabled: boolean) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return defaultEnabled;
  if (['0', 'false', 'off', 'no', 'disabled'].includes(v)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(v)) return true;
  return defaultEnabled;
}

function clampLines(text: string, maxLines: number): string {
  const t = norm(text);
  if (!t) return '';
  const lines = t
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(0, Math.max(1, maxLines - 1)).join('\n') + '\n🪔';
}

function clampChars(text: string, maxChars: number): string {
  const t = norm(text);
  if (!t) return '';
  if (t.length <= maxChars) return t;
  return t.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function tryGet(obj: any, path: string[]): any {
  let cur = obj;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * userContext から "履歴っぽいもの" を自動抽出して、LLM投入用のテキストに整形する。
 * - 露出禁止（LLMの内部制約としてのみ使う）
 * - 形式は "U: / A:" のみ（雑にでも可）
 */
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

  const mapped = raw
    .filter(Boolean)
    .slice(-12)
    .map((m: any) => {
      const roleRaw = String(m?.role ?? '').toLowerCase();
      const body = norm(m?.content ?? m?.text ?? '');
      if (!body) return null;
      return {
        role: roleRaw.startsWith('a') ? ('assistant' as const) : ('user' as const),
        content: body,
      };
    });

  return mapped.filter(
    (x): x is { role: 'user' | 'assistant'; content: string } => x !== null,
  );

}

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

function systemPromptForFullReply(): string {
  return [
    'あなたは iros の会話生成（reply）担当です。',
    '',
    '【目的】',
    'ユーザーと “普通に会話する”。ChatGPT のように自然につなぐ。',
    '',
    '【制約（必須）】',
    '1) 入力に含まれるメタ（phase/depth/q 等）は “内部制約” として尊重するが、本文にJSON/キー名/ラベルを露出しない。',
    '2) 次のテンプレ口癖は禁止：',
    '   - 「受け取った」「いま出ている言葉」「いまの一番大事な一点」「一手に落とす」「迷いを増やさない」「呼吸を戻す」「ここで止める」「核」「切る」',
    '3) 二択誘導（A/Bで選ばせる）をしない。',
    '4) 質問は最大1つ（本当に必要なときだけ）。',
    '5) 4〜10行程度。最後は必ず「🪔」で閉じる。',
    '6) 断定診断・過剰な助言は避け、ユーザーが話しやすい“つなぎ”を優先。',
    '',
    '【出力】',
    '日本語の会話文のみ。箇条書き/JSON/コード/見出しは出さない。',
  ].join('\n');
}

function safeHead(s: string, n = 80) {
  const t = String(s ?? '');
  return t.length <= n ? t : t.slice(0, n);
}

function safeContextToText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return norm(v);
  try {
    return JSON.stringify(v);
  } catch {
    return norm(String(v));
  }
}

function logRephraseOk(
  debug: RephraseOptions['debug'],
  outKeys: string[],
  raw: string,
  mode?: string,
) {
  if (!debug?.conversationId || !debug?.userCode) return;
  console.log('[IROS/rephraseEngine][OK]', {
    traceId: debug?.traceId ?? null,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    mode: mode ?? null,
    keys: outKeys,
    rawLen: raw.length,
    rawHead: safeHead(raw, 120),
  });
}

function logRephraseAfterAttach(
  debug: RephraseOptions['debug'],
  outKeys: string[],
  firstText: string,
  mode?: string,
) {
  if (!debug?.conversationId || !debug?.userCode) return;
  console.log('[IROS/rephraseEngine][AFTER_ATTACH]', {
    traceId: debug?.traceId ?? null,
    conversationId: debug.conversationId,
    userCode: debug.userCode,
    mode: mode ?? null,
    renderEngine: debug?.renderEngine ?? true,
    rephraseBlocksLen: outKeys.length,
    rephraseHead: safeHead(firstText, 120),
  });
}

/**
 * ✅ FINAL用：slotを保ったまま “会話本文” を作る
 */
export async function rephraseSlotsFinal(
  extracted: ExtractedSlots,
  opts: RephraseOptions,
): Promise<RephraseResult> {
  if (!extracted) {
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
    return {
      ok: false,
      reason: 'REPHRASE_DISABLED_BY_ENV',
      meta: { inKeys: extracted.keys, rawLen: 0, rawHead: '' },
    };
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
    const out: Slot[] = inKeys.map((k, i) => ({
      key: k,
      text: fixedTexts[i] ?? 'ここで止める。',
    }));

    // ✅ ログ（FIXEDでも出す）
    logRephraseOk(opts.debug, out.map((x) => x.key), out[0]?.text ?? '', 'FIXED');
    logRephraseAfterAttach(opts.debug, out.map((x) => x.key), out[0]?.text ?? '', 'FIXED');

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
  const userText = norm(opts.userText ?? '');
  const metaText = safeContextToText(opts.userContext ?? null);
  const historyText = extractHistoryTextFromContext(opts.userContext ?? null);
  const seedDraft = extracted.slots.map((s) => s.text).filter(Boolean).join('\n');

  const historyMsgs = extractHistoryMessagesFromContext(opts.userContext ?? null);

  const messages = [
    { role: 'system' as const, content: systemPromptForFullReply() },

    // ★ ここが本命：LLMに「会話」として渡る履歴
    ...historyMsgs,

    {
      role: 'user' as const,
      content: [
        '【ユーザー入力】',
        userText || '(空)',
        '',
        '【内部メタ（露出禁止）】',
        metaText || '(なし)',
        '',
        '【下書きヒント（slot由来・露出禁止）】',
        seedDraft || '(なし)',
        '',
        'この条件で、自然な会話文を生成して。',
      ].join('\n'),
    },
  ];

  console.log('[IROS/rephraseEngine][MSG_PACK]', {
    historyMsgs: historyMsgs.length,
    msgCount: messages.length,
    roles: messages.map((m) => m.role),
  });



  let raw = '';
  try {
    const traceId = opts.debug?.traceId ?? null;
    const conversationId = opts.debug?.conversationId ?? null;
    const userCode = opts.debug?.userCode ?? null;

    // ✅ chatComplete の型が追いついてなくても止まらないように any で渡す
    raw = await chatComplete({
      purpose: 'reply',
      model: opts.model,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.6,
      max_tokens: 700,
      messages,

      // --- pass-through fields (ログ埋め) ---
      traceId,
      conversationId,
      userCode,

      // --- optional compat payloads (chatComplete 側が拾えるなら拾う) ---
      trace: { traceId, conversationId, userCode },
      audit: { slotPlanPolicy: 'FINAL' },
    } as any);
  } catch (e: any) {
    console.error('[IROS/REPHRASE_FINAL][LLM] failed', { message: String(e?.message ?? e) });
    return {
      ok: false,
      reason: 'LLM_CALL_FAILED',
      meta: { inKeys, rawLen: 0, rawHead: '' },
    };
  }

  // ✅ raw段階ログ（keysはslotPlan由来を明示）
  logRephraseOk(opts.debug, extracted.keys, raw);

  const cleaned = clampLines(raw, maxLines);
  if (!cleaned) {
    return {
      ok: false,
      reason: 'LLM_EMPTY',
      meta: { inKeys, rawLen: 0, rawHead: '' },
    };
  }

  const outSlots = buildSlotsWithFirstText(inKeys, cleaned);

  // ✅ slotへ載せた後ログ
  logRephraseAfterAttach(opts.debug, inKeys, outSlots[0]?.text ?? '');

  return {
    ok: true,
    slots: outSlots,
    meta: {
      inKeys,
      outKeys: outSlots.map((x) => x.key),
      rawLen: raw.length,
      rawHead: raw.slice(0, 80),
    },
  };
}

/**
 * ✅ 絶対ルール（幻覚/捏造 防止）
 * - 入力に存在しない「過去の出来事」「前に言ってた」等を作らない
 * - 「覚えてる」「前に話したよね」等の“記憶断言”は禁止
 *   ただし、下書きヒント（slot由来）に明示で含まれている場合のみ言い換え可
 * - ユーザーが「覚えてる？」と聞いた場合は、事実の断言ではなく
 *   「いま出ている話題は◯◯だね」程度の現在要約で返す
 * - 目的は“会話を自然にする”であり、ストーリー補完ではない
 */
