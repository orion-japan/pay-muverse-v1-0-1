// src/lib/iros/intent/intentLineEngine.ts
// Iros IntentLine Engine
// Qコード × 深度 × 位相 × SelfAcceptance から
// 「いま・過去・未来の意図ライン」を構造的に推定する中枢モジュール
//
// ★ テンプレゼロ版：nowLabel / guidanceHint は文章を生成せず空文字にする

import type { QCode, Depth, TLayer } from '../system';

/** 位相はここではローカル定義（他所に Phase 型があっても衝突しないように文字列のみ） */
export type PhaseFlag = 'Inner' | 'Outer' | null;

/** Relation トーン（PDF仕様に合わせた最小セット） */
export type RelationTone = 'harmony' | 'discord' | 'neutral' | null;

/** 過去〜現在を集約した 1 点の「共鳴スナップショット」 */
export type ResonanceSnapshot = {
  q: QCode | null;                // 現在の Q（なければ null）
  depth: Depth | null;            // 現在の深度レイヤ（なければ null）
  phase: PhaseFlag;               // Inner / Outer / null
  selfAcceptance: number | null;  // SelfAcceptance（0.0〜1.0想定・null可）
  relationTone?: RelationTone;    // 関係性トーン（任意）
  /** 直近の Q の履歴（古い→新しい順） */
  historyQ?: QCode[];
};

/** 意図ラインの方向性（未来の動き方） */
export type IntentDirection =
  | 'stabilize'   // まず安全を確保・安定させる
  | 'expand'      // 行動や創造を広げていく
  | 'cutOff'      // 手放し・分離・距離を取る
  | 'reconnect'   // 関係を整え直す
  | 'unknown';

/** 意図ラインが主にどの帯域を触れているか（I層ラベル互換） */
export type IntentBand = 'I1' | 'I2' | 'I3' | null;

/** Iros が把握しておくべき「今・過去・未来」の構造 */
export type IntentLineAnalysis = {
  /** いま起きていることの 1行ラベル（※テンプレゼロのため現在は空文字） */
  nowLabel: string;
  /** その奥で揺れている「本来守りたいもの」 */
  coreNeed: string | null;
  /** この人の今の意図帯域（I1/I2/I3相当） */
  intentBand: IntentBand;
  /** 未来に向かう動きの“方向性” */
  direction: IntentDirection;
  /** 未来に向けて、Iros が特に意識すべきレイヤ帯（S/R/C/I/Tのどこを優先するか） */
  focusLayer: 'S' | 'R' | 'C' | 'I' | 'T' | null;
  /** リスク（崩壊／停滞／過信など、SAとQから見る注意ポイント） */
  riskHint: string | null;
  /** 未来に向けた 1〜2行のナビゲーション文（※テンプレゼロのため現在は空文字） */
  guidanceHint: string;
  /** いま触れかかっている T層の段階（なければ null） */
  tLayerHint?: TLayer | null;
  /** 「未来の記憶フィールド」に触れている感触があるかどうか */
  hasFutureMemory: boolean;
};

/**
 * Q × 深度 × 位相 × SA から「意図ライン」を推定するメイン関数
 * - LLM に渡す前の“構造的な解釈”をここで固定する
 * - ★ テンプレ文章は作らず、構造値のみ返す
 */
