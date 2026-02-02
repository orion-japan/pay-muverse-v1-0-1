// src/lib/iros/unifiedAnalysis.ts
// Unified-like 解析（Depth / Q / 位相）の入口ロジック
// ✅ ここでは「テキストからの Depth / Q(構造シグナル or 明示) / 位相 / トピック推定」だけを行う。
// ✅ SelfAcceptance（自己肯定率）は絶対にここで計算しない（常に null を返す）。
// ✅ ネガ/ポジ（polarity / sentiment）はここでは扱わず、出力トーン用の別レイヤーに委譲する。
// ✅ Qは「単語辞書」ではなく “構造シグナル” で推定し、ユーザー明示があれば必ずそれを優先する。

import {
  type Depth,
  type QCode,
  DEPTH_VALUES,
  QCODE_VALUES,
} from '@/lib/iros/system';

/* ========= 型定義 ========= */

export type UnifiedSignals = {
  // 「出来事が発生して制御が落ちた」系（エラー/問題/事故/想定外/停止）
  incident: boolean;

  // 「間に合わない/期限/追い込み」系（時間圧）
  urgency: boolean;

  // 「身体フリーズ/詰まり/固まり」系（動けない）
  freeze: boolean;

  // 「空虚/虚無/何も感じない」系（感情の断線）
  emptiness: boolean;

  // 「押し戻される/塞がる/詰む/詰まり」系（進行ブロック）
  blocked: boolean;

  // ✅ 追加：「恐怖/怖さ」系（内的脅威・危険感）
  threat: boolean;

  // ✅ 追加：「不安/心配/焦り」系（見通し不安・時間不安・圧）
  anxiety: boolean;

  // 強度（0〜3：荒くてOK）
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

  // ★ 状況サマリ & トピック（小言ログ用）
  situation?: {
    summary: string | null;
    topic: string | null;
  };

  // ★ 構造シグナル（orchestrator が “構造Q” を扱えるように残す）
  signals?: UnifiedSignals;

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

/* ========= Q（明示） =========
   - 例: "Q3", "Q２", "q5" などが文章中にあれば採用
*/
function detectExplicitQCode(text: string): QCode | undefined {
  const t = (text || '').trim();
  if (!t) return undefined;

  // 半角/全角、大小 q/Q を許可
  // Q１〜Q５（全角数字）も拾う
  const m = t.match(
    /(?:^|[^A-Za-z0-9])([qQ][1-5]|[qQ][１-５])(?:[^A-Za-z0-9]|$)/,
  );
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

  const midWords = ['どう生きたい', '人生そのもの', '本心から', '本当の願い'];
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

  const self = /(しんどい|つらい|辛い|疲れた|眠れない|ストレス|詰まる|固まる)/;
  if (self.test(t)) return 'S2';

  return undefined;
}

/* ========= 構造シグナル抽出（単語辞書ではなく “状態特徴”） ========= */

function extractSignals(text: string): UnifiedSignals {
  const compact = (text || '').replace(/\s/g, '');

  // 1) 出来事発生（エラー/問題/事故/想定外/停止）
  const incident =
    /(エラー|error|問題|不具合|障害|事故|トラブル|想定外|停止|止まった|落ちた|壊れた|バグ)/i.test(
      compact,
    );

  // 2) 時間圧（間に合わない/期限/追い込み）
  const urgency =
    /(間に合わない|期限|締切|締め切り|納期|今日中|今週中|急ぎ|至急|追い込み|時間がない)/.test(
      compact,
    );

  // 3) フリーズ（詰まり/固まり/動けない）
  const freeze =
    /(喉が詰まる|息が詰まる|体が固まる|固まる|動けない|止まる|フリーズ|硬直|震える)/.test(
      compact,
    );

  // 4) 断線（空虚/虚無/何も感じない）
  const emptiness =
    /(空虚|虚無|何も感じない|感じない|無感情|無|無意味|空っぽ)/.test(compact);

  // 5) 進行ブロック（詰む/塞がる/進まない）
  const blocked =
    /(進まない|詰んだ|詰む|塞がる|詰まり|手が止まる|止まってる|固まってる)/.test(
      compact,
    );

  // ★ ここがポイント：
  // UnifiedSignals に上の5つ + intensity 以外があるなら、ここで必ず定義して返す
  // 例）もし UnifiedSignals に threat / anxiety がいるなら、下の2つを「型に合わせて」残す
  const threat =
    /(怖い|恐怖|危機|やばい|終わる|崩れる|生存|致命的|最悪)/.test(compact);

  const anxiety =
    /(不安|心配|焦り|落ち着かない|ソワソワ|しんどい|つらい|辛い)/.test(compact);

  // 強度（荒くOK）
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

  // ✅ 返す shape を UnifiedSignals と完全一致させる
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

/* ========= 構造シグナル → Q（最小写像） =========
   ✅ “恐怖” の単語有無ではなく、
   - 出来事発生 + フリーズ/ブロック → Q4
   - 期限圧 + ブロック           → Q3
   - 空虚（断線）               → Q5
   - それ以外は null（ここで決めない）
*/
function decideQFromSignals(signals: UnifiedSignals): QCode | null {
  if (!signals) return null;

  // 空虚は最優先（Q5）
  if (signals.emptiness) return 'Q5';

  // “出来事発生”＋“身体フリーズ/進行ブロック” は Q4（安全低下）
  if (signals.incident && (signals.freeze || signals.blocked)) return 'Q4';

  // “期限圧”＋“進行ブロック” は Q3（間に合わない不安）
  if (signals.urgency && signals.blocked) return 'Q3';

  // フリーズ単体でも、一定強度なら Q4
  if (signals.freeze && signals.intensity >= 2) return 'Q4';

  return null;
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
  requestedQCode?: QCode; // ← 互換で受けるが、ここでは推測の材料にしない
}): Promise<UnifiedLikeAnalysis> {
  const { text, requestedDepth } = params;

  const autoDepth = detectDepthFromText(text);

  const rawDepth: Depth | undefined = autoDepth ?? requestedDepth ?? undefined;
  const depth = normalizeDepth(rawDepth) ?? null;

  // ✅ 明示Q（最優先）
  const explicitQ = detectExplicitQCode(text);
  const qExplicit = normalizeQCode(explicitQ) ?? null;

  // ✅ 構造シグナル → Q（明示が無い時だけ）
  const signals = extractSignals(text);
  const qFromSignals = qExplicit ? null : decideQFromSignals(signals);

  const qCode: QCode | null = qExplicit ?? qFromSignals ?? null;

  let decidedBy: 'explicit' | 'signals' | 'none' = 'none';
  if (qExplicit) decidedBy = 'explicit';
  else if (qFromSignals) decidedBy = 'signals';

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
