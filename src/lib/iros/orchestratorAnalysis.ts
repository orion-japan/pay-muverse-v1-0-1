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

import {
  deriveIntentLine,
  type IntentLineAnalysis,
} from './intent/intentLineEngine';

import { detectIrTrigger, decidePierceMode } from './orchestratorPierce';

type PierceDecision = ReturnType<typeof decidePierceMode>;

export type OrchestratorAnalysisResult = {
  depth: Depth | undefined;
  qCode: QCode | undefined;

  // ✅ 追加：Phase（Inner/Outer）を返す
  phase: 'Inner' | 'Outer' | null;

  unified: UnifiedLikeAnalysis;
  selfAcceptanceLine: number | null;
  qTrace: QTrace;
  yLevel: number | null;
  hLevel: number | null;

  polarityScore: number | null;
  polarityBand: PolarityBand;
  stabilityBand: StabilityBand;

  irTriggered: boolean;
  pierceDecision: PierceDecision;
  intentLine: IntentLineAnalysis | null;
  tLayerHint: string | null;
  hasFutureMemory: boolean | null;
  tLayerModeActive: boolean;

  // ✅ 追加：I層に入った理由（デバッグ用）
  iEnterReasons: string[] | null;
  iEnterEvidence: {
    from: Depth | null;
    to: Depth | null;
    phase: 'Inner' | 'Outer' | null;
    irTriggered: boolean;
    futureDirectionActive: boolean;
    tLayerHint: string | null;
    hasFutureMemory: boolean | null;
    hasIntentLine: boolean;
  } | null;



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
     ※ Q は unified で「使ってもいい」が、無ければ null 前提で扱う
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
  } else {
    // ✅ 追加：そのターンのテキストから推定（推定できないときだけ fallback）
    const inferred = inferPhaseFromText(text);
    if (inferred) {
      phase = inferred;
    } else if (memoryState?.phase === 'Inner' || memoryState?.phase === 'Outer') {
      phase = memoryState.phase;
    } else if (
      baseMeta &&
      ((baseMeta as any).phase === 'Inner' || (baseMeta as any).phase === 'Outer')
    ) {
      phase = (baseMeta as any).phase as 'Inner' | 'Outer';
    }
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
     - unifiedQ / scanQ も「材料」として拾えるようにする（存在すれば）
  ========================================================= */
  const explicitQ = pickExplicitQCode(text);

  // unified 側に Q が入っている場合だけ拾う（無理に作らない）
  const unifiedQ: QCode | null = normalizeQCode((unified as any)?.q?.current);

  // 候補生成（キーワード分類ではなく “構造シグナル”）
  const qCodeCandidate = proposeQFromSignals({
    lastQ: (lastQ ?? null) as QCode | null,
    unifiedQ,
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
      lastQ: (lastQ ?? null) as QCode | null,
      selfAcceptance: selfAcceptanceLine,
      lastSelfAcceptance: lastSelfAcceptanceRaw,
      yLevel: yh0.yLevel ?? null,
      isFirstTurn: !!isFirstTurn,
    }) ?? null;

  // ✅ 明示Qがある場合：continuityは通さず、そのまま最終確定
  // ✅ 明示Qがない場合：continuityで「戻し/維持」を決める
  //    scanQには「候補」を渡す（ここが “前回に張り付く” を緩和する本線）
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
     Intent Anchor（意図アンカー）の暫定導出
     - ここは「覚えてる？」の直接修正ではない
     - ただし、会話の “軸” を meta / state に残すための材料を作る
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
        typeof baseAnchor.y_level === 'number' ? baseAnchor.y_level : yLevel,
      h_level:
        typeof baseAnchor.h_level === 'number' ? baseAnchor.h_level : hLevel,
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

  // =========================================================
  // ✅ I層への遷移ゲート（配線）
  // =========================================================
  const shouldEnterI =
    !(depth && String(depth).startsWith('I')) &&
    (
      irTriggered ||
      !!intentLine ||
      futureDirectionActive === true ||
      !!tLayerHint ||
      hasFutureMemory === true
    );

  const finalDepth: Depth | undefined = shouldEnterI ? 'I1' : depth;

  // =========================================================
  // ✅ I層に入った理由（デバッグ用）※ここで1回だけ作る
  // =========================================================
  const iEnterReasons: string[] | null = shouldEnterI ? [] : null;

  if (iEnterReasons) {
    if (irTriggered) iEnterReasons.push('irTriggered');
    if (!!intentLine) iEnterReasons.push('intentLine');
    if (futureDirectionActive === true) iEnterReasons.push('futureDirectionActive');
    if (!!tLayerHint) iEnterReasons.push('tLayerHint');
    if (hasFutureMemory === true) iEnterReasons.push('hasFutureMemory');
    if (iEnterReasons.length === 0) iEnterReasons.push('unknown');
  }

  const iEnterEvidence = shouldEnterI
    ? {
        from: depth ?? null,
        to: finalDepth ?? null,
        phase,
        irTriggered,
        futureDirectionActive,
        tLayerHint,
        hasFutureMemory,
        hasIntentLine: !!intentLine,
      }
    : null;

  // fixedUnified にも反映（保存/描画の single source of truth）
  if (finalDepth && finalDepth !== depth) {
    (fixedUnified as any).depth = { ...(fixedUnified as any).depth, stage: finalDepth };
    console.log('[IROS][I-GATE] enter I', {
      from: depth ?? null,
      to: finalDepth,
      phase,
      irTriggered,
      futureDirectionActive,
      tLayerHint,
      hasFutureMemory,
      hasIntentLine: !!intentLine,
    });
  }

  return {
    depth: finalDepth,
    qCode,
    phase,
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

    // ✅ 追加した2つ（ここで返す）
    iEnterReasons,
    iEnterEvidence,
  };}