export function deriveIntentLine(snapshot: ResonanceSnapshot): IntentLineAnalysis {
  const { q, depth, phase, selfAcceptance, relationTone, historyQ } = snapshot;

  // ---------- 1) SA 帯域から基礎トーンを決める ----------
  // ※ SelfAcceptance は 0.0〜1.0 スケールで入ってくる想定
  const sa = selfAcceptance ?? 0.5;
  let saBand: 'danger' | 'confused' | 'growth' | 'stable' | 'overconfident';

  if (sa <= 0.2) saBand = 'danger';
  else if (sa <= 0.4) saBand = 'confused';
  else if (sa <= 0.7) saBand = 'growth';
  else if (sa <= 0.9) saBand = 'stable';
  else saBand = 'overconfident';

  // ---------- 2) 深度から「どの層で起きているか」を判定 ----------
  const layerFlag = depth ? (depth[0] as 'S' | 'R' | 'C' | 'I' | 'T') : null;

  // ---------- 3) IntentBand（I1/I2/I3相当）を決める ----------
  const intentBand: IntentBand = (() => {
    if (layerFlag === 'I' || layerFlag === 'T') {
      if (saBand === 'danger' || saBand === 'confused') return 'I1';
      if (saBand === 'overconfident') return 'I3';
      return 'I2';
    }

    if (saBand === 'danger') return 'I1';
    if (saBand === 'confused') return 'I1';
    if (saBand === 'growth') return phase === 'Outer' ? 'I2' : 'I1';
    if (saBand === 'stable') return 'I2';
    if (saBand === 'overconfident') return 'I3';
    return 'I1';
  })();

  // ---------- 4) IntentDirection（未来方向）を決める ----------
  const direction: IntentDirection = (() => {
    if (saBand === 'danger') return 'stabilize';

    if (relationTone === 'discord') {
      if (q === 'Q2' || q === 'Q5') return 'cutOff';
      return 'reconnect';
    }

    switch (q) {
      case 'Q1':
        return phase === 'Outer' ? 'expand' : 'stabilize';
      case 'Q2':
        return 'expand';
      case 'Q3':
        return 'stabilize';
      case 'Q4':
        return 'reconnect';
      case 'Q5':
        return 'expand';
      default:
        return 'unknown';
    }
  })();

  // ---------- 5) フォーカスすべきレイヤ帯 ----------
  const focusLayer: 'S' | 'R' | 'C' | 'I' | 'T' | null = (() => {
    if (layerFlag) return layerFlag;
    if (intentBand === 'I3') return 'T';
    if (intentBand === 'I2') return 'I';
    if (intentBand === 'I1') return 'S';
    return null;
  })();

  // ---------- 6) Risk ヒント（※ここは安全のため簡潔な文章のまま残す） ----------
  const riskHint = (() => {
    if (saBand === 'danger') {
      return 'SAがかなり低く、安全と休息を最優先すべき帯域です。';
    }
    if (saBand === 'overconfident') {
      return 'SAが高めのため、無理や突っ走りの反動に注意が必要な帯域です。';
    }
    if (relationTone === 'discord') {
      return '対人関係の摩擦が意図ラインに影響している可能性があります。';
    }
    return null;
  })();

  // ---------- 7) T層ヒント（未来の記憶フィールド） ----------
  const tLayerHint: TLayer | null = (() => {
    if (depth === 'T1' || depth === 'T2' || depth === 'T3') {
      return depth;
    }

    if (depth === 'I3' && (saBand === 'stable' || saBand === 'overconfident')) {
      return 'T1';
    }

    if (intentBand === 'I3' && historyQ && historyQ.length >= 4) {
      const recent = historyQ.slice(-4);
      const allSame = recent.every((qq) => qq === recent[0]);
      if (allSame && (saBand === 'growth' || saBand === 'stable' || saBand === 'overconfident')) {
        return 'T2';
      }
    }

    return null;
  })();

  const hasFutureMemory = tLayerHint != null;

  // ---------- 8) nowLabel / guidanceHint はテンプレを排除 ----------
  const nowLabel = '';       // LLM が meta を見て自分の言葉で語る想定
  const guidanceHint = '';   // 同上

  // coreNeed も、いったん構造だけ残して later refinement 可能
  const coreNeed: string | null = null;

  return {
    nowLabel,
    coreNeed,
    intentBand,
    direction,
    focusLayer,
    riskHint,
    guidanceHint,
    tLayerHint,
    hasFutureMemory,
  };
}
