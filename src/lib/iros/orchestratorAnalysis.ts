// src/lib/iros/orchestratorAnalysis.ts
// Iros Orchestrator — 解析パート集約
// - Unified-like 解析
// - depth / Q の決定（連続性補正付き）
// - SelfAcceptance ライン / Y・H
// - Polarity / Stability
// - ir診断トリガー / I層ピアス判定
// - IntentLine / T層ヒント / 未来方向モード

import type { Depth, QCode, IrosMeta } from './system';
import type { IrosMemoryState } from './memoryState';

import { analyzeUnifiedTurn, type UnifiedLikeAnalysis } from './unifiedAnalysis';

import { updateQTrace, type QTrace } from './orchestratorCore';

import { computeYH } from './analysis/computeYH';

import { applyDepthContinuity, applyQContinuity } from './depthContinuity';


// ★ 追加：Polarity & Stability 計算
import {
  computePolarityAndStability,
  type PolarityBand,
  type StabilityBand,
} from './analysis/polarity';

import { estimateSelfAcceptance, type SelfAcceptanceInput } from './sa/meter';

import { clampSelfAcceptance } from './orchestratorMeaning';

import { deriveIntentLine, type IntentLineAnalysis } from './intent/intentLineEngine';

import { detectIrTrigger, decidePierceMode } from './orchestratorPierce';

type PierceDecision = ReturnType<typeof decidePierceMode>;

export type OrchestratorAnalysisResult = {
  depth: Depth | undefined;
  qCode: QCode | undefined;
  unified: UnifiedLikeAnalysis;
  selfAcceptanceLine: number | null;
  qTrace: QTrace;
  yLevel: number | null;
  hLevel: number | null;

  // ★ 追加：Polarity / Stability
  polarityScore: number | null;
  polarityBand: PolarityBand;
  stabilityBand: StabilityBand;

  irTriggered: boolean;
  pierceDecision: PierceDecision;
  intentLine: IntentLineAnalysis | null;
  tLayerHint: string | null;
  hasFutureMemory: boolean | null;
  tLayerModeActive: boolean;
};

/**
 * Iros の 1ターンに必要な「解析フェーズ」をまとめて実行する。
 */