/* ========= ローカルヘルパー ========= */

function normalizeDepth(depth?: Depth): Depth | undefined {
  if (!depth) return undefined;
  return depth;
}

function normalizeQCode(qCode?: unknown): QCode | null {
  if (qCode === 'Q1' || qCode === 'Q2' || qCode === 'Q3' || qCode === 'Q4' || qCode === 'Q5') {
    return qCode as QCode;
  }
  return null;
}

/**
 * ユーザーが先頭/文中で「Q1〜Q5」を“状態宣言”として明示した場合に拾う
 * 例:
 * - "Q3 心配です"
 * - "今Q1っぽい"
 * - "（Q2）"
 * - "Q5状態で…"
 * - "これはQ3の状態だ"
 *
 * ✅ 方針：
 * - 「設計・説明文脈」は explicit 扱いしない（例: "RならQ2でいい", "Q1に倒したい"）
 * - “宣言っぽい形”だけ拾う（今/現在/状態/っぽい/です/だ/（Q2）など）
 */
function pickExplicitQCode(text: string): QCode | null {
  const s = String(text || '');
  if (!s) return null;

  // 正規化（全角Q/数字→半角、連続空白→単一化）
  const normalized = s
    .replace(/[Ｑ]/g, 'Q')
    .replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d)))
    .replace(/\s+/g, ' ')
    .trim();

  const compact = normalized.replace(/\s+/g, '');

  // ❌ 先に“設計・説明”っぽい文脈を除外（ここに引っかかったら explicit としては扱わない）
  // 例:
  // - "RならQ2でいい"
  // - "Q1に倒したい / Q2へ寄せる / Q3に戻す"
  // - "Q2を優先 / Q1を採用 / Q3で固定"
  if (
    /ならQ[1-5]/.test(compact) ||
    /Q[1-5]で(?:いい|OK|よい)/.test(compact) ||
    /Q[1-5]に(?:倒|寄|戻|する|したい)/.test(compact) ||
    /Q[1-5]を(?:優先|採用|固定|選ぶ)/.test(compact)
  ) {
    return null;
  }

  // ✅ “状態宣言”パターンを拾う（区切り文字が無くてもOK）
  // - 単独/括弧: "Q2", "(Q2)", "（Q2）"
  // - 連結: "Q5状態", "Q3の状態", "Q4状態で"
  // - 口語: "今Q1", "現在Q2", "Q3です", "Q2だ", "Q5っぽい"
  const m = compact.match(
    /(?:^|[（(【\[]|[：:、,。.!?？])(?:今|いま|現在|現状)?Q([1-5])(?:です|だ|っぽい|寄り|と思う|状態(?:で|だ|です)?|の状態(?:だ|です)?|状態)?(?:$|[）)】\]]|[：:、,。.!?？])/,
  );

  // ↑この正規表現は「Q5状態で」みたいな連結も拾えるように
  //   "状態" / "状態で" / "の状態" を許容しているのがポイント

  if (!m) return null;

  const q = `Q${m[1]}` as QCode;
  return q;
}



