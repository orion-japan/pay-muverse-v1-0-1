// src/lib/iros/language/rephraseEngine.ts
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
//   → 長い履歴（12件など）を入れると、逆に“流れ”が薄くなる/迷うことが多い
//
// ✅ ITは条件が揃ってから：
// - ここ（writer）は “判断” をしない
// - ただし userContext 側に「ITが成立した証拠（IT_TRIGGER_OK / tLayerModeActive 等）」があり、
//   かつ intentBand/tLayerHint が I* のときだけ「Iっぽい1文」を“表現ルールとして”許可する（露出禁止）
//
// ✅ 追加（今回の肝2：I-Line 改変禁止）
// - 入力に [[ILINE]]...[[/ILINE]] が含まれている場合、その中身は一字一句改変禁止
// - LLM出力にその固定文が完全一致で含まれない場合、rephrase を破棄（ok=false）
// - 制御マーカー自体は本文に絶対露出させない（混入したら破棄）

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
  return lines.slice(0, Math.max(1, maxLines)).join('\n');
}

function clampChars(text: string, maxChars: number): string {
  const t = norm(text);
  if (!t) return '';
  if (t.length <= maxChars) return t;
  return t.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function ensureLampEnd(text: string): string {
  const t = norm(text);
  if (!t) return '';
  // 末尾の🪔は1回に正規化
  const stripped = t.replace(/\n?🪔\s*$/u, '').trim();
  return stripped + '\n🪔';
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
    .map((m: any) => {
      // --- 本文候補（in/out 系も含めて広めに拾う）---
      const body = norm(
        m?.content ??
          m?.text ??
          m?.message ??
          m?.in_text ??
          m?.inText ??
          m?.in_head ??
          m?.inHead ??
          m?.out_text ??
          m?.outText ??
          m?.out_head ??
          m?.outHead ??
          m?.out ??
          m?.assistantText ??
          m?.assistant_text ??
          '',
      );
      if (!body) return null;

      // --- role 推定材料（role/agent/from/kind など）---
      const roleRaw = norm(m?.role ?? m?.speaker ?? m?.type ?? '').toLowerCase();
      const agentRaw = norm(m?.agent ?? m?.provider ?? m?.source ?? '').toLowerCase();
      const fromRaw = norm(m?.from ?? m?.author ?? m?.kind ?? '').toLowerCase();

      // --- “out系” があるなら assistant とみなす（role欠損の最頻パターン対策）---
      const hasOutLike =
        m?.out_text != null ||
        m?.outText != null ||
        m?.out_head != null ||
        m?.outHead != null ||
        m?.assistantText != null ||
        m?.assistant_text != null;

      // --- “in系” があるなら user とみなす（補助）---
      const hasInLike =
        m?.in_text != null ||
        m?.inText != null ||
        m?.in_head != null ||
        m?.inHead != null;

      const isAssistantByRole =
        roleRaw === 'assistant' ||
        roleRaw === 'bot' ||
        roleRaw === 'ai' ||
        roleRaw.startsWith('assistant') ||
        roleRaw === 'a';

      const isAssistantByFrom =
        fromRaw === 'assistant' ||
        fromRaw === 'bot' ||
        fromRaw === 'ai' ||
        fromRaw.startsWith('assistant') ||
        fromRaw === 'a';

      const isAssistantByAgent =
        agentRaw === 'iros' ||
        agentRaw === 'assistant' ||
        agentRaw === 'bot' ||
        agentRaw === 'ai';

      // ✅ 最終判定
      const isAssistant =
        isAssistantByRole ||
        isAssistantByFrom ||
        isAssistantByAgent ||
        // role等が無い場合は out/in で推定（out優先）
        (!roleRaw && !fromRaw && !agentRaw && (hasOutLike ? true : hasInLike ? false : false));

      return {
        role: isAssistant ? ('assistant' as const) : ('user' as const),
        content: body,
      };
    });

  return mapped.filter(
    (x): x is { role: 'user' | 'assistant'; content: string } => x !== null,
  );
}

function readIntEnv(name: string, fallback: number, min: number, max: number) {
  const raw = String(process.env[name] ?? '').trim();
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/**
 * ✅ 直近Nメッセージを抽出（デフォルト: 4 = 直近2往復）
 * - 明示キー lastUser / lastAssistant があればそれを優先
 * - 無ければ historyMessages から最後のN件
 *
 * ENV:
 * - IROS_REPHRASE_LAST_MSGS=4 (default) / 8 ...
 */
function extractLastTurnsFromContext(
  userContext: unknown,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const MAX_LAST_MSGS = readIntEnv('IROS_REPHRASE_LAST_MSGS', 4, 2, 8);

  if (!userContext || typeof userContext !== 'object') return [];
  const uc: any = userContext as any;

  // 1) 明示キー優先
  const lastUser =
    tryGet(uc, ['lastUser']) ??
    tryGet(uc, ['last_user']) ??
    tryGet(uc, ['ctxPack', 'lastUser']) ??
    tryGet(uc, ['ctx_pack', 'lastUser']) ??
    null;

  const lastAssistant =
    tryGet(uc, ['lastAssistant']) ??
    tryGet(uc, ['last_assistant']) ??
    tryGet(uc, ['ctxPack', 'lastAssistant']) ??
    tryGet(uc, ['ctx_pack', 'lastAssistant']) ??
    null;

  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const u = norm(lastUser);
  const a = norm(lastAssistant);
  if (u) out.push({ role: 'user', content: u });
  if (a) out.push({ role: 'assistant', content: a });

  if (out.length > 0) return out;

  // 2) historyMessages から抽出（最後のN件）
  const historyMsgs = extractHistoryMessagesFromContext(userContext);
  if (historyMsgs.length === 0) return [];

  return historyMsgs.slice(-MAX_LAST_MSGS);
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

// -------------------------------
// ✅ IT成立（条件が揃った証拠）を userContext から読む
// -------------------------------
function readItOkFromContext(userContext: unknown): boolean {
  if (!userContext || typeof userContext !== 'object') return false;
  const uc: any = userContext as any;

  // いろんな場所に混ざり得るので広めに探索
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

  // IT_TRIGGER_OK / IT_HOLD を “成立の証拠” として扱う（writer判断ではない）
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

function safeHead(s: string, n = 80) {
  const t = String(s ?? '');
  return t.length <= n ? t : t.slice(0, n);
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
// ✅ ログ（ここで確実に出す）
// -------------------------------
function logRephraseOk(
  debug: RephraseOptions['debug'],
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
  debug: RephraseOptions['debug'],
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

  // ✅ ITが成立していて、かつ I* 指定のときだけ “Iっぽい1文” を許可（強制はしない）
  const isIRequested = (b && b.startsWith('I')) || (h && h.startsWith('I'));
  const allowIStyle = itOk && isIRequested;

  const base = [
    'あなたは iros の会話生成（reply）担当です。',
    '',
    '【目的】',
    'ユーザーの内側ですでに起きていることを、',
    '解説せず・距離を取らず・本人の言葉より一段深い地点で言語化する。',
    '',
    '【最重要方針】',
    'あなたは「説明者」ではない。',
    'ユーザーの感情や状態を“説明・要約・評価”する返答は禁止。',
    '本人が薄々わかっているが、まだ言い切れていない一点を、',
    '事実として短く差し出す役割を担う。',
    '',
    '【制約（必須）】',
    '1) 入力に含まれるメタ（phase/depth/q 等）は内部制約としてのみ使い、本文にJSON/キー名/ラベルを露出しない。',
    '2) 次のテンプレ口癖は禁止：',
    '   - 「受け取った」「いま出ている言葉」「いまの一番大事な一点」「一手に落とす」「迷いを増やさない」「呼吸を戻す」「核」「切る」',
    '   - 「この流れだと」「この流れでは」「いまの流れだと」',
    '3) 二択誘導（A/Bで選ばせる）をしない。',
    '4) 質問は最大1つ。本当に必要な場合のみ。',
    '5) 3〜6行程度。最後は必ず「🪔」で閉じる。',
    '6) 励まし・一般論・ポジティブ誘導は禁止。',
    '7) 「〜と感じているんですね」「〜ようです」「〜かもしれません」等の',
    '   解説・推定・距離を取る表現は禁止。',
    '8) 「前に言っていた」「覚えている」などの記憶断言は禁止。',
    '',
    '【出力】',
    '日本語の会話文のみ。箇条書き・見出し・解説文・メタ言及は禁止。',
    '',
    '【履歴の使い方】',
    '- 直近の発話（lastTurns）を最優先。',
    '- 履歴は連続性の補助にのみ使い、本文で過去を説明しない。',
  ].filter(Boolean);

  const bandInfo = [
    '',
    '【内部制約：帯域ヒント（露出禁止）】',
    `directTask=${directTask ? 'true' : 'false'} / itOk=${itOk ? 'true' : 'false'} / intentBand=${
      b ?? '(null)'
    } / tLayerHint=${h ?? '(null)'}`,
  ].join('\n');

  const iStyleRule = allowIStyle
    ? [
        '',
        '【I層の言い回し（許可）】',
        '- ここ（writer）は判断をしない。I層に踏み込む内容判断は禁止。',
        '- ただし “言い切り” の文体（短く、断定的、説明しない）は許可される。',
        '- 「本当は〜」の説教や助言は禁止。Iっぽい一文を置くなら、その後に解説を足さない。',
      ].join('\n')
    : [
        '',
        '【I層の言い回し（未許可）】',
        '- I層の言い切り（本当に引っかかっているのは〜 等）は出さない。',
        '- 入口の会話は短い受け止め→次へつなぐ（必要なら質問1つ）に留める。',
      ].join('\n');

  const lockRule = buildLockRuleText(args?.lockedILines ?? []);

  return base.join('\n') + bandInfo + lockRule + iStyleRule;
}

/**
 * ✅ FINAL用：slotを保ったまま “会話本文” を作る
 */
export async function rephraseSlotsFinal(
  extracted: ExtractedSlots,
  opts: RephraseOptions,
): Promise<RephraseResult> {
  if (!extracted) {
    // ✅ ここでもログは出す（監査）
    logRephraseOk(opts.debug, [], '', 'NO_SLOTS');
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
    logRephraseOk(opts.debug, extracted.keys, '', 'DISABLED');
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

    // ✅ ログ（FIXEDでも確実に出す）
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
  const userText = norm(opts?.userText ?? '');
  const metaText = safeContextToText(opts?.userContext ?? null);

  // ✅ 依頼文っぽさ（SYSTEMで使う）
  const isDirectTask = /(本文だけ|文面|短文|そのまま使える|作って|出して)/.test(userText);

  // 長めの“履歴テキスト”は保険としてだけ使う（露出禁止）
  const historyText = extractHistoryTextFromContext(opts?.userContext ?? null);

  // ★ 本命：直近2往復だけ
  const lastTurns = extractLastTurnsFromContext(opts?.userContext ?? null);

  // slot由来の下書き（露出禁止）
  const seedDraftRaw = extracted.slots.map((s) => s.text).filter(Boolean).join('\n');

  // ✅ ILINE抽出（slot由来に含まれるのが主ルート）
  const { locked: lockedILines, cleanedForModel: seedDraft } = extractLockedILines(seedDraftRaw);

  // ✅ ITは条件が揃ってから（証拠があるときだけI表現ルールを許可）
  const itOk = readItOkFromContext(opts?.userContext ?? null);
  const band = extractIntentBandFromContext(opts?.userContext ?? null);

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

    // ★ 直近2往復（最大4メッセージ）
    ...lastTurns,

    {
      role: 'user',
      content: [
        '【ユーザー入力】',
        userText || '(空)',
        '',
        '【内部メタ（露出禁止）】',
        metaText || '(なし)',
        '',
        '【履歴ヒント（露出禁止）】',
        lastTurns.length > 0 ? '(直近2往復を上で投入済み)' : historyText || '(なし)',
        '',
        '【下書きヒント（slot由来・露出禁止）】',
        seedDraft || '(なし)',
        '',
        'この条件で、自然な会話文を生成して。',
      ].join('\n'),
    },
  ];

  console.log('[IROS/rephraseEngine][MSG_PACK]', {
    traceId: opts.debug?.traceId ?? null,
    conversationId: opts.debug?.conversationId ?? null,
    userCode: opts.debug?.userCode ?? null,
    lastTurns: lastTurns.length,
    hasHistoryText: Boolean(historyText),
    msgCount: messages.length,
    roles: messages.map((m) => m.role),
    itOk,
    intentBand: band.intentBand,
    tLayerHint: band.tLayerHint,
    directTask: isDirectTask,
    lockedILines: lockedILines.length,
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
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
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
    logRephraseOk(opts.debug, extracted.keys, '', 'LLM_FAIL');
    return {
      ok: false,
      reason: 'LLM_CALL_FAILED',
      meta: { inKeys, rawLen: 0, rawHead: '' },
    };
  }

  // ✅ raw段階ログ（keysはslotPlan由来を明示）
  logRephraseOk(opts.debug, extracted.keys, raw, 'LLM');

  // ✅ ILINE改変禁止：検証（不一致なら破棄）
  if (!verifyLockedILinesPreserved(raw, lockedILines)) {
    console.log('[IROS/REPHRASE][VERIFY]', {
      traceId: opts.debug?.traceId ?? null,
      conversationId: opts.debug?.conversationId ?? null,
      userCode: opts.debug?.userCode ?? null,
      iLine_preserved: false,
      lockedCount: lockedILines.length,
    });

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

  console.log('[IROS/REPHRASE][VERIFY]', {
    traceId: opts.debug?.traceId ?? null,
    conversationId: opts.debug?.conversationId ?? null,
    userCode: opts.debug?.userCode ?? null,
    iLine_preserved: true,
    lockedCount: lockedILines.length,
  });

  // ✅ 仕上げ：行数制限→🪔正規化
  const cleaned = ensureLampEnd(clampLines(raw, maxLines));
  if (!cleaned) {
    logRephraseOk(opts.debug, extracted.keys, '', 'LLM_EMPTY');
    return {
      ok: false,
      reason: 'LLM_EMPTY',
      meta: { inKeys, rawLen: 0, rawHead: '' },
    };
  }

  // ✅ 出力にマーカーが混入した場合は破棄（露出禁止の最終安全）
  if (cleaned.includes(ILINE_OPEN) || cleaned.includes(ILINE_CLOSE)) {
    logRephraseOk(opts.debug, extracted.keys, cleaned, 'ILINE_MARKER_LEAKED');
    return {
      ok: false,
      reason: 'ILINE_MARKER_LEAKED',
      meta: {
        inKeys,
        rawLen: cleaned.length,
        rawHead: safeHead(cleaned, 80),
      },
    };
  }

  const outSlots = buildSlotsWithFirstText(inKeys, cleaned);

  // ✅ slotへ載せた後ログ
  logRephraseAfterAttach(opts.debug, inKeys, outSlots[0]?.text ?? '', 'LLM');

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
