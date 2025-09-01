// src/lib/sofia/analyze.ts
// ------------------------------------------------------------
// Sofia: 軽量ヒューリスティクス解析ユーティリティ（Edge/Node共通）
// - Qコード推定 / レイヤ推定 / キーワード抽出
// - 位相(Inner/Outer) / 自己肯定率 / 関係性トーン / 次Q提案
// ------------------------------------------------------------

/* =========================
   型定義
========================= */
export type Layer =
  | "S1" | "S2" | "S3"
  | "F1" | "F2" | "F3"
  | "R1" | "R2" | "R3"
  | "C1" | "C2" | "C3"
  | "I1" | "I2" | "I3"
  | "T1" | "T2" | "T3";

export type QCode = `Q${number}`; // 例: Q1..Q5 など

export type Analysis = {
  qcodes: { code: QCode; score: number }[];
  layers: { layer: Layer; score: number }[];
  keywords: string[];
};

export type Phase = "Inner" | "Outer";
export type RelationQuality = "harmony" | "discord";

/* =========================
   内部ユーティリティ
========================= */
const safeLog = (...args: any[]) => {
  try { console.log(...args); } catch {}
};
const trunc = (s: string, n = 120) =>
  (s || "").replace(/\s+/g, " ").slice(0, n) + ((s && s.length > n) ? "…" : "");

/* =========================
   Qコード / レイヤ ヒント
========================= */
// ※五行ベース（必要に応じて拡張）
const Q_PATTERNS: Array<[QCode, RegExp]> = [
  ["Q1", /(我慢|抑圧|整理|秩序|内省|責任感)/iu],          // 金
  ["Q2", /(怒り|苛立ち|挑戦|成長|拡張|発芽)/iu],          // 木
  ["Q3", /(不安|心配|迷い|土台|安定|調停|均衡)/iu],        // 土
  ["Q4", /(恐怖|躊躇|浄化|水|流す|鎮静|静けさ)/iu],        // 水
  ["Q5", /(ウツ|停滞|情熱|火種|創造|再点火|活性)/iu],      // 火
];

// 18段階（S/F/R/C/I/T × 1..3）
const LAYER_HINTS: Array<[Layer, RegExp]> = [
  // Self（自分領域）
  ["S1", /(自分|自己|気分|体調|今日|目の前|習慣)/iu],
  ["S2", /(自己理解|感情整理|セルフケア|休息|整える)/iu],
  ["S3", /(自己再定義|価値観|コア|OS|内的一致)/iu],

  // Family/Others（他者領域）
  ["F1", /(家族|友人|相手|対人|人間関係|会話)/iu],
  ["F2", /(関係調整|信頼|共感|感謝|境界線|距離感)/iu],
  ["F3", /(関係再構築|和解|連携|チームワーク)/iu],

  // Relationship/Organization（組織・制度・共同体）
  ["R1", /(職場|学校|組織|コミュニティ|役割|所属)/iu],
  ["R2", /(役割調整|規範|合意形成|責任|協働|制度)/iu],
  ["R3", /(結婚|離婚|家族問題|文化|慣習|統合)/iu], // 表示は R3 ラベルのみ

  // Creation（自己実現）
  ["C1", /(夢|将来|目標|自己実現|学び|挑戦)/iu],
  ["C2", /(計画|実験|試作|習慣化|スキル|練習)/iu],
  ["C3", /(作品|成果|発表|ローンチ|貢献)/iu],

  // Impact（社会・世界）
  ["I1", /(社会|地域|環境|ニュース|社会課題)/iu],
  ["I2", /(価値提案|影響|循環|サステナ|連鎖)/iu],
  ["I3", /(世界観|普遍|倫理|原理|原型)/iu],

  // Transcend（超越・根源）
  ["T1", /(静けさ|沈黙|空|無|祈り|瞑想)/iu],
  ["T2", /(境界超越|次元|宇宙|超越|大いなるもの)/iu],
  ["T3", /(真実|体現|姿勢|確信|一体)/iu],
];

/* =========================
   主要関数: ユーザ文章解析
========================= */
export function analyzeUserText(text: string): Analysis {
  console.time?.("[Sofia:analyze] total");
  safeLog("[Sofia:analyze] input:", trunc(text, 200));

  const qMatches = Q_PATTERNS
    .map(([code, rx]) => ({ code, score: rx.test(text) ? 1 : 0 }))
    .filter(x => x.score > 0);

  const lMatches = LAYER_HINTS
    .map(([layer, rx]) => ({ layer, score: rx.test(text) ? 1 : 0 }))
    .filter(x => x.score > 0);

  // キーワード抽出（簡易）
  const tokens = Array.from(new Set(
    (text || "").toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
      .split(/\s+/).filter(Boolean)
  ));

  const topQ = qMatches.slice(0, 3);
  const topL = lMatches.slice(0, 2);
  const keywords = tokens.slice(0, 20);

  safeLog("[Sofia:analyze] qcodes:", topQ);
  safeLog("[Sofia:analyze] layers:", topL);
  safeLog("[Sofia:analyze] keywords(top20):", keywords);

  console.timeEnd?.("[Sofia:analyze] total");
  return { qcodes: topQ as any, layers: topL as any, keywords };
}

