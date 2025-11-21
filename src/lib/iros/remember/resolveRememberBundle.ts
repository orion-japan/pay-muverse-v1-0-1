// src/lib/iros/remember/resolveRememberBundle.ts
// Rememberモード用：期間バンドル取得 & 必要なら生成
//
// ✅ このファイルがやること
// - 「yesterday / lastWeek / lastMonth / customRange」などのスコープから
//   対象期間(period_start / period_end)を計算
// - resonance_period_bundles を検索して、既存バンドルがあればそれを返す
// - なければ generateResonancePeriodBundle を呼び出して新規生成
// - Iros に渡しやすい「テキストまとめ」を組み立てる
//
// ⚠ ここでは「期間ベース」のみ扱います（topicベースRAGはあとで拡張）

import { SupabaseClient } from '@supabase/supabase-js';
import {
  generateResonancePeriodBundle,
  type PeriodType,
  type ResonancePeriodBundleRow,
  type ResonancePeriodBundleJson,
} from './generatePeriodBundle';

export type RememberScopeKind = 'yesterday' | 'lastWeek' | 'lastMonth' | 'customRange';

export type ResolveRememberArgs = {
  supabase: SupabaseClient;
  userCode: string;
  tenantId?: string | null;
  scopeKind: RememberScopeKind;
  /**
   * customRange のときのみ必須。
   * それ以外の scopeKind の場合は無視されます。
   */
  customStart?: Date | string;
  customEnd?: Date | string;
  /**
   * 日付の基準（now）。テストや「任意の時点」を基準にしたいときに指定。
   * 未指定なら new Date()。
   */
  now?: Date;
  /**
   * LLM に渡すログ件数上限（generateResonancePeriodBundle に渡す）
   */
  maxLogsForSummary?: number;
  /**
   * タイトルを外から上書きしたい場合
   */
  titleHint?: string;
};

export type RememberResolvedBundle = {
  bundle: ResonancePeriodBundleRow;
  textForIros: string;
  jsonForDebug?: ResonancePeriodBundleJson | null;
};

/**
 * Rememberモード用：期間バンドルを取得（なければ生成）して、
 * Iros に渡しやすい 1 本のテキストにまとめる。
 */
export async function resolveRememberBundle(
  args: ResolveRememberArgs
): Promise<RememberResolvedBundle | null> {
  const {
    supabase,
    userCode,
    tenantId,
    scopeKind,
    customStart,
    customEnd,
    now = new Date(),
    maxLogsForSummary,
    titleHint,
  } = args;

  const { periodType, periodStart, periodEnd } = computePeriodRange(scopeKind, now, {
    customStart,
    customEnd,
  });

  const periodStartIso = periodStart.toISOString();
  const periodEndIso = periodEnd.toISOString();

  // 1. 既存バンドルを探す（user_code + period_type + period_start / end）
  const { data: existing, error: existingError } = await supabase
    .from('resonance_period_bundles')
    .select('*')
    .eq('user_code', userCode)
    .eq('period_type', periodType)
    .eq('period_start', periodStartIso)
    .eq('period_end', periodEndIso)
    .order('created_at', { ascending: false })
    .limit(1);

  if (existingError) {
    console.error('[resolveRememberBundle] failed to fetch existing bundle', existingError);
    throw existingError;
  }

  let bundleRow: ResonancePeriodBundleRow | null = null;

  if (existing && existing.length > 0) {
    bundleRow = existing[0] as unknown as ResonancePeriodBundleRow;
  } else {
    // 2. なければオンデマンド生成
    bundleRow = await generateResonancePeriodBundle({
      supabase,
      userCode,
      tenantId,
      periodType,
      periodStart,
      periodEnd,
      titleHint,
      maxLogsForSummary,
    });

    if (!bundleRow) {
      // 対象期間にログがなかった場合など
      return null;
    }
  }

  const bundleJson = extractBundleJson(bundleRow);

  // 3. Iros に渡す “1本のテキスト” を組み立てる
  const textForIros = buildRememberText(bundleRow, bundleJson);

  return {
    bundle: bundleRow,
    textForIros,
    jsonForDebug: bundleJson,
  };
}

/**
 * scopeKind から、periodType と [start, end) を計算する。
 * end は「排他的」（< end）で扱う想定。
 */
