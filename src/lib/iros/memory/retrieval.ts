// src/lib/iros/memory/retrieval.ts
import type { RootIds, RetrievalBundle, EvidenceCard, ResonanceMetrics } from './types';
import { getShortTermSummary, getRecentEpisodes, auditEvent } from './store';
import { rankEvidences } from './scorer';
import { inferMetrics } from './metrics';
/** 共鳴指標の簡易推定（実装差し替え前提のダミー） */

export function inferMetricsFromText(text: string) {
  return inferMetrics(text);
}
/** 目的一句の抽出（簡易） */
export function deriveObjectiveLine(userText: string): string {
  const t = userText.replace(/\s+/g, ' ').trim();
  return t.length > 36 ? `${t.slice(0, 34)}…` : t || '目的一句未設定';
}

/** Retrieval → Evidenceの選別 → RetrievalBundle 生成 */
export async function buildRetrievalBundle(root: RootIds, userText: string): Promise<RetrievalBundle> {
  // 1) 短期要約
  const st = await getShortTermSummary(root);
  const miniSummary = st?.short_summary ?? '(直近要約なし)';

  // 2) エピソード候補
  const episodes = await getRecentEpisodes(root, 8);

  // 3) 指標推定
  const metrics = inferMetricsFromText(userText);

  // 4) スコアリングして最大5件に
  const ranked = rankEvidences(episodes, metrics).slice(0, 5);

  // 5) Retrieval 課金ログ（0.5pt想定）
  await auditEvent(root, 'retrieval', 0.5, 'buildRetrievalBundle', ranked.map(r => r.id));

  return {
    miniSummary,
    objectiveLine: deriveObjectiveLine(userText),
    evidences: ranked,
    metrics,
  };
}

/** LLＭ向けのプロンプト素片を合成（System/Context用） */
export function composeContextForIros(bundle: RetrievalBundle): string {
  const evLines = (bundle.evidences || []).map((e, i) => {
    const date = e.date ? ` (${new Date(e.date).toISOString().slice(0, 10)})` : '';
    return `- [${i + 1}] ${e.title ?? 'episode'}${date}: ${e.snippet}`;
  }).join('\n');

  return [
    `# 会話の直近要約`,
    `${bundle.miniSummary}`,
    ``,
    `# 目的一句`,
    `${bundle.objectiveLine}`,
    ``,
    `# 根拠カード（最大5）`,
    evLines || '(なし)',
    ``,
    `# 共鳴指標`,
    `phase=${bundle.metrics.phase ?? '-'}, depth=${bundle.metrics.depth ?? '-'}, q_primary=${bundle.metrics.q_primary ?? '-'}`,
    ``,
    `# 出力指針`,
    `- 禁則：🫧は使わない／表記は「位相」「深度」「フェーズ・ドリフト軸」など既定に準拠`,
    `- トーン：Iros（やわらかい会話体／鏡映→具体の順）`,
  ].join('\n');
}
