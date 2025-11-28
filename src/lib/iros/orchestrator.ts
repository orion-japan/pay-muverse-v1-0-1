// src/lib/iros/orchestrator.ts
// Iros Orchestrator — Will Engine（Goal / Priority）+ Continuity Engine 統合版
// - 極小構造のまま「意志の連続性」を追加した v2
// - Unified-like 解析入口 + isFirstTurn 対応版
// - A: 深度スキャン構造化（autoDepthFromDeepScan / autoQFromDeepScan）
// - B: 連続性（前ターンの depth / Q を使った補正）

import {
  type IrosMode,
  type Depth,
  type QCode,
  type IrosMeta,
  type IrosIntentMeta,
  IROS_MODES,
  DEPTH_VALUES,
  QCODE_VALUES,
} from './system';

import { deriveIrosGoal } from './will/goalEngine';
import { deriveIrosPriority } from './will/priorityEngine';

// Continuity Engine（Goal 用）
import {
  applyGoalContinuity,
  type ContinuityContext,
} from './will/continuityEngine';

// Depth/Q 連続性（分離モジュール）
import { applyDepthContinuity, applyQContinuity } from './depthContinuity';

// Unified-like 解析（分離モジュール）
import {
  analyzeUnifiedTurn,
  type UnifiedLikeAnalysis,
} from './unifiedAnalysis';

import { generateIrosReply, type GenerateResult } from './generate';

// ★ Intent Line エンジン
import {
  deriveIntentLine,
  type IntentLineAnalysis,
} from './intent/intentLineEngine';

// ★ 意味づけ・SelfAcceptance 系ヘルパー（分割先）
import {
  clampSelfAcceptance,
  resolveModeWithSA,
  buildFinalMeta,
  buildPersonalMeaningBlock,
  classifySelfAcceptance,
} from './orchestratorMeaning';

// ★ QTrace（揺れの履歴）を扱うコア
import { updateQTrace, type QTrace } from './orchestratorCore';

// ★ Y/H（揺れ・余白）推定コア
import { computeYH } from './analysis/computeYH';

// ★ MemoryState（現在地レイヤー）読み書き
import {
  loadIrosMemoryState,
  upsertIrosMemoryState,
  type IrosMemoryState,
} from './memoryState';

// ★ Self Acceptance メーター
//   - ここで得られる値は「瞬間の気分」ではなく、
//     lastSelfAcceptance をブレンドした “自己肯定ライン（長期ベースライン）”
import {
  estimateSelfAcceptance,
  type SelfAcceptanceInput,
} from './sa/meter';

// ★ I層 Piercing / Priority 補正（分割ファイル）
import {
  detectIrTrigger,
  decidePierceMode,
  adjustPriorityWithSelfAcceptance,
} from './orchestratorPierce';

// ★ I層強制モード（ENV）
//   - true のとき、requestedDepth を優先して depth を固定する
const FORCE_I_LAYER =
  typeof process !== 'undefined' &&
  process.env.IROS_FORCE_I_LAYER === '1';

// ==== Orchestrator に渡す引数 ==== //
export type IrosOrchestratorArgs = {
  conversationId?: string;
  text: string;

  requestedMode?: IrosMode;
  requestedDepth?: Depth;
  requestedQCode?: QCode;

  baseMeta?: Partial<IrosMeta>;

  /** ★ この会話の最初のターンかどうか（reply/route.ts から渡す） */
  isFirstTurn?: boolean;

  /** ★ MemoryState 読み書き用：user_code */
  userCode?: string;
};

// ==== Orchestrator から返す結果 ==== //
export type IrosOrchestratorResult = {
  content: string;
  meta: IrosMeta;
};