export async function runOrchestratorAnalysis(args: {
  text: string;
  requestedDepth?: Depth;
  requestedQCode?: QCode;
  baseMeta?: Partial<IrosMeta>;
  memoryState?: IrosMemoryState | null;
  isFirstTurn?: boolean;
}): Promise<OrchestratorAnalysisResult> {
  const {
    text,
    requestedDepth,
    requestedQCode,
    baseMeta,
    memoryState,
    isFirstTurn,
  } = args;

  /* =========================================================
     0) Unified-like 解析（Depth / Phase / Situation）
     ※ Q は unified で扱わない（常に null）
  ========================================================= */
  const unified = await analyzeUnifiedTurn({
    text,
    requestedDepth,
    requestedQCode,
  });

  // 生の推定（Depthのみ）
  const rawDepthFromScan: Depth | undefined = unified.depth.stage ?? undefined;

/* =========================================================
   A) 深度スキャン + 連続性補正（scanがあっても必ず通す）
========================================================= */
const lastDepth = baseMeta?.depth;
const lastQ = (baseMeta as any)?.qCode as QCode | undefined;

const depth: Depth | undefined = normalizeDepth(
  applyDepthContinuity({
    scanDepth: rawDepthFromScan, // undefinedでもOK
    lastDepth,
    text,
    isFirstTurn: !!isFirstTurn,
  }),
);

  /* =========================================================
     P) Phase（Inner / Outer）の統一（Q決定の材料に使う）
  ========================================================= */
  let phase: 'Inner' | 'Outer' | null = null;

  const unifiedPhaseRaw: unknown = (unified as any).phase;
  if (unifiedPhaseRaw === 'Inner' || unifiedPhaseRaw === 'Outer') {
    phase = unifiedPhaseRaw;
  } else if (memoryState?.phase === 'Inner' || memoryState?.phase === 'Outer') {
    phase = memoryState.phase;
  } else if (
    baseMeta &&
    ((baseMeta as any).phase === 'Inner' || (baseMeta as any).phase === 'Outer')
  ) {
    phase = (baseMeta as any).phase as 'Inner' | 'Outer';
  }

  /* =========================================================
     ir診断トリガー（Q候補生成の材料）
  ========================================================= */
  const irTriggered = detectIrTrigger(text);

  /* =========================================================
     SA) Self Acceptance（自己肯定“ライン”）
     ※ ここでは qCode は未確定なので null で計測（Qで誤誘導しない）
  ========================================================= */
  const lastSelfAcceptanceRaw =
    typeof memoryState?.selfAcceptance === 'number'
      ? memoryState.selfAcceptance
      : typeof (baseMeta as any)?.selfAcceptance === 'number'
        ? (baseMeta as any).selfAcceptance
        : null;

  const phaseForSA: 'Inner' | 'Outer' | null = phase;

  const saInput0: SelfAcceptanceInput = {
    userText: text,
    assistantText: '',
    qCode: null,
    depthStage: depth ?? null,
    phase: phaseForSA,
    historyDigest: null,
    lastSelfAcceptance: lastSelfAcceptanceRaw,
  };

  const saResult0 = await estimateSelfAcceptance(saInput0);
  const selfAcceptanceLine = clampSelfAcceptance(saResult0.value);

  /* =========================================================
     Y/H) 揺れ(Y)・余白(H)（Q決定の材料に使うため “仮” 計算）
     ※ qCode 未確定なので null で1回計算
  ========================================================= */
  const yh0 = computeYH({
    text,
    depth: depth ?? null,
    qCode: null,
    selfAcceptance: selfAcceptanceLine,
    unified,
    prevMeta: (baseMeta as any) ?? null,
  });

/* =========================================================
   Q) Qコード確定（明示Qがあれば絶対勝ち / それ以外は continuity）
========================================================= */
const explicitQ = pickExplicitQCode(text);

const qCodeCandidate = proposeQFromSignals({
  lastQ: lastQ ?? null,
  depth: depth ?? null,
  phase,
  irTriggered,
  selfAcceptance: selfAcceptanceLine,
  lastSelfAcceptance: lastSelfAcceptanceRaw,
  yLevel: yh0.yLevel ?? null,
  hLevel: yh0.hLevel ?? null,
  isFirstTurn: !!isFirstTurn,
  requestedQCode: requestedQCode ?? null,
  text,
});

const stabilizedQ =
  stabilizeQ({
    candidate: qCodeCandidate,
    lastQ: lastQ ?? null,
    selfAcceptance: selfAcceptanceLine,
    lastSelfAcceptance: lastSelfAcceptanceRaw,
    yLevel: yh0.yLevel ?? null,
    isFirstTurn: !!isFirstTurn,
  }) ?? null;

// ✅ 明示Qがある場合：continuityは通さず、そのまま最終確定
// ✅ 明示Qがない場合：continuityで「戻し/維持」を決める（scanQに候補を渡すのが重要）
const qFinal: QCode | null = explicitQ
  ? explicitQ
  : (applyQContinuity({
      scanQ: (stabilizedQ ?? qCodeCandidate) ?? undefined,
      lastQ: lastQ ?? undefined,
      isFirstTurn: !!isFirstTurn,
    }) ?? null);


const qCode: QCode | undefined = qFinal ?? undefined;

  /* =========================================================
     A-2) QTrace の更新（最終Qで更新する）
  ========================================================= */
  const prevQTrace = (baseMeta as any)?.qTrace as QTrace | undefined | null;

  const qTrace: QTrace = updateQTrace(
    prevQTrace ?? {
      lastQ: null,
      dominantQ: null,
      streakQ: null,
      streakLength: 0,
      volatility: 0,
    },
    qCode ?? null,
  );

  /* =========================================================
     A') 統一：最終決定した depth / qCode / phase / SA を unified に反映
  ========================================================= */
  const fixedUnified: UnifiedLikeAnalysis = {
    ...unified,
    q: { ...unified.q, current: qCode ?? null },
    depth: { ...unified.depth, stage: depth ?? unified.depth.stage },
    phase,
  };

  (fixedUnified as any).selfAcceptance = selfAcceptanceLine;
  (fixedUnified as any).self_acceptance = selfAcceptanceLine;

  /* =========================================================
     Y/H) 揺れ(Y)・余白(H)（確定Qで再計算）
  ========================================================= */
  const yh = computeYH({
    text,
    depth: depth ?? null,
    qCode: qCode ?? null,
    selfAcceptance: selfAcceptanceLine,
    unified: fixedUnified,
    prevMeta: (baseMeta as any) ?? null,
  });

  const yLevel = yh.yLevel ?? null;
  const hLevel = yh.hLevel ?? null;

  (fixedUnified as any).yLevel = yLevel;
  (fixedUnified as any).hLevel = hLevel;

  /* =========================================================
     Polarity & Stability の推定
  ========================================================= */
  const pol = computePolarityAndStability({
    qCode: qCode ?? null,
    selfAcceptance: selfAcceptanceLine,
    yLevel,
  });

  const polarityScore = pol.polarityScore;
  const polarityBand = pol.polarityBand;
  const stabilityBand = pol.stabilityBand;

  (fixedUnified as any).polarityScore = polarityScore;
  (fixedUnified as any).polarityBand = polarityBand;
  (fixedUnified as any).stabilityBand = stabilityBand;

  /* =========================================================
     GIGA) Intent Anchor（意図アンカー）の暫定導出
  ========================================================= */
  let intentAnchor:
    | {
        text: string;
        strength?: number | null;
        y_level?: number | null;
        h_level?: number | null;
      }
    | null = null;

  const baseAnchor =
    (baseMeta as any)?.intent_anchor &&
    typeof (baseMeta as any).intent_anchor === 'object'
      ? (baseMeta as any).intent_anchor
      : null;

  if (
    baseAnchor &&
    typeof baseAnchor.text === 'string' &&
    baseAnchor.text.trim().length > 0
  ) {
    intentAnchor = {
      text: baseAnchor.text.trim(),
      strength:
        typeof baseAnchor.strength === 'number'
          ? baseAnchor.strength
          : selfAcceptanceLine,
      y_level:
        typeof baseAnchor.y_level === 'number'
          ? baseAnchor.y_level
          : yLevel,
      h_level:
        typeof baseAnchor.h_level === 'number'
          ? baseAnchor.h_level
          : hLevel,
    };
  } else {
    const raw = (text || '').trim();
    if (raw.length > 0) {
      const m = raw.match(/^(.+?[。！？!?])/);
      const core = (m && m[1]) || raw;
      const anchorText = core.slice(0, 180).trim();

      if (anchorText.length > 0) {
        intentAnchor = {
          text: anchorText,
          strength: selfAcceptanceLine,
          y_level: yLevel,
          h_level: hLevel,
        };
      }
    }
  }

  if (intentAnchor) {
    (fixedUnified as any).intent_anchor = intentAnchor;
  }

  /* =========================================================
     I層 Piercing 判定
  ========================================================= */
  const pierceDecision = decidePierceMode({
    depth: depth ?? null,
    requestedDepth,
    selfAcceptance: selfAcceptanceLine,
    yLevel: yh.yLevel,
    irTriggered,
  });

  /* =========================================================
     Intent Line の導出
  ========================================================= */
  let intentLine: IntentLineAnalysis | null = null;
  let tLayerHint: string | null = null;
  let hasFutureMemory: boolean | null = null;

  try {
    const phaseForIntentLine =
      fixedUnified?.phase === 'Inner' || fixedUnified?.phase === 'Outer'
        ? fixedUnified.phase
        : null;

    intentLine = deriveIntentLine({
      q: qCode ?? null,
      depth: depth ?? null,
      phase: phaseForIntentLine,
      selfAcceptance: selfAcceptanceLine,
    });

    if (intentLine && (intentLine as any).tLayerHint) {
      tLayerHint = (intentLine as any).tLayerHint as string;
    }

    if (intentLine && typeof (intentLine as any).hasFutureMemory === 'boolean') {
      hasFutureMemory = (intentLine as any).hasFutureMemory as boolean;
    }
  } catch (e) {
    console.warn('[IROS/ANALYSIS] deriveIntentLine failed', e);
  }

  /* =========================================================
     未来方向モード検出（T層モードフラグ）
  ========================================================= */
  const futureDirectionActive = detectFutureDirectionMode({
    text,
    irTriggered,
    intentLine,
  });

  if (futureDirectionActive) {
    if (!tLayerHint) {
      tLayerHint = 'T2';
    }
    if (hasFutureMemory === null) {
      hasFutureMemory = true;
    }
  }

  console.log('[IROS/QDECIDE] ping');

  console.log('[IROS/QDECIDE][analysis]', {
    text: (text || '').slice(0, 60),
    lastQ: (baseMeta as any)?.qCode ?? null,
    unifiedQ: (unified as any)?.q?.current ?? null,
    scanQ: (unified as any)?.q?.current ?? null,
    explicitQ: explicitQ ?? null,
    decidedQ: qCode ?? null,
    depth: depth ?? null,
    phase,
  });

  if (explicitQ) {
    console.log('[IROS/QDECIDE][explicit]', { explicitQ, applied: true });
  }

  return {
    depth,
    qCode,
    unified: fixedUnified,
    selfAcceptanceLine,
    qTrace,
    yLevel,
    hLevel,
    polarityScore,
    polarityBand,
    stabilityBand,
    irTriggered,
    pierceDecision,
    intentLine,
    tLayerHint,
    hasFutureMemory,
    tLayerModeActive: futureDirectionActive,
  };
}

