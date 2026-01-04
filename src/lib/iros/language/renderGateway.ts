// src/lib/iros/language/renderGateway.ts
import { renderV2, type RenderBlock } from './renderV2';

function head(s: string, n = 40) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export function renderGatewayAsReply(args: {
  extra?: any | null;
  content?: string | null;
  assistantText?: string | null;
  text?: string | null;
  maxLines?: number;
}): {
  content: string;
  meta: {
    blocksCount: number;
    maxLines: number;
    enable: boolean;

    pickedFrom: string;
    pickedLen: number;
    pickedHead: string;

    fallbackFrom: string;
    fallbackLen: number;
    fallbackHead: string;

    outLen: number;
    outHead: string;
  };
} {
  const extra = args?.extra ?? {};
  const enable = extra?.renderEngine === true;

  const c1 = String(args?.content ?? '').trim();
  const c2 = String(args?.assistantText ?? '').trim();
  const c3 = String(args?.text ?? '').trim();

  const picked =
    c1 ||
    c2 ||
    c3 ||
    '';

  const pickedFrom = c1 ? 'content' : c2 ? 'assistantText' : c3 ? 'text' : 'none';

  if (!enable) {
    return {
      content: picked,
      meta: {
        blocksCount: 0,
        maxLines: 0,
        enable: false,
        pickedFrom,
        pickedLen: picked.length,
        pickedHead: head(picked),
        fallbackFrom: 'n/a',
        fallbackLen: 0,
        fallbackHead: '',
        outLen: picked.length,
        outHead: head(picked),
      },
    };
  }

  const blocks: RenderBlock[] = [
    { text: args?.content ?? null },
    { text: args?.assistantText ?? null },
    { text: args?.text ?? null },
  ];

  const maxLines =
    Number.isFinite(Number(args?.maxLines)) && Number(args?.maxLines) > 0
      ? Number(args?.maxLines)
      : 5;

  const s4 = String(extra?.speechSkippedText ?? '').trim();
  const s5 = String(extra?.rawTextFromModel ?? '').trim();
  const s6 = String(extra?.extractedTextFromModel ?? '').trim();

  const fallbackText =
    picked ||
    s4 ||
    s5 ||
    s6 ||
    '';

  const fallbackFrom =
    picked
      ? pickedFrom
      : s4
        ? 'speechSkippedText'
        : s5
          ? 'rawTextFromModel'
          : s6
            ? 'extractedTextFromModel'
            : 'none';

  const content = renderV2({ blocks, maxLines, fallbackText });

  const meta = {
    blocksCount: blocks.length,
    maxLines,
    enable: true,
    pickedFrom,
    pickedLen: picked.length,
    pickedHead: head(picked),
    fallbackFrom,
    fallbackLen: fallbackText.length,
    fallbackHead: head(fallbackText),
    outLen: String(content ?? '').trim().length,
    outHead: head(content),
  };

  // ✅ “空に落ちる” を確実に捕まえる
  if (meta.outLen === 0) {
    console.warn('[IROS/renderGateway][EMPTY_OUT]', meta);
  } else {
    console.debug('[IROS/renderGateway][OK]', meta);
  }

  return { content, meta };
}