export async function runIrosTurn(
  args: IrosOrchestratorArgs,
): Promise<IrosOrchestratorResult> {
  const {
    conversationId,
    text,
    requestedMode,
    requestedDepth,
    requestedQCode,
    baseMeta,
    isFirstTurn,
    userCode,
  } = args;

  // ★ MemoryState / QTrace から順に上書きしていくベース
  let mergedBaseMeta: Partial<IrosMeta> | undefined = baseMeta;

  /* =========================================================
     -1) MemoryState 読み込み
         - userCode ごとに 1行だけ持っている「現在地」を baseMeta に合成
  ========================================================= */
  let memoryState: IrosMemoryState | null = null;

  if (userCode) {
    try {
      memoryState = await loadIrosMemoryState(userCode);

      if (
        typeof process !== 'undefined' &&
        process.env.NODE_ENV !== 'production'
      ) {
        console.log('[IROS/ORCH v2] loaded MemoryState', {
          userCode,
          hasMemory: !!memoryState,
          depthStage: memoryState?.depthStage ?? null,
          qPrimary: memoryState?.qPrimary ?? null,
          selfAcceptance: memoryState?.selfAcceptance ?? null,
          yLevel: memoryState?.yLevel ?? null,
          hLevel: memoryState?.hLevel ?? null,
        });
      }

      if (memoryState) {
        const hasBaseSA =
          typeof (mergedBaseMeta as any)?.selfAcceptance === 'number' &&
          !Number.isNaN((mergedBaseMeta as any).selfAcceptance);

        mergedBaseMeta = {
          ...(mergedBaseMeta ?? {}),
          // depth / qCode：明示指定 or 既存 meta があればそちら優先
          ...(mergedBaseMeta?.depth
            ? {}
            : memoryState.depthStage
            ? { depth: memoryState.depthStage as Depth }
            : {}),
          ...(mergedBaseMeta?.qCode
            ? {}
            : memoryState.qPrimary
            ? { qCode: memoryState.qPrimary as QCode }
            : {}),
          // SelfAcceptance / Y / H だけを合成（phase / intent 系は一旦外す）
          // ★ selfAcceptance は「自己肯定ライン」。baseMeta に無い場合のみ MemoryState から補完
          ...(!hasBaseSA && typeof memoryState.selfAcceptance === 'number'
            ? { selfAcceptance: memoryState.selfAcceptance }
            : {}),
          ...(typeof memoryState.yLevel === 'number'
            ? { yLevel: memoryState.yLevel }
            : {}),
          ...(typeof memoryState.hLevel === 'number'
            ? { hLevel: memoryState.hLevel }
            : {}),
        };
      }
    } catch (e) {
      console.error('[IROS/ORCH v2] loadIrosMemoryState failed', {
        userCode,
        error: e,
      });
    }
  }

  /* =========================================================
     0) Unified-like 解析（Q / Depth の決定をここに集約）
        ─ 後で UnifiedAnalysis LLM に差し替える入口
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
        - 基本方針：
          「今回のスキャン結果（autoDepthFromDeepScan）を最優先」
        - scanDepth が取れない場合のみ、前回の depth から補完
  ========================================================= */

  let depthFromContinuity: Depth | undefined;

  if (rawDepthFromScan) {
    // ✅ 今回のスキャン結果があるときは、それをそのまま「今回の視点」として採用
    depthFromContinuity = rawDepthFromScan;
  } else {
    // ✅ スキャンできなかったときだけ、連続性ロジックで補完
    depthFromContinuity = normalizeDepth(
      applyDepthContinuity({
        scanDepth: rawDepthFromScan,
        lastDepth: mergedBaseMeta?.depth,
        text,
        isFirstTurn: !!isFirstTurn,
      }),
    );
  }

  // ★ I層強制モード or requestedDepth が I層 のときは requestedDepth を最優先
  let depth: Depth | undefined;
  if ((FORCE_I_LAYER || isIntentDepth(requestedDepth)) && requestedDepth) {
    depth = requestedDepth;
  } else {
    depth = depthFromContinuity;
  }

  // Qコードはこれまで通り「スキャン結果＋連続性」で決める
  const qCode = normalizeQCode(
    applyQContinuity({
      scanQ: rawQFromScan,
      lastQ: (mergedBaseMeta as any)?.qCode,
      isFirstTurn: !!isFirstTurn,
    }),
  );

  /* =========================================================
     A-2) QTrace の更新（D: 揺れの履歴ログ用の基盤）
          - mergedBaseMeta.qTrace を読み、今回の qCode で 1ステップ更新
          - 結果は meta.qTrace として次ターン・ログに残す
  ========================================================= */
  const prevQTrace = (mergedBaseMeta as any)?.qTrace as
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
         - ログ／DB上で resolved と unified がずれないようにする
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
         - sa/meter.ts を利用して、text / depth / Q / phase / lastSA から推定
         - ここで扱う selfAcceptance は「瞬間の気分」ではなく、
           lastSelfAcceptance をブレンドした *自己肯定ライン* として扱う
  ========================================================= */

  // 直近のライン SA（あれば）を lastSelfAcceptance として渡す
  const lastSelfAcceptanceRaw =
    typeof memoryState?.selfAcceptance === 'number'
      ? memoryState.selfAcceptance
      : typeof (mergedBaseMeta as any)?.selfAcceptance === 'number'
      ? (mergedBaseMeta as any).selfAcceptance
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
         - text / depth / qCode / selfAcceptanceLine / unified / prevMeta から
           0〜3 レベルでスコアリング
  ========================================================= */
  const yh = computeYH({
    text,
    depth: depth ?? null,
    qCode: qCode ?? null,
    selfAcceptance: selfAcceptanceLine,
    unified: fixedUnified,
    prevMeta: (mergedBaseMeta as any) ?? null,
  });

  // ==========================================
  // ir診断：観測対象の抽出（トリガー時のみ）
  // ==========================================
  const irTriggered = detectIrTrigger(text);

  // ===============================
  // I層 Piercing 判定（再利用する）
  // ===============================
  const pierceDecision = decidePierceMode({
    depth: depth ?? null,
    requestedDepth,
    selfAcceptance: selfAcceptanceLine,
    yLevel: yh.yLevel,
    irTriggered, // ← さっきのを再利用！
  });

  /* =========================================================
     mode の最終決定（SelfAcceptance ライン + I層判定）
  ========================================================= */

  const baseMode = normalizeMode(requestedMode);

  const baseWeights = (() => {
    switch (baseMode) {
      case 'consult':
      case 'counsel':
        // 相談寄りを少し強めておく
        return { counsel: 2, mirror: 1, resonate: 1 };
      case 'resonate':
        // 前向きモードを少し強めておく
        return { counsel: 1, mirror: 1, resonate: 2 };
      case 'mirror':
      default:
        // デフォルトは mirror 中心
        return { counsel: 1, mirror: 2, resonate: 1 };
    }
  })();

  // ★ SelfAcceptance ラインを加味して mirror / counsel / forward(resonate) の比重を調整
  let mode: IrosMode = resolveModeWithSA(baseWeights, selfAcceptanceLine);

  // ★ pierceMode 中は基本的に mirror 優先
  if (pierceDecision.pierceMode && mode !== 'mirror') {
    mode = 'mirror';
  }

  // I層は常に mirror 固定（優先ルール）
  if (isIntentDepth(requestedDepth) || isIntentDepth(depth)) {
    mode = 'mirror';
  }

  // ====== 次ターンに残る meta（I層はこのあと上書きする） ======
  let meta: IrosMeta = {
    ...(mergedBaseMeta ?? {}),
    mode,
    ...(depth ? { depth } : {}),
    ...(qCode ? { qCode } : {}),
    // ★ Y/H を meta に載せる（0〜3 のレベル）
    yLevel: yh.yLevel,
    hLevel: yh.hLevel,
    // unified 結果そのものも meta に残しておく（DB jsonb にそのまま入る想定）
    unified: fixedUnified,
    // ★ I層 Piercing 状態を meta に載せる
    pierceMode: pierceDecision.pierceMode,
    pierceReason: pierceDecision.pierceReason,
  } as IrosMeta;

  // ★ Self Acceptance ラインを meta に載せる
  if (selfAcceptanceLine !== null) {
    (meta as any).selfAcceptance = selfAcceptanceLine;
  }

  // ★ QTrace を meta に載せる（D: 揺れの履歴ログ用）
  (meta as any).qTrace = qTrace;

  /* =========================================================
     A'') Intent Line の導出
         - Q / Depth / Phase / SelfAcceptance ラインから
           「いまのフェーズ」を 1 本の線にまとめる
  ========================================================= */
  try {
    const phaseRaw =
      fixedUnified?.phase === 'Inner' || fixedUnified?.phase === 'Outer'
        ? fixedUnified.phase
        : null;

    const selfAcceptanceForIntentLine =
      typeof (meta as any)?.selfAcceptance === 'number'
        ? (meta as any).selfAcceptance
        : null;

    const intentLine: IntentLineAnalysis | null = deriveIntentLine({
      q: qCode ?? null,
      depth: depth ?? null,
      phase: phaseRaw,
      selfAcceptance: selfAcceptanceForIntentLine,
      // relationTone / historyQ は今は未使用（将来拡張用）
    });

    // ★ Intent Line と T層ヒント / 未来記憶フラグを meta に載せる
    meta = {
      ...meta,
      intentLine,
      ...(intentLine && (intentLine as any).tLayerHint
        ? { tLayerHint: (intentLine as any).tLayerHint }
        : {}),
      ...(intentLine && typeof (intentLine as any).hasFutureMemory === 'boolean'
        ? { hasFutureMemory: (intentLine as any).hasFutureMemory }
        : {}),
    };
  } catch (e) {
    console.warn('[IROS/ORCH] deriveIntentLine failed', e);
  }

  /* =========================================================
     A''') 未来方向モード検出（T層フラグ整備）
           - intentLine / tLayerHint / hasFutureMemory / テキスト内容から
             「未来方向が前面に出ているか」を判定し、meta にフラグ付け
  ========================================================= */
  const futureDirectionActive = detectFutureDirectionMode({
    text,
    irTriggered,
    intentLine: (meta as any).intentLine ?? null,
  });

  if (futureDirectionActive) {
    // tLayerHint / hasFutureMemory が未設定の場合の補完
    if (!(meta as any).tLayerHint) {
      // 未来方向モード時のデフォルト T層ヒント（将来必要に応じて調整）
      (meta as any).tLayerHint =
        (meta as any).intentLine?.tLayerHint ?? 'T2';
    }

    if (typeof (meta as any).hasFutureMemory !== 'boolean') {
      (meta as any).hasFutureMemory = true;
    }
  }

  // LLM 側で参照しやすいよう、「いま T層を前面に出すべきか」のフラグを固定
  (meta as any).tLayerModeActive = futureDirectionActive;

  /* =========================================================
     ① Goal Engine：今回の "意志" を生成
  ========================================================= */
  let goal = deriveIrosGoal({
    userText: text,
    lastDepth: mergedBaseMeta?.depth,
    lastQ: mergedBaseMeta?.qCode,
    requestedDepth,
    requestedQCode,
  });

  /* =========================================================
     ② Continuity Engine：前回の意志を踏まえて補正（Goal 用）
  ========================================================= */
  const continuity: ContinuityContext = {
    lastDepth: mergedBaseMeta?.depth,
    lastQ: mergedBaseMeta?.qCode,
    userText: text,
  };
  goal = applyGoalContinuity(goal, continuity);

  /* =========================================================
     ③ Priority Engine：Goal の意志に基づき重み計算
  ========================================================= */
  const priorityBase = deriveIrosPriority({
    goal,
    mode,
    depth,
    qCode,
  });

  // ★ SelfAcceptance ラインを使って Priority を補正
  const priority = adjustPriorityWithSelfAcceptance(
    priorityBase,
    selfAcceptanceLine,
  );

  // meta に priority も載せて、LLM 側で使えるようにしておく
  (meta as any).priority = priority;

  // ====== ログ（開始時点の解析サマリ） ======
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    const irTargetType = (meta as any).irTargetType ?? null;
    const irTargetText = (meta as any).irTargetText ?? null;

    console.log('[IROS/ORCH v2] runIrosTurn start', {
      conversationId,
      textSample: text.slice(0, 80),
      requestedMode,
      requestedDepth,
      requestedQCode,
      autoDepthFromDeepScan: rawDepthFromScan ?? null,
      autoQFromDeepScan: rawQFromScan ?? null,
      chosenDepth: depth ?? null,
      resolved: { mode, depth: depth ?? null, qCode: qCode ?? null },
      baseMeta: mergedBaseMeta,
      goalAfterContinuity: goal,
      priorityWeights: priority.weights,
      isFirstTurn,
      FORCE_I_LAYER,
      selfAcceptance: selfAcceptanceLine,
      selfAcceptanceBand: classifySelfAcceptance(selfAcceptanceLine),
      qTrace,
      yLevel: yh.yLevel,
      hLevel: yh.hLevel,
      fromMemoryState: {
        hasMemory: !!memoryState,
        depthStage: memoryState?.depthStage ?? null,
        qPrimary: memoryState?.qPrimary ?? null,
      },
      // 🆕 I層 Piercing 関連
      irTriggered,
      pierceModeCandidate: pierceDecision.pierceMode,
      pierceReasonCandidate: pierceDecision.pierceReason,
      // 🆕 ir 観測対象
      irTargetType,
      irTargetText,
      // 🆕 T層ヒント（ログ確認用）
      tLayerHint: (meta as any).tLayerHint ?? null,
      hasFutureMemory: (meta as any).hasFutureMemory ?? null,
      tLayerModeActive: (meta as any).tLayerModeActive ?? null,
    });
  }

  /* =========================================================
     ④ LLM：生成（本文 + I層ジャッジ）
  ========================================================= */
  const result: GenerateResult = await generateIrosReply({
    conversationId,
    text,
    meta,
  });

  // ★ 診断ヘッダーを本文から除去（旧 Q3〜Unified ブロック用）
  const contentWithoutDiag = stripDiagnosticHeader(result.content);

  // I層ジャッジの結果を meta に反映
  if (result.intent) {
    const intent: IrosIntentMeta = result.intent;
    meta = {
      ...meta,
      intent,
      intentLayer: intent.layer,
      intentConfidence: intent.confidence ?? null,
      intentReason: intent.reason ?? null,
    };
  }

  /* =========================================================
     ⑤ 最終 meta の統合（Q / Depth / intentSummary を整える）
  ========================================================= */
  meta = buildFinalMeta({
    baseMeta: mergedBaseMeta,
    workingMeta: meta,
    goal,
  });

  /* =========================================================
     ⑥ 表示モード
        - いまは常に「LLM本文のみ」をそのまま返す
        - 構図（Q / depth / intentLine）は meta 側だけで利用し、
          UI には「いまの構図：〜」などのヘッダーは出さない
  ========================================================= */

  const finalContent: string = contentWithoutDiag;
  const hasMeaningBlock: boolean = false;

  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    const saFinal =
      typeof (meta as any).selfAcceptance === 'number'
        ? (meta as any).selfAcceptance
        : null;
    const yFinal =
      typeof (meta as any).yLevel === 'number'
        ? (meta as any).yLevel
        : null;
    const hFinal =
      typeof (meta as any).hLevel === 'number'
        ? (meta as any).hLevel
        : null;

    console.log('[IROS/ORCH v2] runIrosTurn done', {
      conversationId,
      resolved: {
        mode: meta.mode,
        depth: meta.depth ?? null,
        qCode: meta.qCode ?? null,
      },
      goalKind: goal?.kind ?? null,
      replyLength: finalContent.length,
      isFirstTurn,
      intentLayer: meta.intentLayer ?? null,
      intentConfidence: meta.intentConfidence ?? null,
      hasMeaningBlock,
      selfAcceptance: saFinal,
      yLevel: yFinal,
      hLevel: hFinal,
      pierceMode: (meta as any).pierceMode ?? null,
      pierceReason: (meta as any).pierceReason ?? null,
      irTargetType: (meta as any).irTargetType ?? null,
      irTargetText: (meta as any).irTargetText ?? null,
      tLayerHint: (meta as any).tLayerHint ?? null,
      hasFutureMemory: (meta as any).hasFutureMemory ?? null,
      tLayerModeActive: (meta as any).tLayerModeActive ?? null,
    });
  }

  /* =========================================================
     ⑦ MemoryState への保存（userCode 単位で 1行）
  ========================================================= */
  if (userCode) {
    try {
      const depthStageForSave = meta.depth ?? null;
      const qForSave = meta.qCode ?? null;

      const saForSave =
        typeof (meta as any).selfAcceptance === 'number'
          ? (meta as any).selfAcceptance
          : null;

      const unifiedForSave = (meta as any).unified ?? null;
      const phaseForSave =
        unifiedForSave &&
        (unifiedForSave.phase === 'Inner' ||
          unifiedForSave.phase === 'Outer')
          ? unifiedForSave.phase
          : null;

      // 🆕 situation.summary / topic を安全に取り出す
      const situation = unifiedForSave?.situation ?? null;
      const situationSummaryForSave =
        situation && typeof situation.summary === 'string'
          ? situation.summary
          : null;
      const situationTopicForSave =
        situation && typeof situation.topic === 'string'
          ? situation.topic
          : null;

      const intentLayerForSave = (meta as any).intentLayer ?? null;
      const intentConfidenceForSave =
        typeof (meta as any).intentConfidence === 'number'
          ? (meta as any).intentConfidence
          : null;

      const yForSave =
        typeof (meta as any).yLevel === 'number'
          ? (meta as any).yLevel
          : null;
      const hForSave =
        typeof (meta as any).hLevel === 'number'
          ? (meta as any).hLevel
          : null;

      const sentimentForSave =
        typeof (meta as any)?.sentiment_level === 'string'
          ? (meta as any).sentiment_level
          : null;

      await upsertIrosMemoryState({
        userCode,
        depthStage: depthStageForSave,
        qPrimary: qForSave,
        selfAcceptance: saForSave,
        phase: phaseForSave,
        intentLayer: intentLayerForSave,
        intentConfidence: intentConfidenceForSave,
        yLevel: yForSave,
        hLevel: hForSave,
        // situation / sentiment も MemoryState に固定
        situationSummary: situationSummaryForSave,
        situationTopic: situationTopicForSave,
        sentiment_level: sentimentForSave,
      });
    } catch (e) {
      console.error('[IROS/ORCH v2] upsertIrosMemoryState failed', {
        userCode,
        error: e,
      });
    }
  }

  return {
    content: finalContent,
    meta,
  };
}

