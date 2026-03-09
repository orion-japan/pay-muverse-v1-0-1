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
 *
 * 重要:
 * - Markdown の「行末2スペース（ハード改行）」は保持する
 * - block 先頭の空行は落とす
 * - block 末尾の空行は落とす
 *   ※ block間の余白は renderV2 本体で管理する
 */
function normalizeLines(raw: string, opts?: { keepOneBlank?: boolean }): string[] {
  const keepOneBlank = opts?.keepOneBlank === true;

  const s0 = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  if (s0 === '') return [];

  const lines0 = s0.split('\n');

  const out: string[] = [];
  let blankAdded = false;
  let seenNonBlank = false;

  for (const x of lines0) {
    // 全角空白だけ端から除去（見た目事故を防ぐ）
    const t0 = String(x ?? '').replace(/^\u3000+|\u3000+$/g, '');

    // markdown ハード改行（行末2スペース）は保持
    const hasMdHardBreak = / {2}$/.test(t0);

    // 空行判定
    const isBlank = t0.trim().length === 0;

    if (isBlank) {
      // block先頭の空行は出さない
      if (!seenNonBlank) continue;

      if (keepOneBlank) {
        if (!blankAdded && out.length > 0) {
          out.push('');
          blankAdded = true;
        }
      } else {
        out.push('');
      }
      continue;
    }

    // 行頭スペースは残す
    // 行末スペースは markdown hard break 以外だけ除去
    let lineOut = t0.replace(/[ \t]+$/g, '');
    if (hasMdHardBreak) {
      lineOut = lineOut.replace(/[ \t]+$/g, '') + '  ';
    }

    out.push(lineOut);
    seenNonBlank = true;
    blankAdded = false;
  }

  // block末尾の空行だけ落とす
  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
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
  const hasLineLimit = Number.isFinite(maxLinesRaw) && maxLinesRaw > 0;

  // maxLines は「非空行」の上限として扱う
  const maxNonBlankLines = hasLineLimit ? Math.floor(maxLinesRaw) : Infinity;

  const seen = new Set<string>();
  const out: string[] = [];

  let nonBlankCount = 0;

  const canAddMoreNonBlank = () => nonBlankCount < maxNonBlankLines;

  const pushBlankIfOk = () => {
    if (out.length === 0) return;
    if (out[out.length - 1] === '') return;
    out.push('');
  };

  const pushLine = (line: string) => {
    if (!canAddMoreNonBlank()) return false;

    if (!shouldSkipDedupe(line)) {
      // dedupe は “表示差分” だけ潰す
      // markdown 末尾2スペースは比較から除外
      const lineForKey = String(line).replace(/ {2}$/, '');
      const k = normKey(lineForKey);
      if (seen.has(k)) return true; // 追加しないが処理は継続
      seen.add(k);
    }

    out.push(line);
    nonBlankCount += 1;
    return true;
  };

  /**
   * block 単位で流し込む
   * - block内の空行は normalizeLines 側で整理
   * - block間の余白はここで 1つだけ付ける
   */
  const renderBlockLines = (lines: string[]) => {
    if (!Array.isArray(lines) || lines.length === 0) return;

    let insertedBlockGap = false;

    for (const line of lines) {
      if (line === '') {
        pushBlankIfOk();
        continue;
      }

      // ✅ block先頭の本文行の前に、前blockとの区切り余白を1つだけ入れる
      if (!insertedBlockGap && out.length > 0 && out[out.length - 1] !== '') {
        pushBlankIfOk();
      }

      insertedBlockGap = true;

      if (!pushLine(line)) break;
    }
  };

  // blocks → 整形して忠実に反映
  for (const b of blocks) {
    if (!canAddMoreNonBlank()) break;

    const raw = String((b as any)?.text ?? '');
    const lines = normalizeLines(raw, { keepOneBlank: true });
    renderBlockLines(lines);
  }

  // blocks が完全に空の場合のみ fallback を使う
  if (out.length === 0 && input?.fallbackText && canAddMoreNonBlank()) {
    const fbLines = normalizeLines(String(input.fallbackText), { keepOneBlank: true });
    renderBlockLines(fbLines);
  }

  // 末尾の空行だけ落とす（意味改変ではなく見た目調整）
  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
  }

  return out.join('\n');
}
