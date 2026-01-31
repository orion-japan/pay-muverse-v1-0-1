// src/lib/iros/language/renderV2.ts
// iros — RenderEngine v2 (format-only gate / zero-judgement / zero-generation)

// src/lib/iros/language/renderV2.ts
// iros — RenderEngine v2 (format-only gate / zero-judgement / zero-generation)

// src/lib/iros/language/renderV2.ts
// iros — RenderEngine v2 (format-only gate / zero-judgement / zero-generation)

export type RenderBlock = {
  text: string | null | undefined;
  kind?: string; // ignored
};

export type RenderV2Input = {
  blocks: RenderBlock[];
  maxLines?: number; // default 5
  fallbackText?: string | null;
  allowUnder5?: boolean;
};

function normKey(s: string): string {
  // ✅ 重複判定用の正規化（表示の“見かけ差”だけ潰す）
  // - 全角空白→半角空白
  // - 連続空白→1つ
  // - 前後空白除去
  // - 記号自体は消さない（生成/改変になるので）
  return String(s ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeLines(raw: string, opts?: { keepOneBlank?: boolean }): string[] {
  const keepOneBlank = opts?.keepOneBlank === true;

  const s = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // ✅ trimは全体で一回。行ごとのtrimは「呼吸」を殺すので弱める
    .trim();

  if (!s) return [];

  const lines0 = s.split('\n');

  const out: string[] = [];
  let blankAdded = false;

  for (const x of lines0) {
    // ✅ 全角空白は「行頭/行末」だけ落とす（本文中の全角スペースは保持）
    // - 以前の replace(/\u3000/g,'') は本文中の空白まで消してしまい事故る
    const t = String(x ?? '').replace(/^\u3000+|\u3000+$/g, '');
    const trimmed = t.trim();

    if (!trimmed) {
      // ✅ 呼吸：空行は最大1つだけ許可
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


function shouldSkipDedupe(line: string): boolean {
  // ✅ “固定句”は重複除去しない（SAFE/INSIGHTなどが消えるのを防ぐ）
  // - 短い行（<= 14文字）は固定句である可能性が高い
  // - 末尾が句点で終わる短文も固定句扱い
  const t = String(line ?? '').trim();
  if (!t) return false;
  if (t.length <= 14) return true;
  if (t.length <= 20 && /[。！？!]$/.test(t)) return true;
  return false;
}

export function renderV2(input: RenderV2Input): string {
  const blocks = Array.isArray(input?.blocks) ? input.blocks : [];

  console.warn('[IROS/renderV2][PROBE]', {
    disable: (() => {
      const v = String(process.env.IROS_RENDER_V2_DISABLE ?? '').toLowerCase();
      return v === '1' || v === 'true' || v === 'on' || v === 'yes';
    })(),
    blocksLen: Array.isArray(input?.blocks) ? input.blocks.length : null,
    fallbackLen: String(input?.fallbackText ?? '').length,
    maxLines: input?.maxLines ?? null,
    allowUnder5: input?.allowUnder5 ?? null,
  });


  // ✅ 実験用：renderV2 の整形を完全に無効化（素通し）
  // env: IROS_RENDER_V2_DISABLE = "1" | "true" | "on" | "yes"
  const disableRaw = String(process.env.IROS_RENDER_V2_DISABLE ?? '').toLowerCase();
  const disable = disableRaw === '1' || disableRaw === 'true' || disableRaw === 'on' || disableRaw === 'yes';
  if (disable) {
    // blocks があれば blocks をそのまま結合（trim/dedupe/行制限なし）
    const joined = blocks
      .map((b) => String((b as any)?.text ?? ''))
      .filter((s) => s.length > 0)
      .join('\n');

    // blocks が空なら fallbackText をそのまま返す
    return joined.length > 0 ? joined : String(input?.fallbackText ?? '');
  }

  const maxLinesRaw = Number(input?.maxLines);
  const requested =
    Number.isFinite(maxLinesRaw) && maxLinesRaw > 0 ? Math.floor(maxLinesRaw) : 5;

  const allowUnder5 = input?.allowUnder5 === true;

  // ✅ 通常は最低 5 行（「勝手に短文化」を防ぐ）
  // ✅ ただし allowUnder5=true の時だけ requested を尊重（1行/2行も許可）
  const maxLines = allowUnder5 ? requested : Math.max(5, requested);

  // ✅ seenは「表示行」ではなく「正規化キー」で判定する
  const seen = new Set<string>();
  const out: string[] = [];

  // ✅ blocks 側は“呼吸”あり（最大1つ空行を許可）
  for (const b of blocks) {
    const raw = String((b as any)?.text ?? '');
    const lines = normalizeLines(raw, { keepOneBlank: true });

    for (const line of lines) {
      // 空行は seen 対象外（呼吸のため）
      if (line === '') {
        out.push('');
        if (out.length >= maxLines) return out.slice(0, maxLines).join('\n');
        continue;
      }

      if (!shouldSkipDedupe(line)) {
        const k = normKey(line);
        if (seen.has(k)) continue;
        seen.add(k);
      }

      out.push(line);
      if (out.length >= maxLines) return out.slice(0, maxLines).join('\n');
    }
  }

  // ✅ blocks が空で何も作れない場合は、fallbackText を「整形だけ」して返す
  if (out.length === 0) {
    const fbLines = normalizeLines(String(input?.fallbackText ?? ''), { keepOneBlank: true });

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

  // ✅ 末尾が空行で終わるのは見た目が悪いので落とす（生成ではなく整形）
  while (out.length > 0 && out[out.length - 1] === '') out.pop();

  return out.slice(0, maxLines).join('\n');
}

