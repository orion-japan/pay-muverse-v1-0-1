// src/lib/iros/unifiedAnalysis.ts
// Unified-like 解析（Depth / Q / 位相）の入口ロジック
// V3 / 18階層版
// - ここでは「テキストからの Depth / Q(構造シグナル or 明示) / 位相 / トピック推定」だけを行う
// - SelfAcceptance はここで計算しない（常に null）
// - polarity / sentiment はここで扱わない
// - Qはユーザー明示があれば最優先、なければ構造シグナルで最小推定
// - Depth は S/F/R/C/I/T の18階層（+ T1..T3）を入口推定する

import {
  type Depth,
  type QCode,
  DEPTH_VALUES,
  QCODE_VALUES,
} from '@/lib/iros/system';

/* ========= 型定義 ========= */

export type UnifiedSignals = {
  incident: boolean;
  urgency: boolean;
  freeze: boolean;
  emptiness: boolean;
  blocked: boolean;
  threat: boolean;
  anxiety: boolean;
  intensity: 0 | 1 | 2 | 3;
};

export type UnifiedLikeAnalysis = {
  q: {
    current: QCode | null;
    decidedBy?: 'explicit' | 'signals' | 'none';
  };
  depth: {
    stage: Depth | null;
  };
  phase: 'Inner' | 'Outer' | null;
  intentSummary: string | null;

  situation?: {
    summary: string | null;
    topic: string | null;
  };

  signals?: UnifiedSignals;

  selfAcceptance?: number | null;
  self_acceptance?: number | null;
};

/* ========= 正規化 ========= */

function normalizeDepth(depth?: Depth | null): Depth | undefined {
  if (!depth) return undefined;
  return DEPTH_VALUES.includes(depth) ? depth : undefined;
}

function normalizeQCode(qCode?: QCode | null): QCode | undefined {
  if (!qCode) return undefined;
  return QCODE_VALUES.includes(qCode) ? qCode : undefined;
}

function compactText(text: string): string {
  return String(text ?? '').replace(/\s/g, '').trim();
}

/* ========= Q（明示） ========= */

function detectExplicitQCode(text: string): QCode | undefined {
  const t = String(text ?? '').trim();
  if (!t) return undefined;

  const m = t.match(/(?:^|[^A-Za-z0-9])([qQ][1-5]|[qQ][１-５])(?:[^A-Za-z0-9]|$)/);
  if (!m) return undefined;

  const raw = m[1]
    .toUpperCase()
    .replace('１', '1')
    .replace('２', '2')
    .replace('３', '3')
    .replace('４', '4')
    .replace('５', '5');

  return normalizeQCode(raw as QCode);
}

/* ========= Depth 判定ヘルパ ========= */

function hasAny(t: string, words: string[]): boolean {
  return words.some((w) => t.includes(w));
}

function scoreHits(t: string, words: string[]): number {
  let n = 0;
  for (const w of words) {
    if (t.includes(w)) n += 1;
  }
  return n;
}

/* ========= I 帯 ========= */

function detectIDepthFromText(text: string): Depth | undefined {
  const t = compactText(text);
  if (!t) return undefined;

  const i3Words = [
    '何のために',
    '何の為に',
    '使命',
    '存在理由',
    '存在意義',
    '生きている意味',
    '生きる意味',
    '生まれてきた意味',
    '生きてきた意味',
    'なぜ生まれた',
    'なぜ生まれてきた',
    'なぜ自分はここにいる',
    '私は何者',
    '自分は何者',
  ];
  if (hasAny(t, i3Words)) return 'I3';

  const i2Words = [
    'どう生きたい',
    '人生そのもの',
    '本心から',
    '本当の願い',
    '本当はどうしたい',
    '何を大切にしたい',
    '何を大事にしたい',
    'どう在りたい',
    'どうありたい',
    '自分にとって大切',
    '自分にとって重要',
    'なぜこれをやりたい',
    'なぜこれをやろうとしている',
    'そもそもなぜ',
    'そもそも私はなぜ',
  ];
  if (hasAny(t, i2Words)) return 'I2';

  const i1Words = [
    'ありたい姿',
    '在り方',
    '自分らしく',
    '本音で生きたい',
    '自分のまま',
    '本当の自分',
    '自分の軸',
    '軸に戻りたい',
    '意味を整理したい',
    '意図を整理したい',
  ];
  if (hasAny(t, i1Words)) return 'I1';

  return undefined;
}

