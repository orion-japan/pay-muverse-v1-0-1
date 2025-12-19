// src/lib/iros/unifiedAnalysis.ts
// Unified-like 解析（Depth / Q / 位相）の入口ロジック
// ✅ ここでは「テキストからの Depth / Q(※明示のみ) / 位相 / トピック推定」だけを行う。
// ✅ SelfAcceptance（自己肯定率）は絶対にここで計算しない（常に null を返す）。
// ✅ ネガ/ポジ（polarity / sentiment）はここでは扱わず、出力トーン用の別レイヤーに委譲する。
// ✅ Qは「推測で自動検出しない」：ユーザーが明示した場合のみ拾う（Q1〜Q5）。

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

  // ★ 状況サマリ & トピック（小言ログ用）
  situation?: {
    summary: string | null;
    topic: string | null;
  };

  // ★ Self Acceptance（0.0〜1.0 想定）
  selfAcceptance?: number | null;
  self_acceptance?: number | null;
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

/* ========= Q（明示のみ） =========
   - 推測では拾わない
   - 例: "Q3", "Q２", "q5" などが文章中にあれば採用
*/
function detectExplicitQCode(text: string): QCode | undefined {
  const t = (text || '').trim();
  if (!t) return undefined;

  // 半角/全角、大小 q/Q を許可
  // Q１〜Q５（全角数字）も拾う
  const m = t.match(/(?:^|[^A-Za-z0-9])([qQ][1-5]|[qQ][１-５])(?:[^A-Za-z0-9]|$)/);
  if (!m) return undefined;

  const raw = m[1].toUpperCase().replace('１', '1').replace('２', '2').replace('３', '3').replace('４', '4').replace('５', '5');
  return normalizeQCode(raw as QCode);
}

/* ========= テキスト → Depth（簡易版） ========= */

function detectIDepthFromText(text: string): Depth | undefined {
  const t = (text || '').trim();
  if (!t) return undefined;

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

  const midWords = [
    'どう生きたい',
    '人生そのもの',
    '本心から',
    '本当の願い',
    '魂のレベル',
    '魂レベル',
  ];
  if (midWords.some((w) => t.includes(w))) return 'I2';

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

  const iDepth = detectIDepthFromText(t);
  if (iDepth) return iDepth;

  const rel =
    /(あの人|彼氏|彼女|上司|部下|同僚|家族|親|子ども|子供|人間関係|職場の空気)/;
  if (rel.test(t)) return 'R1';

  const act =
    /(やめたい|辞めたい|転職|始めたい|挑戦|プロジェクト|作品|創りたい|つくりたい|起業|ビジネス)/;
  if (act.test(t)) return 'C1';

  const self = /(しんどい|つらい|辛い|疲れた|不安|イライラ|眠れない|ストレス)/;
  if (self.test(t)) return 'S2';

  return undefined;
}

/* ========= 状況トピック推定（簡易カテゴリ） ========= */

function detectSituationTopic(text: string): string | null {
  const t = (text || '').trim();
  if (!t) return null;

  if (
    /(彼氏|彼女|恋愛|好きな人|片思い|両想い|結婚|プロポーズ|離婚|不倫|パートナー|夫|妻|カレ|カノジョ)/.test(
      t,
    )
  ) {
    return '恋愛・パートナーシップ';
  }

  if (
    /(仕事|職場|会社|上司|部下|同僚|パワハラ|モラハラ|評価|人事|昇進|転職|残業|プロジェクト)/.test(
      t,
    )
  ) {
    return '仕事・キャリア';
  }

  if (/(お金|収入|給料|年収|売上|支払い|生活費|借金|ローン|家賃)/.test(t)) {
    return 'お金・収入';
  }

  if (/(家族|親|父|母|子ども|子供|夫婦|家庭|実家|親戚)/.test(t)) {
    return '家族・家庭';
  }

  if (
    /(自己肯定感|自信がない|自信が持てない|孤独|寂しい|しんどい|つらい|辛い|不安|落ち込む|メンタル)/.test(
      t,
    )
  ) {
    return '自己・メンタル';
  }

  return 'その他・ライフ全般';
}

/* ========= 状況サマリ生成（1〜2行） ========= */

function buildSituationSummary(text: string, topic: string | null): string | null {
  const t = (text || '').trim();
  if (!t) return null;

  switch (topic) {
    case '恋愛・パートナーシップ':
      return '恋愛・パートナーシップに関する今の気持ちや迷いを整理しようとしている状態';
    case '仕事・キャリア':
      return '仕事や職場での状況・ストレスについて、自分の立ち位置やこれからを考え直している状態';
    case 'お金・収入':
      return 'お金や収入・生活の安定について、不安や今後の見通しを確認しようとしている状態';
    case '家族・家庭':
      return '家族や家庭との関係性について、心の重さやバランスを見つめ直している状態';
    case '自己・メンタル':
      return '自分自身の心の状態やメンタルの揺れについて、言葉にしながら整えようとしている状態';
    default:
      break;
  }

  if (t.length <= 60) return t;
  return t.slice(0, 60) + '…';
}

/* ========= Unified-like 解析 ========= */

export async function analyzeUnifiedTurn(params: {
  text: string;
  requestedDepth?: Depth;
  requestedQCode?: QCode; // ← 互換で受けるが、unifiedでは推測に使わない
}): Promise<UnifiedLikeAnalysis> {
  const { text, requestedDepth } = params;

  const autoDepth = detectDepthFromText(text);

  const rawDepth: Depth | undefined = autoDepth ?? requestedDepth ?? undefined;
  const depth = normalizeDepth(rawDepth) ?? null;

  // ✅ Qは「明示されている場合のみ」拾う
  const explicitQ = detectExplicitQCode(text);
  const qCode = normalizeQCode(explicitQ) ?? null;

  let phase: 'Inner' | 'Outer' | null = null;
  const compact = (text || '').replace(/\s/g, '');

  if (/(心|気持ち|自分|本音|内面)/.test(compact)) {
    phase = 'Inner';
  } else if (
    /(あの人|相手|みんな|周り|世界|社会|会社|職場|環境|状況|ニュース|出来事|地震|事故|事件)/.test(
      compact,
    )
  ) {
    phase = 'Outer';
  }

  const topic = detectSituationTopic(text);
  const summary = buildSituationSummary(text, topic);

  return {
    q: { current: qCode }, // ✅ 明示Qがある時だけ入る（なければnull）
    depth: { stage: depth },
    phase,
    intentSummary: null,
    situation: {
      summary,
      topic,
    },
    selfAcceptance: null,
    self_acceptance: null,
  };
}
