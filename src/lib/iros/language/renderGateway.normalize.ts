// file: src/lib/iros/language/renderGateway.normalize.ts
// iros - renderGateway normalize helpers
// 目的：blocks（改行ブロック）を「表示前に」正規化する（sanitizeの前段）
// 方針：本文の意味には触れず、重複/見出し/空行/軽いノイズだけ整える

type NormalizeOpts = {
  // 見出し候補が複数ある場合に、最大何行までを見出し探索に使うか
  titleScanMaxLines?: number;

  // 同じ見出しが連続した時に、見出しを畳む（true推奨）
  dedupeConsecutiveTitles?: boolean;

  // 連続空行を最大いくつ残すか（デフォルト 1）
  maxBlankRun?: number;

  // 完全一致のブロック重複を除去（true推奨）
  dedupeExactBlocks?: boolean;
};

type NormalizeResult = {
  blocks: string[];
  meta: {
    inBlocks: number;
    outBlocks: number;
    removedExactDups: number;
    removedTitleDups: number;
    trimmedBlankRuns: number;
  };
};

function normNL(s: unknown) {
  return String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function trimEndLines(s: string) {
  const lines = normNL(s).split('\n').map((x) => String(x ?? '').trimEnd());
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

function collapseBlankRuns(lines: string[], maxRun: number) {
  const out: string[] = [];
  let run = 0;
  for (const line of lines) {
    const t = String(line ?? '').trim();
    if (!t) {
      run += 1;
      if (run <= maxRun) out.push('');
      continue;
    }
    run = 0;
    out.push(line);
  }
  return out;
}

// 見出しを “軽く” 抽出：
// - 最初の数行から、空行/記号だけを飛ばして、最初に来る「短い1行」を候補にする
// - markdownの見出し記号や **強調だけ** は外して返す（sanitizeと同じ方向性）
function pickTitle(block: string, scanMaxLines: number): string {
  const lines = trimEndLines(block).split('\n');
  const n = Math.max(1, Math.min(scanMaxLines, lines.length));

  for (let i = 0; i < n; i++) {
    let s = String(lines[i] ?? '').trim();
    if (!s) continue;

    // 記号だけ行は飛ばす
    if (/^[\p{P}\p{S}]+$/u.test(s)) continue;

    // markdown見出し記号を落とす
    s = s.replace(/^\s{0,3}#{1,6}\s+/, '');

    // "**見出しだけ**" の形は中身に落とす
    const m = s.match(/^\*\*(.+?)\*\*$/);
    if (m) s = m[1];

    s = s.trim();
    if (!s) continue;

    // 長すぎる行は見出し候補にしない（本文っぽい）
    if (s.length > 40) continue;

    return s;
  }

  return '';
}

function normalizeBlock(block: string, maxBlankRun: number): string {
  const b = trimEndLines(block);
  if (!b) return '';
  const lines = b.split('\n').map((x) => String(x ?? '').trimEnd());
  const collapsed = collapseBlankRuns(lines, maxBlankRun);
  return collapsed.join('\n').trimEnd();
}

export function normalizeBlocksForRender(
  blocksIn: string[],
  opts?: NormalizeOpts,
): NormalizeResult {
  const titleScanMaxLines = opts?.titleScanMaxLines ?? 3;
  const dedupeConsecutiveTitles = opts?.dedupeConsecutiveTitles ?? true;
  const maxBlankRun = opts?.maxBlankRun ?? 1;
  const dedupeExactBlocks = opts?.dedupeExactBlocks ?? true;

  const meta = {
    inBlocks: Array.isArray(blocksIn) ? blocksIn.length : 0,
    outBlocks: 0,
    removedExactDups: 0,
    removedTitleDups: 0,
    trimmedBlankRuns: 0,
  };

  const seenExact = new Set<string>();
  let prevTitle = '';

  const out: string[] = [];

  for (const b0 of blocksIn ?? []) {
    const b1 = normalizeBlock(normNL(b0), maxBlankRun);
    if (!b1) continue;

    // 連続空行の圧縮が起きたか（粗い計測）
    // ※ここは正確計測しなくてOK。ログ用途の目安。
    if (/\n{3,}/.test(normNL(b0))) meta.trimmedBlankRuns += 1;

    if (dedupeExactBlocks) {
      const key = b1;
      if (seenExact.has(key)) {
        meta.removedExactDups += 1;
        continue;
      }
      seenExact.add(key);
    }

    if (dedupeConsecutiveTitles) {
      const title = pickTitle(b1, titleScanMaxLines);
      if (title && prevTitle && title === prevTitle) {
        // 「同じ見出しが連続」している時は、見出しだけ落として本文にする（本文が無ければ丸ごと捨てる）
        const lines = b1.split('\n');
        const firstLine = String(lines[0] ?? '').trim();
        let rest = lines.slice(1).join('\n').trim();
        // 先頭行が実際にタイトルっぽい場合だけ剥がす
        // （タイトル検出が2行目だった場合は触らない）
        if (firstLine.includes(title)) {
          if (!rest) {
            meta.removedTitleDups += 1;
            continue;
          }
          out.push(rest);
          meta.removedTitleDups += 1;
          // prevTitle は維持（連続畳み中）
          continue;
        }
      }
      prevTitle = title || prevTitle;
    }

    out.push(b1);
  }

  meta.outBlocks = out.length;
  return { blocks: out, meta };
}