/* ========= ローカルヘルパー ========= */

function normalizeDepth(depth?: Depth): Depth | undefined {
  if (!depth) return undefined;
  return depth;
}

function normalizeQCode(qCode?: QCode): QCode | undefined {
  if (!qCode) return undefined;
  return qCode;
}

/**
 * ユーザーが先頭/文中で「Q1〜Q5」を明示した場合に拾う
 * 例: "Q3 心配です", "今Q1っぽい", "（Q2）"
 */
function pickExplicitQCode(text: string): QCode | null {
  const s = String(text || '');
  if (!s) return null;

  // なるべく事故らないように「Q + 1桁」を拾う（全角・空白・記号も許容）
  // 例: "Q3", "Q 3", "Ｑ３", "(Q2)" などを許容
  const normalized = s
    .replace(/[Ｑ]/g, 'Q')
    .replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d)))
    .replace(/\s+/g, '');

  const m = normalized.match(/Q([1-5])/);
  if (!m) return null;

  const q = `Q${m[1]}` as QCode;
  if (q === 'Q1' || q === 'Q2' || q === 'Q3' || q === 'Q4' || q === 'Q5') {
    return q;
  }
  return null;
}

/**
 * Q候補の生成（キーワード分類はしない）
 * - requestedQCode は初回のみ採用
 * - 以後は depth/phase/SA/YH/irTriggered など “構造シグナル” から候補を出す
 */