/* ========= T 帯 ========= */

function detectTDepthFromText(text: string): Depth | undefined {
  const t = compactText(text);
  if (!t) return undefined;

  const t3Words = [
    '超越',
    '悟り',
    '真理そのもの',
    '宇宙意識',
    '存在全体',
    '根源そのもの',
  ];
  if (hasAny(t, t3Words)) return 'T3';

  const t2Words = [
    '次元を超える',
    '次元をまたぐ',
    '次元的',
    '時間を超える',
    '境界を超える',
    '枠を超える',
  ];
  if (hasAny(t, t2Words)) return 'T2';

  const t1Words = [
    '超えたい',
    '抜けたい',
    '抜け出したい',
    '手放して次へ',
    '一段上に行きたい',
    '視座を上げたい',
  ];
  if (hasAny(t, t1Words)) return 'T1';

  return undefined;
}

/* ========= R 帯 ========= */

function detectRDepthFromText(text: string): Depth | undefined {
  const t = compactText(text);
  if (!t) return undefined;

  const relWords = [
    'あの人',
    '彼氏',
    '彼女',
    '好きな人',
    'パートナー',
    '夫',
    '妻',
    '上司',
    '部下',
    '同僚',
    '家族',
    '親',
    '子ども',
    '子供',
    '友達',
    '人間関係',
    '関係',
    '関係性',
    '職場の空気',
    '相手',
    '周り',
  ];

  const r3Words = [
    'どう感じている',
    'どう思っている',
    '本音は何',
    '本音はなん',
    '関係の意味',
    '二人の関係',
    '関係の本質',
    'なぜこの関係',
  ];
  if (hasAny(t, r3Words)) return 'R3';

  const r2Words = [
    '距離感',
    'どう接する',
    'どう向き合う',
    'どう関わる',
    '気持ちが知りたい',
    '気持ちを知りたい',
    'どう受け止める',
    'どう返す',
    'どう関係を作る',
  ];
  if (hasAny(t, r2Words)) return 'R2';

  if (hasAny(t, relWords)) return 'R1';

  return undefined;
}

/* ========= C 帯 ========= */

function detectCDepthFromText(text: string): Depth | undefined {
  const t = compactText(text);
  if (!t) return undefined;

  const c3Words = [
    '何を作るべきか',
    '何を創るべきか',
    '構想全体',
    '全体設計',
    '設計思想',
    '構造設計',
    '世界観設計',
  ];
  if (hasAny(t, c3Words)) return 'C3';

  const c2Words = [
    '実装の構成',
    '構成を整理',
    'どう設計する',
    'どう作ればいい',
    'どう組む',
    '仕組みをどう作る',
    '設計したい',
    '実装したい',
    '構造を作りたい',
    '仕様を決めたい',
    '作り方を整理したい',
  ];
  if (hasAny(t, c2Words)) return 'C2';

  const c1Words = [
    '始めたい',
    '挑戦',
    'プロジェクト',
    '作品',
    '創りたい',
    'つくりたい',
    '作りたい',
    '起業',
    'ビジネス',
    '実装',
    '設計',
    '構成',
    '仕組み',
    '機能',
    '開発',
  ];
  if (hasAny(t, c1Words)) return 'C1';

  return undefined;
}

/* ========= F 帯 ========= */

