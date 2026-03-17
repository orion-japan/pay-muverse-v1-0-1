// file: src/lib/iros/language/renderGateway.sanitize.ts
// iros - renderGateway sanitize helpers
// 目的：UIに出す本文から内部ラベル/指示/タグを除去し、表示を安定させる

function norm(s: unknown) {
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
}

/** =========================================================
 * ✅ 内部ラベル除去（最終責任）
 * - system/protocol/hint 由来のタグや、メタ説明行を本文から消す
 * - “意味を壊さず短く” を優先
 * ========================================================= */
export function stripInternalLabels(line: string): string {
  let s = norm(line).trim();
  if (!s) return '';

  // 0幅文字（UIで「空行に見える」やつ）を先に除去
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!s) return '';

  // 1) 角括弧ラベル（例：【WRITER_PROTOCOL】など）
  s = s.replace(/【[^】]{1,24}】/g, '').trim();

  // 2) writer hint / meta説明
  s = s.replace(/^writer hint[:：]\s*/i, '').trim();

  // 2.5) 先頭の「… / ...」はノイズ
  s = s.replace(/^(\.{3,}|…{1,})\s*/g, '').trim();
  if (s === '...' || s === '…' || /^\.{3,}$/.test(s) || /^…+$/.test(s)) return '';

  // 3) FRAME / SLOTS 系のメタ行（記号だけ/文末なしは捨てる）
  if (/^FRAME\s*=\s*.*$/i.test(s) && !/[。！？!?]/.test(s)) return '';
  if (/^SLOTS\s*=\s*.*$/i.test(s) && !/[。！？!?]/.test(s)) return '';
  s = s.replace(/^FRAME\s*=\s*\S+\s*/i, '').trim();
  s = s.replace(/^SLOTS\s*=\s*\S+\s*/i, '').trim();

  // 4) known meta labels（文末なしは捨てる）
  if (
    /^(OBS_META|ROTATION_META|IT_HINT|ANCHOR_CONFIRM|TURN_MODE|SUBMODE)\s*[:：].*$/i.test(s) &&
    !/[。！？!?]/.test(s)
  ) {
    return '';
  }
  s = s
    .replace(/^(OBS_META|ROTATION_META|IT_HINT|ANCHOR_CONFIRM|TURN_MODE|SUBMODE)\s*[:：]\s*/i, '')
    .trim();

  // 5) =/: を含む内部キーっぽい行は捨てる（本文に残す価値が薄い）
  if (
    /(phase\s*=|depth\s*=|q\s*=|spinloop\s*=|spinstep\s*=|descentgate\s*=|tLayerHint\s*=|itx_|slotPlanPolicy|slotSeed|llmRewriteSeed)/i.test(
      s,
    )
  ) {
    if (s.includes('=') || s.includes(':') || s.includes('：')) return '';
  }

  // 6) [sa ...] などのタグ単体行
  s = s.replace(/^[〔\[]sa[\w.\s-]+[〕\]]$/i, '').trim();

  // 7) 空白正規化
  s = s.replace(/\s{2,}/g, ' ').trim();

  // ✅ 句読点/記号だけの“残骸行”は捨てる（「。」だけ等）
  if (/^[\u3000\s]*[。．\.、,・:：;；!！\?？…]+[\u3000\s]*$/.test(s)) return '';

  return s;
}

/**
 * ✅ 表示用サニタイズ
 * - enable=true/false どちらでも「人が読む文」に寄せるために使う
 * - 末尾🪔付与は「互換モード(renderEngine=false)」のときだけ opts.appendLamp=true で行う
 * - 重要：本文中の🪔は必ず除去し、付けるなら末尾だけ
 */
