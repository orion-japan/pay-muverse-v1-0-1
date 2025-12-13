// file: src/lib/iros/server/handleIrosReply.pure.ts
// handleIrosReply から切り出した「副作用なし（pure）」ユーティリティ群

import type { QCode } from '@/lib/iros/system';
import {
  finalPolishIrosText as finalPolishCore,
} from '@/lib/iros/render/finalPolishIrosText';

/* =========================================================
   ヘルパー：assistant返答から【IROS_STATE_META】の JSON を抜き出す
========================================================= */
export function extractIrosStateMetaFromAssistant(
  text: string | null | undefined,
): any | null {
  if (!text) return null;

  const marker = '【IROS_STATE_META】';
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return null;

  const after = text.slice(idx + marker.length);

  // JSON の開始位置（最初の { ）を探す
  const startIdx = after.indexOf('{');
  if (startIdx === -1) return null;

  // 文字列リテラル中の { } を誤カウントしない
  let depth = 0;
  let endRelIdx = -1;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < after.length; i++) {
    const ch = after[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        endRelIdx = i;
        break;
      }
    }
  }

  if (endRelIdx === -1) return null;

  const jsonStr = after.slice(startIdx, endRelIdx + 1);

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error(
      '[IROS/StateMeta] failed to parse IROS_STATE_META JSON',
      e,
      jsonStr,
    );
    return null;
  }
}

/* =========================================================
   Q フォールバック（detectQFromText が落ちた時の最低限）
========================================================= */
export function detectQFallbackFromText(
  text: string | null | undefined,
): QCode | null {
  const t = (text ?? '').toLowerCase();

  // Q2: 怒り/攻撃/不満
  if (/怒|ムカ|腹立|イラ|苛立|不満|キレ|許せ|攻撃|文句|憤/.test(t)) {
    return 'Q2';
  }

  // Q4: 恐怖/不安（恐れ寄り）/危機
  if (/怖|恐|不安|心配|怖い|恐い|危険|危機|震え|パニック|怯/.test(t)) {
    return 'Q4';
  }

  // Q3: 不安（安定欲求）/迷い/落ち着かない
  if (/不安|迷|焦|落ち着|モヤ|ぐるぐる|疲|しんど|つら|重い/.test(t)) {
    return 'Q3';
  }

  // Q1: 我慢/抑圧/秩序/耐える
  if (
    /我慢|耐|抑|抑え|ちゃんと|きちんと|ルール|正し|責任|秩序/.test(t)
  ) {
    return 'Q1';
  }

  // Q5: 空虚/虚しさ/燃え尽き/意味の喪失
  if (/空虚|虚|むな|意味ない|無意味|燃え尽|無気力|冷め|空っぽ/.test(t)) {
    return 'Q5';
  }

  return null;
}

/* =========================================================
   Final Polish：最後の文章見直し（唯一実装へ委譲）
========================================================= */
export type FinalPolishOptions = {
  style?: string | null;
  qNow?: string | null;
};

export function finalPolishIrosText(
  text: string,
  opts: FinalPolishOptions = {},
): string {
  return finalPolishCore(text, opts);
}

/* =========================================================
   値のクランプ / JSON安全化
========================================================= */
export function clampSelfAcceptance(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;

  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function makePostgrestSafePayload<T extends Record<string, any>>(
  payload: T,
): T | null {
  try {
    const json = JSON.stringify(payload);
    if (!json) return null;
    return JSON.parse(json) as T;
  } catch (e) {
    console.error('[UnifiedAnalysis] payload JSON serialize failed', e, payload);
    return null;
  }
}

/* =========================================================
   situation_topic 解決（meta/unified/note から）
========================================================= */
// 優先：meta → snake_case → unified → extra.pastStateNoteText から抽出 → null
export function resolveSituationTopicFromMeta(meta: any): string | null {
  const m: any = meta ?? {};
  const unified: any = m?.unified ?? {};
  const note: any = m?.extra?.pastStateNoteText;

  const fromMeta =
    typeof m.situationTopic === 'string' && m.situationTopic.trim().length > 0
      ? m.situationTopic.trim()
      : null;

  const fromSnake =
    typeof m.situation_topic === 'string' && m.situation_topic.trim().length > 0
      ? m.situation_topic.trim()
      : null;

  const fromUnified =
    typeof unified?.situation_topic === 'string' &&
    unified.situation_topic.trim().length > 0
      ? unified.situation_topic.trim()
      : typeof unified?.situation?.topic === 'string' &&
        unified.situation.topic.trim().length > 0
      ? unified.situation.topic.trim()
      : null;

  const fromNote = (() => {
    if (typeof note !== 'string' || note.trim().length === 0) return null;

    const m1 = note.match(/対象トピック:\s*([^\n\r]+)/);
    const m2 = note.match(/対象トピック\s*([^\n\r]+)/);

    const picked =
      m1 && m1[1]
        ? String(m1[1]).trim()
        : m2 && m2[1]
        ? String(m2[1]).trim()
        : null;

    return picked && picked.length > 0 ? picked : null;
  })();

  return fromMeta ?? fromSnake ?? fromUnified ?? fromNote ?? null;
}