function computePeriodRange(
  scopeKind: RememberScopeKind,
  now: Date,
  opts: { customStart?: Date | string; customEnd?: Date | string }
): { periodType: PeriodType; periodStart: Date; periodEnd: Date } {
  if (scopeKind === 'customRange') {
    if (!opts.customStart || !opts.customEnd) {
      throw new Error(
        '[computePeriodRange] customRange requires customStart and customEnd'
      );
    }
    const start =
      opts.customStart instanceof Date
        ? opts.customStart
        : new Date(opts.customStart);
    const end =
      opts.customEnd instanceof Date ? opts.customEnd : new Date(opts.customEnd);
    return {
      periodType: 'custom',
      periodStart: start,
      periodEnd: end,
    };
  }

  // 日付操作はシンプルに：UTCベースで「00:00〜」を切る
  const base = new Date(now);

  if (scopeKind === 'yesterday') {
    const start = startOfDay(addDays(base, -1));
    const end = startOfDay(base);
    return { periodType: 'day', periodStart: start, periodEnd: end };
  }

  if (scopeKind === 'lastWeek') {
    // 「直近7日間」のような扱い（週番号ベースで合わせたい場合はここを調整）
    const end = startOfDay(base);
    const start = addDays(end, -7);
    return { periodType: 'week', periodStart: start, periodEnd: end };
  }

  if (scopeKind === 'lastMonth') {
    // 前月の1日〜当月1日まで
    const thisMonthStart = startOfMonth(base);
    const lastMonthStart = addMonths(thisMonthStart, -1);
    return {
      periodType: 'month',
      periodStart: lastMonthStart,
      periodEnd: thisMonthStart,
    };
  }

  // unreachable
  throw new Error(`[computePeriodRange] unsupported scopeKind: ${scopeKind}`);
}

function extractBundleJson(
  row: ResonancePeriodBundleRow
): ResonancePeriodBundleJson | null {
  if (!row.bundle_json) return null;

  // Supabase の jsonb は JSでは object で返ってくる想定
  if (typeof row.bundle_json === 'object') {
    return row.bundle_json as ResonancePeriodBundleJson;
  }

  // 念のため string の場合もパース
  if (typeof row.bundle_json === 'string') {
    try {
      return JSON.parse(row.bundle_json) as ResonancePeriodBundleJson;
    } catch (e) {
      console.error('[extractBundleJson] failed to parse bundle_json string', e);
      return null;
    }
  }

  return null;
}

/**
 * Iros に渡す「Remember用の一塊テキスト」を生成。
 * ここではシンプルに Markdown っぽいテキストを返す。
 */
function buildRememberText(
  row: ResonancePeriodBundleRow,
  bundle: ResonancePeriodBundleJson | null
): string {
  const lines: string[] = [];

  const title = row.title ?? 'この期間のRememberログ';
  lines.push(`【Remember】${title}`);
  lines.push('');

  lines.push(`期間: ${row.period_start} 〜 ${row.period_end}`);
  if (row.q_dominant) {
    lines.push(`支配的だったQコード: ${row.q_dominant}`);
  }
  lines.push('');

  if (bundle?.main_topics && bundle.main_topics.length > 0) {
    lines.push('主なテーマ:');
    for (const t of bundle.main_topics) {
      lines.push(`- ${t}`);
    }
    lines.push('');
  }

  if (bundle?.overall_summary) {
    lines.push('全体の流れ・要約:');
    lines.push(bundle.overall_summary);
    lines.push('');
  } else if (row.summary) {
    lines.push('全体の流れ・要約:');
    lines.push(row.summary);
    lines.push('');
  }

  if (bundle?.representative_sentences && bundle.representative_sentences.length > 0) {
    lines.push('象徴的だった言葉:');
    for (const s of bundle.representative_sentences) {
      lines.push(`- 「${s}」`);
    }
    lines.push('');
  }

  if (bundle?.unresolved_points && bundle.unresolved_points.length > 0) {
    lines.push('まだ揺れている・整理しきれていないポイント:');
    for (const u of bundle.unresolved_points) {
      lines.push(`- ${u}`);
    }
    lines.push('');
  }

  lines.push('——');
  lines.push(
    'この期間の流れをふまえて、いま感じていることや、続きを話したいことがあれば教えてください。'
  );

  return lines.join('\n');
}

/* ====== 日付ユーティリティ（単純実装） ====== */

function startOfDay(d: Date): Date {
  const nd = new Date(d);
  nd.setHours(0, 0, 0, 0);
  return nd;
}

function startOfMonth(d: Date): Date {
  const nd = new Date(d);
  nd.setDate(1);
  nd.setHours(0, 0, 0, 0);
  return nd;
}

function addDays(d: Date, diff: number): Date {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + diff);
  return nd;
}

function addMonths(d: Date, diff: number): Date {
  const nd = new Date(d);
  nd.setMonth(nd.getMonth() + diff);
  return nd;
}
