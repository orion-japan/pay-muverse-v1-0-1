// src/lib/iros/language/rephraseEngine.ts
// iros — Rephrase/Generate Engine (slot-preserving)
//
// 目的：
// - FINALでも「文章そのもの」をLLMに一度だけ生成させる
// - slot の key と順序は絶対に崩さない
// - ズレた出力は黙って破棄（null）
// - render直前に1箇所だけ挿す想定
//
// 重要：
// - ここは “判断しない / 意味を足さない”
// - ただし「テンプレ句を避ける」「引用を短くする」「自然会話にする」は許可（意味を変えない範囲）
//
// NOTE:
// - 「本当にテンプレ脱却」= 上流 slot 本文を可変にするのが本命だが、
//   当面はこの層で “文章そのものを生成” してテンプレ感を消す。

import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete';

type Slot = { key: string; text: string };

type ExtractedSlots = {
  slots: Slot[];
  keys: string[];
  source: string;
} | null;

function norm(s: unknown) {
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
}

function head(s: string, n = 80) {
  const t = norm(s).replace(/\s+/g, ' ');
  return t.length <= n ? t : t.slice(0, n) + '…';
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
 * ※ここでは key を落とさない（LLM生成に必須）。
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

type RephraseOptions = {
  model: string;
  temperature?: number;
  maxLinesHint?: number; // 全体行数の目安

  /**
   * ✅ 追加：直前のユーザー入力（このターンの生テキスト）
   * - これが入ると OBS の “引用” に頼らず「何に答えてるか」を固定できる
   * - 未指定なら OBS から「ユーザー文引用」を抽出して使う（従来通り）
   */
  userText?: string | null;

  /**
   * ✅ 追加：直前user文脈メモ（1〜2行推奨）
   * - “意味追加” ではなく、どの質問/主題へ答えるかのブレ止め
   * - 未指定なら渡さない
   */
  userContext?: string | null;
};

type RephraseResult =
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

/**
 * OBSスロット内の「ユーザー文引用」を拾う
 * 例：いま出ている言葉：「....」
 */
function extractQuotedUserTextFromObs(obsText: string): string | null {
  const t = norm(obsText);
  if (!t) return null;

  const m1 = t.match(/「([^」]{1,600})」/);
  if (m1?.[1]) return norm(m1[1]);

  const m2 = t.match(/"([^"]{1,600})"/);
  if (m2?.[1]) return norm(m2[1]);

  return null;
}

/* =========================================================
 * ✅ “柔軟性” のためのヒント設計
 * - ここは意味追加ではなく「書き方の幅」だけを与える
 * ======================================================= */

type LenTier = 'short' | 'medium' | 'long';
type NextKind = 'action' | 'dialogue';

type SlotHint = {
  key: string;
  len: LenTier;
  // NEXTが毎回「行動」固定だと会話が死ぬので二系統にする
  nextKind?: NextKind;
};

function guessLenTier(allText: string, opts?: { maxLinesHint?: number }): LenTier {
  // maxLinesHint が低いなら短めに寄せる
  const maxLinesHint = typeof opts?.maxLinesHint === 'number' ? opts!.maxLinesHint : null;
  if (maxLinesHint != null && maxLinesHint <= 4) return 'short';

  const n = norm(allText).length;
  if (n <= 60) return 'short';
  if (n <= 180) return 'medium';
  return 'long';
}

function guessNextKindFromSeed(nextSeed: string): NextKind {
  const t = norm(nextSeed);
  // 「誰に／いつ／何を」系が含まれるなら行動スロットとして扱う
  if (
    t.includes('誰に') ||
    t.includes('いつ') ||
    t.includes('何を') ||
    t.includes('一手') ||
    t.includes('行動')
  ) {
    return 'action';
  }
  // それ以外は会話の次（確認/選択/質問）として扱う
  return 'dialogue';
}

