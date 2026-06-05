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
import { supabaseServer } from '@/lib/supabaseServer'
import { findSemanticSnapshotsV1 } from '@/lib/iros/memory/semanticRecall';
import { normalizeDiagnosisTargetKey } from '@/lib/iros/memory/normalizeDiagnosisTargetKey';
// ★ 過去記憶トリガー検出 + キーワード抽出

export type MemoryRecallTriggerKind = 'none' | 'recent_topic' | 'keyword' | 'semantic';

export type MemoryRecallTrigger = {
  kind: MemoryRecallTriggerKind;
  keyword?: string | null;
};

export type MemoryRecallResult = {
  hasNote: boolean;
  pastStateNoteText: string | null;
  triggerKind: MemoryRecallTriggerKind | null;
  keyword: string | null;
  matchedTerms?: string[];
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

  // 0) 「◯◯ってなんの話だっけ？ / ◯◯って何だっけ？」系
  // 例:
  // - 逆行ってなんの話だっけ？ -> 逆行
  // - Muverseって何だっけ？   -> Muverse
  const topicQuestionPatterns = [
    /^(.+?)って(?:なんの|何の)?話だっけ\??$/u,
    /^(.+?)って何だっけ\??$/u,
    /^(.+?)ってなんだっけ\??$/u,
    /^(.+?)とは(?:なんの|何の)?話\??$/u,
  ];

  for (const pattern of topicQuestionPatterns) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const keyword = cleanKeyword(m[1]);
      if (keyword) {
        return {
          kind: 'keyword',
          keyword,
        };
      }
    }
  }

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

  // 2) 「前の話 / さっきの件 / この前のやつ」など、
  //    明示的に“過去参照”を含む質問だけ recent_topic にする
  const explicitRecentTopicPatterns = [
    /(前に話した|前に言った|この前の|さっきの|さっき話した|前回の|前の話|あの話|あの件|その件)/u,
    /(なんの話だっけ|何の話だっけ|なんだっけ|何だっけ|でしたっけ|だよね|だったよね)/u,
  ];

  const hasExplicitPastRef = explicitRecentTopicPatterns.some((re) => re.test(text));
  if (hasExplicitPastRef && isQuestionLike(text)) {
    return {
      kind: 'recent_topic',
      keyword: null,
    };
  }

  // 3) それ以外はリコールなし
  //    ※ 普通の質問（例: 真実が知りたい / 地球外生命体の話）は
  //       過去状態リコールに入れない
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

  // ✅ 追加
  is_ir_diagnosis?: boolean | null;
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

  // ✅ 追加
  is_ir_diagnosis?: boolean | null;
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
  userText?: string;
}): Promise<SnapshotRow[]> {
  const { client, userCode, trigger } = args;
  const limit = args.limit ?? 5;

  const normalizeCompareText = (v: unknown): string => {
    return String(v ?? '')
      .trim()
      .replace(/[　\s]+/g, '')
      .replace(/[!?！？。．、,\.\-ー～〜「」『』（）()【】\[\]]/g, '')
      .toLowerCase();
  };

  const currentInputNorm = normalizeCompareText(args.userText);

  const toSnapshotFromTraining = (row: TrainingSampleRow): SnapshotRow => ({
    date: row.created_at,
    summary: null,
    depth_stage: row.depth_stage,
    q_primary: row.q_code,
    self_acceptance: row.self_acceptance,
    situation_summary: row.situation_summary,
    situation_topic: row.situation_topic,
    is_ir_diagnosis: false,
  });

  const toSnapshotFromMemory = (row: MemoryStateRow): SnapshotRow => ({
    date: row.updated_at,
    summary: row.summary,
    depth_stage: row.depth_stage,
    q_primary: row.q_primary,
    self_acceptance: row.self_acceptance,
    situation_summary: row.situation_summary,
    situation_topic: row.situation_topic,
    is_ir_diagnosis: row.is_ir_diagnosis ?? false,
  });

  const filterAndDedupeSnapshots = (rows: SnapshotRow[]): SnapshotRow[] => {
    const filtered = rows.filter((row) => {
      // ✅ ir診断は除外
      if (row.is_ir_diagnosis === true) return false;

      // ✅ situation_summary だけでなく summary も候補にする
      const rawSummary = String(row.situation_summary ?? row.summary ?? '').trim();

      const rawTopic = String(row.situation_topic ?? '').trim();

      const summaryNorm = normalizeCompareText(rawSummary);
      const topicNorm = normalizeCompareText(rawTopic);

      // summary も topic も空なら除外
      if (!summaryNorm && !topicNorm) return false;

      // 現在入力と実質同じ summary / topic は除外
      if (currentInputNorm) {
        if (summaryNorm && summaryNorm === currentInputNorm) return false;
        if (topicNorm && topicNorm === currentInputNorm) return false;
      }

      // 低情報な相槌・短文は除外
      const lowInfoSet = new Set([
        'はい',
        'うん',
        'ok',
        'okay',
        'ありがとう',
        'ありがとうございます',
        'どういたしまして',
        '了解',
        'りょうかい',
        '承知',
        'なるほど',
        'そうなんだ',
        'そうですか',
        'たしかに',
      ]);

      if (rawSummary && lowInfoSet.has(rawSummary.toLowerCase())) return false;

      // summary が短すぎて topic も無いなら除外
      if (summaryNorm.length <= 2 && !topicNorm) return false;

      // keyword recall のときは keyword が summary/topic のどちらかに含まれる候補を優先的に残す
      if (trigger.kind === 'keyword' && trigger.keyword) {
        const kwNorm = normalizeCompareText(trigger.keyword);
        if (kwNorm) {
          const hitSummary = summaryNorm.includes(kwNorm);
          const hitTopic = topicNorm.includes(kwNorm);

          if (!hitSummary && !hitTopic) return false;
        }
      }

      return true;
    });

    const seen = new Set<string>();
    const deduped: SnapshotRow[] = [];

    for (const row of filtered) {
      const key = [
        normalizeCompareText(row.summary),
        normalizeCompareText(row.situation_summary),
        normalizeCompareText(row.situation_topic),
        String(row.depth_stage ?? '').trim(),
        String(row.q_primary ?? '').trim(),
      ].join('|');

      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(row);
    }

    return deduped.slice(0, limit);
  };
  /* ---------- ① iros_training_samples をメインで見る ---------- */

  const baseTrainQuery = client
    .from('iros_training_samples')
    .select(
      'created_at, depth_stage, q_code, self_acceptance, situation_summary, situation_topic',
    )
    .eq('user_code', userCode);

  let trainQuery = baseTrainQuery;

  if (trigger.kind === 'keyword' && trigger.keyword) {
    const kw = `%${trigger.keyword}%`;

    trainQuery = trainQuery.or(
      [
        `situation_summary.ilike.${kw}`,
        `situation_topic.ilike.${kw}`
      ].join(',')
    );
  }

  let { data: trainData, error: trainError } = await trainQuery
    .order('created_at', { ascending: false })
    .limit(limit * 3);

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
      .limit(limit * 3);

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
    const snapshots = (trainData as TrainingSampleRow[]).map(toSnapshotFromTraining);
    const cleaned = filterAndDedupeSnapshots(snapshots);

    if (cleaned.length > 0) {
      return cleaned;
    }
  }

  /* ---------- ② 最終手段として iros_memory_state を見る ---------- */

  const { data: memData, error: memError } = await client
    .from('iros_memory_state')
    .select(
      'updated_at, summary, depth_stage, q_primary, self_acceptance, situation_summary, situation_topic',
    )
    .eq('user_code', userCode)
    .order('updated_at', { ascending: false })
    .limit(limit * 3);

  if (memError) {
    console.error('[IROS/MemoryRecall] memory_state load error', {
      userCode,
      error: memError,
    });
    return [];
  }

  if (!memData || memData.length === 0) return [];

  const snapshots = (memData as MemoryStateRow[]).map(toSnapshotFromMemory);
  return filterAndDedupeSnapshots(snapshots);
}

