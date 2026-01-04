// src/lib/iros/language/renderV2.ts
// iros — RenderEngine v2 (format-only gate / zero-judgement / zero-generation)

export type RenderBlock = {
  text: string | null | undefined;
  kind?: string; // ignored
};

export type RenderV2Input = {
  blocks: RenderBlock[];
  maxLines?: number; // default 5

  // ✅ blocks が空だった場合の「パススルー」本文（生成ではなく整形のみ）
  // 例: orch の raw assistantText / greeting など
  fallbackText?: string | null;
};

function normalizeLines(raw: string): string[] {
  const s = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!s) return [];
  return s
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export function renderV2(input: RenderV2Input): string {
  const blocks = Array.isArray(input?.blocks) ? input.blocks : [];
  const maxLinesRaw = Number(input?.maxLines);
  const maxLines =
    Number.isFinite(maxLinesRaw) && maxLinesRaw > 0 ? Math.floor(maxLinesRaw) : 5;

  const seen = new Set<string>();
  const out: string[] = [];

  for (const b of blocks) {
    const raw = String((b as any)?.text ?? '');
    const lines = normalizeLines(raw);
    for (const line of lines) {
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
      if (out.length >= maxLines) return out.slice(0, maxLines).join('\n');
    }
  }

  // ✅ blocks が空で何も作れない場合は、fallbackText を「整形だけ」して返す
  if (out.length === 0) {
    const fbLines = normalizeLines(String(input?.fallbackText ?? ''));
    for (const line of fbLines) {
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
      if (out.length >= maxLines) break;
    }
  }

  return out.slice(0, maxLines).join('\n');
}
