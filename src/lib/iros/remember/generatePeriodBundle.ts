// src/lib/iros/remember/generatePeriodBundle.ts
// Rememberモード用：期間バンドル（resonance_period_bundles）生成ユーティリティ
//
// - unified_resonance_logs から指定ユーザー＆期間のログを取得
// - Qコード／深度の分布を集計
// - chatComplete で「期間まとめJSON(bundle_json)」を生成
// - resonance_period_bundles に 1件 insert して、そのレコードを返す

import { SupabaseClient } from '@supabase/supabase-js';
import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete';

export type PeriodType = 'day' | 'week' | 'month' | 'custom';

export type ResonancePeriodBundleJson = {
  main_topics: string[];
  representative_sentences: string[];
  overall_summary: string;
  unresolved_points?: string[];
  q_stats?: Record<string, number>;
  depth_stats?: Record<string, number>;
};

export type ResonancePeriodBundleRow = {
  id: number;
  user_code: string;
  tenant_id: string | null;
  period_type: string;
  period_start: string;
  period_end: string;
  title: string | null;
  topics: unknown | null;
  q_dominant: string | null;
  q_stats: unknown | null;
  depth_stats: unknown | null;
  summary: string | null;
  bundle_json: unknown | null;
  created_at: string;
  updated_at: string;
};

type QCodeJson = {
  currentQ?: string;
  depthStage?: string;
  [key: string]: unknown;
};

type ResonanceLogRow = {
  id: number | string;
  user_code: string;
  tenant_id?: string | null;
  created_at: string;
  content?: string | null;
  text?: string | null;
  q_code?: string | QCodeJson | null;
  depth_stage?: string | null;
};

export type GenerateBundleArgs = {
  supabase: SupabaseClient;
  userCode: string;
  tenantId?: string | null;
  periodType: PeriodType;
  periodStart: Date | string;
  periodEnd: Date | string;
  titleHint?: string;
  maxLogsForSummary?: number;
};

/**
 * 指定ユーザー＆期間の unified_resonance_logs を集約し、
 * resonance_period_bundles に 1 件 insert して、そのレコードを返す。
 */
