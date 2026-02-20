// src/lib/iros/remember/generateResonancePeriodBundle.ts
// Iros Remember 用：期間バンドル生成コア
// - 指定期間の iros_messages を集計
// - Qコード/深度の統計 + LLM要約で bundle_json を生成
// - resonance_period_bundles に INSERT して、その行を返す

import type { SupabaseClient } from '@supabase/supabase-js';
import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete';

export type PeriodType = 'day' | 'week' | 'month';

export type ResonancePeriodBundleJson = {
  main_topics: string[];
  representative_sentences: string[];
  q_stats: Record<string, number>;
  depth_stats: Record<string, number>;
  unresolved_points: string[];
  overall_summary: string;
  // 予備フィールド（将来拡張用）
  [key: string]: any;
};

export type GenerateBundleArgs = {
  // ★ v1 系に合わせてジェネリック指定を外す
  supabase: SupabaseClient;
  userCode: string;
  tenantId: string;
  periodType: PeriodType;
  periodStart: string; // ISO文字列 (含む)
  periodEnd: string;   // ISO文字列 (未満)
  model?: string;
};

export type GeneratedBundleRow = {
  id: number;
  period_type: PeriodType;
  period_start: string;
  period_end: string;
  title: string | null;
  summary: string | null;
  q_dominant: string | null;
  q_stats: Record<string, number> | null;
  depth_stats: Record<string, number> | null;
  topics: string[] | null;
  created_at: string;
};

type RawIrosMessage = {
  id: number;
  role: string;
  text: string | null;
  content: string | null;
  q_code: string | null;
  depth_stage: string | null;
  created_at: string;
};

// ヒストグラム作成ユーティリティ
function countHistogram(values: (string | null | undefined)[]) {
  const map = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    const key = String(v);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(map.entries());
}

function pickDominantKey(stats: Record<string, number>): string | null {
  let bestKey: string | null = null;
  let bestVal = 0;
  for (const [k, v] of Object.entries(stats)) {
    if (v > bestVal) {
      bestVal = v;
      bestKey = k;
    }
  }
  return bestKey;
}

// LLM 用のプロンプトを生成
function buildLlmMessages(params: {
  periodType: PeriodType;
  periodStart: string;
  periodEnd: string;
  messages: RawIrosMessage[];
  qStats: Record<string, number>;
  depthStats: Record<string, number>;
}): ChatMessage[] {
  const { periodType, periodStart, periodEnd, messages, qStats, depthStats } =
    params;

  const systemPrompt = `
あなたは「Iros」という対話ログから、
ユーザーの意図の流れと変化をまとめるアナリストAIです。

出力は必ず **日本語の JSON** にしてください。
説明文や前置きやコードブロック記号は書かず、
純粋な JSON オブジェクトだけを返してください。

フィールド構造は次のとおりです：

{
  "title": string,                  // 期間を象徴する短いタイトル
  "overall_summary": string,       // 期間全体の要約（200文字以内）
  "main_topics": string[],         // よく現れたテーマ
  "representative_sentences": string[], // 印象的な発言の要約（実際の生テキストでなく要約）
  "unresolved_points": string[],   // まだ揺れている・未解決の論点
  "q_comment": string | null,      // Qコードの流れから読めるコメント（任意）
  "depth_comment": string | null   // depth_stage の流れから読めるコメント（任意）
}
`.trim();

  // ログを短く要約して LLM に渡す
  const logLines = messages.map((m) => {
    const time = m.created_at;
    const role = m.role;
    const text = (m.text ?? m.content ?? '').replace(/\s+/g, ' ').slice(0, 80);
    const q = m.q_code ?? '-';
    const d = m.depth_stage ?? '-';
    return `[${time}] (${role}) [Q=${q}, D=${d}] ${text}`;
  });

  const userPrompt = `
期間: ${periodType} / ${periodStart} 〜 ${periodEnd}

この期間の Iros ログサマリです：

${logLines.join('\n') || '(ログなし)'}

Qコードの分布:
${JSON.stringify(qStats, null, 2)}

深度(depth_stage)の分布:
${JSON.stringify(depthStats, null, 2)}

上記を参考にして、
「この期間にユーザーの中で何が動いていたか」を
穏やかなトーンでまとめてください。

必ず指定された JSON 構造のみを出力してください。
`.trim();

  const messagesForLlm: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  return messagesForLlm;
}