function proposeQFromSignals(args: {
  lastQ: QCode | null;
  depth: Depth | null;
  phase: 'Inner' | 'Outer' | null;
  irTriggered: boolean;
  selfAcceptance: number | null;
  lastSelfAcceptance: number | null;
  yLevel: number | null;
  hLevel: number | null;
  isFirstTurn: boolean;
  requestedQCode: QCode | null;
  text: string;
}): QCode | null {
  const {
    lastQ,
    depth,
    phase,
    irTriggered,
    selfAcceptance,
    lastSelfAcceptance,
    yLevel,
    isFirstTurn,
    requestedQCode,
  } = args;

  // 0) 初回のみ：明示指定があれば採用（以後は固定化原因になるので使わない）
  if (isFirstTurn && requestedQCode) return requestedQCode;

  // 1) SA変化（落差/上昇）は “軸変換の圧” として強い
  const deltaSA =
    typeof selfAcceptance === 'number' && typeof lastSelfAcceptance === 'number'
      ? selfAcceptance - lastSelfAcceptance
      : 0;

  // 2) 揺れ（Y）が強い：不安/恐怖帯域へ寄る（Q3/Q4）
  //    ※ここは「感情分類」ではなく「安定性シグナル」からの推定
  const y = typeof yLevel === 'number' ? yLevel : 0;

  // 3) I層/ir は “深度上げ” の圧が強い → 抑制(Q1) or 変容(Q3) のどちらかへ寄せる
  const isI = depth === 'I1' || depth === 'I2' || depth === 'I3';

  if (irTriggered || isI) {
    // SAが落ちている/揺れているなら「中心化（Q3）」へ
    if (deltaSA <= -0.03 || y >= 2) return 'Q3';
    // それ以外は「再配列（Q1）」へ（秩序/再決定）
    return 'Q1';
  }

  // 4) 創造/行動（C）寄り：推進（Q2/Q5）
  const isC = depth === 'C1' || depth === 'C2' || depth === 'C3';
  if (isC) {
    if (deltaSA >= 0.03) return 'Q5'; // 上がってる → 情熱
    return 'Q2'; // 動かす → 変容
  }

  // 5) 関係/共鳴（R）寄り：推進（Q2） or 調整（Q3）
  const isR = depth === 'R1' || depth === 'R2' || depth === 'R3';
  if (isR) {
    if (y >= 2) return 'Q3'; // 揺れてる → 中央へ
    return 'Q2';
  }

  // 6) Self（S）寄り：安定化（Q1/Q3）
  const isS = depth === 'S1' || depth === 'S2' || depth === 'S3';
  if (isS) {
    if (y >= 2 || deltaSA <= -0.03) return 'Q3';
    return 'Q1';
  }

  // 7) Phaseだけ見える場合：Innerは整える(Q1/Q3)、Outerは動かす(Q2)
  if (phase === 'Inner') {
    if (y >= 2 || deltaSA <= -0.03) return 'Q3';
    return 'Q1';
  }
  if (phase === 'Outer') {
    return 'Q2';
  }

  // 8) 何も決め手がない：前回を維持
  return lastQ ?? null;
}

