// src/lib/iros/language/rephraseEngine.ts
// iros — Rephrase Engine (slot-preserving)
//
// 目的：
// - FINALでも「表現だけ」をLLMに一度だけ貸す
// - slotの key と順序は絶対に崩さない
// - ズレた出力は黙って破棄（null）
// - render直前に1箇所だけ挿す想定
//
// 重要：
// - ここは “判断しない / 意味を足さない”
// - ただし「長すぎる引用を短くする」「テンプレ句を自然にする」は許可（意味を変えない範囲）
//
// NOTE:
// - 本当にテンプレ脱却したいなら、上流の slot本文（normalChat.ts 等）を可変にするのが本命。

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
 * ※ここでは key を落とさない（rephraseに必須）。
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
  maxLinesHint?: number; // “逸脱しない”ための補助
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

function buildRephraseSystem(opts?: { maxLinesHint?: number }) {
  const maxLinesHint = typeof opts?.maxLinesHint === 'number' ? opts!.maxLinesHint : null;

  return [
    'あなたの役割は「表現の整形（rephrase）」だけです。判断・助言・新しい意味の追加は禁止。',
    '',
    '入力slotsは「意味・順序・役割が確定済み」です。',
    'あなたは“内容の追加”をせずに、読みやすい日本語へ整えてください。',
    '',
    '【絶対禁止】',
    '- 新しい助言・評価・説教・一般論・抽象化の追加',
    '- 因果の捏造（だから/つまり/本当は等で意味を足す）',
    '- スロットの増減、順序変更、キーの変更',
    '',
    '【強い許可（重要）】',
    '- テンプレ感を減らすため、固定句（例：「受け取った。」「いま出ている言葉：」等）は自然な言い回しに置換してよい',
    '- 長すぎる引用（「現在の状況：...」のような丸ごと貼り付け）は “意味を変えず短く” 圧縮してよい',
    '- 同じ内容の繰り返しは1回にまとめてよい（意味は保持）',
    '',
    '【守ること】',
    '- 各slotは「元の役割」を保つ（OBS=観測、SHIFT=一点、NEXT=一手、SAFE=安全）',
    '- 口調は自然な会話文。過剰に丁寧/硬くしない。',
    '',
    '【出力形式（厳守）】',
    'JSONのみを出力してください。',
    '{ "slots": [ { "key": "<入力と同じ>", "text": "<言い換え文>" }, ... ] }',
    '',
    maxLinesHint != null ? `補助制約：全体の行数は概ね ${maxLinesHint} 行を超えないこと。` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function safeJsonParse(raw: string): any | null {
  const t = norm(raw);
  if (!t) return null;

  // 先頭/末尾のゴミを落とす最小処理（LLMが余計な前置きをした場合）
  const firstBrace = t.indexOf('{');
  const lastBrace = t.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  const sliced = t.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(sliced);
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

  return outSlots;
}

/**
 * FINAL用：slotを保ったまま表現だけ rephrase する。
 * - 失敗したら ok:false で返す（呼び元が黙って元slotを採用すればよい）
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

  // =========================================================
  // ✅ rephrase final を env で即OFF（single switch）
  // - IROS_REPHRASE_FINAL_ENABLED が '1' / 'true' のときだけ有効
  // - OFFのときは ok:false を返し、呼び元が元slotを採用すればよい
  // =========================================================
  {
    const rawFlag = process.env.IROS_REPHRASE_FINAL_ENABLED;
    const enabled = rawFlag === '1' || rawFlag === 'true';

    console.log('[IROS/REPHRASE_FLAG]', { raw: rawFlag, enabled });

    if (!enabled) {
      console.log('[IROS/REPHRASE_FLAG] skipped');
      return {
        ok: false,
        reason: 'REPHRASE_DISABLED_BY_ENV',
        meta: { inKeys: extracted.keys, rawLen: 0, rawHead: '' },
      };
    }
  }

  const inKeys = extracted.keys;

  const system = buildRephraseSystem({ maxLinesHint: opts.maxLinesHint });
  const payload = {
    slots: extracted.slots.map((s) => ({ key: s.key, text: s.text })),
  };

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(payload) },
  ];

  const raw = await chatComplete({
    // いまは既存の型に合わせて reply のまま（必要なら後で 'rephrase' を追加）
    purpose: 'reply',
    model: opts.model,
    messages,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
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