/* ========= 表示モード／ヘッダー生成ヘルパー ========= */

type PresentationKind = 'plain' | 'withHeader' | 'irOnly';

/**
 * どの「線路」で返すかを決める:
 * - irOnly     : ir診断コマンド（ir診断 上司 など）
 * - withHeader : I層 or mirror モード → 冒頭コメントを付与
 * - plain      : それ以外は LLM 本文のみ
 */
function decidePresentationKind(args: {
  text: string;
  meta: IrosMeta;
  irTriggered: boolean;
  requestedDepth?: Depth;
}): PresentationKind {
  const { text, meta, irTriggered, requestedDepth } = args;

  const normalizedText = text.replace(/\s/g, '');

  // 「ir診断」「ir診断上司」などを判定
  const isIrCommand =
    irTriggered && normalizedText.includes('ir診断');

  const resolvedDepth: Depth | undefined =
    (meta.depth as Depth | undefined) ?? requestedDepth ?? undefined;

  const isIntentDepthActive = isIntentDepth(resolvedDepth);

  if (isIrCommand) {
    return 'irOnly';
  }

  // I層 or mirror モードのときは、基本的にコメントヘッダーを付ける
  if (isIntentDepthActive || meta.mode === 'mirror') {
    return 'withHeader';
  }

  return 'plain';
}