function detectFDepthFromText(text: string): Depth | undefined {
  const t = compactText(text);
  if (!t) return undefined;

  const f3Words = [
    '定着させたい',
    '習慣化したい',
    '続く仕組みにしたい',
    '生活の型にしたい',
    '日常に組み込みたい',
    '維持できる形にしたい',
  ];
  if (hasAny(t, f3Words)) return 'F3';

  const f2Words = [
    '続けられる形',
    '安定させたい',
    '流れを整えたい',
    '日常の流れ',
    '土台を作りたい',
    '無理なく続けたい',
    '崩れにくくしたい',
    'リズムを整えたい',
  ];
  if (hasAny(t, f2Words)) return 'F2';

  const f1Words = [
    '形にしたい',
    '整えたい',
    '続けたい',
    '頻度を決めたい',
    '時間帯を決めたい',
    'ルールを決めたい',
    '習慣',
    '安定',
    '土台',
    'ルーティン',
  ];
  if (hasAny(t, f1Words)) return 'F1';

  return undefined;
}

/* ========= S 帯 ========= */

function detectSDepthFromText(text: string): Depth | undefined {
  const t = compactText(text);
  if (!t) return undefined;

  const s3Words = [
    '自分の核心',
    '根っこの気持ち',
    '本当の気持ち',
    '自分の感情の正体',
    '心の奥',
  ];
  if (hasAny(t, s3Words)) return 'S3';

  const s2Words = [
    'しんどい',
    'つらい',
    '辛い',
    '疲れた',
    '眠れない',
    'ストレス',
    '詰まる',
    '固まる',
    '落ち着かない',
    '自分の状態',
    '今の状態',
    '気持ちに戻りたい',
    '自分を整理したい',
  ];
  if (hasAny(t, s2Words)) return 'S2';

  const s1Words = [
    '整理したい',
    '見直したい',
    '落ち着きたい',
    '自分のこと',
    '今の自分',
    'いまの自分',
    '気持ちを見たい',
    '状態を見たい',
  ];
  if (hasAny(t, s1Words)) return 'S1';

  return undefined;
}

/* ========= テキスト → Depth（V3 / 18階層） ========= */

function detectDepthFromText(text: string): Depth | undefined {
  const t = String(text ?? '').trim();
  if (!t) return undefined;

  // 上位帯から優先
  const tDepth = detectTDepthFromText(t);
  if (tDepth) return tDepth;

  const iDepth = detectIDepthFromText(t);
  if (iDepth) return iDepth;

  const rDepth = detectRDepthFromText(t);
  if (rDepth) return rDepth;

  const cDepth = detectCDepthFromText(t);
  if (cDepth) return cDepth;

  const fDepth = detectFDepthFromText(t);
  if (fDepth) return fDepth;

  const sDepth = detectSDepthFromText(t);
  if (sDepth) return sDepth;

  return undefined;
}

/* ========= 構造シグナル抽出 ========= */

function extractSignals(text: string): UnifiedSignals {
  const compact = compactText(text);

  const incident =
    /(エラー|error|問題|不具合|障害|事故|トラブル|想定外|停止|止まった|落ちた|壊れた|バグ)/i.test(
      compact,
    );

  const urgency =
    /(間に合わない|期限|締切|締め切り|納期|今日中|今週中|急ぎ|至急|追い込み|時間がない)/.test(
      compact,
    );

  const freeze =
    /(喉が詰まる|息が詰まる|体が固まる|固まる|動けない|止まる|フリーズ|硬直|震える)/.test(
      compact,
    );

  const emptiness =
    /(空虚|虚無|何も感じない|感じない|無感情|無意味|空っぽ)/.test(compact);

  const blocked =
    /(進まない|詰んだ|詰む|塞がる|詰まり|手が止まる|止まってる|固まってる)/.test(
      compact,
    );

  const threat =
    /(怖い|恐怖|危機|やばい|終わる|崩れる|致命的|最悪)/.test(compact);

  const anxiety =
    /(不安|心配|焦り|落ち着かない|ソワソワ|しんどい|つらい|辛い)/.test(compact);

  const count =
    (incident ? 1 : 0) +
    (urgency ? 1 : 0) +
    (freeze ? 1 : 0) +
    (emptiness ? 1 : 0) +
    (blocked ? 1 : 0) +
    (threat ? 1 : 0) +
    (anxiety ? 1 : 0);

  const intensity: 0 | 1 | 2 | 3 =
    count === 0 ? 0 : count === 1 ? 1 : count === 2 ? 2 : 3;

  return {
    incident,
    urgency,
    freeze,
    emptiness,
    blocked,
    threat,
    anxiety,
    intensity,
  };
}

