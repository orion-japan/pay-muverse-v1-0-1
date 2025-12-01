// src/lib/iros/topicChange.ts
// Iros Topic Change モジュール（前回 / 今回の変化を比較するための部品）

import type { SupabaseClient } from '@supabase/supabase-js';

/* ========= 型定義 ========= */

export type TopicPhase = 'Inner' | 'Outer' | null;
export type TopicImportance = 'casual' | 'important' | 'critical';

export type TopicSnapshot = {
  createdAt: string | null;
  qCode: string | null;
  depthStage: string | null;
  selfAcceptance: number | null;
  summary: string | null;
};

export type TopicChangeContext = {
  userCode: string;
  topicKey: string;
  topicLabel?: string | null;
  /** importance はとりあえず latest 側の値 or null */
  importance?: TopicImportance | null;
  previous: TopicSnapshot;
  current: TopicSnapshot;
};

/** iros_training_samples の行イメージ（必要な最低限だけ） */
type IrosTrainingSampleRow = {
  id: string;
  user_code: string;
  conversation_id: string | null;
  created_at: string | null;
  q_code: string | null;
  depth_stage: string | null;
  self_acceptance: number | string | null;
  situation_summary: string | null;
  situation_topic: string | null;
};

/* ========= トリガー検出 ========= */

/**
 * ユーザー発話から「変化を一緒に見て欲しい」系のリクエストを検出。
 */
export function detectTopicChangeRequest(userText: string): boolean {
  const text = (userText || '').toLowerCase();

  const patterns: RegExp[] = [
    /変化を一緒に見て/,
    /変化を一緒にみて/,
    /変化を見てもらえますか/,
    /変化をみてもらえますか/,
    /変化を見てほしい/,
    /変化をみてほしい/,
    /今の変化を.*見て/,

    /see the change/,
    /look at the change/,
  ];

  return patterns.some((re) => re.test(text));
}

/* ========= TopicChangeContext 読み込み ========= */

export type LoadTopicChangeParams = {
  /** Supabase クライアント（サービスロールでも normal でも OK） */
  client: SupabaseClient;
  userCode: string;
  /** situation_topic として保存されている値（例: "仕事・キャリア"） */
  topicKey: string;
  /** 表示用ラベルが別である場合に渡す（なければ topicKey をそのまま使う想定） */
  topicLabel?: string | null;
  /** 直近何件から previous / current を作るか（デフォルト 2） */
  limit?: number;
};

/**
 * 同一 topic の直近 N 件（デフォルト 2 件）から
 * 「previous / current」構造を組み立てる。
 *
 * 2 件未満しかデータがない場合は null を返す。
 */
export async function loadTopicChangeContext(
  params: LoadTopicChangeParams,
): Promise<TopicChangeContext | null> {
  const { client, userCode, topicKey, topicLabel, limit = 2 } = params;

  const { data, error } = await client
    .from('iros_training_samples')
    .select(
      [
        'id',
        'user_code',
        'conversation_id',
        'created_at',
        'q_code',
        'depth_stage',
        'self_acceptance',
        'situation_summary',
        'situation_topic',
      ].join(', '),
    )
    .eq('user_code', userCode)
    .eq('situation_topic', topicKey)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[IROS/TopicChange] select error', error);
    return null;
  }

  const rows = (data || []) as IrosTrainingSampleRow[];

  if (!rows || rows.length < 2) {
    // 変化を見るには最低 2 点必要
    return null;
  }

  // rows[0] = 最新, rows[1] = 1 つ前
  const [latest, previous] = rows;

  const snapshotFromRow = (row: IrosTrainingSampleRow): TopicSnapshot => ({
    createdAt: row.created_at,
    qCode: row.q_code,
    depthStage: row.depth_stage,
    selfAcceptance:
      typeof row.self_acceptance === 'number'
        ? row.self_acceptance
        : row.self_acceptance == null
          ? null
          : Number.isNaN(Number(row.self_acceptance))
            ? null
            : Number(row.self_acceptance),
    summary: row.situation_summary,
  });

  const ctx: TopicChangeContext = {
    userCode,
    topicKey,
    topicLabel: topicLabel ?? topicKey,
    importance: null,
    previous: snapshotFromRow(previous),
    current: snapshotFromRow(latest),
  };

  return ctx;
}

/* ========= LLM プロンプト用ヘルパー ========= */

export function formatTopicChangeForPrompt(ctx: TopicChangeContext): string {
  const { topicLabel, previous, current } = ctx;

  const saPrev = previous.selfAcceptance;
  const saCurr = current.selfAcceptance;

  const saDiff =
    saPrev != null && saCurr != null ? saCurr - saPrev : null;

  const saTrend =
    saDiff == null
      ? '自己受容度の数値的な変化は判定できません。'
      : saDiff > 0
        ? '自己受容度は、前回よりもわずかに「上がっている」傾向があります。'
        : saDiff < 0
          ? '自己受容度は、前回よりも少し「揺れている」ように見えますが、ベースは維持されています。'
          : '自己受容度は、数値上はほぼ変わらず安定しています。';

  return [
    `◆ トピック: ${topicLabel ?? ctx.topicKey}`,
    '',
    '【前回のスナップショット】',
    `- Qコード: ${previous.qCode ?? '不明'}`,
    `- 深度: ${previous.depthStage ?? '不明'}`,
    `- 時点: ${previous.createdAt ?? '不明'}`,
    `- 状況要約: ${previous.summary ?? '（要約なし）'}`,
    '',
    '【今回のスナップショット】',
    `- Qコード: ${current.qCode ?? '不明'}`,
    `- 深度: ${current.depthStage ?? '不明'}`,
    `- 時点: ${current.createdAt ?? '不明'}`,
    `- 状況要約: ${current.summary ?? '（要約なし）'}`,
    '',
    '【自己受容度の傾向】',
    saTrend,
    '',
    '→ LLM への指示：',
    '上記「前回」と「今回」の違いから、',
    '・どんな変化が起きているか',
    '・どこに進歩や確かな一歩があるか',
    '・いままだ揺れているポイントはどこか',
    'を、Iros らしい静かな語りで言語化してください。',
  ].join('\n');
}