/**
 * 通常の「いまの構図」コメント
 *  - Qコード／Depth から 1行〜2行のヘッダーを生成
 */
function buildStructuredHeader(meta: IrosMeta): string | null {
  const q = (meta.qCode as QCode | undefined) ?? undefined;
  const depth = (meta.depth as Depth | undefined) ?? undefined;

  const qPhrase = describeQCodeBrief(q);
  const depthSentence = describeDepthPhaseLabel(depth);

  if (!qPhrase && !depthSentence) return null;

  const lines: string[] = [];

  if (q) {
    // 例: Q3
    lines.push(q);
  }

  const segments: string[] = [];
  if (qPhrase) {
    segments.push(`「${qPhrase}」`);
  }
  if (depthSentence) {
    segments.push(depthSentence);
  }

  const joined =
    segments.length === 1
      ? segments[0]
      : `${segments[0]}の中で${segments[1]}`;

  lines.push(`いまの構図：いまのあなたは、${joined}にいます。`);

  return lines.join('\n');
}

/**
 * Qコード → 一言ラベル
 *  - Q1〜Q5 の意味付けをここで固定
 */
function describeQCodeBrief(qCode?: QCode | null): string | null {
  if (!qCode) return null;
  switch (qCode) {
    case 'Q1':
      return '我慢と秩序のゆらぎ';
    case 'Q2':
      return '怒りと成長欲求のゆらぎ';
    case 'Q3':
      return '不安と安定欲求のゆらぎ';
    case 'Q4':
      return '恐れと浄化欲求のゆらぎ';
    case 'Q5':
      return '空虚と情熱のゆらぎ';
    default:
      return null;
  }
}