export async function generateResonancePeriodBundle(
  args: GenerateBundleArgs
): Promise<ResonancePeriodBundleRow | null> {
  const {
    supabase,
    userCode,
    tenantId,
    periodType,
    periodStart,
    periodEnd,
    titleHint,
    maxLogsForSummary = 100,
  } = args;

  const periodStartIso =
    typeof periodStart === 'string'
      ? new Date(periodStart).toISOString()
      : periodStart.toISOString();
  const periodEndIso =
    typeof periodEnd === 'string'
      ? new Date(periodEnd).toISOString()
      : periodEnd.toISOString();

  // 1. 対象期間のログ取得
  const { data: logs, error: logsError } = await supabase
    .from('unified_resonance_logs')
    .select(
      [
        'id',
        'user_code',
        'tenant_id',
        'created_at',
        'content',
        'text',
        'q_code',
        'depth_stage',
      ].join(', ')
    )
    .eq('user_code', userCode)
    .gte('created_at', periodStartIso)
    .lt('created_at', periodEndIso)
    .order('created_at', { ascending: true });

  if (logsError) {
    console.error('[generateResonancePeriodBundle] failed to fetch logs', logsError);
    throw logsError;
  }

  if (!logs || logs.length === 0) {
    return null;
  }

  const typedLogs = logs as unknown as ResonanceLogRow[];

  // 2. Qコード / 深度の分布を集計
  const qStats: Record<string, number> = {};
  const depthStats: Record<string, number> = {};

  for (const row of typedLogs) {
    let qCode: string | undefined;
    let depthStage: string | undefined;

    if (typeof row.q_code === 'string') {
      qCode = row.q_code;
    } else if (row.q_code && typeof row.q_code === 'object') {
      const qc = row.q_code as QCodeJson;
      if (typeof qc.currentQ === 'string') qCode = qc.currentQ;
      if (typeof qc.depthStage === 'string') depthStage = qc.depthStage;
    }

    if (!depthStage && typeof row.depth_stage === 'string') {
      depthStage = row.depth_stage;
    }

    if (qCode) {
      qStats[qCode] = (qStats[qCode] ?? 0) + 1;
    }
    if (depthStage) {
      depthStats[depthStage] = (depthStats[depthStage] ?? 0) + 1;
    }
  }

  const qDominant =
    Object.keys(qStats).length > 0
      ? Object.entries(qStats).sort((a, b) => b[1] - a[1])[0][0]
      : null;

  // 3. LLM に渡すログ（本文）を整形（上限 maxLogsForSummary 件）
  const slicedLogs = typedLogs.slice(-maxLogsForSummary);

  const logSummaries = slicedLogs.map((row) => {
    const text = row.content ?? row.text ?? '';
    let qCode: string | undefined;
    let depthStage: string | undefined;

    if (typeof row.q_code === 'string') {
      qCode = row.q_code;
    } else if (row.q_code && typeof row.q_code === 'object') {
      const qc = row.q_code as QCodeJson;
      if (typeof qc.currentQ === 'string') qCode = qc.currentQ;
      if (typeof qc.depthStage === 'string') depthStage = qc.depthStage;
    }

    if (!depthStage && typeof row.depth_stage === 'string') {
      depthStage = row.depth_stage;
    }

    return {
      created_at: row.created_at,
      text,
      q_code: qCode ?? null,
      depth_stage: depthStage ?? null,
    };
  });

  // 4. LLMに期間バンドルJSONを生成させる
  const systemPrompt = `
あなたは「期間内の相談ログ」を要約して構造化JSONを作るアシスタントです。

- 入力されるのは、あるユーザーの一定期間のログ一覧です。
- あなたの役割は、この期間の「テーマ・流れ・未解決点」を抽出し、
  下記の JSON 形式で返すことです。

出力は必ず **JSONのみ** で返してください。

{
  "main_topics": [string, ...],
  "representative_sentences": [string, ...],
  "overall_summary": string,
  "unresolved_points": [string, ...]
}
`.trim();

  const userPrompt = `
以下は、あるユーザーの期間ログです。
これらを読んで、指定された JSON フォーマットでまとめを作ってください。

期間情報:
- period_type: ${periodType}
- period_start: ${periodStartIso}
- period_end: ${periodEndIso}
- user_code: ${userCode}
- tenant_id: ${tenantId ?? 'null'}

Qコード分布 (参考用):
${JSON.stringify(qStats, null, 2)}

深度分布 (参考用):
${JSON.stringify(depthStats, null, 2)}

ログ一覧 (最大 ${maxLogsForSummary} 件・古い順):
${JSON.stringify(logSummaries, null, 2)}
`.trim();

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  // 🔴 ここをあなたの chatComplete の仕様に合わせて修正
  const rawText = await chatComplete({
    model: process.env.OPENAI_API_MODEL || 'gpt-4.1-mini', // ※必要に応じて変更
    messages,
  });

  let bundleJson: ResonancePeriodBundleJson;
  try {
    bundleJson = JSON.parse(rawText) as ResonancePeriodBundleJson;
  } catch (e) {
    console.error(
      '[generateResonancePeriodBundle] failed to parse LLM JSON. rawText=',
      rawText
    );
    throw e;
  }

  const title =
    titleHint ??
    buildDefaultTitle({
      periodType,
      periodStartIso,
      periodEndIso,
    });

  const summary = bundleJson.overall_summary ?? null;

  // 6. Supabase に insert
  const insertPayload = {
    user_code: userCode,
    tenant_id: tenantId ?? null,
    period_type: periodType,
    period_start: periodStartIso,
    period_end: periodEndIso,
    title,
    topics: bundleJson.main_topics ?? [],
    q_dominant: qDominant,
    q_stats: qStats,
    depth_stats: depthStats,
    summary,
    bundle_json: bundleJson,
  };

  const { data: inserted, error: insertError } = await supabase
    .from('resonance_period_bundles')
    .insert(insertPayload)
    .select('*')
    .single();

  if (insertError) {
    console.error(
      '[generateResonancePeriodBundle] failed to insert resonance_period_bundles',
      insertError
    );
    throw insertError;
  }

  return inserted as ResonancePeriodBundleRow;
}

function buildDefaultTitle(args: {
  periodType: PeriodType;
  periodStartIso: string;
  periodEndIso: string;
}): string {
  const { periodType, periodStartIso, periodEndIso } = args;
  const start = new Date(periodStartIso);
  const end = new Date(periodEndIso);

  const pad = (n: number) => String(n).padStart(2, '0');

  const y = start.getFullYear();
  const m = pad(start.getMonth() + 1);
  const d = pad(start.getDate());

  if (periodType === 'day') {
    return `${y}年${m}月${d}日：Rememberログ`;
  }
  if (periodType === 'week') {
    return `${y}年${m}月${d}日〜${end.getFullYear()}年${pad(
      end.getMonth() + 1
    )}月${pad(end.getDate())}日：Rememberログ（週）`;
  }
  if (periodType === 'month') {
    return `${y}年${m}月：Rememberログ（月）`;
  }
  return `${y}年${m}月${d}日〜${end.getFullYear()}年${pad(
    end.getMonth() + 1
  )}月${pad(end.getDate())}日：Rememberログ`;
}