// メイン関数：期間バンドル生成 + INSERT
export async function generateResonancePeriodBundle(
  args: GenerateBundleArgs,
): Promise<GeneratedBundleRow | null> {
  const {
    supabase,
    userCode,
    tenantId,
    periodType,
    periodStart,
    periodEnd,
  } = args;

  // 1) 対象期間のメッセージ取得（assistant中心だが user もあってよいので roleは絞らない）
  const { data: rows, error: msgErr } = await supabase
    .from('iros_messages')
    .select(
      [
        'id',
        'role',
        'text',
        'content',
        'q_code',
        'depth_stage',
        'created_at',
      ].join(','),
    )
    .eq('user_code', userCode)
    .gte('created_at', periodStart)
    .lt('created_at', periodEnd)
    .order('created_at', { ascending: true });

  if (msgErr) {
    console.error('[generateResonancePeriodBundle] messages query failed', msgErr);
    throw new Error(msgErr.message);
  }

  const messages: RawIrosMessage[] = (rows ?? []) as RawIrosMessage[];

  // 2) 分布を計算
  const qStats = countHistogram(messages.map((m) => m.q_code));
  const depthStats = countHistogram(messages.map((m) => m.depth_stage));
  const dominantQ = pickDominantKey(qStats);

  // 3) LLM に JSON 要約を依頼
  // ★ 初期値を入れておくことで「代入前に使用」エラーを回避
  let bundleJson: ResonancePeriodBundleJson = {
    main_topics: [],
    representative_sentences: [],
    q_stats: qStats,
    depth_stats: depthStats,
    unresolved_points: [],
    overall_summary: '',
  };
  let title: string | null = null;
  let summary: string | null = null;

  if (messages.length === 0) {
    // ログが無ければ LLM は使わず固定メッセージ
    bundleJson = {
      main_topics: [],
      representative_sentences: [],
      q_stats: qStats,
      depth_stats: depthStats,
      unresolved_points: [],
      overall_summary: 'この期間には Iros の記録がありませんでした。',
    };
    title = '記録のない期間';
    summary = bundleJson.overall_summary;
  } else {
    const messagesForLlm = buildLlmMessages({
      periodType,
      periodStart,
      periodEnd,
      messages,
      qStats,
      depthStats,
    });

    const model =
      args.model ||
      process.env.IROS_REMEMBER_MODEL ||
      process.env.OPENAI_MODEL ||
      'gpt-5-mini';

    let raw = '';
    try {
      raw = await chatComplete({
        model,
        messages: messagesForLlm,
        temperature: 0.4,
        max_tokens: 800,
        purpose: 'digest',
      });
    } catch (e: any) {
      console.error(
        '[generateResonancePeriodBundle] LLM call failed, fallback to simple summary',
        e,
      );
      // LLM が落ちた場合の簡易フォールバック
      bundleJson = {
        main_topics: [],
        representative_sentences: [],
        q_stats: qStats,
        depth_stats: depthStats,
        unresolved_points: [],
        overall_summary:
          'この期間の対話ログから、Qコードと深度の分布のみを記録しました。',
      };
      title = 'ログ集約（簡易）';
      summary = bundleJson.overall_summary;
    }

    if (!title) {
      try {
        const parsed = raw ? (JSON.parse(raw) as any) : {};

        const overall_summary =
          typeof parsed.overall_summary === 'string'
            ? parsed.overall_summary
            : '';

        bundleJson = {
          main_topics: Array.isArray(parsed.main_topics)
            ? parsed.main_topics.map((s: any) => String(s))
            : [],
          representative_sentences: Array.isArray(
            parsed.representative_sentences,
          )
            ? parsed.representative_sentences.map((s: any) => String(s))
            : [],
          q_stats: qStats,
          depth_stats: depthStats,
          unresolved_points: Array.isArray(parsed.unresolved_points)
            ? parsed.unresolved_points.map((s: any) => String(s))
            : [],
          overall_summary:
            overall_summary ||
            'この期間の意図の流れを要約しました。（詳細は main_topics を参照）',
          // 任意フィールドも bundle_json に保持
          q_comment: parsed.q_comment ?? null,
          depth_comment: parsed.depth_comment ?? null,
        };

        title =
          typeof parsed.title === 'string' && parsed.title.trim().length > 0
            ? parsed.title.trim()
            : null;
        summary = bundleJson.overall_summary;
      } catch (e) {
        console.error(
          '[generateResonancePeriodBundle] failed to parse LLM JSON, raw=',
          raw,
          e,
        );
        bundleJson = {
          main_topics: [],
          representative_sentences: [],
          q_stats: qStats,
          depth_stats: depthStats,
          unresolved_points: [],
          overall_summary:
            'LLMの要約結果を解釈できなかったため、統計情報のみを記録しました。',
        };
        title = 'ログ集約（パース失敗）';
        summary = bundleJson.overall_summary;
      }
    }
  }

  // topics は main_topics をそのまま流用
  const topics = bundleJson.main_topics;

  // 4) resonance_period_bundles に INSERT
  const { data: inserted, error: insErr } = await supabase
    .from('resonance_period_bundles')
    .insert({
      user_code: userCode,
      tenant_id: tenantId,
      period_type: periodType,
      period_start: periodStart,
      period_end: periodEnd,
      title,
      topics,
      q_dominant: dominantQ,
      q_stats: qStats,
      depth_stats: depthStats,
      summary,
      bundle_json: bundleJson,
    })
    .select(
      [
        'id',
        'period_type',
        'period_start',
        'period_end',
        'title',
        'summary',
        'q_dominant',
        'q_stats',
        'depth_stats',
        'topics',
        'created_at',
      ].join(','),
    )
    .single();

  if (insErr) {
    console.error(
      '[generateResonancePeriodBundle] insert failed',
      insErr,
      bundleJson,
    );
    throw new Error(insErr.message);
  }

  return inserted as GeneratedBundleRow;
}