function buildSlotHints(slots: Slot[], opts?: { maxLinesHint?: number }): SlotHint[] {
  const joined = slots.map((s) => s.text).join('\n');
  const base = guessLenTier(joined, opts);

  return slots.map((s) => {
    const key = s.key;

    // 基本はbaseに従うが、SAFEは短めに、OBSは状況で中〜短
    let len: LenTier = base;
    if (key === 'SAFE') len = base === 'long' ? 'medium' : 'short';
    if (key === 'OBS' && base === 'long') len = 'medium';

    const hint: SlotHint = { key, len };

    if (key === 'NEXT') {
      hint.nextKind = guessNextKindFromSeed(s.text);
      // actionの時は長くしすぎると説教になるので最大medium
      if (hint.nextKind === 'action' && len === 'long') hint.len = 'medium';
    }

    return hint;
  });
}

function buildGenerateSystem(opts?: { maxLinesHint?: number }) {
  const maxLinesHint = typeof opts?.maxLinesHint === 'number' ? opts!.maxLinesHint : null;

  return [
    'あなたは「理解された」と感じる文章に整える“表現担当”です。',
    'ただし、判断・助言・新しい意味の追加は禁止されています（推測・一般論・説教・診断は禁止）。',
    '',
    '入力には slot（OBS / SHIFT / NEXT / SAFE …）のキーと元テキスト、そして slot_hints が渡されます。',
    '必要なら user_said（直前ユーザー入力の要約/引用）と user_context（直前文脈メモ）が渡されます。',
    'あなたは元テキストと同じ意味・同じ役割を保ったまま、自然な会話文として書き起こしてください。',
    '',
    '【絶対条件】',
    '- スロットの数・順序・キーは完全一致（増減・並び替え・キー変更は禁止）',
    '- 事実・意味の追加は禁止（答えを捏造しない）',
    '- 元テキストの意図を勝手に“強化/弱体化”しない',
    '',
    '【最重要：直答の保持】',
    '- 元テキストが「質問への答え」になっている場合、OBSで必ず直答を保つ（例：時期/結論/定義/Yes/No）。',
    '- OBSを「〜について知りたいんだね」「考えよう」などの観測語りに置き換えない。',
    '- “質問→答え”の軸を壊さない。必要なら短い補足は可。ただし新情報の追加は禁止。',
    '',
    '【テンプレ禁止（最重要）】',
    '- 次のような決まり文句をそのまま使わない：',
    '  「受け取った」「いま出ている言葉」「いまの一点だけ」',
    '  「次は一手だけ」「迷いを増やさない」「呼吸を戻す」「必要な情報だけ」など',
    '- 同じ意味でも、毎回必ず別の自然な言い回しにする',
    '',
    '【スロット役割（厳守）】',
    '- OBS：元テキストの役割を保持する。直答がある場合は直答を先頭に置く（1〜2文）。',
    '- SHIFT：OBSを補助する“見る点”を1文で示す。新しい論点を作らない。',
    '- NEXT：slot_hints.nextKind に従う。',
    '  - nextKind="action"：行動を1つに落とす（誰に／いつ／何を）。不足は空欄のまま明示してよい。',
    '  - nextKind="dialogue"：会話の次を1つに絞る（確認する/選ぶ/短い質問を返す）。行動提案はしない。',
    '- SAFE：圧を下げる一言（評価しない/命令しない）。',
    '',
    '【長さの柔軟性】',
    '- slot_hints.len に従い、短/中/長を調整する。',
    '  - short: 1文中心 / medium: 1〜2文 / long: 2〜3文（だらだら説明しない）',
    '',
    '【文章スタイル】',
    '- 日本語の自然な会話',
    '- 抽象に逃げない。口調は落ち着いて、説得ではなく納得。',
    '- 記号（🪔など）へのこだわりは不要',
    '',
    '【出力形式（厳守）】',
    'JSONのみを出力してください。',
    '{ "slots": [ { "key": "<入力と同じ>", "text": "<生成文>" }, ... ] }',
    '',
    maxLinesHint != null ? `補助制約：全体の行数は概ね ${maxLinesHint} 行以内。` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function safeJsonParse(raw: string): any | null {
  const t = norm(raw);
  if (!t) return null;

  const firstBrace = t.indexOf('{');
  const lastBrace = t.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  try {
    return JSON.parse(t.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function validateOut(inKeys: string[], out: any): Slot[] | null {
  const slots = out?.slots;
  if (!Array.isArray(slots) || slots.length === 0) return null;

  const outSlots: Slot[] = [];
  for (const s of slots) {
    const key = String(s?.key ?? '').trim();
    const text = norm(s?.text ?? '');
    if (!key || !text) return null;
    outSlots.push({ key, text });
  }

  // キー集合の一致（完全一致・順序一致）
  const outKeys = outSlots.map((x) => x.key);
  if (outKeys.length !== inKeys.length) return null;
  for (let i = 0; i < inKeys.length; i++) {
    if (outKeys[i] !== inKeys[i]) return null;
  }

  // =========================================================
  // ✅ 禁句フィルタ：テンプレ臭が出たら “黙って破棄”
  // =========================================================
  const FORBIDDEN_PHRASES: string[] = [
    '受け取った',
    'いま出ている言葉',
    'いまの一点だけ',
    '次は一手だけ',
    '迷いを増やさない',
    '呼吸を戻す',
    '必要な情報だけ',
    '大丈夫だよ',
    '気軽に考えて',
  ];

  const FORBIDDEN_PATTERNS: RegExp[] = [
    /今のポイントは.+ということですね/,
    /〜について(知ってる|知りたい|尋ねてる)ね/,
    /大切だね$/,
    /考えましょう$/,
  ];

  for (const s of outSlots) {
    const t = norm(s.text);

    for (const p of FORBIDDEN_PHRASES) {
      if (p && t.includes(p)) return null;
    }
    for (const r of FORBIDDEN_PATTERNS) {
      if (r.test(t)) return null;
    }
  }

  return outSlots;
}

/**
 * FINAL用：slotを保ったまま “文章そのもの” をLLMに生成させる。
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

  {
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
  }

  const inKeys = extracted.keys;

  // ✅ 直前user文脈（優先順位）
  // 1) opts.userText（呼び出し側から渡される “このターンの user”）
  // 2) OBS から抽出した引用
  // 3) null
  const obs = extracted.slots.find((s) => s.key === 'OBS')?.text ?? '';
  const userQuotedFromObs = extractQuotedUserTextFromObs(obs);
  const user_said = norm(opts.userText ?? '') || userQuotedFromObs;

  const user_context = norm(opts.userContext ?? '') || null;

  const slot_hints = buildSlotHints(extracted.slots, { maxLinesHint: opts.maxLinesHint });

  const system = buildGenerateSystem({ maxLinesHint: opts.maxLinesHint });

  const payload = {
    // ✅ “何に答えるか”固定用（意味追加ではない）
    user_said: user_said || null,
    user_context,

    slot_hints,
    slots: extracted.slots.map((s) => ({ key: s.key, text: s.text })),
  };

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(payload) },
  ];

  const raw = await chatComplete({
    purpose: 'writer',
    model: opts.model,
    messages,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.55,

    // ✅ chatComplete.ts 側の引数名は responseFormat
    // （ここが response_format だと JSON強制が効かず VALIDATION_FAILED が増える）
    responseFormat: { type: 'json_object' },
  });

  const rawLen = norm(raw).length;
  const rawHead = head(raw);

  const parsed = safeJsonParse(raw);
  const validated = validateOut(inKeys, parsed);

  if (!validated) {
    return {
      ok: false,
      reason: 'VALIDATION_FAILED',
      meta: { inKeys, rawLen, rawHead },
    };
  }

  return {
    ok: true,
    slots: validated,
    meta: {
      inKeys,
      outKeys: validated.map((x) => x.key),
      rawLen,
      rawHead,
    },
  };
}