/**
 * Q候補の生成（キーワード分類はしない）
 * - requestedQCode は初回のみ採用
 * - 以後は depth/phase/SA/YH/irTriggered など “構造シグナル” から候補を出す
 *
 * ✅ 重要：
 * - 「Outer だから Q2」みたいな固定化ロジックは入れない（名残を削除）
 */
function proposeQFromSignals(args: {
  lastQ: QCode | null;
  unifiedQ: QCode | null;
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
    unifiedQ,
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


  // 0.5) unified でQが明確なら “候補” として採用（最終決定は stabilize/continuity）
  if (unifiedQ && unifiedQ !== lastQ) return unifiedQ;

  // 1) SA変化（落差/上昇）は “軸変換の圧” として強い
  const deltaSA =
    typeof selfAcceptance === 'number' && typeof lastSelfAcceptance === 'number'
      ? selfAcceptance - lastSelfAcceptance
      : 0;

  // 2) 揺れ（Y）が強い：不安/恐怖帯域へ寄る（Q3/Q4）
  const y = typeof yLevel === 'number' ? yLevel : 0;

  // 3) I層/ir は “深度上げ” の圧が強い → 中央化(Q3) / 再配列(Q1)
  const isI = depth === 'I1' || depth === 'I2' || depth === 'I3';
  if (irTriggered || isI) {
    if (deltaSA <= -0.03 || y >= 2) return 'Q3';
    return 'Q1';
  }

  // 4) C寄り：上がってるなら情熱(Q5)、それ以外は変化推進(Q2)
  const isC = depth === 'C1' || depth === 'C2' || depth === 'C3';
  if (isC) {
    if (deltaSA >= 0.03) return 'Q5';
    return 'Q2';
  }

  // 5) R寄り：揺れてるなら中央(Q3)、それ以外は推進(Q2)
  const isR = depth === 'R1' || depth === 'R2' || depth === 'R3';
  if (isR) {
    if (y >= 2) return 'Q3';
    return 'Q2';
  }

  // 6) S寄り：揺れ/落差があればQ3、そうでなければQ1
  const isS = depth === 'S1' || depth === 'S2' || depth === 'S3';
  if (isS) {
    if (y >= 2 || deltaSA <= -0.03) return 'Q3';
    return 'Q1';
  }

  // 7) phaseしか材料がない場合：
  //    - Inner: 整える(Q1) / 揺れが強いならQ3
  //    - Outer: “固定”はしない。lastQ を基本に、揺れが強いときだけQ3へ寄せる
  if (phase === 'Inner') {
    if (y >= 2 || deltaSA <= -0.03) return 'Q3';
    return 'Q1';
  }
  if (phase === 'Outer') {
    if (y >= 2 || deltaSA <= -0.03) return 'Q3';
    return lastQ ?? null;
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

  const strength = Math.max(Math.min(1, deltaSA * 10), Math.min(1, y / 3));

  // 強い時だけ切替（弱い時は lastQ を維持＝暴れ防止）
  if (strength >= 0.40) return candidate;

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
// orchestratorAnalysis.ts の一番下（ローカルヘルパー群の近く）に追加

function inferPhaseFromText(text: string): 'Inner' | 'Outer' | null {
  const s = String(text || '').trim();
  if (!s) return null;

  const compact = s.replace(/\s/g, '');

  // Outer: 外に向けた実行/依頼/具体策/提案/教示
  const outerRe =
    /(教えて|教えてください|アドバイス|具体的|提案|やり方|方法|手順|どうすれば|どうしたら|進め方|設計|実装|修正|確認|レビュー|作って|作成|出して|まとめて|整理して|比較して|おすすめ|選び方|例を|例:|サンプル)/;

  // Inner: 体感/感情/内省/未消化/自己状態の言語化
  const innerRe =
    /(つらい|苦しい|しんどい|怖い|不安|虚無|空虚|泣|怒り|焦り|モヤ|胸|喉|体が|固ま|震え|息|呼吸|浄化|受け止め|自分なんて|価値がない|消えたい|無理|限界|闇|未消化|トラウマ|痛み)/;

  const isOuter = outerRe.test(compact);
  const isInner = innerRe.test(compact);

  // 両方ヒットしたら「内側が先（体感/感情）」を優先
  if (isInner && !isOuter) return 'Inner';
  if (isOuter && !isInner) return 'Outer';
  if (isInner && isOuter) return 'Inner';

  return null;
}
