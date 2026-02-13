// src/app/api/agent/iros/reply/_impl/utils.ts
// iros — route.ts split: small pure helpers (no side effects)
/* eslint-disable @typescript-eslint/no-explicit-any */

// =========================================================
// Text pickers
// =========================================================

/**
 * pickText
 * - "表示用本文" を拾うための最小ヘルパ
 * - ⚠️ object を String() すると "[object Object]" 事故が起きるので基本拾わない
 * - number は許可（ログ/ID等の意図しない混入に備えつつ、表示としては無害）
 */
export function pickText(...vals: any[]): string {
  for (const v of vals) {
    if (typeof v === 'string') {
      const t = v.replace(/\r\n/g, '\n').trimEnd();
      if (t.length > 0) return t;
      continue;
    }

    if (typeof v === 'number' && Number.isFinite(v)) {
      const t = String(v).trimEnd();
      if (t.length > 0) return t;
      continue;
    }

    // object / boolean / function / symbol / null / undefined は拾わない
  }
  return '';
}

// =========================================================
// Safe fallback picker (NEVER echo userText)
// =========================================================

/**
 * userText を「絶対に本文候補にしない」安全版 fallback picker
 * - EMPTY_LIKE（…… / ...）は捨てる
 * - @OBS/@SHIFT など内部マーカーは捨てる
 * - JSONっぽい/オブジェクト文字列 "[object Object]" は捨てる
 *
 * NOTE:
 * - assistant の最終フォールバックに userText を使うと「ユーザー文のオウム返し」になり、
 *   outLen が極端に短い / 会話が壊れる / ログが誤誘導される原因になる。
 * - ここでは allowUserTextAsLastResort が true でも userText を返さない。
 */
export function pickFallbackAssistantText(args: {
  allowUserTextAsLastResort?: boolean;
  userText?: string | null;

  // 直接指定（従来互換）
  assistantText?: string | null;
  content?: string | null;
  text?: string | null;

  // 呼び出し側（route.ts）で多用される形
  candidates?: any[];

  // 追加があっても崩れないよう、残りは許容
  [k: string]: any;
}): string {
  const norm = (v: any) =>
    typeof v === 'string'
      ? v.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
      : typeof v === 'number' && Number.isFinite(v)
        ? String(v).trim()
        : '';

  const isEmptyLike = (s0: string) => {
    const s = norm(s0);
    if (!s) return true;
    // "……" / "..." / "・・・・" 的なやつ
    if (/^[.。・…]{2,}$/u.test(s)) return true;
    if (/^…+$/.test(s)) return true;
    return false;
  };

  const isInternalLike = (s0: string) => {
    const s = norm(s0);
    if (!s) return false;
    if (/^@(OBS|SHIFT|NEXT|SAFE|DRAFT|SEED_TEXT)\b/m.test(s)) return true;
    if (/^INTERNAL PACK\b/m.test(s)) return true;
    // JSON 断片/role混入など
    if (/^\s*\{.*"role"\s*:\s*"(user|assistant|system)"/m.test(s)) return true;
    return false;
  };

  const isObjectStringLike = (s0: string) => {
    const s = norm(s0);
    if (!s) return false;
    if (s === '[object Object]') return true;
    return false;
  };

  const accept = (v: any) => {
    const s = norm(v);
    if (!s) return null;
    if (isEmptyLike(s)) return null;
    if (isInternalLike(s)) return null;
    if (isObjectStringLike(s)) return null;
    return s;
  };

  // 0) candidates を最優先で走査（順序維持）
  if (Array.isArray(args.candidates) && args.candidates.length > 0) {
    for (const c of args.candidates) {
      const s = accept(c);
      if (s) return s;
    }
  }

  // 1) assistant 系の候補だけを見る（userText は絶対に返さない）
  const a = accept(args.assistantText);
  if (a) return a;

  const c = accept(args.content);
  if (c) return c;

  const x = accept(args.text);
  if (x) return x;

  // 2) 最後まで無ければ空（ここで userText は使わない）
  return '';
}

// =========================================================
// History normalization
// =========================================================

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

    // system は「履歴として見せたい」場合に assistant 扱いになるが、
    // もし system を除外したいならここで continue にする。
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

  // LLMに渡す履歴の最大（最後のNターン）
  return out.slice(-12);
}

// =========================================================
// RenderBlock fallback（route.ts 内で1箇所に統一）
// =========================================================

export type RenderBlock = { text: string | null | undefined; kind?: string };

export function buildFallbackRenderBlocksFromFinalText(finalText: string): RenderBlock[] {
  const t = String(finalText ?? '').trim();
  if (!t) return [];

  // 段落 or 行で「ブロック化」する
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

  // 1) [[ILINE]] ... [[/ILINE]] が先頭にある場合は、それを先頭ブロックに固定
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
    out.push({ text: s, kind: 'p' });
  }
  return out;
}
