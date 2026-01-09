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

function buildGenerateSystem(opts?: { maxLinesHint?: number }) {
  const maxLinesHint = typeof opts?.maxLinesHint === 'number' ? opts!.maxLinesHint : null;

  return [
    'あなたは「理解された」と感じる文章に整える“表現担当”です。',
    'ただし、判断・助言・新しい意味の追加は禁止されています。',
    '',
    '入力には slot（OBS / SHIFT / NEXT / SAFE …）のキーと、元テキストが渡されます。',
    'あなたは元テキストを言い換えるのではなく、',
    '同じ意味・同じ役割を保ったまま、自然な会話文として新規に書き起こしてください。',
    '',
    '【絶対条件】',
    '- スロットの数・順序・キーは完全一致させる（増減・並び替え・キー変更は禁止）',
    '- 事実・意味の追加は禁止（推測・一般論・評価・説教・診断・因果の捏造をしない）',
    '- NEXT以外で新しい行動提案をしない',
    '',
    '【テンプレ禁止（最重要）】',
    '- 次のような決まり文句をそのまま使わない：',
    '  「受け取った」「いま出ている言葉」「いまの一点だけ」',
    '  「次は一手だけ」「迷いを増やさない」「呼吸を戻す」など',
    '- 同じ意味でも、毎回必ず別の自然な言い回しにする',
    '',
    '【スロット役割（厳守）】',
    '- OBS：ユーザー発言の要点を“観測として”短く写す（1〜2文）',
    '- SHIFT：いま残す焦点を1文で示す',
    '- NEXT：行動を1つに落とす（誰に／いつ／何を）。不足は空欄のまま明示してよい',
    '- SAFE：圧を下げる一言。評価しない',
    '',
    '【文章スタイル】',
    '- 日本語の自然な会話',
    '- 説明しすぎないが、抽象にも逃げない',
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

  if (outSlots.length !== inKeys.length) return null;

  for (let i = 0; i < inKeys.length; i++) {
    if (outSlots[i].key !== inKeys[i]) return null;
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

  const obs = extracted.slots.find((s) => s.key === 'OBS')?.text ?? '';
  const userQuoted = extractQuotedUserTextFromObs(obs);

  const system = buildGenerateSystem({ maxLinesHint: opts.maxLinesHint });

  const payload = {
    user_said: userQuoted,
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
    response_format: { type: 'json_object' },
  } as any);

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
