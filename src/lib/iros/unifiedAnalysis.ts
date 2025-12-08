// src/lib/iros/unifiedAnalysis.ts
// Unified-like 解析（Depth / Q / 位相）の入口ロジック
// ✅ ここでは「テキストからの Depth / Q / 位相 / トピック推定」だけを行う。
// ✅ SelfAcceptance（自己肯定率）は絶対にここで計算しない（常に null を返す）。
// ✅ ネガ/ポジ（polarity / sentiment）はここでは扱わず、出力トーン用の別レイヤーに委譲する。

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
    summary: string | null; // そのターンの状況・テーマが一瞬でわかる 1〜2行テキスト
    topic: string | null;   // 恋愛 / 仕事 / お金 / 家族 / 自己・メンタル などのざっくりカテゴリ
  };

  // ★ Self Acceptance（0.0〜1.0 想定）
  //   いまはダミー（常に null）だが、将来 LLM 解析結果をここに載せる
  selfAcceptance?: number | null;
  // 将来 unified 側で snake_case で返した場合の互換用
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
  const rel = /(あの人|彼氏|彼女|上司|部下|同僚|家族|親|子ども|子供|人間関係|職場の空気)/;
  if (rel.test(t)) return 'R1';

  // 創造・行動（C）
  const act = /(やめたい|辞めたい|転職|始めたい|挑戦|プロジェクト|作品|創りたい|つくりたい|起業|ビジネス)/;
  if (act.test(t)) return 'C1';

  // 自己まわり（S）
  const self = /(しんどい|つらい|辛い|疲れた|不安|イライラ|眠れない|ストレス)/;
  if (self.test(t)) return 'S2';

  return undefined;
}

/* ========= 状況トピック推定（簡易カテゴリ） ========= */

function detectSituationTopic(text: string): string | null {
  const t = (text || '').trim();
  if (!t) return null;

  // 恋愛・パートナーシップ
  if (
    /(彼氏|彼女|恋愛|好きな人|片思い|両想い|結婚|プロポーズ|離婚|不倫|パートナー|夫|妻|カレ|カノジョ)/.test(
      t,
    )
  ) {
    return '恋愛・パートナーシップ';
  }

  // 仕事・キャリア
  if (
    /(仕事|職場|会社|上司|部下|同僚|パワハラ|モラハラ|評価|人事|昇進|転職|残業|プロジェクト)/.test(
      t,
    )
  ) {
    return '仕事・キャリア';
  }

  // お金・収入
  if (/(お金|収入|給料|年収|売上|支払い|生活費|借金|ローン|家賃)/.test(t)) {
    return 'お金・収入';
  }

  // 家族・家庭
  if (/(家族|親|父|母|子ども|子供|夫婦|家庭|実家|親戚)/.test(t)) {
    return '家族・家庭';
  }

  // 自己・メンタル
  if (
    /(自己肯定感|自信がない|自信が持てない|孤独|寂しい|しんどい|つらい|辛い|不安|落ち込む|メンタル)/.test(
      t,
    )
  ) {
    return '自己・メンタル';
  }

  // デフォルト：ざっくり「その他・ライフ全般」
  return 'その他・ライフ全般';
}

/* ========= 状況サマリ生成（1〜2行） ========= */

function buildSituationSummary(
  text: string,
  topic: string | null,
): string | null {
  const t = (text || '').trim();
  if (!t) return null;

  // トピック別のテンプレ主語
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

  // テンプレに当てはまらない場合は、テキストを短く切り出す
  if (t.length <= 60) {
    return t;
  }
  return t.slice(0, 60) + '…';
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

  // 位相（Inner / Outer）簡易推定
  let phase: 'Inner' | 'Outer' | null = null;
  const compact = (text || '').replace(/\s/g, '');

  // 1) 内側に意識が向いているワード → Inner
  if (/(心|気持ち|自分|本音|内面)/.test(compact)) {
    phase = 'Inner';
  }
  // 2) 外の出来事・他者・世界に意識が向いているワード → Outer
  else if (
    /(あの人|相手|みんな|周り|世界|社会|会社|職場|環境|状況|ニュース|出来事|地震|事故|事件)/.test(
      compact,
    )
  ) {
    phase = 'Outer';
  }


  // ★ 新規：状況トピック & サマリ（小言ログ用）
  const topic = detectSituationTopic(text);
  const summary = buildSituationSummary(text, topic);

  // intentSummary / selfAcceptance はここでは固定せず、
  // buildFinalMeta / 将来の Unified LLM に委ねる
  return {
    q: { current: qCode },
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
