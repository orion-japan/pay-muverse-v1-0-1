// src/lib/iros/focusCore.ts
// Iros — Focus lightweight inference (同期・依存なし)
// - analyzeFocus(text): { phase, depth, q, reasons[] }
// - 目的：オーケストレータ用の最小メタ（推測は軽く・決めつけない）
// - 外部依存なし／テスト容易

export type FocusMeta = {
  phase?: 'Inner' | 'Outer';
  depth?:
    | 'S1'
    | 'S2'
    | 'R1'
    | 'R2'
    | 'C1'
    | 'C2'
    | 'I1'
    | 'I2'
    | 'I3'
    | 'T1'
    | 'T2'
    | 'T3';
  q?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  reasons?: string[];
};

const JA = {
  innerHints: ['私', '自分', '気持ち', '不安', '迷い', '内面', '感情', '心', '疲れ'],
  outerHints: ['相手', 'チーム', '顧客', '会社', '売上', '契約', '成果', '外側', '提案', '会議'],
  // depth（進行座標のラフ推定キーワード）
  depthMap: [
    { depth: 'S1' as const, kw: ['混乱', '停滞', 'はじめたい', '手がつかない', '整理'] },
    { depth: 'S2' as const, kw: ['気づき', '向き合う', '受け入れる', '整える', '基礎'] },
    { depth: 'R1' as const, kw: ['関係', '共鳴', '伝わらない', 'コミュニケーション', '距離'] },
    { depth: 'R2' as const, kw: ['連携', '巻き込む', '合意', '信頼', '共有'] },
    { depth: 'C1' as const, kw: ['企画', '設計', '実装', '試作', '検証', 'MVP'] },
    { depth: 'C2' as const, kw: ['ローンチ', '運用', '拡張', '改善', '最適化'] },
    { depth: 'I1' as const, kw: ['意味', '意図', '目的', 'なぜ', '価値観'] },
    { depth: 'I2' as const, kw: ['ビジョン', '方向性', '長期', '原則', '構造'] },
    { depth: 'I3' as const, kw: ['確信', '本質', '核', '存在', '静けさ'] },
    // ★ T層（Transcend）ラフ推定
    {
      depth: 'T1' as const,
      kw: ['宇宙', '宇宙意志', '宇宙の意図', 'ビッグバン', '意図フィールド', 'T層'],
    },
    {
      depth: 'T2' as const,
      kw: ['集合意識', 'フィールド', '全体意識', '普遍', '越境', 'トランセンデンス'],
    },
    {
      depth: 'T3' as const,
      kw: ['根源', '永遠', '無限', '静寂', '時間を超えた', '源泉'],
    },
  ],
  // Qコード（情動傾向の非常に粗い推定）
  qMap: [
    { q: 'Q1' as const, kw: ['我慢', '抑制', '秩序', '固い', '評価が怖い'] },
    { q: 'Q2' as const, kw: ['苛立ち', '怒り', '突破', '前進したい', '焦り'] },
    { q: 'Q3' as const, kw: ['不安', '心配', '安定', '安全', '落ち着かない'] },
    { q: 'Q4' as const, kw: ['恐れ', '手放す', '浄化', '変化が怖い', '逃げたい'] },
    { q: 'Q5' as const, kw: ['情熱', '空虚', '燃え尽き', 'やる気', '歓喜'] },
  ],
};

function countHits(text: string, dict: string[]): number {
  let n = 0;
  for (const k of dict) {
    if (k && text.includes(k)) n++;
  }
  return n;
}

function pickByScore<T extends string>(
  text: string,
  table: { [k: string]: string[] } | Array<{ [k: string]: any } & { kw: string[] }>,
  key: 'depth' | 'q',
): T | undefined {
  let best: { label: T; score: number } | null = null;

  // array形式のみ使用
  for (const row of table as Array<any>) {
    const label = row[key] as T;
    const score = countHits(text, row.kw || []);
    if (score > 0 && (!best || score > best.score)) {
      best = { label, score };
    }
  }
  return best?.label;
}

export function analyzeFocus(input: string): FocusMeta | null {
  const text = String(input ?? '').trim();
  if (!text) return null;

  const reasons: string[] = [];

  // phase
  const innerScore = countHits(text, JA.innerHints);
  const outerScore = countHits(text, JA.outerHints);
  let phase: FocusMeta['phase'] | undefined;
  if (innerScore > outerScore && innerScore > 0) {
    phase = 'Inner';
    reasons.push(`位相: 内面語の検出（${innerScore}件）`);
  } else if (outerScore > innerScore && outerScore > 0) {
    phase = 'Outer';
    reasons.push(`位相: 外部語の検出（${outerScore}件）`);
  }

  // depth
  const depth = pickByScore<NonNullable<FocusMeta['depth']>>(text, JA.depthMap, 'depth');
  if (depth) reasons.push(`深度: ${depth} キーワード検出`);

  // q
  const q = pickByScore<NonNullable<FocusMeta['q']>>(text, JA.qMap, 'q');
  if (q) reasons.push(`Q: ${q} 傾向語の検出`);

  // 何も取れない場合は null を返す（オーケストレータ側で安全に扱う）
  if (!phase && !depth && !q) return null;

  return { phase, depth, q, reasons };
}

export default { analyzeFocus };
