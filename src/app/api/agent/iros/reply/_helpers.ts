// src/app/api/agent/iros/reply/_helpers.ts
import type { NextRequest } from 'next/server';

// =========================================================
// ✅ auth helpers
// =========================================================

/**
 * auth から最良の userCode を抽出。
 * - 開発補助：ヘッダ x-user-code を許容
 * - auth の返りがどの形でも拾えるように「取りうるキー」を全部見る
 */
export function pickUserCode(req: NextRequest, auth: any): string | null {
  const h = req.headers.get('x-user-code');
  const fromHeader = h && h.trim() ? h.trim() : null;

  const candidates = [
    auth?.userCode,
    auth?.user_code,
    auth?.me?.user_code,
    auth?.me?.userCode,
    auth?.user?.user_code,
    auth?.user?.userCode,
    auth?.profile?.user_code,
    auth?.profile?.userCode,
  ]
    .map((v: any) => (v != null ? String(v) : ''))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return (candidates[0] ?? null) || fromHeader || null;
}

/** auth から uid をできるだけ抽出（ログ用） */
export function pickUid(auth: any): string | null {
  return (
    (auth?.uid && String(auth.uid)) ||
    (auth?.firebase_uid && String(auth.firebase_uid)) ||
    (auth?.user?.id && String(auth.user.id)) ||
    (auth?.me?.id && String(auth.me.id)) ||
    null
  );
}

// =========================================================
// ✅ speech helpers
// =========================================================

export function pickSpeechAct(meta: any): string | null {
  return (
    meta?.speechAct ??
    meta?.extra?.speechAct ??
    meta?.speech_act ??
    meta?.extra?.speech_act ??
    null
  );
}

export function pickSilenceReason(meta: any): string | null {
  return (
    meta?.silencePatchedReason ??
    meta?.extra?.silencePatchedReason ??
    meta?.silenceReason ??
    meta?.extra?.silenceReason ??
    null
  );
}

export function isEffectivelyEmptyText(text: any): boolean {
  const s = String(text ?? '').trim();
  if (!s) return true;

  const t = s.replace(/\s+/g, '');
  return t === '…' || t === '…。🪔' || t === '...' || t === '....';
}

// =========================================================
// ✅ UI向け「現在のモード」可視化（NORMAL / IR / SILENCE）
// - silenceReason があっても「本文があるなら SILENCE にしない」
// =========================================================

export type ReplyUIMode = 'NORMAL' | 'IR' | 'SILENCE';

export function inferUIMode(args: {
  modeHint?: string | null;
  effectiveMode?: string | null;
  meta?: any;
  finalText?: string | null;
}): ReplyUIMode {
  const { modeHint, effectiveMode, meta, finalText } = args;

  const hint = String(modeHint ?? '').toUpperCase();
  if (hint.includes('IR')) return 'IR';

  const eff = String(effectiveMode ?? '').toUpperCase();
  if (eff.includes('IR')) return 'IR';

  const speechAct = String(pickSpeechAct(meta) ?? '').toUpperCase();
  const empty = isEffectivelyEmptyText(finalText);

  if (speechAct === 'SILENCE' && empty) return 'SILENCE';
  return 'NORMAL';
}

export function inferUIModeReason(args: {
  modeHint?: string | null;
  effectiveMode?: string | null;
  meta?: any;
  finalText?: string | null;
}): string | null {
  const { modeHint, effectiveMode, meta, finalText } = args;

  const speechAct = String(pickSpeechAct(meta) ?? '').toUpperCase();
  const empty = isEffectivelyEmptyText(finalText);

  if (speechAct === 'SILENCE' && empty) {
    return pickSilenceReason(meta) ?? 'SILENCE';
  }

  const hint = String(modeHint ?? '').trim();
  if (hint.length > 0) return `MODE_HINT:${hint}`;

  const eff = String(effectiveMode ?? '').trim();
  if (eff.length > 0) return `EFFECTIVE_MODE:${eff}`;

  return null;
}

// =========================================================
// ✅ sanitize / numeric normalize
// =========================================================

export function sanitizeFinalContent(input: string): { text: string; removed: string[] } {
  const raw = String(input ?? '');
  const lines = raw.replace(/\r\n/g, '\n').split('\n');

  const headerRe = /^\s*(Iros|IROS|Sofia|SOFIA|IT|✨|Q[1-5])\s*$/;
  const removed: string[] = [];

  while (lines.length > 0) {
    const head = (lines[0] ?? '').trim();
    if (head.length === 0 || headerRe.test(head)) {
      removed.push(lines.shift() ?? '');
      continue;
    }
    break;
  }

  while (lines.length > 0 && String(lines[0] ?? '').trim().length === 0) {
    removed.push(lines.shift() ?? '');
  }

  const text = lines.join('\n').trimEnd();
  return { text, removed };
}

function pickNumber(...vals: any[]): number | null {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim().length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function clampInt(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/**
 * yLevel / hLevel を “整数に統一” する（DBの int と常に一致させる）
 */
export function normalizeMetaLevels(meta: any): any {
  const m = meta ?? {};
  const u = m.unified ?? {};

  const yRaw = pickNumber(m.yLevel, m.y_level, u.yLevel, u.y_level) ?? null;
  const hRaw = pickNumber(m.hLevel, m.h_level, u.hLevel, u.h_level) ?? null;

  const yInt = yRaw == null ? null : clampInt(Math.round(yRaw), 0, 3);
  const hInt = hRaw == null ? null : clampInt(Math.round(hRaw), 0, 3);

  if (yInt == null && hInt == null) return m;

  if (yInt != null) {
    m.yLevel = yInt;
    m.y_level = yInt;
  }
  if (hInt != null) {
    m.hLevel = hInt;
    m.h_level = hInt;
  }

  m.unified = m.unified ?? {};
  if (yInt != null) {
    m.unified.yLevel = yInt;
    m.unified.y_level = yInt;
  }
  if (hInt != null) {
    m.unified.hLevel = hInt;
    m.unified.h_level = hInt;
  }

  if (m.unified.intent_anchor && typeof m.unified.intent_anchor === 'object') {
    if (yInt != null) m.unified.intent_anchor.y_level = yInt;
    if (hInt != null) m.unified.intent_anchor.h_level = hInt;
  }

  if (m.intent_anchor && typeof m.intent_anchor === 'object') {
    if (yInt != null) m.intent_anchor.y_level = yInt;
    if (hInt != null) m.intent_anchor.h_level = hInt;
  }

  m.extra = {
    ...(m.extra ?? {}),
    normalizedLevels: {
      yLevelRaw: yRaw,
      hLevelRaw: hRaw,
      yLevelInt: yInt,
      hLevelInt: hInt,
    },
  };

  return m;
}