/* ========= 構造シグナル → Q ========= */

function decideQFromSignals(signals: UnifiedSignals): QCode | null {
  if (!signals) return null;

  if (signals.emptiness) return 'Q5';
  if (signals.incident && (signals.freeze || signals.blocked)) return 'Q4';
  if (signals.urgency && signals.blocked) return 'Q3';
  if (signals.freeze && signals.intensity >= 2) return 'Q4';

  return null;
}

/* ========= 状況トピック推定 ========= */

function detectSituationTopic(text: string): string | null {
  const t = String(text ?? '').trim();
  if (!t) return null;

  if (
    /(彼氏|彼女|恋愛|好きな人|片思い|両想い|結婚|プロポーズ|離婚|不倫|パートナー|夫|妻|カレ|カノジョ)/.test(
      t,
    )
  ) {
    return '恋愛・パートナーシップ';
  }

  if (
    /(仕事|職場|会社|上司|部下|同僚|パワハラ|モラハラ|評価|人事|昇進|転職|残業|プロジェクト|実装|設計|開発)/.test(
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

/* ========= 状況サマリ ========= */

function buildSituationSummary(text: string, topic: string | null): string | null {
  const t = String(text ?? '').trim();
  if (!t) return null;

  switch (topic) {
    case '恋愛・パートナーシップ':
      return '恋愛・パートナーシップに関する今の気持ちや迷いを整理しようとしている状態';
    case '仕事・キャリア':
      return '仕事や実装・構成について、自分の立ち位置や進め方を見直している状態';
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

/* ========= 位相 ========= */

function detectPhaseFromText(text: string): 'Inner' | 'Outer' | null {
  const compact = compactText(text);
  if (!compact) return null;

  if (/(心|気持ち|自分|本音|内面|どう感じる|どう思う|しんどい|怖い|不安)/.test(compact)) {
    return 'Inner';
  }

  if (
    /(あの人|相手|みんな|周り|世界|社会|会社|職場|環境|状況|ニュース|出来事|地震|事故|事件)/.test(
      compact,
    )
  ) {
    return 'Outer';
  }

  return null;
}

/* ========= Unified-like 解析 ========= */

export async function analyzeUnifiedTurn(params: {
  text: string;
  requestedDepth?: Depth;
  requestedQCode?: QCode;
}): Promise<UnifiedLikeAnalysis> {
  const { text, requestedDepth } = params;

  const autoDepthLight = detectDepthFromText(text);

  let autoDepthDeep: Depth | null = null;
  if (!autoDepthLight) {
    try {
      const mod = await import('@/lib/iros/deepScan');
      if (typeof mod.deepScan === 'function') {
        const ds = mod.deepScan(text);
        autoDepthDeep = (ds?.depth ?? null) as Depth | null;
      }
    } catch {
      autoDepthDeep = null;
    }
  }

  const autoDepth = autoDepthLight ?? autoDepthDeep ?? null;
  const rawDepth: Depth | undefined = (autoDepth ?? requestedDepth ?? undefined) as
    | Depth
    | undefined;
  const depth = normalizeDepth(rawDepth) ?? null;

  const explicitQ = detectExplicitQCode(text);
  const qExplicit = normalizeQCode(explicitQ) ?? null;

  const signals = extractSignals(text);
  const qFromSignals = qExplicit ? null : decideQFromSignals(signals);
  const qCode: QCode | null = qExplicit ?? qFromSignals ?? null;

  let decidedBy: 'explicit' | 'signals' | 'none' = 'none';
  if (qExplicit) decidedBy = 'explicit';
  else if (qFromSignals) decidedBy = 'signals';

  const phase = detectPhaseFromText(text);

  const topic = detectSituationTopic(text);
  const summary = buildSituationSummary(text, topic);

  return {
    q: { current: qCode, decidedBy },
    depth: { stage: depth },
    phase,
    intentSummary: null,
    situation: {
      summary,
      topic,
    },
    signals,
    selfAcceptance: null,
    self_acceptance: null,
  };
}
