// src/lib/iros/language/rephrase/ilineLock.ts
// iros — ILINE lock helpers (preserve exact lines, no marker leakage)

export const ILINE_OPEN = '[[ILINE]]';
export const ILINE_CLOSE = '[[/ILINE]]';

export function extractLockedILines(
  text: string,
  opts?: { ilineOpen?: string; ilineClose?: string },
): { locked: string[]; cleanedForModel: string } {
  const locked: string[] = [];
  let cleaned = String(text ?? '');

  const open = opts?.ilineOpen ?? ILINE_OPEN;
  const close = opts?.ilineClose ?? ILINE_CLOSE;

  const re = new RegExp(
    open.replace(/[[\]]/g, '\\$&') + '([\\s\\S]*?)' + close.replace(/[[\]]/g, '\\$&'),
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

export function verifyLockedILinesPreserved(
  output: string,
  locked: string[],
  opts?: { ilineOpen?: string; ilineClose?: string },
): boolean {
  if (!locked.length) return true;

  const open = opts?.ilineOpen ?? ILINE_OPEN;
  const close = opts?.ilineClose ?? ILINE_CLOSE;

  // マーカー混入は即アウト（露出禁止）
  if (String(output ?? '').includes(open) || String(output ?? '').includes(close)) return false;

  const out = String(output ?? '').replace(/\r\n/g, '\n');
  return locked.every((s) => out.includes(String(s ?? '').replace(/\r\n/g, '\n')));
}

export function buildLockRuleText(locked: string[]): string {
  if (!locked.length) return '';
  return [
    '',
    '【改変禁止行（最重要）】',
    '次の各行は、一字一句そのまま本文に含めてください（句読点・助詞・改行も維持）。',
    `ただし制御マーカー（${ILINE_OPEN} など）は出力に絶対に含めないでください。`,
    '改変禁止行：',
    ...locked.map((s, i) => `- (${i + 1}) ${s}`),
    '',
  ].join('\n');
}
