// src/lib/iros/language/renderV2.ts
// iros — RenderEngine v2
// philosophy:
// - zero judgement
// - zero generation
// - slotPlan / LLM が決めた「完結」を一切疑わない
// - render は整形と表示制約のみを担う

export type RenderBlock = {
  text: string | null | undefined;
  kind?: string; // ignored
};

export type RenderV2Input = {
  blocks: RenderBlock[];

  /**
   * 表示上の最大行数制限
   * - 未指定 = 制限なし
   * - slotPlan / LLM の完結判断とは無関係
   */
  maxLines?: number;

  /**
   * blocks が完全に空のときのみ使用される
   * 「救済」ではなく「表示用フォールバック」
   */
  fallbackText?: string | null;
};

/**
 * 重複検出用の正規化キー
 * - 表示差分のみ潰す
 * - 意味改変は禁止
 */
function normKey(s: string): string {
  return String(s ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 行正規化
 * - 改行統一
 * - 行頭/行末の全角空白のみ除去
 * - 「呼吸」として空行は最大1つ許可
 */
function normalizeLines(
  raw: string,
  opts?: { keepOneBlank?: boolean }
): string[] {
  const keepOneBlank = opts?.keepOneBlank === true;

  const s = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  if (!s) return [];

  const lines0 = s.split('\n');

  const out: string[] = [];
  let blankAdded = false;

  for (const x of lines0) {
    const t = String(x ?? '').replace(/^\u3000+|\u3000+$/g, '');
    const trimmed = t.trim();

    if (!trimmed) {
      if (keepOneBlank && !blankAdded && out.length > 0) {
        out.push('');
        blankAdded = true;
      }
      continue;
    }

    out.push(trimmed);
    blankAdded = false;
  }

  return out;
}

/**
 * 固定句は重複除去しない
 * - SAFE / INSIGHT / 短い言い切りを守る
 */
function shouldSkipDedupe(line: string): boolean {
  const t = String(line ?? '').trim();
  if (!t) return false;
  if (t.length <= 14) return true;
  if (t.length <= 20 && /[。！？!]$/.test(t)) return true;
  return false;
}

export function renderV2(input: RenderV2Input): string {
  const blocks = Array.isArray(input?.blocks) ? input.blocks : [];

  const maxLinesRaw = Number(input?.maxLines);
  const hasLineLimit =
    Number.isFinite(maxLinesRaw) && maxLinesRaw > 0;
  const maxLines = hasLineLimit
    ? Math.floor(maxLinesRaw)
    : Infinity;

  const seen = new Set<string>();
  const out: string[] = [];

  // blocks → 整形して忠実に反映
  for (const b of blocks) {
    const raw = String((b as any)?.text ?? '');
    const lines = normalizeLines(raw, { keepOneBlank: true });

    for (const line of lines) {
      if (line === '') {
        out.push('');
        if (out.length >= maxLines) break;
        continue;
      }

      if (!shouldSkipDedupe(line)) {
        const k = normKey(line);
        if (seen.has(k)) continue;
        seen.add(k);
      }

      out.push(line);
      if (out.length >= maxLines) break;
    }

    if (out.length >= maxLines) break;
  }

  // blocks が完全に空の場合のみ fallback を使う
  if (out.length === 0 && input?.fallbackText) {
    const fbLines = normalizeLines(
      String(input.fallbackText),
      { keepOneBlank: true }
    );

    for (const line of fbLines) {
      if (line === '') {
        out.push('');
        if (out.length >= maxLines) break;
        continue;
      }

      if (!shouldSkipDedupe(line)) {
        const k = normKey(line);
        if (seen.has(k)) continue;
        seen.add(k);
      }

      out.push(line);
      if (out.length >= maxLines) break;
    }
  }

  // 末尾の空行だけ落とす（意味改変ではなく見た目調整）
  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
  }

  return out.join('\n');
}
