// file: src/lib/iros/rotation/descentGate.ts
// iros — Descent Gate (落下ゲート)
//
// 目的：自己否定/不安で「S -S -F -R」みたいな負方向ループに入っているかを
//       LLM禁止・純関数で判定して、meta.descentGate を安定的に切り替える。
// 方針：Qコード + selfAcceptance(sa) + depthStage + 直前ゲート(prev) でヒステリシス。
//
// ✅ 方針：descentGate は boolean を捨てて string union に統一する
//   'closed'  : 落下していない（通常）
//   'offered' : 落下を提案/開始（下降に入ってよい）
//   'accepted': 落下を受理（下降中・保持）
//
// ※入力側で boolean が来る場合でも、この関数は壊れない（内部で正規化する）

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | null;

export type DepthStage =
  | 'S1' | 'S2' | 'S3'
  | 'F1' | 'F2' | 'F3'
  | 'R1' | 'R2' | 'R3'
  | 'C1' | 'C2' | 'C3'
  | 'I1' | 'I2' | 'I3'
  | 'T1' | 'T2' | 'T3'
  | null;

export type DescentGateState = 'closed' | 'offered' | 'accepted';

export type DescentGateInput = {
  qCode: QCode; // 'Q1'..'Q5'
  sa: number | null; // selfAcceptance 0..1 想定
  depthStage: DepthStage; // 'S1'..'T3' 等
  targetKind?: string | null; // 'uncover' など（任意）

  // ✅ 統一形は DescentGateState だが、過渡期として boolean が来ても壊れないようにする
  prevDescentGate?: DescentGateState | boolean | null;
};

export type DescentGateResult = {
  descentGate: DescentGateState;
  reason: string;
  debug?: {
    score: number;
    qRisk: number;
    saRisk: number;
    depthRisk: number;
    targetRisk: number;
    prev: DescentGateState | null;
    thresholds: { on: number; off: number };
  };
};

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function depthBand(depthStage: DepthStage): 'S' | 'F' | 'R' | 'C' | 'I' | 'T' | 'U' {
  const d = String(depthStage ?? '').trim().toUpperCase();
  const head = d.slice(0, 1);
  if (head === 'S') return 'S';
  if (head === 'F') return 'F';
  if (head === 'R') return 'R';
  if (head === 'C') return 'C';
  if (head === 'I') return 'I';
  if (head === 'T') return 'T';
  return 'U';
}

function normalizePrevDescentGate(v: DescentGateInput['prevDescentGate']): DescentGateState | null {
  if (v == null) return null;

  // 互換: boolean が来たら
  if (typeof v === 'boolean') return v ? 'accepted' : 'closed';

  // 正式: string union
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'closed' || s === 'offered' || s === 'accepted') return s as DescentGateState;
  }

  return null;
}

function qRiskScore(qCode: QCode): number {
  const q = String(qCode ?? '').trim().toUpperCase();

  // 目安：
  // - Q3/Q4 は自己否定・不安/恐怖で落下しやすい
  // - Q1 は抑制で停滞はありうるが「落下ゲート」単体では強くない
  // - Q2/Q5 は上向き寄り
  if (q === 'Q3') return 0.55;
  if (q === 'Q4') return 0.75;
  if (q === 'Q1') return 0.25;
  if (q === 'Q2') return 0.10;
  if (q === 'Q5') return 0.10;
  return 0.20; // unknown
}

function saRiskScore(sa: number | null): number {
  if (typeof sa !== 'number' || !Number.isFinite(sa)) return 0.35; // unknown は中間
  const x = clamp01(sa);

  // SA が低いほど落下リスクが高い
  // 0.35以下はかなり危険、0.55以上で落ち着く
  if (x <= 0.25) return 0.85;
  if (x <= 0.35) return 0.70;
  if (x <= 0.45) return 0.55;
  if (x <= 0.55) return 0.35;
  return 0.15;
}