// ========================================
// 🔶 IrDiagnosisSnapshot 型
// ========================================
export type IrDiagnosisSnapshot = {
  target: string | null;
  observation: string | null;
  state: string | null;
  summary: string | null;
  createdAt: string | null;
  diagnosisResultId?: number | null;
  targetKey?: string | null;
  qPrimary?: string | null;
  depthStage?: string | null;
  phase?: string | null;
};

function normalizeIrDiagnosisTargetForMatch(value: unknown): string {
  return String(value ?? '')
    .replace(/[\s　]+/g, '')
    .trim()
    .toLowerCase();
}

function pickIrMetaFromMessageMeta(meta: any): any | null {
  const candidates = [
    meta?.extra?.irMeta,
    meta?.extra?.ctxPack?.irMeta,
    meta?.ctxPack?.irMeta,
    meta?.irMeta,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') return candidate;
  }

  return null;
}

function snapshotFromIrMetaAndMessage(row: any, irMeta: any): IrDiagnosisSnapshot | null {
  const snapshot: IrDiagnosisSnapshot = {
    target: typeof irMeta?.targetLabel === 'string' ? irMeta.targetLabel : null,
    observation:
      typeof irMeta?.observationResult === 'string'
        ? irMeta.observationResult
        : null,
    state:
      typeof irMeta?.awarenessText === 'string'
        ? irMeta.awarenessText
        : null,
    summary:
      typeof irMeta?.summaryText === 'string'
        ? irMeta.summaryText
        : typeof row?.text === 'string' && row.text.trim()
          ? row.text.trim()
          : typeof row?.content === 'string' && row.content.trim()
            ? row.content.trim()
            : null,
    createdAt:
      typeof row?.created_at === 'string'
        ? row.created_at
        : null,
  };

  const hasDiagnosisSnapshot =
    snapshot.target !== null ||
    snapshot.observation !== null ||
    snapshot.state !== null ||
    snapshot.summary !== null;

  return hasDiagnosisSnapshot ? snapshot : null;
}

