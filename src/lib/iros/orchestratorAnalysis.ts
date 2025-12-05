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

import {
  analyzeUnifiedTurn,
  type UnifiedLikeAnalysis,
} from './unifiedAnalysis';

import { applyDepthContinuity, applyQContinuity } from './depthContinuity';

import { updateQTrace, type QTrace } from './orchestratorCore';

import { computeYH } from './analysis/computeYH';

// ★ 追加：Polarity & Stability 計算
import {
  computePolarityAndStability,
  type PolarityBand,
  type StabilityBand,
} from './analysis/polarity';

import {
  estimateSelfAcceptance,
  type SelfAcceptanceInput,
} from './sa/meter';

import { clampSelfAcceptance } from './orchestratorMeaning';

import {
  deriveIntentLine,
  type IntentLineAnalysis,
} from './intent/intentLineEngine';

import {
  detectIrTrigger,
  decidePierceMode,
} from './orchestratorPierce';

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
     0) Unified-like 解析（Q / Depth の決定入口）
  ========================================================= */
  const unified = await analyzeUnifiedTurn({
    text,
    requestedDepth,
    requestedQCode,
  });

  // LLM / ルールベースの生の推定結果
  const rawDepthFromScan: Depth | undefined =
    unified.depth.stage ?? undefined;

  // ★ Q は unified の結果が無ければ requestedQCode をそのままスキャン結果として利用
  const rawQFromScan: QCode | undefined =
    (unified.q.current as QCode | undefined) ??
    requestedQCode ??
    undefined;

  /* =========================================================
     A) 深度スキャン + 連続性補正
  ========================================================= */

  const lastDepth = baseMeta?.depth;
  const lastQ = (baseMeta as any)?.qCode as QCode | undefined;

  let depthFromContinuity: Depth | undefined;

  if (rawDepthFromScan) {
    // ✅ 今回のスキャン結果があるときは、それをそのまま「今回の視点」として採用
    depthFromContinuity = rawDepthFromScan;
  } else {
    // ✅ スキャンできなかったときだけ、連続性ロジックで補完
    depthFromContinuity = normalizeDepth(
      applyDepthContinuity({
        scanDepth: rawDepthFromScan,
        lastDepth,
        text,
        isFirstTurn: !!isFirstTurn,
      }),
    );
  }

  // depth 最終決定（I層強制は orchestrator.ts 側で処理する想定）
  const depth: Depth | undefined = depthFromContinuity;

  // Qコードはこれまで通り「スキャン結果＋連続性」で決める
  const qCode: QCode | undefined = normalizeQCode(
    applyQContinuity({
      scanQ: rawQFromScan,
      lastQ,
      isFirstTurn: !!isFirstTurn,
    }),
  );

  /* =========================================================
     A-2) QTrace の更新（D: 揺れの履歴ログ用の基盤）
  ========================================================= */
  const prevQTrace = (baseMeta as any)?.qTrace as
    | QTrace
    | undefined
    | null;

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
     A') 統一：最終決定した depth / qCode を unified にも反映
  ========================================================= */
  const fixedUnified: UnifiedLikeAnalysis = {
    ...unified,
    q: {
      ...unified.q,
      current: qCode ?? unified.q.current,
    },
    depth: {
      ...unified.depth,
      stage: depth ?? unified.depth.stage,
    },
  };

  /* =========================================================
     SA) Self Acceptance（自己肯定“ライン”）の決定
  ========================================================= */

  // 直近のライン SA（あれば）を lastSelfAcceptance として渡す
  const lastSelfAcceptanceRaw =
    typeof memoryState?.selfAcceptance === 'number'
      ? memoryState.selfAcceptance
      : typeof (baseMeta as any)?.selfAcceptance === 'number'
      ? (baseMeta as any).selfAcceptance
      : null;

  // phase は Unified の結果を優先し、無ければ MemoryState から補完
  const phaseForSA: 'Inner' | 'Outer' | null =
    fixedUnified?.phase === 'Inner' || fixedUnified?.phase === 'Outer'
      ? fixedUnified.phase
      : memoryState?.phase ?? null;

  const saInput: SelfAcceptanceInput = {
    userText: text,
    // Orchestrator 単体では直前の assistantText を持っていないため、ここでは空文字。
    assistantText: '',
    qCode: qCode ?? null,
    depthStage: depth ?? null,
    phase: phaseForSA,
    historyDigest: null,
    lastSelfAcceptance: lastSelfAcceptanceRaw,
  };

  // meter から返ってくる値 = 「更新済みの自己肯定ライン」
  const saResult = await estimateSelfAcceptance(saInput);
  const selfAcceptanceLine = clampSelfAcceptance(saResult.value);

  // ★ unified 側にも SelfAcceptance ラインを埋め込む（UI / ログ用）
  if (fixedUnified) {
    (fixedUnified as any).selfAcceptance = selfAcceptanceLine;
    (fixedUnified as any).self_acceptance = selfAcceptanceLine;
  }

  /* =========================================================
     Y/H) 揺れ(Y)・余白(H) の推定
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

  // ★ unified にも Y/H を埋め込んでおく（必要なら）
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

  // ログ / LLM 用に unified にも入れておく
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

  // すでに meta 側に意図アンカーがあれば、それをベースにする
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
    // 既存アンカーを優先（数値だけ今回の Y/H, SA で補完）
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
    // アンカーがまだ無い場合のみ、テキストから暫定生成
    const raw = (text || '').trim();
    if (raw.length > 0) {
      // 「最初の文」をざっくり拾う（。！？で区切る）→ なければ全文
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

  // unified にも意図アンカーを埋め込む（Orchestrator / ログ / LLM 用）
  if (intentAnchor) {
    (fixedUnified as any).intent_anchor = intentAnchor;
  }

  /* =========================================================
     ir診断トリガー + I層 Piercing 判定
  ========================================================= */

  const irTriggered = detectIrTrigger(text);

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
      // relationTone / historyQ は今は未使用（将来拡張用）
    });

    if (intentLine && (intentLine as any).tLayerHint) {
      tLayerHint = (intentLine as any).tLayerHint as string;
    }

    if (
      intentLine &&
      typeof (intentLine as any).hasFutureMemory === 'boolean'
    ) {
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

/* ========= 未来方向モード検出ヘルパー ========= */

function detectFutureDirectionMode(args: {
  text: string;
  irTriggered: boolean;
  intentLine: IntentLineAnalysis | null | undefined;
}): boolean {
  const { text, irTriggered, intentLine } = args;

  // 1) IntentLine からのシグナルを最優先
  if (
    intentLine &&
    ((intentLine as any).hasFutureMemory === true ||
      (intentLine as any).tLayerHint)
  ) {
    return true;
  }

  // 2) テキストのキーワード（未来 / 意図 / 方向 系）
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

  // 3) ir診断など、構造的に「先」を見るモードは T層寄りとみなす
  if (irTriggered) {
    return true;
  }

  return false;
}