function depthRiskScore(depthStage: DepthStage): number {
  const band = depthBand(depthStage);

  // S/F/R は「自己否定で負ループ」になりやすい帯域
  // C/I/T は「創造・統合」方向に寄りやすい
  if (band === 'S') return 0.55;
  if (band === 'F') return 0.50;
  if (band === 'R') return 0.45;
  if (band === 'C') return 0.20;
  if (band === 'I') return 0.15;
  if (band === 'T') return 0.10;
  return 0.30; // unknown
}

function targetRiskScore(targetKind: string | null | undefined): number {
  const raw = String(targetKind ?? '').trim().toLowerCase();

  // ------------------------------------------------------------
  // 互換: goal.kind（enableAction等）や別名が混入してもここで正規化
  // 期待するのは: uncover / expand / stabilize / pierce / forward 系
  // ------------------------------------------------------------
  const norm =
    raw === 'enableaction' ? 'expand'
    : raw === 'enable_action' ? 'expand'
    : raw === 'action' ? 'expand'
    : raw === 'act' ? 'expand'
    : raw === 'forward' ? 'forward'
    : raw;

  // uncover は深掘りなので、落下中にやると悪化することがある → 少しリスク加点
  if (norm === 'uncover') return 0.25;

  // expand（行動/前進）系は落下から抜ける一歩になりやすい → リスク減点
  if (norm === 'forward' || norm === 'expand') return -0.10;

  // stabilize は安全寄り（悪化させにくい）→ 影響なし
  if (norm === 'stabilize') return 0;

  // pierce は鋭い切り込みで刺激になりやすい → 微加点（必要なら後で調整）
  if (norm === 'pierce') return 0.10;

  return 0;
}


/**
 * decideDescentGate
 * - score が一定以上なら offered
 * - 一度 offered/accepted になったら、OFF閾値を下げて“揺れ戻り”を抑える（ヒステリシス）
 * - 下降中は accepted に寄せて保持（安定性優先）
 */
export function decideDescentGate(input: DescentGateInput): DescentGateResult {
  const qRisk = qRiskScore(input.qCode);
  const saRisk = saRiskScore(input.sa);
  const depthRisk = depthRiskScore(input.depthStage);
  const tRisk = targetRiskScore(input.targetKind);

  // スコア合成（0..1 を想定。targetは加減点）
  // SA と Q を強めに
  let score =
    qRisk * 0.38 +
    saRisk * 0.42 +
    depthRisk * 0.20 +
    tRisk;

  // 範囲クランプ
  score = Math.max(0, Math.min(1, score));

  const prev = normalizePrevDescentGate(input.prevDescentGate);
  const prevIsDown = prev === 'offered' || prev === 'accepted';

  // ヒステリシス閾値
  // - ON:  0.58 以上で offered
  // - OFF: 0.48 未満で closed（prevが下降中のときだけ適用）
  const ON_TH = 0.58;
  const OFF_TH = 0.48;

  let descentGate: DescentGateState;
  let reason: string;

  if (prevIsDown) {
    // いったん落ちたら、少し回復しても簡単に戻さない
    descentGate = score >= OFF_TH ? 'accepted' : 'closed';
    reason =
      descentGate === 'accepted'
        ? `hold: prev=${prev}, score=${score.toFixed(2)} >= off=${OFF_TH}`
        : `recover: prev=${prev}, score=${score.toFixed(2)} < off=${OFF_TH}`;
  } else {
    descentGate = score >= ON_TH ? 'offered' : 'closed';
    reason =
      descentGate === 'offered'
        ? `drop: score=${score.toFixed(2)} >= on=${ON_TH}`
        : `stable: score=${score.toFixed(2)} < on=${ON_TH}`;
  }

  return {
    descentGate,
    reason,
    debug: {
      score,
      qRisk,
      saRisk,
      depthRisk,
      targetRisk: tRisk,
      prev,
      thresholds: { on: ON_TH, off: OFF_TH },
    },
  };
}