/**
 * Depth → 大まかな「流れ」のラベル
 *  - S/R/C/I/T をざっくりフェーズ言語に変換
 */
function describeDepthPhaseLabel(depth?: Depth | null): string | null {
  if (!depth) return null;
  const head = depth.charAt(0);
  switch (head) {
    case 'S':
      return '日常の足元で「自分の感覚」を確かめ直している流れ';
    case 'R':
      return '誰かとの関係や場との距離感を組み直している流れ';
    case 'C':
      return 'これから創っていく「形」を選び直している流れ';
    case 'I':
      return '生き方そのものの輪郭を見つめ直している流れ';
    case 'T':
      return 'これまでの流れを超えていく転換点のフェーズ';
    default:
      return null;
  }
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

/* ========= 最小バリデーション ========= */

function normalizeMode(mode?: IrosMode): IrosMode {
  if (!mode) return 'mirror';
  return IROS_MODES.includes(mode) ? mode : 'mirror';
}

function normalizeDepth(depth?: Depth): Depth | undefined {
  if (!depth) return undefined;
  return DEPTH_VALUES.includes(depth) ? depth : undefined;
}

function normalizeQCode(qCode?: QCode): QCode | undefined {
  if (!qCode) return undefined;
  return QCODE_VALUES.includes(qCode) ? qCode : undefined;
}

/** I層（I1〜I3）かどうかの判定ヘルパー */
function isIntentDepth(depth?: Depth | null): boolean {
  if (!depth) return false;
  // Depth は文字列リテラル型なので startsWith が使える
  return depth.startsWith('I');
}

/* ========= 診断ヘッダー除去ヘルパー ========= */
/**
 * LLM が先頭に付けてくる診断ブロックを本文から取り除き、
 * それ以降の「会話本文」だけを残す。
 */
function stripDiagnosticHeader(text: string): string {
  if (!text || typeof text !== 'string') return '';

  // 診断ヘッダーが無い場合はそのまま
  if (!/^Q[1-5]/.test(text.trimStart())) {
    return text;
  }

  // Q1〜Q5 で始まり、「【Unified 構図】」〜「Intent Summary:」までをまとめて削除
  const pattern =
    /^Q[1-5][\s\S]*?【Unified 構図】[\s\S]*?Intent Summary:[^\n]*\n?/;

  const stripped = text.replace(pattern, '').trimStart();

  // 万一うまくマッチしなかった場合も、最低限トリムだけして返す
  return stripped.length > 0 ? stripped : text;
}
