// src/lib/iros/memoryRecall.ts
// Iros MemoryRecall モジュール
//
// 役割：
//  - ユーザー入力から「過去状態カルテ」を呼び出すトリガーを検出
//  - iros_training_samples / iros_memory_state から最近の状態を取り出し、IROS_PAST_STATE_NOTE 文字列を組み立てる
//
// トリガーの種類：
//  - 'keyword'       : 「ウツ」「上司の件」など具体ワード付きで覚えてる？と聞かれたとき
//  - 'recent_topic'  : キーワードは取れないが「覚えてる？」「〜でしたっけ？」など質問文のとき（最近トピックでフォールバック）
//  - 'none'          : リコールと判定しない

import type { SupabaseClient } from '@supabase/supabase-js';

// ★ 過去記憶トリガー検出 + キーワード抽出

export type MemoryRecallTriggerKind = 'none' | 'recent_topic' | 'keyword';

export type MemoryRecallTrigger = {
  kind: MemoryRecallTriggerKind;
  keyword?: string | null;
};

export type MemoryRecallResult = {
  hasNote: boolean;
  pastStateNoteText: string | null;
  triggerKind: MemoryRecallTriggerKind | null;
  keyword: string | null;
};

// 「覚えてます？」系をゆるく拾う
const REMEMBER_TRIGGER_REGEX =
  /(覚えてる[？\?]?|覚えてます[か？\?]*|覚えていましたっけ[？\?]?)/;

// 「あの時」「前に」などのノイズを削りたい時用
const FILLER_WORDS_REGEX =
  /(前に|前回|この前|あのとき|あの時|例の|あの件の?|その件の?)/g;

/**
 * メイン入口：
 * - kind = 'keyword'      → keyword 付きで DB 検索に回す
 * - kind = 'recent_topic' → キーワードなしで「最近のスナップショット」を拾う
 * - kind = 'none'         → 何もしない（※ prepare 側で fallback する）
 */
export function detectMemoryRecallTriggerFromText(
  rawText: string,
): MemoryRecallTrigger {
  const text = normalizeForRecall(rawText);

  // 1) 「覚えてます？」系 → 優先して扱う
  if (REMEMBER_TRIGGER_REGEX.test(text)) {
    const keyword = extractRecallKeyword(text);

    if (keyword) {
      return {
        kind: 'keyword',
        keyword,
      };
    }

    // キーワードが取れなかった場合 → 最近トピック参照
    return {
      kind: 'recent_topic',
      keyword: null,
    };
  }

  // 2) 上記以外でも「質問っぽい文」は全部リコール対象にする
  if (isQuestionLike(text)) {
    return {
      kind: 'recent_topic',
      keyword: null,
    };
  }

  // 3) それ以外はリコールなし（※ prepare 側で recent_topic にフォールバック）
  return { kind: 'none' };
}

/**
 * 全角記号 → 半角、前後の空白・？を削る程度の軽い正規化
 */
function normalizeForRecall(input: string): string {
  return (input ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    ) // 全角英数記号 → 半角
    .replace(/[！？]/g, '?') // 感嘆・疑問を「?」に寄せる
    .trim();
}

/**
 * 「質問っぽい」かどうかの簡易判定
 * - 末尾が「?」「？」で終わる
 * - 末尾が「か？」「かな？」など
 */
function isQuestionLike(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;

  if (/[？?]$/.test(t)) return true;
  if (/(か|かな|かも)$/u.test(t)) return true;

  return false;
}

/**
 * 「〜覚えてます？」の形から、検索用のトピックワードを抽出する
 *
 * 例:
 *  - 「ウツの状態覚えてます？」         → 「ウツの状態」
 *  - 「前に話してた上司の件覚えてる？」 → 「話してた上司の件」
 *  - 「覚えてます？あの時のライブ」     → 「あの時のライブ」
 */
function extractRecallKeyword(text: string): string | null {
  // パターン1: 「(何か)覚えてます？」の形
  const patternBefore = /^(.+?)(のこと)?覚えて(る|ます)(か)?\??$/;
  const m1 = text.match(patternBefore);
  if (m1 && m1[1]) {
    return cleanKeyword(m1[1]);
  }

  // パターン2: 「覚えてます？(何か)」の形
  const patternAfter = /^覚えて(る|ます)(か)?[、，]?(.*)\??$/;
  const m2 = text.match(patternAfter);
  if (m2 && m2[3]) {
    return cleanKeyword(m2[3]);
  }

  // それ以外は、いったんキーワードなし
  return null;
}

/**
 * 抜き出したキーワードから、ノイズ・接頭語を削る
 */
function cleanKeyword(raw: string): string | null {
  let kw = raw ?? '';

  // 「前に / この前 / あの時 / 例の …」などを削る
  kw = kw.replace(FILLER_WORDS_REGEX, '');

  // 終わりが「〜のこと」
  kw = kw.replace(/のこと$/, '');

  // 終わりが「〜の話 / 〜の話し / 〜について / 〜の件」
  kw = kw.replace(/(の話し?|について|の件)$/g, '');

  // 末尾の ? などを削る
  kw = kw.replace(/[?？]+$/, '');

  // 前後の空白を削る
  kw = kw.trim();

  // ★ 先頭に助詞だけ残っているケースを削る（「の体調不良」→「体調不良」）
  kw = kw.replace(/^(の|は|が|を|に|で|と)/, '').trim();

  if (!kw || kw.length <= 1) {
    return null;
  }

  return kw;
}

