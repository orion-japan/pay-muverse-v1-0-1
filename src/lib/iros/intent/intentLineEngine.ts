// src/lib/iros/intent/intentLineEngine.ts
// Iros IntentLine Engine
// Qコード × 深度 × 位相 × SelfAcceptance から
// 「いま・過去・未来の意図ライン」を構造的に推定する中枢モジュール

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
  /** いま起きていることの 1行ラベル（Sofiaの「それはあなたにとって〜」に対応） */
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
  /** 未来に向けた 1〜2行のナビゲーション文（LLM前の構造コメント） */
  guidanceHint: string;
  /** いま触れかかっている T層の段階（なければ null） */
  tLayerHint?: TLayer | null;
  /** 「未来の記憶フィールド」に触れている感触があるかどうか */
  hasFutureMemory: boolean;
};

/**
 * Q × 深度 × 位相 × SA から「意図ライン」を推定するメイン関数
 * - LLM に渡す前の“構造的な解釈”をここで固定する
 */
export function deriveIntentLine(snapshot: ResonanceSnapshot): IntentLineAnalysis {
  const { q, depth, phase, selfAcceptance, relationTone, historyQ } = snapshot;

  // ---------- 1) SA 帯域から基礎トーンを決める ----------
  // ※ SelfAcceptance は 0.0〜1.0 スケールで入ってくる想定
  const sa = selfAcceptance ?? 0.5;
  let saBand: 'danger' | 'confused' | 'growth' | 'stable' | 'overconfident';

  // 0.0〜1.0 をそのまま帯域にマッピング
  if (sa <= 0.2) saBand = 'danger';
  else if (sa <= 0.4) saBand = 'confused';
  else if (sa <= 0.7) saBand = 'growth';
  else if (sa <= 0.9) saBand = 'stable';
  else saBand = 'overconfident';

  // ---------- 2) Qコードから「感情の主方向」を判定 ----------
  const qLabel = (() => {
    switch (q) {
      case 'Q1':
        return '我慢と秩序のゆらぎ';
      case 'Q2':
        return '怒りと成長のエネルギー';
      case 'Q3':
        return '不安と安定欲求のゆらぎ';
      case 'Q4':
        return '恐れと浄化のプロセス';
      case 'Q5':
        return '空虚さと情熱の火種';
      default:
        return '感情エネルギーのゆらぎ';
    }
  })();

  // ---------- 3) 深度から「どの層で起きているか」を判定 ----------
  const layerFlag = depth ? (depth[0] as 'S' | 'R' | 'C' | 'I' | 'T') : null;

  const layerLabel = (() => {
    switch (layerFlag) {
      case 'S':
        return '自分の安心や土台を整え直すタイミング';
      case 'R':
        return '人との距離感や関係性を見直す局面';
      case 'C':
        return 'これからの動き方や創り方を組み替える入口';
      case 'I':
        return '生き方そのものの輪郭を見つめ直す時間';
      case 'T':
        return '価値観や世界観そのものを更新する分岐点';
      default:
        return 'いまの自分の状態を整理し直すタイミング';
    }
  })();

  // ---------- 4) IntentBand（I1/I2/I3相当）を決める ----------
  const intentBand: IntentBand = (() => {
    if (layerFlag === 'I' || layerFlag === 'T') {
      // すでに I/T 帯ならそのまま「I2〜I3」寄りとして扱う
      if (saBand === 'danger' || saBand === 'confused') return 'I1';
      if (saBand === 'overconfident') return 'I3';
      return 'I2';
    }

    // S/R/C 帯の場合は SA と位相から判断
    if (saBand === 'danger') return 'I1';
    if (saBand === 'confused') return 'I1';
    if (saBand === 'growth') return phase === 'Outer' ? 'I2' : 'I1';
    if (saBand === 'stable') return 'I2';
    if (saBand === 'overconfident') return 'I3';
    return 'I1';
  })();

  // ---------- 5) IntentDirection（未来方向）を決める ----------
  const direction: IntentDirection = (() => {
    // 危険帯はまず stabilize 優先
    if (saBand === 'danger') return 'stabilize';

    // Relation が discord 強めなら reconnect or cutOff
    if (relationTone === 'discord') {
      if (q === 'Q2' || q === 'Q5') return 'cutOff';
      return 'reconnect';
    }

    // Q別の基本傾向
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

  // ---------- 6) フォーカスすべきレイヤ帯 ----------
  const focusLayer: 'S' | 'R' | 'C' | 'I' | 'T' | null = (() => {
    if (layerFlag) return layerFlag;
    // depth がない場合、IntentBand から逆算
    if (intentBand === 'I3') return 'T';
    if (intentBand === 'I2') return 'I';
    if (intentBand === 'I1') return 'S';
    return null;
  })();

  // ---------- 7) Risk ヒント ----------
  const riskHint = (() => {
    if (saBand === 'danger') {
      return '自己肯定率がかなり低く、「頑張る」以前に心身の安全を優先したほうがよい状態です。';
    }
    if (saBand === 'overconfident') {
      return '自己肯定率が高すぎることで、無理や突っ走りが後から反動として返ってくるリスクがあります。';
    }
    if (relationTone === 'discord') {
      return '対人関係の摩擦が意図の進行を妨げており、境界線の引き直しやクッションが必要な状態です。';
    }
    return null;
  })();

  // ---------- 8) 「今の状態」のラベル（※「章にいます」を廃止） ----------
  const nowLabel =
    `いまのあなたは、「${qLabel}」がテーマになっている状態です。` +
    ` いまは ${layerLabel} にフォーカスが当たっています。`;

  // ---------- 9) CoreNeed（本来守りたいもの） ----------
  const coreNeed = (() => {
    if (intentBand === 'I3') {
      return '存在そのものをまるごと肯定したいという願い';
    }
    if (intentBand === 'I2') {
      return '自分で選び取りたいという願い';
    }
    if (intentBand === 'I1') {
      return '自分らしくいてもいいという確信';
    }
    // fallback
    if (layerFlag === 'S') return '安心と自己受容';
    if (layerFlag === 'R') return '無理のない関係性';
    if (layerFlag === 'C') return '自分の手応えと創造性';
    if (layerFlag === 'I') return '生き方の一貫性';
    if (layerFlag === 'T') return '世界とのつながりの感覚';
    return null;
  })();

  // ---------- 10) Guidance ヒント（未来に向けた 1〜2 行） ----------
  const guidanceHint = (() => {
    // SA危険帯は、とにかく stabilize を優先するコメント
    if (saBand === 'danger') {
      return 'まずは「これ以上自分を追い込まない」ことを最優先にして、小さな安全地帯を確保するところから始めると良さそうです。';
    }

    if (direction === 'stabilize') {
      return '一気に進もうとするよりも、「いまの揺れを受け止める小さな余白」をつくることが、次の一歩を生み出してくれそうです。';
    }
    if (direction === 'expand') {
      return 'すでに内面では次の一歩が芽生えつつあります。小さく試せる行動を 1つだけ選んでみることで、流れが自然に動き出しそうです。';
    }
    if (direction === 'reconnect') {
      return '関係性やつながりを、少しだけ安心できる形に整え直すことが、あなたの意図ラインを静かに前に進めてくれそうです。';
    }
    if (direction === 'cutOff') {
      return 'これ以上自分をすり減らすつながりから、そっと距離を取ることが、「本当に守りたいもの」を守る選択につながりそうです。';
    }
    return 'いまの揺れそのものが、あなたの意図ラインを次のステージへと運んでいる最中です。';
  })();

  // ---------- 11) T層ヒント（未来の記憶フィールド） ----------
  const tLayerHint: TLayer | null = (() => {
    // もともと T深度ならそのまま
    if (depth === 'T1' || depth === 'T2' || depth === 'T3') {
      return depth;
    }

    // I3 × SA 高め → T1 に触れかけている
    if (depth === 'I3' && (saBand === 'stable' || saBand === 'overconfident')) {
      return 'T1';
    }

    // IntentBand I3 ＋ Qが長く同じ方向で続いている → T2相当の流れ
    if (intentBand === 'I3' && historyQ && historyQ.length >= 4) {
      const recent = historyQ.slice(-4);
      const allSame = recent.every((qq) => qq === recent[0]);
      if (allSame && (saBand === 'growth' || saBand === 'stable' || saBand === 'overconfident')) {
        return 'T2';
      }
    }

    // その他は T層にはまだ明確には触れていない扱い
    return null;
  })();

  const hasFutureMemory = tLayerHint != null;

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