export function sanitizeVisibleText(
  raw: string,
  opts?: { appendLamp?: boolean; keepMarkdown?: boolean },
): string {
  let s = String(raw ?? '');

  // 1) 改行統一
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ✅ 重要：
  // - appendLamp=true の互換モードだけ、既存の 🪔 を一旦外して末尾1個に正規化する
  // - 通常表示では本文に含まれる 🪔 を保持する
  if (opts?.appendLamp) {
    s = s.replace(/🪔/g, '');
  }

  const keepMd = !!opts?.keepMarkdown;

  // 2) Markdown見出しを落とす（従来挙動）
  // - ✅ keepMarkdown=true のときは落とさない
  if (!keepMd) {
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  }

  // 3) 「**見出しだけ**」行の強調を落とす（従来挙動）
  // - ✅ keepMarkdown=true のときは落とさない
  if (!keepMd) {
    s = s.replace(/^\s*\*\*(.+?)\*\*\s*$/gm, '$1');
  }

  // ✅ iros の内部指示（slot directives）を UI に漏らさない最終ガード
  // - 行内に @... が出た行は丸ごと落とす
  function stripIrosDirectives(s0: string): string {
    const lines = String(s0 ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n');

    const kept: string[] = [];
    for (const line0 of lines) {
      const line = String(line0 ?? '');
      if (/@(?:OBS|CONSTRAINTS|SHIFT|NEXT|SAFE|ACK|RESTORE|Q)\b/.test(line)) continue;
      kept.push(line);
    }
    return kept.join('\n');
  }

  // 3.5) iros 内部指示を落とす（UIに漏らさない）
  s = stripIrosDirectives(s);

  // 4) 行単位で整形：段落（空行）は残すが、連続空行は1個に潰す
  // - ✅ keepMarkdown=true の時は、Markdown水平線(---/***/___)は残す
  // - ✅ keepMarkdown=true の時は、行末2スペース（ハード改行）を潰さない
  const isMarkdownHr = (t: string) => /^(\-\-\-+|\*\*\*+|___+)\s*$/.test(t);

  const isPunctOnly = (line: string) => {
    const t = line.trim();
    if (!t) return false;
    if (keepMd && isMarkdownHr(t)) return false; // HRは落とさない
    return /^[\p{P}\p{S}]+$/u.test(t);
  };

  const inLines = s.split('\n').map((line) => {
    // 従来は trimEnd していたが、Markdownの "  " を壊すので keepMarkdown=true では保持
    return keepMd ? String(line ?? '') : String(line ?? '').trimEnd();
  });

  const outLines: string[] = [];

  for (const line of inLines) {
    const t = line.trim();

    if (isPunctOnly(line)) continue;

    if (!t) {
      if (outLines.length > 0 && outLines[outLines.length - 1] !== '') outLines.push('');
      continue;
    }

    outLines.push(line);
  }

  while (outLines.length > 0 && outLines[0] === '') outLines.shift();
  while (outLines.length > 0 && outLines[outLines.length - 1] === '') outLines.pop();

  s = outLines.join('\n');

  // 5) 改行暴れ防止（保険：3連以上は2連に）
  s = s.replace(/\n{3,}/g, '\n\n').trimEnd();

  // 6) 互換モードだけ末尾に 🪔 を付ける（末尾のみ）
  if (opts?.appendLamp) {
    if (s.length > 0 && !s.endsWith('\n')) s += '\n';
    s += '🪔';
  }

  return s;
}

export function stripDirectiveLines(text: string): string {
  const s = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ✅ “行ごと”落とす（先頭だけ消えてJSON尻尾が残る事故を防ぐ）
  // - @TASK/@DRAFT などの directive 行は丸ごと削除
  // - INTERNAL PACK 行も丸ごと削除
  return s
    .split('\n')
    .filter((line) => {
      const t = String(line ?? '').trim();
      if (!t) return true;

      // ✅ directive line: drop whole line
      if (/^@(?:CONSTRAINTS|OBS|TASK|SHIFT|NEXT|SAFE|ACK|RESTORE|Q|DRAFT)\b/.test(t)) return false;

      // ✅ internal pack: drop whole line
      if (/^INTERNAL PACK\b/i.test(t)) return false;

      return true;
    })
    .join('\n')
    .trim();
}

export function stripILINETags(text: string): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\[\[ILINE\]\]\s*\n?/g, '')
    .replace(/\n?\s*\[\[\/ILINE\]\]/g, '')
    .trim();
}