/* =========================================================
   2) 過去状態カルテの取得
   - iros_training_samples をメインで参照
   - keyword の場合は situation_summary にキーワードを含むものを優先
   - 0 件なら、キーワードなしで最近 N 件にフォールバック
   - それでも 0 件なら、最終手段として iros_memory_state を見る
========================================================= */

type TrainingSampleRow = {
  created_at: string | null;
  depth_stage: string | null;
  q_code: string | null;
  self_acceptance: number | null;
  situation_summary: string | null;
  situation_topic: string | null;
};

type MemoryStateRow = {
  updated_at: string | null;
  summary: string | null;
  depth_stage: string | null;
  q_primary: string | null;
  self_acceptance: number | null;
  situation_summary: string | null;
  situation_topic: string | null;
};

type SnapshotRow = {
  date: string | null;

  // ★ summary 優先（iros_memory_state.summary）
  summary?: string | null;

  depth_stage: string | null;
  q_primary: string | null;
  self_acceptance: number | null;
  situation_summary: string | null;
  situation_topic: string | null;
};

/**
 * iros_training_samples / iros_memory_state から、
 * ユーザーの最近の状態スナップショットを取得
 */
async function loadRecentSnapshots(args: {
  client: SupabaseClient;
  userCode: string;
  trigger: MemoryRecallTrigger;
  limit?: number;
}): Promise<SnapshotRow[]> {
  const { client, userCode, trigger } = args;
  const limit = args.limit ?? 5;

  /* ---------- ① iros_training_samples をメインで見る ---------- */

  const baseTrainQuery = client
    .from('iros_training_samples')
    .select(
      'created_at, depth_stage, q_code, self_acceptance, situation_summary, situation_topic',
    )
    .eq('user_code', userCode);

  let trainQuery = baseTrainQuery;

  if (trigger.kind === 'keyword' && trigger.keyword) {
    trainQuery = trainQuery.ilike('situation_summary', `%${trigger.keyword}%`);
  }

  let { data: trainData, error: trainError } = await trainQuery
    .order('created_at', { ascending: false })
    .limit(limit);

  if (trainError) {
    console.error('[IROS/MemoryRecall] training_samples load error', {
      userCode,
      error: trainError,
    });
  }

  if (!trainData) {
    trainData = [];
  }

  // keyword で 0 件だった場合 → 最近 N 件にフォールバック
  if (trainData.length === 0 && trigger.kind === 'keyword') {
    const fb = await baseTrainQuery
      .order('created_at', { ascending: false })
      .limit(limit);

    if (fb.error) {
      console.error('[IROS/MemoryRecall] training_samples fallback error', {
        userCode,
        error: fb.error,
      });
    } else if (fb.data) {
      trainData = fb.data;
    }
  }

  if (trainData.length > 0) {
    return (trainData as TrainingSampleRow[]).map((row) => ({
      date: row.created_at,
      summary: null, // training_samples には summary は無い
      depth_stage: row.depth_stage,
      q_primary: row.q_code,
      self_acceptance: row.self_acceptance,
      situation_summary: row.situation_summary,
      situation_topic: row.situation_topic,
    }));
  }

  /* ---------- ② 最終手段として iros_memory_state を見る ---------- */

  const { data: memData, error: memError } = await client
    .from('iros_memory_state')
    .select(
      'updated_at, summary, depth_stage, q_primary, self_acceptance, situation_summary, situation_topic',
    )
    .eq('user_code', userCode)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (memError) {
    console.error('[IROS/MemoryRecall] memory_state load error', {
      userCode,
      error: memError,
    });
    return [];
  }

  if (!memData || memData.length === 0) return [];

  return (memData as MemoryStateRow[]).map((row) => ({
    date: row.updated_at,
    summary: row.summary,
    depth_stage: row.depth_stage,
    q_primary: row.q_primary,
    self_acceptance: row.self_acceptance,
    situation_summary: row.situation_summary,
    situation_topic: row.situation_topic,
  }));
}

/**
 * スナップショット配列から IROS_PAST_STATE_NOTE 文字列を組み立てる
 *
 * ★方針：
 *  - iros_memory_state.summary が取れているなら、それを最優先で LLM に渡す
 *  - summary が無い場合のみ、従来の詳細スナップショット形式にフォールバック
 */
