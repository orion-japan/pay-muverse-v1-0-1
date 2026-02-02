// file: src/lib/iros/orchestratorSoul.ts
// Iros Orchestrator - Soul layer extraction (behavior-preserving)
// - orchestrator.ts の「4.5 Iros Soul レイヤー」ブロックを関数化
// - 目的：orchestrator の肥大化を止め、ログ差し込み点を固定する
// - 重要：挙動は変えない（meta の補完・soulNote の格納ルールを保持）

import type { Depth, QCode, IrosMeta } from '@/lib/iros/system';

import { shouldUseSoul } from './soul/shouldUseSoul';
import { runIrosSoul } from './soul/runIrosSoul';
import type { IrosSoulInput } from './soul/types';

export type ApplySoulArgs = {
  text: string;
  meta: IrosMeta;

  // orchestratorAnalysis 由来（必要なものだけ）
  intentLine: any | null;
  yLevel: number | null;
  hLevel: number | null;

  // situation_topic 抽出に必要
  unified: any | null;
};

export type ApplySoulResult = {
  meta: IrosMeta;
  soulNote: any | null;
  situationTopic: string | null;
};

function resolveSituationTopicFromMeta(meta: any): string | null {
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

/**
 * applySoul()
 * - meta 作成直後に呼ぶ
 * - meta.situationSummary の補完（未設定時のみ）
 * - meta.situationTopic の抽出・保存
 * - Soul 実行（shouldUseSoul を通す）
 * - meta.soulNote を設定
 */
export async function applySoul(args: ApplySoulArgs): Promise<ApplySoulResult> {
  const { text, meta, intentLine, yLevel, hLevel } = args;

  let soulNote: any = null;

  try {
    // ✅ meta が作られた直後〜SoulInput を作る前に置く（現行挙動）
    const thisTurnText = String(text ?? '').trim();

    if (thisTurnText) {
      const s = String((meta as any)?.situationSummary ?? '').trim();

      // ✅ 「未設定/空」のときだけ、このターンの入力で補完する
      // （解析が作った summary を潰さない）
      if (!s) {
        (meta as any).situationSummary = thisTurnText;
      }
    }

    // ★ intentAnchorText を確実に作る（優先：meta.intent_anchor.text → intentLine.coreNeed）
    const intentAnchorText: string | null =
      (meta as any)?.intent_anchor?.text &&
      typeof (meta as any).intent_anchor.text === 'string' &&
      (meta as any).intent_anchor.text.trim().length > 0
        ? (meta as any).intent_anchor.text.trim()
        : intentLine && typeof (intentLine as any).coreNeed === 'string'
        ? String((intentLine as any).coreNeed).trim() || null
        : null;

    // ★ situationTopic を meta/unified/notes から拾う
    const situationTopic: string | null = resolveSituationTopicFromMeta(meta);

    // ★ 追加：拾えた topic は meta にも保存（Training/MemoryState へ残す）
    if (situationTopic) {
      (meta as any).situationTopic = situationTopic;
    }

    const soulInput: IrosSoulInput = {
      userText: text,
      qCode: (meta.qCode ?? null) as QCode | null,
      depthStage: (meta.depth ?? null) as Depth | null,
      phase: ((meta as any).phase ?? null) as any,
      selfAcceptance: (meta.selfAcceptance ?? null) as number | null,
      yLevel: typeof (meta as any).yLevel === 'number' ? (meta as any).yLevel : yLevel,
      hLevel: typeof (meta as any).hLevel === 'number' ? (meta as any).hLevel : hLevel,

      // ★ 今回のターンは text を入れる（null にしない）
      situationSummary:
        typeof text === 'string' && text.trim().length > 0 ? text.trim() : null,

      // ★ topic も供給
      situationTopic,

      // ★ Soul に意図アンカーを渡す
      intentAnchorText,

      intentNowLabel:
        intentLine && typeof (intentLine as any).nowLabel === 'string'
          ? (intentLine as any).nowLabel
          : null,
      intentGuidanceHint:
        intentLine && typeof (intentLine as any).guidanceHint === 'string'
          ? (intentLine as any).guidanceHint
          : null,
    };

    if (shouldUseSoul(soulInput)) {
      soulNote = await runIrosSoul(soulInput);
    }

    if (soulNote) {
      (meta as any).soulNote = soulNote;
    }

    return { meta, soulNote, situationTopic };
  } catch (e) {
    if (process.env.DEBUG_IROS_SOUL === '1') {
      // eslint-disable-next-line no-console
      console.error('[IROS/Soul] error', e);
    }
    return { meta, soulNote: null, situationTopic: null };
  }
}
