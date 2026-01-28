// src/app/api/agent/iros/reply/_impl/utils.ts
// iros — route.ts split: small pure helpers (no side effects)

export function pickText(...vals: any[]): string {
  for (const v of vals) {
    const s = typeof v === 'string' ? v : String(v ?? '');
    const t = s.replace(/\r\n/g, '\n').trimEnd();
    if (t.length > 0) return t;
  }
  return '';
}

export function pickFallbackAssistantText(args: {
  // NOTE:
  // - assistant の最終フォールバックに userText を使うと「ユーザー文のオウム返し」になり、
  //   outLen が極端に短い/会話が壊れる/ログが誤誘導される原因になる。
  // - ここでは allowUserTextAsLastResort が true でも userText を返さない。
  allowUserTextAsLastResort?: boolean;

  userText?: string | null;

  // 直接指定（従来互換）
  assistantText?: string | null;
  content?: string | null;
  text?: string | null;

  // ✅ 呼び出し側が使っている形（route.ts 内の多数呼び出しを吸収）
  candidates?: any[];

  // 追加があっても崩れないよう、残りはそのまま許容
  [k: string]: any;
}) {
  const norm = (v: any) => String(v ?? '').trim();

  // 0) candidates を最優先で走査（呼び出し側の実態）
  if (Array.isArray(args.candidates) && args.candidates.length > 0) {
    for (const c of args.candidates) {
      const s = norm(c);
      if (s) return s;
    }
  }

  // 1) assistant 系の候補だけを見る（userText は絶対に返さない）
  const a = norm(args.assistantText);
  if (a) return a;

  const c = norm(args.content);
  if (c) return c;

  const x = norm(args.text);
  if (x) return x;

  // 2) 最後まで無ければ空（ここで userText は使わない）
  return '';
}

export function normalizeHistoryMessages(
  raw: unknown[] | string | null | undefined,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!raw) return [];
  if (typeof raw === 'string') return [];
  if (!Array.isArray(raw)) return [];

  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of raw.slice(-24)) {
    if (!m || typeof m !== 'object') continue;

    const roleRaw = String((m as any)?.role ?? (m as any)?.speaker ?? (m as any)?.type ?? '')
      .toLowerCase()
      .trim();

    const body = String((m as any)?.content ?? (m as any)?.text ?? (m as any)?.message ?? '')
      .replace(/\r\n/g, '\n')
      .trim();

    if (!body) continue;

    const isAssistant =
      roleRaw === 'assistant' ||
      roleRaw === 'bot' ||
      roleRaw === 'system' ||
      roleRaw.startsWith('a');

    out.push({
      role: (isAssistant ? 'assistant' : 'user') as 'assistant' | 'user',
      content: body,
    });
  }
  return out.slice(-12);
}

// =========================================================
// RenderBlock fallback（route.ts 内で1箇所に統一）
// =========================================================
export type RenderBlock = { text: string | null | undefined; kind?: string };

export function buildFallbackRenderBlocksFromFinalText(finalText: string): RenderBlock[] {
  const t = String(finalText ?? '').trim();
  if (!t) return [];

  // ✅ 段落 or 行で「ブロック化」する
  // - \n\n があれば段落優先
  // - \n\n が無ければ 1行=1ブロック（診断seed等の “改行だけ” を救う）
  const splitToBlocks = (s: string): string[] => {
    const raw = String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!raw) return [];
    if (/\n{2,}/.test(raw)) {
      return raw
        .split(/\n{2,}/g)
        .map((x) => x.trim())
        .filter(Boolean);
    }
    if (raw.includes('\n')) {
      return raw
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
    }
    return [raw];
  };

  const blocksText: string[] = [];

  // 1) [[ILINE]] ... [[/ILINE]] がある場合は、それを先頭ブロックに固定
  const start = t.indexOf('[[ILINE]]');
  const end = t.indexOf('[[/ILINE]]');

  if (start === 0 && end > start) {
    const ilineBlock = t.slice(0, end + '[[/ILINE]]'.length).trim();
    if (ilineBlock) blocksText.push(ilineBlock);

    const rest = t.slice(end + '[[/ILINE]]'.length).trim();
    blocksText.push(...splitToBlocks(rest));
  } else {
    blocksText.push(...splitToBlocks(t));
  }

  // 空ブロック除去 + 構造化
  const out: RenderBlock[] = [];
  for (const b of blocksText) {
    const s = String(b ?? '').trim();
    if (!s) continue;
    out.push({ text: s });
  }
  return out;
}