function buildPastStateNoteTextFromSnapshots(args: {
  rows: SnapshotRow[];
  topicLabel?: string | null;
  keyword?: string | null;
}): string | null {
  const { rows, topicLabel, keyword } = args;
  if (!rows || rows.length === 0) return null;

  // ★ summary 最優先（最新=rows[0] 前提：loadRecentSnapshots は新しい順）
  const latest = rows[0];
  const summary =
    typeof latest?.summary === 'string' ? latest.summary.trim() : '';

  if (summary) {
    // summary は「そのまま LLM に渡すテキスト」想定なので、余計な装飾は付けない
    return summary;
  }

  // ---- summary が無い場合のみ、従来ロジック ----
  const lines: string[] = [];

  lines.push('【IROS_PAST_STATE_NOTE】');
  lines.push('');
  lines.push(
    `対象トピック: ${
      topicLabel && topicLabel.trim().length > 0
        ? topicLabel
        : 'その他・ライフ全般'
    }`,
  );
  if (keyword && keyword.trim().length > 0) {
    lines.push(`関連キーワード: 「${keyword}」`);
  }
  lines.push('');
  lines.push(
    '以下は、同じユーザーの過去の状態スナップショットです。（新しいものから順）',
  );
  lines.push('ユーザーにそのまま復唱する必要はありません。');
  lines.push(
    '「以前はどんな状態だったか」「今と何が違うか」を感じ取るための材料としてだけ使ってください。',
  );
  lines.push('');

  for (const row of rows) {
    const dateStr =
      row.date && row.date.length >= 10 ? row.date.slice(0, 10) : '----------';

    const q = row.q_primary ?? '―';
    const depth = row.depth_stage ?? '―';
    const sa =
      typeof row.self_acceptance === 'number'
        ? row.self_acceptance.toFixed(2)
        : '―';
    const memo =
      (row.situation_summary && row.situation_summary.trim()) || '(メモなし)';

    lines.push(`- 日付: ${dateStr}`);
    lines.push(`  Q: ${q} / 深度: ${depth} / SA: ${sa}`);
    lines.push(`  状況メモ: ${memo}`);
    lines.push('');
  }

  return lines.join('\n');
}

/* =========================================================
   3) 外部公開：このターン用の pastStateNote を準備
   - handleIrosReply などから呼び出す想定
========================================================= */

/**
 * このターンのユーザー入力に基づいて、
 * 過去状態カルテ（IROS_PAST_STATE_NOTE）を準備する。
 *
 * 呼び出し側では、結果の pastStateNoteText を
 * meta.extra.pastStateNoteText などに載せて LLM に渡す想定。
 */
export async function preparePastStateNoteForTurn(args: {
  client: SupabaseClient;
  userCode: string;
  userText: string;
  topicLabel?: string | null;
  limit?: number;

  /**
   * ★ 追加：
   * detectMemoryRecallTriggerFromText が 'none' のときに、
   * 強制的に recent_topic へフォールバックするかどうか。
   * - デフォルト true（現要件：毎ターン recent_topic フォールバック）
   * - トークン厳しい時に false にして条件付き運用へ移行できる
   */
  forceRecentTopicFallback?: boolean;
}): Promise<MemoryRecallResult> {
  const { client, userCode, userText, topicLabel } = args;

  // 1) トリガー判定
  let trigger = detectMemoryRecallTriggerFromText(userText);

  const forceFallback =
    typeof args.forceRecentTopicFallback === 'boolean'
      ? args.forceRecentTopicFallback
      : true;

  // ★ ここが今回のポイント：
  //   - kind='none' でも毎ターン recent_topic に倒す（デフォルト true）
  if (trigger.kind === 'none' && forceFallback) {
    console.log(
      '[IROS/MemoryRecall] no explicit trigger in text → fallback to recent_topic',
      { userCode, userText },
    );

    trigger = { kind: 'recent_topic', keyword: null };
  }

  // ★ 強制フォールバックしない運用のときは、none なら即return
  if (trigger.kind === 'none') {
    return {
      hasNote: false,
      pastStateNoteText: null,
      triggerKind: 'none',
      keyword: null,
    };
  }

  // 2) 最近の状態をロード
  const rows = await loadRecentSnapshots({
    client,
    userCode,
    trigger,
    limit: args.limit,
  });

  if (!rows || rows.length === 0) {
    console.log('[IROS/MemoryRecall] no rows for trigger', {
      userCode,
      triggerKind: trigger.kind,
      keyword: trigger.keyword,
    });
    return {
      hasNote: false,
      pastStateNoteText: null,
      triggerKind: trigger.kind,
      keyword: trigger.keyword ?? null,
    };
  }

  // 3) ノート文字列を組み立て（summary 最優先）
  const noteText = buildPastStateNoteTextFromSnapshots({
    rows,
    topicLabel: topicLabel ?? null,
    keyword: trigger.keyword ?? null,
  });

  const hasNote = !!noteText && noteText.trim().length > 0;

  console.log('[IROS/MemoryRecall] pastStateNoteText prepared', {
    userCode,
    hasNote,
    triggerKind: trigger.kind,
    keyword: trigger.keyword,
    usedSummary: typeof rows?.[0]?.summary === 'string' && !!rows[0].summary?.trim(),
  });

  return {
    hasNote,
    pastStateNoteText: hasNote ? noteText! : null,
    triggerKind: trigger.kind,
    keyword: trigger.keyword ?? null,
  };
}