/**
 * Qの安定化（固定化ではない）
 * - candidate が lastQ と違う場合でも “強いシグナル” があるときだけ切り替える
 */
function stabilizeQ(args: {
  candidate: QCode | null;
  lastQ: QCode | null;
  selfAcceptance: number | null;
  lastSelfAcceptance: number | null;
  yLevel: number | null;
  isFirstTurn: boolean;
}): QCode | null {
  const { candidate, lastQ, selfAcceptance, lastSelfAcceptance, yLevel } = args;
  if (!candidate) return lastQ ?? null;
  if (!lastQ) return candidate;
  if (candidate === lastQ) return candidate;

  const deltaSA =
    typeof selfAcceptance === 'number' && typeof lastSelfAcceptance === 'number'
      ? Math.abs(selfAcceptance - lastSelfAcceptance)
      : 0;

  const y = typeof yLevel === 'number' ? yLevel : 0;

  // “強さ” の目安（0〜1くらいで扱う）
  const strength = Math.max(Math.min(1, deltaSA * 10), Math.min(1, y / 3));

  // 強い時だけ切替（弱い時は lastQ を維持＝暴れ防止）
  if (strength >= 0.55) return candidate;

  return lastQ;
}

/* ========= 未来方向モード検出ヘルパー ========= */

function detectFutureDirectionMode(args: {
  text: string;
  irTriggered: boolean;
  intentLine: IntentLineAnalysis | null | undefined;
}): boolean {
  const { text, irTriggered, intentLine } = args;

  if (
    intentLine &&
    ((intentLine as any).hasFutureMemory === true ||
      (intentLine as any).tLayerHint)
  ) {
    return true;
  }

  const compact = text.replace(/\s/g, '');
  const futureKeywords = [
    'これから',
    '今後',
    '未来',
    '将来',
    'どこに向かう',
    'どう進めば',
    '進み方',
    '方向性',
    '意図',
    'ビジョン',
  ];

  if (futureKeywords.some((kw) => compact.includes(kw))) {
    return true;
  }

  if (irTriggered) {
    return true;
  }

  return false;
}
