// src/lib/iros/unifiedAnalysis.ts
// Unified-like 解析（Depth / Q / 位相）の入口ロジック

import {
  type Depth,
  type QCode,
  DEPTH_VALUES,
  QCODE_VALUES,
} from './system';

/* ========= 型定義 ========= */

export type UnifiedLikeAnalysis = {
  q: {
    current: QCode | null;
  };
  depth: {
    stage: Depth | null;
  };
  phase: 'Inner' | 'Outer' | null;
  intentSummary: string | null;
};

/* ========= Depth/Q 正規化 ========= */

function normalizeDepth(depth?: Depth): Depth | undefined {
  if (!depth) return undefined;
  return DEPTH_VALUES.includes(depth) ? depth : undefined;
}

function normalizeQCode(qCode?: QCode): QCode | undefined {
  if (!qCode) return undefined;
  return QCODE_VALUES.includes(qCode) ? qCode : undefined;
}

/* ========= テキスト → Depth（簡易版） ========= */

function detectIDepthFromText(text: string): Depth | undefined {
  const t = (text || '').trim();
  if (!t) return undefined;

  // I3：存在・意味系
  const strongWords = [
    '何のために',
    '何の為に',
    '使命',
    '存在理由',
    '生きている意味',
    '生きる意味',
    '生まれてきた意味',
    '生きてきた意味',
    'なぜ生まれた',
    'なぜ生まれてきた',
    'なぜ自分はここにいる',
    '存在意義',
  ];
  if (strongWords.some((w) => t.includes(w))) return 'I3';

  // I2：人生 / 本心 / 願い / 魂
  const midWords = [
    'どう生きたい',
    '人生そのもの',
    '本心から',
    '本当の願い',
    '魂のレベル',
    '魂レベル',
  ];
  if (midWords.some((w) => t.includes(w))) return 'I2';

  // I1：在り方 / 自分らしく / 本音
  const softWords = [
    'ありたい姿',
    '在り方',
    '自分らしく',
    '本音で生きたい',
    '自分のまま',
    '本当の自分',
  ];
  if (softWords.some((w) => t.includes(w))) return 'I1';

  return undefined;
}

function detectDepthFromText(text: string): Depth | undefined {
  const t = (text || '').trim();
  if (!t) return undefined;

  // I層は I専用ロジックに委譲
  const iDepth = detectIDepthFromText(t);
  if (iDepth) return iDepth;

  // 関係・共鳴（R）
  const rel = /(あの人|彼氏|彼女|上司|部下|同僚|家族|親|子ども|人間関係|職場の空気)/;
  if (rel.test(t)) return 'R1';

  // 創造・行動（C）
  const act = /(やめたい|転職|始めたい|挑戦|プロジェクト|作品|創りたい|つくりたい)/;
  if (act.test(t)) return 'C1';

  // 自己まわり（S）
  const self = /(しんどい|つらい|疲れた|不安|イライラ|眠れない|ストレス)/;
  if (self.test(t)) return 'S2';

  return undefined;
}

/* ========= Unified-like 解析（ダミー強化版） ========= */

export async function analyzeUnifiedTurn(params: {
  text: string;
  requestedDepth?: Depth;
  requestedQCode?: QCode;
}): Promise<UnifiedLikeAnalysis> {
  const { text, requestedDepth, requestedQCode } = params;

  const autoDepth = detectDepthFromText(text);

  // Depth 優先順位：
  // 1) テキストからの自動検出（autoDepth）
  // 2) ユーザー指定（requestedDepth：Qトレースなど）
  const rawDepth: Depth | undefined = autoDepth ?? requestedDepth ?? undefined;
  const depth = normalizeDepth(rawDepth) ?? null;

  // Q 優先順位：
  // 1) ユーザー指定（requestedQCode）
  // 2) ここではまだ自動検出なし（将来 deepScan 拡張で差し替え）
  const qCode = normalizeQCode(requestedQCode) ?? null;

  // 位相は簡易に Inner 推定のみ
  const phase: 'Inner' | 'Outer' | null =
    /心|気持ち|自分|本音|内側/.test(text) ? 'Inner' : null;

  // intentSummary はここでは固定せず、buildFinalMeta 側に委ねる
  return {
    q: { current: qCode },
    depth: { stage: depth },
    phase,
    intentSummary: null,
  };
}