/* =========================
   追加: 位相/自己肯定率/関係性/次Q
========================= */
// 反応語彙（自己肯定/否定/過信）
const POS_SELF = /(できる|大丈夫|やってみる|落ち着いて|認める|感謝|助かった)/u;
const NEG_SELF = /(どうせ|無理|できない|自分なんか|不安|怖い|最悪|疲れた|諦め|ダメ)/u;
const OVERCONF = /(完璧|間違いない|俺が正しい|常に正しい|絶対に|批判は許さない)/u;

/** 位相推定 */
export function inferPhase(text: string | undefined): Phase {
  const t = (text || "");
  const innerHit = /(内省|内側|怖い|不安|疲れ|落ち着|整理|静か|後悔|反省)/u.test(t);
  const outerHit = /(相手|上司|部下|家族|チーム|営業|発言|投稿|発表|挑戦|批判|攻撃|怒り)/u.test(t);
  const phase: Phase = innerHit && !outerHit ? "Inner" : outerHit && !innerHit ? "Outer" : "Inner";
  safeLog("[analyze.inferPhase]", { innerHit, outerHit, phase });
  return phase;
}

/** 自己肯定率（推定）0-100 と帯域 */
export function estimateSelfAcceptance(
  text: string | undefined
): { score: number; band: "lt20" | "20_40" | "40_70" | "70_90" | "gt90" } {
  const t = (text || "");
  let score = 50;

  const pos = (t.match(POS_SELF) ? 1 : 0);
  const neg = (t.match(NEG_SELF) ? 1 : 0);
  const over = (t.match(OVERCONF) ? 1 : 0);

  score += pos * 10;
  score -= neg * 15;
  score += over * 12; // 一見高いが後段で過信補正

  // 過信（>90）を実質 20% とみなすヒント
  if (score > 90 && over) score = 20 + Math.min(10, pos * 5);

  score = Math.max(0, Math.min(100, Math.round(score)));

  const band =
    score < 20 ? "lt20" :
    score < 40 ? "20_40" :
    score < 70 ? "40_70" :
    score < 90 ? "70_90" : "gt90";

  safeLog("[analyze.estimateSelfAcceptance]", { pos, neg, over, score, band });
  return { score, band };
}

/** 位相×自己肯定率 → 関係性の質（返答トーン用） */
export function relationQualityFrom(
  phase: Phase,
  selfBand: "lt20" | "20_40" | "40_70" | "70_90" | "gt90"
): { label: RelationQuality; confidence: number } {
  let label: RelationQuality = "harmony";
  let conf = 0.55;

  if (phase === "Inner") {
    if (selfBand === "lt20" || selfBand === "20_40") { label = "discord"; conf = 0.7; }
    if (selfBand === "40_70") { label = "harmony"; conf = 0.6; }
    if (selfBand === "70_90") { label = "harmony"; conf = 0.8; }
    if (selfBand === "gt90")  { label = "harmony"; conf = 0.65; } // 硬直に注意
  } else { // Outer
    if (selfBand === "lt20" || selfBand === "20_40") { label = "discord"; conf = 0.8; } // 投影・攻撃化
    if (selfBand === "40_70") { label = "harmony"; conf = 0.6; }
    if (selfBand === "70_90") { label = "harmony"; conf = 0.75; }
    if (selfBand === "gt90")  { label = "discord"; conf = 0.7; }  // 過信リスク
  }

  safeLog("[analyze.relationQualityFrom]", { phase, selfBand, label, conf });
  return { label, confidence: conf };
}

/** Q → 次Q（位相別） */
export function nextQFrom(qcode: string, phase: Phase): string | null {
  const mapInner: Record<string, string> = { Q1: "Q3", Q2: "Q1", Q3: "Q1", Q4: "Q3", Q5: "Q4" };
  const mapOuter: Record<string, string> = { Q1: "Q4", Q2: "Q5", Q3: "Q5", Q4: "Q2", Q5: "Q2" };
  const q = (qcode || "").toUpperCase();
  const next = (phase === "Inner" ? mapInner[q] : mapOuter[q]) || null;
  safeLog("[analyze.nextQFrom]", { qcode: q, phase, next });
  return next;
}

/* =========================
   総合ワンショット（任意）
   - 既存呼び出しに影響を出したくないので別関数で提供
========================= */
export function analyzeAll(text: string) {
  const base = analyzeUserText(text);
  const phase = inferPhase(text);
  const self = estimateSelfAcceptance(text);
  const relation = relationQualityFrom(phase, self.band);
  const nextQ = base.qcodes[0]?.code ? nextQFrom(base.qcodes[0].code, phase) : null;

  return {
    ...base,
    phase,
    selfAcceptance: self,
    relation,
    nextQ,
  };
}