// ========================================
// 🔶 loadLatestIrDiagnosisSnapshot
// ========================================
export async function loadLatestIrDiagnosisSnapshot(
  supabase: any,
  userCode: string,
  targetLabel?: string | null
): Promise<IrDiagnosisSnapshot | null> {
  const requestedTarget = normalizeIrDiagnosisTargetForMatch(targetLabel);
  const requestedTargetKey = normalizeDiagnosisTargetKey(targetLabel);

  try {
    let diagnosisResultQuery = supabase
      .from('iros_ir_diagnosis_results')
      .select('id, target_label, target_key, q_primary, depth_stage, phase, diagnosis_text, diagnosis_json, created_at')
      .eq('owner_user_code', userCode)
      .order('created_at', { ascending: false })
      .limit(1);

    if (requestedTargetKey) {
      diagnosisResultQuery = diagnosisResultQuery.eq('target_key', requestedTargetKey);
    }

    const { data: diagnosisResultRow, error: diagnosisResultError } =
      await diagnosisResultQuery.maybeSingle();

    if (diagnosisResultError) {
      console.warn('[IROS][loadLatestIrDiagnosisSnapshot] diagnosis_results query error', {
        userCode,
        targetLabel,
        requestedTargetKey,
        error: diagnosisResultError,
      });
    } else if (diagnosisResultRow) {
      const diagnosisJson = (diagnosisResultRow as any)?.diagnosis_json ?? null;
      const irMeta = diagnosisJson?.irMeta ?? diagnosisJson?.baseDiagExtra?.irMeta ?? null;

      const snapshot: IrDiagnosisSnapshot = {
        diagnosisResultId:
          typeof (diagnosisResultRow as any)?.id === 'number'
            ? (diagnosisResultRow as any).id
            : null,
        target:
          (typeof (diagnosisResultRow as any)?.target_label === 'string'
            ? (diagnosisResultRow as any).target_label
            : null) ??
          (typeof irMeta?.targetLabel === 'string' ? irMeta.targetLabel : null),
        targetKey:
          typeof (diagnosisResultRow as any)?.target_key === 'string'
            ? (diagnosisResultRow as any).target_key
            : null,
        qPrimary:
          typeof (diagnosisResultRow as any)?.q_primary === 'string'
            ? (diagnosisResultRow as any).q_primary
            : null,
        depthStage:
          typeof (diagnosisResultRow as any)?.depth_stage === 'string'
            ? (diagnosisResultRow as any).depth_stage
            : null,
        phase:
          typeof (diagnosisResultRow as any)?.phase === 'string'
            ? (diagnosisResultRow as any).phase
            : null,
        observation:
          typeof irMeta?.observationResult === 'string'
            ? irMeta.observationResult
            : null,
        state:
          typeof irMeta?.awarenessText === 'string'
            ? irMeta.awarenessText
            : null,
        summary:
          typeof (diagnosisResultRow as any)?.diagnosis_text === 'string'
            ? (diagnosisResultRow as any).diagnosis_text
            : typeof irMeta?.summaryText === 'string'
              ? irMeta.summaryText
              : null,
        createdAt:
          typeof (diagnosisResultRow as any)?.created_at === 'string'
            ? (diagnosisResultRow as any).created_at
            : null,
      };

      const hasDiagnosisSnapshot =
        snapshot.target !== null ||
        snapshot.observation !== null ||
        snapshot.state !== null ||
        snapshot.summary !== null;

      if (hasDiagnosisSnapshot) return snapshot;
    }

    if (requestedTarget) {
      const { data: messageRows, error: messageError } = await supabase
        .from('iros_messages')
        .select('text, content, meta, created_at')
        .eq('user_code', userCode)
        .eq('role', 'assistant')
        .order('created_at', { ascending: false })
        .limit(80);

      if (messageError) {
        console.warn('[IROS][loadLatestIrDiagnosisSnapshot] message query error', {
          userCode,
          targetLabel,
          error: messageError,
        });
      } else {
        const rows = Array.isArray(messageRows) ? messageRows : [];

        for (const row of rows) {
          const irMeta = pickIrMetaFromMessageMeta((row as any)?.meta);
          if (!irMeta) continue;

          const rowTarget = normalizeIrDiagnosisTargetForMatch(irMeta?.targetLabel);
          if (!rowTarget || rowTarget !== requestedTarget) continue;

          const snapshot = snapshotFromIrMetaAndMessage(row, irMeta);
          if (snapshot) return snapshot;
        }
      }
    }

    return null;
  } catch (e) {
    console.warn('[IROS][loadLatestIrDiagnosisSnapshot] failed', e);
    return null;
  }
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
  triggerKind?: MemoryRecallTriggerKind | null;
  matchedTerms?: string[] | null;
}): string | null {
  const { rows, topicLabel, keyword, triggerKind, matchedTerms } = args;
  if (!rows || rows.length === 0) return null;

  // ★ summary 最優先（最新=rows[0] 前提：loadRecentSnapshots は新しい順）
  const latest = rows[0];
  const summary =
    typeof latest?.summary === 'string' ? latest.summary.trim() : '';

  if (summary) {
    if (triggerKind === 'semantic') {
      const semanticLines: string[] = [summary];

      if (matchedTerms && matchedTerms.length > 0) {
        semanticLines.push('');
        semanticLines.push(`関連トリガー: semantic`);
        semanticLines.push(`一致語: ${matchedTerms.slice(0, 6).join(', ')}`);
      }

      return semanticLines.join('\n');
    }

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
  if (triggerKind === 'semantic') {
    lines.push(`関連トリガー: semantic`);
    if (matchedTerms && matchedTerms.length > 0) {
      lines.push(`一致語: ${matchedTerms.slice(0, 6).join(', ')}`);
    }
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
  conversationLine?: string | null;
  topicDigest?: string | null;
  situationTopic?: string | null;
  depthStage?: string | null;

  /**
   * ★ 追加：
   * detectMemoryRecallTriggerFromText が 'none' のときに、
   * 強制的に recent_topic へフォールバックするかどうか。
   * - デフォルト true（現要件：毎ターン recent_topic フォールバック）
   * - トークン厳しい時に false にして条件付き運用へ移行できる
   */
  forceRecentTopicFallback?: boolean;
}): Promise<MemoryRecallResult> {
  const {
    client,
    userCode,
    userText,
    topicLabel,
    conversationLine,
    topicDigest,
    situationTopic,
    depthStage,
  } = args;

  // 1) トリガー判定
  let trigger = detectMemoryRecallTriggerFromText(userText);

  const forceFallback =
    typeof args.forceRecentTopicFallback === 'boolean'
      ? args.forceRecentTopicFallback
      : true;

  // ✅ 明示指定がある場合だけ recent_topic に倒す
  // - 通常の知識質問・構造質問では pastStateRecall を混ぜない
  // - 「覚えてる？」「前の話だっけ？」のような明示トリガーは
  //   detectMemoryRecallTriggerFromText() 側で拾う
  if (trigger.kind === 'none' && forceFallback) {
    console.log(
      '[IROS/MemoryRecall] no explicit trigger in text → fallback to recent_topic',
      { userCode, userText },
    );

    trigger = { kind: 'recent_topic', keyword: null };
  }

  // 2) 最近の状態をロード
  const rows = await loadRecentSnapshots({
    client,
    userCode,
    trigger,
    limit: args.limit,
    userText,
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
      matchedTerms: [],
    };
  }

  // 3) semantic rerank
  let finalRows = rows;
  let finalTriggerKind: MemoryRecallTriggerKind = trigger.kind;
  let matchedTerms: string[] = [];

  const semantic = findSemanticSnapshotsV1({
    userText,
    conversationLine: conversationLine ?? null,
    topicDigest: topicDigest ?? null,
    situationTopic: situationTopic ?? null,
    depthStage: depthStage ?? null,
    snapshots: rows.map((row) => ({
      summary: row.summary ?? row.situation_summary ?? null,
      topic: row.situation_topic ?? null,
      situation_summary: row.situation_summary ?? null,
      situation_topic: row.situation_topic ?? null,
      depth_stage: row.depth_stage ?? null,
      q_code: row.q_primary ?? null,
      raw: row,
    })),
    minScore: 4,
    topN: Math.min(args.limit ?? 3, 3),
  });

  if (semantic.hits.length > 0) {
    const semanticRows = semantic.hits
      .map((hit) => (hit.raw ?? null) as SnapshotRow | null)
      .filter((v): v is SnapshotRow => !!v);

    if (semanticRows.length > 0) {
      finalRows = semanticRows;
      finalTriggerKind = 'semantic';
      matchedTerms = semantic.matchedTerms ?? [];
    }
  }

  // 4) ノート文字列を組み立て（summary 最優先）
  const noteText = buildPastStateNoteTextFromSnapshots({
    rows: finalRows,
    topicLabel: topicLabel ?? null,
    keyword: trigger.keyword ?? null,
    triggerKind: finalTriggerKind,
    matchedTerms,
  });

  const hasNote = !!noteText && noteText.trim().length > 0;

  // ✅ 最終ガード:
  // trigger が none のままなら、note は返さない
  // - 通常の知識質問 / 構造質問に pastStateNote を混ぜない
  // - 明示的な recall（keyword / recent_topic / semantic）のときだけ返す
  if (finalTriggerKind === 'none' && !hasNote) {
    console.log('[IROS/MemoryRecall] note suppressed by finalTriggerKind=none', {
      userCode,
      hasNote_raw: hasNote,
      keyword: trigger.keyword,
      matchedTerms,
      semanticBestScore: semantic.bestScore,
    });

    return {
      hasNote: false,
      pastStateNoteText: null,
      triggerKind: 'none',
      keyword: trigger.keyword ?? null,
      matchedTerms: [],
    };
  }

  console.log('[IROS/MemoryRecall] pastStateNoteText prepared', {
    userCode,
    hasNote,
    triggerKind_requested: trigger.kind,
    triggerKind_final: finalTriggerKind,
    keyword: trigger.keyword,
    matchedTerms,
    semanticBestScore: semantic.bestScore,
    usedSummary:
      typeof finalRows?.[0]?.summary === 'string' &&
      !!finalRows[0].summary?.trim(),
  });

  return {
    hasNote,
    pastStateNoteText: hasNote ? noteText : null,
    triggerKind: finalTriggerKind,
    keyword: trigger.keyword ?? null,
    matchedTerms,
  };
}

export type IrDiagnosisInventoryItem = {
  id: number | null;
  targetLabel: string | null;
  targetKey: string | null;
  qPrimary: string | null;
  depthStage: string | null;
  phase: string | null;
  diagnosisTextHead: string | null;
  createdAt: string | null;
};

export type IrDiagnosisInventorySnapshot = {
  totalCount: number;
  recent: IrDiagnosisInventoryItem[];
  hasMore: boolean;
  error?: string | null;
};

// 🔶 loadIrDiagnosisInventorySnapshot
// 保存済みir診断の「件数」と「直近リスト」を取得する。
// 最新1件ではなく、ユーザーが「どれくらい持ってる？」「一覧ある？」と聞いた時の正本。
export async function loadIrDiagnosisInventorySnapshot(
  supabase: any,
  userCode: string,
  limit = 10
): Promise<IrDiagnosisInventorySnapshot> {
  const ownerUserCode = String(userCode ?? '').trim();
  const safeLimit = Math.max(1, Math.min(30, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 10));

  if (!ownerUserCode) {
    return {
      totalCount: 0,
      recent: [],
      hasMore: false,
      error: 'missing_user_code',
    };
  }

  try {
    const { data, error, count } = await supabase
      .from('iros_ir_diagnosis_results')
      .select(
        'id, target_label, target_key, q_primary, depth_stage, phase, diagnosis_text, created_at',
        { count: 'exact' }
      )
      .eq('owner_user_code', ownerUserCode)
      .order('created_at', { ascending: false })
      .limit(safeLimit);

    if (error) {
      console.warn('[IROS][loadIrDiagnosisInventorySnapshot] query error', {
        userCode: ownerUserCode,
        limit: safeLimit,
        error,
      });

      return {
        totalCount: 0,
        recent: [],
        hasMore: false,
        error: String(error?.message ?? error),
      };
    }

    const rows = Array.isArray(data) ? data : [];
    const totalCount = typeof count === 'number' ? count : rows.length;

    const recent: IrDiagnosisInventoryItem[] = rows.map((row: any) => ({
      id: typeof row?.id === 'number' ? row.id : null,
      targetLabel: typeof row?.target_label === 'string' ? row.target_label : null,
      targetKey: typeof row?.target_key === 'string' ? row.target_key : null,
      qPrimary: typeof row?.q_primary === 'string' ? row.q_primary : null,
      depthStage: typeof row?.depth_stage === 'string' ? row.depth_stage : null,
      phase: typeof row?.phase === 'string' ? row.phase : null,
      diagnosisTextHead:
        typeof row?.diagnosis_text === 'string'
          ? row.diagnosis_text.slice(0, 160)
          : null,
      createdAt: typeof row?.created_at === 'string' ? row.created_at : null,
    }));

    return {
      totalCount,
      recent,
      hasMore: totalCount > recent.length,
      error: null,
    };
  } catch (e) {
    console.warn('[IROS][loadIrDiagnosisInventorySnapshot] failed', e);

    return {
      totalCount: 0,
      recent: [],
      hasMore: false,
      error: String((e as any)?.message ?? e),
    };
  }
}

export type IrDiagnosisDetailLookupArgs = {
  id?: number | null;
  targetLabel?: string | null;
  depthStage?: string | null;
  createdDate?: string | null;
};

export type IrDiagnosisDetailSnapshot = {
  found: boolean;
  id: number | null;
  targetLabel: string | null;
  targetKey: string | null;
  qPrimary: string | null;
  depthStage: string | null;
  phase: string | null;
  diagnosisText: string | null;
  diagnosisTextHead: string | null;
  createdAt: string | null;
  error?: string | null;
};

// 🔶 loadIrDiagnosisDetailSnapshot
// 診断一覧の1行を指定された時に、該当する保存済みir診断の本文を取得する。
export async function loadIrDiagnosisDetailSnapshot(
  supabase: any,
  userCode: string,
  lookup: IrDiagnosisDetailLookupArgs
): Promise<IrDiagnosisDetailSnapshot> {
  const ownerUserCode = String(userCode ?? '').trim();
  const id = Number(lookup?.id ?? 0);
  const targetLabel = String(lookup?.targetLabel ?? '').trim();
  const depthStage = String(lookup?.depthStage ?? '').trim();
  const createdDate = String(lookup?.createdDate ?? '').trim();

  if (!ownerUserCode) {
    return {
      found: false,
      id: null,
      targetLabel: null,
      targetKey: null,
      qPrimary: null,
      depthStage: null,
      phase: null,
      diagnosisText: null,
      diagnosisTextHead: null,
      createdAt: null,
      error: 'missing_user_code',
    };
  }

  try {
    let query = supabase
      .from('iros_ir_diagnosis_results')
      .select('id, target_label, target_key, q_primary, depth_stage, phase, diagnosis_text, created_at')
      .eq('owner_user_code', ownerUserCode);

    if (Number.isFinite(id) && id > 0) {
      query = query.eq('id', Math.trunc(id));
    } else {
      if (targetLabel) {
        query = query.eq('target_label', targetLabel);
      }

      if (depthStage) {
        query = query.eq('depth_stage', depthStage);
      }

      if (/^\d{4}-\d{2}-\d{2}$/.test(createdDate)) {
        const dayStart = new Date(createdDate + 'T00:00:00.000Z');
        if (!Number.isNaN(dayStart.getTime())) {
          const nextDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
          query = query
            .gte('created_at', dayStart.toISOString())
            .lt('created_at', nextDay.toISOString());
        }
      }
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      console.warn('[IROS][loadIrDiagnosisDetailSnapshot] query error', {
        userCode: ownerUserCode,
        lookup,
        error,
      });

      return {
        found: false,
        id: null,
        targetLabel: targetLabel || null,
        targetKey: null,
        qPrimary: null,
        depthStage: depthStage || null,
        phase: null,
        diagnosisText: null,
        diagnosisTextHead: null,
        createdAt: null,
        error: String(error?.message ?? error),
      };
    }

    const row = Array.isArray(data) ? data[0] : null;
    const diagnosisText =
      typeof row?.diagnosis_text === 'string' ? row.diagnosis_text : null;

    return {
      found: Boolean(row),
      id: typeof row?.id === 'number' ? row.id : null,
      targetLabel: typeof row?.target_label === 'string' ? row.target_label : null,
      targetKey: typeof row?.target_key === 'string' ? row.target_key : null,
      qPrimary: typeof row?.q_primary === 'string' ? row.q_primary : null,
      depthStage: typeof row?.depth_stage === 'string' ? row.depth_stage : null,
      phase: typeof row?.phase === 'string' ? row.phase : null,
      diagnosisText,
      diagnosisTextHead: diagnosisText ? diagnosisText.slice(0, 160) : null,
      createdAt: typeof row?.created_at === 'string' ? row.created_at : null,
      error: null,
    };
  } catch (e) {
    console.warn('[IROS][loadIrDiagnosisDetailSnapshot] failed', e);

    return {
      found: false,
      id: null,
      targetLabel: targetLabel || null,
      targetKey: null,
      qPrimary: null,
      depthStage: depthStage || null,
      phase: null,
      diagnosisText: null,
      diagnosisTextHead: null,
      createdAt: null,
      error: String((e as any)?.message ?? e),
    };
  }
}
