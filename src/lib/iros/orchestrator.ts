// src/lib/iros/orchestrator.ts
// Iros Orchestrator — Will Engine（Goal / Priority）+ Continuity Engine 統合版
// - 極小構造のまま「意志の連続性」を追加した v2
// - Unified-like 解析入口 + isFirstTurn 対応版
// - 解析・Will・Memory・プレゼン系を分割モジュールに委譲

import {
  type IrosMode,
  type Depth,
  type QCode,
  type IrosMeta,
  type TLayer,
  type IrosStyle, // ★ 追加：口調スタイル
  DEPTH_VALUES,
  QCODE_VALUES,
} from './system';

import { generateIrosReply, type GenerateResult } from './generate';

import { clampSelfAcceptance } from './orchestratorMeaning';

import { loadBaseMetaFromMemoryState, type LoadStateResult } from './orchestratorState';

import { computeSpinState } from './orchestratorSpin';

// ★ 揺らぎ×ヒステリシス決定器（回転の安全ギア）
import { decideSpinControl } from './spin/decideSpinControl';

// ★ High 揺らぎ時のアンカー確認イベント
import { decideAnchorEvent } from './intentAnchor/anchorEvent';


// ★ types 側の型（spinの参照用）
import type { SpinLoop, SpinStep } from './types';

// 解析フェーズ（Unified / depth / Q / SA / YH / IntentLine / T層）
import {
  runOrchestratorAnalysis,
  type OrchestratorAnalysisResult,
} from './orchestratorAnalysis';

// Will（Goal / Priority）
import {
  computeGoalAndPriority,
  type IrosGoalType,
  type IrosPriorityType,
} from './orchestratorWill';

// 診断ヘッダー除去
import { stripDiagnosticHeader } from './orchestratorPresentation';

// モード決定（mirror / vision / diagnosis）
import { applyModeToMeta } from './orchestratorMode';

// Vision-Trigger（ビジョンモード 自動遷移）
import {
  detectVisionTrigger,
  logVisionTrigger,
} from './visionTrigger';

import { savePersonIntentState } from './memory/savePersonIntent';

// 🔸 Iros Soul（Silent Advisor）レイヤー
import { shouldUseSoul } from './soul/shouldUseSoul';
import { runIrosSoul } from './soul/runIrosSoul';
import type { IrosSoulInput } from './soul/types';

// ★ 今日できること？トリガー検出
import { detectActionRequest } from './will/detectActionRequest';

import { applyDelegateIntentOverride } from './will/delegateIntentOverride';

// ★ CONT: 意志の連続性（Depth / Q のなだらか化）
import { applyGoalContinuity } from './will/continuityEngine'; // ★ CONT 追加

// ==== 固定アンカー（北） ====
// - ユーザー発話から抽出しない
// - 常に「太陽SUN」を北として持つ
const FIXED_NORTH = {
  key: 'SUN',
  text: '太陽SUN',
  phrase: '成長 / 進化 / 希望 / 歓喜',
} as const;

// ==== I層強制モード（ENV） ====
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

  /** ★ v_iros_user_profile の1行分（任意） */
  userProfile?: Record<string, any> | null;

  /** ★ 口調スタイル（route / handleIrosReply から渡す） */
  style?: IrosStyle | string | null;
};

// ==== Orchestrator から返す結果 ==== //
export type IrosOrchestratorResult = {
  content: string;
  meta: IrosMeta;
};

/* ============================================================================
 * S4（幽霊値）対策：Depth 正規化ユーティリティ
 * - どこから S4 が来ても「F1」に丸める
 * - それ以外は DEPTH_VALUES の範囲だけ通す
 * ========================================================================== */
function normalizeDepthStrict(depth?: Depth | null): Depth | undefined {
  if (!depth) return undefined;

  // ★ ここが本体：S4 は絶対に残さない
  if (depth === 'S4') return 'F1' as Depth;

  // 既存許容（DEPTH_VALUES で gate）
  return DEPTH_VALUES.includes(depth) ? depth : undefined;
}

function normalizeDepthStrictOrNull(depth?: Depth | null): Depth | null {
  return normalizeDepthStrict(depth) ?? null;
}

/* ============================================================================
 * 任せる系（delegate intent）オーバーライド
 * ========================================================================== */

/**
 * ユーザーが「任せる／決めて／進めて／動かして／動ける形に／選択させないで」
 * などの **決定権の委譲** をしているとき、
 *
 * - goal.kind を 'enableAction' に寄せる
 * - goal.targetDepth / priority.goal.targetDepth を 'C1' に固定
 * - forward 重みを強くし、mirror を下げる
 *
 * ことで、S2 uncover 固定から「行動フェーズ（C1）」へ drift させる。
 */

// Iros Orchestrator — Will Engine（Goal / Priority）+ Continuity Engine 統合版
export async function runIrosTurn(
  args: IrosOrchestratorArgs,
): Promise<IrosOrchestratorResult> {
  const {
    conversationId, // ← いまは未使用（将来拡張用）
    text,
    requestedMode,
    requestedDepth,
    requestedQCode,
    baseMeta,
    isFirstTurn,
    userCode,
    userProfile,
    style, // ★ 追加
  } = args;

  // ★★ ここにあった「0. 意図の薄いターン（挨拶 / コマンド）」の
  //     早期 return ロジックは削除しました。
  //     すべての入力を通常どおり解析〜Soul〜Will〜generate に通します。

  // ----------------------------------------------------------------
  // 1. MemoryState 読み込み（meta ベースのみ使用）
  // ----------------------------------------------------------------
  let loadResult: LoadStateResult | null = null;
  if (userCode) {
    loadResult = await loadBaseMetaFromMemoryState({
      userCode,
      baseMeta,
    });
  }

  // ----------------------------------------------------------------
  // 2. baseMeta 構築（ルート引数 + Memory の統合）
  // ----------------------------------------------------------------
  // loadBaseMetaFromMemoryState は { mergedBaseMeta, memoryState } を返す前提
  const mergedBaseMeta: Partial<IrosMeta> =
    loadResult?.mergedBaseMeta ?? baseMeta ?? {};

  // memoryState は解析に渡す
  const memoryState: unknown = loadResult?.memoryState ?? null;

  // ★ CONT: 連続性用に「前回までの depth / qCode」を控えておく
  const lastDepthForContinuity: Depth | undefined =
    normalizeDepthStrict((mergedBaseMeta.depth as Depth | undefined) ?? undefined) ?? undefined;

  const lastQForContinuity: QCode | undefined =
    (mergedBaseMeta.qCode as QCode | undefined) ?? undefined;

  // ★ style の反映：
  //   - 明示指定された style を最優先
  //   - なければ memory / baseMeta 側をそのまま使う
  if (typeof style !== 'undefined' && style !== null) {
    (mergedBaseMeta as any).style = style;
  }

  // ★ 前回ターンの Goal.kind / uncoverStreak を取得
  const previousGoal: any =
    (mergedBaseMeta as any).goal &&
    typeof (mergedBaseMeta as any).goal === 'object'
      ? (mergedBaseMeta as any).goal
      : null;

  const lastGoalKind: any =
    previousGoal && typeof previousGoal.kind === 'string'
      ? previousGoal.kind
      : null;

  const previousUncoverStreak: number =
    typeof (mergedBaseMeta as any).uncoverStreak === 'number'
      ? (mergedBaseMeta as any).uncoverStreak
      : 0;

  // depth / qCode の初期値決定
  const initialDepth = determineInitialDepth(
    requestedDepth,
    mergedBaseMeta.depth as Depth | undefined,
  );

  const initialQCode =
    (requestedQCode as QCode | undefined) ??
    (mergedBaseMeta.qCode as QCode | undefined);

  // ★ ここでも S4 を潰す（入口）
  const normalizedDepth = normalizeDepthStrict(initialDepth);
  const normalizedQCode = normalizeQCode(initialQCode);

  // ② runIrosTurn() 内：mergedBaseMeta 構築後（lastDepthForContinuity の近く）に追加
  //    ※「前回の spin / phase」を控える（慣性と反転条件のため）
  const lastSpinLoop: SpinLoop | null =
    ((mergedBaseMeta as any).spinLoop as SpinLoop | undefined) ?? null;

  const lastSpinStep: SpinStep | null =
    (typeof (mergedBaseMeta as any).spinStep === 'number'
      ? ((mergedBaseMeta as any).spinStep as SpinStep)
      : null);

  const lastPhaseForSpin: 'Inner' | 'Outer' | null =
    ((mergedBaseMeta as any).phase === 'Inner' || (mergedBaseMeta as any).phase === 'Outer')
      ? ((mergedBaseMeta as any).phase as 'Inner' | 'Outer')
      : null;

  // ★ 前回ターンの揺らぎランク（ヒステリシス用）
  const lastVolatilityRank: 'low' | 'mid' | 'high' | null =
    ((mergedBaseMeta as any).volatilityRank === 'low' ||
    (mergedBaseMeta as any).volatilityRank === 'mid' ||
    (mergedBaseMeta as any).volatilityRank === 'high')
      ? ((mergedBaseMeta as any).volatilityRank as 'low' | 'mid' | 'high')
      : null;


  // ----------------------------------------------------------------
  // 3. 解析フェーズ（Unified / depth / Q / SA / YH / IntentLine / T層）
  // ----------------------------------------------------------------
  const analysis: OrchestratorAnalysisResult = await runOrchestratorAnalysis({
    text,
    requestedDepth: normalizedDepth,
    requestedQCode: normalizedQCode,
    baseMeta: mergedBaseMeta,
    // memoryState の具体的な型は解析側で定義されているので any 扱い
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    memoryState: memoryState as any,
    isFirstTurn: !!isFirstTurn,
  });

  const {
    depth,
    qCode: resolvedQCode,
    selfAcceptanceLine,
    unified,
    yLevel,
    hLevel,
    intentLine,
    tLayerHint,
    hasFutureMemory,
    qTrace,
    tLayerModeActive,
  } = analysis;

  // T層ヒントを T1/T2/T3 のみに正規化
  const normalizedTLayer: TLayer | null =
    tLayerHint === 'T1' || tLayerHint === 'T2' || tLayerHint === 'T3'
      ? (tLayerHint as TLayer)
      : null;

  // 解析から返った depth を正規化して採用（なければ従来通り fallback）
  // ★ ここでも S4 を潰す（analysis由来）
  const analyzedDepth: Depth | undefined =
    normalizeDepthStrict(depth as Depth | undefined) ?? normalizedDepth;

  // ----------------------------------------------------------------
  // 4. meta 初期化（解析結果を反映）
  // ----------------------------------------------------------------
  let meta: IrosMeta = {
    ...(mergedBaseMeta as IrosMeta),

    // ★ 追加：今回ターンの unified を meta に載せる（生成・topic・後段が参照できるように）
    unified: (unified as any) ?? (mergedBaseMeta as any).unified ?? null,

    // ★ 修正：analysis由来の depth を優先（S4は潰し済）
    depth: analyzedDepth,

    qCode: resolvedQCode ?? normalizedQCode,
    selfAcceptance:
      typeof selfAcceptanceLine === 'number'
        ? clampSelfAcceptance(selfAcceptanceLine)
        : mergedBaseMeta.selfAcceptance ?? null,
    yLevel:
      typeof yLevel === 'number'
        ? yLevel
        : mergedBaseMeta.yLevel ?? null,
    hLevel:
      typeof hLevel === 'number'
        ? hLevel
        : mergedBaseMeta.hLevel ?? null,
    intentLine: intentLine ?? mergedBaseMeta.intentLine ?? null,
    tLayerHint: normalizedTLayer ?? mergedBaseMeta.tLayerHint ?? null,
    hasFutureMemory,
  };

  // ★ situation_topic を確実に付与（Training/集計/MemoryState の舵取り）
  // 優先：meta → snake_case → unified → extra.pastStateNoteText から抽出 → 既定値
  function resolveSituationTopicFromMeta(meta: any): string | null {
    const m: any = meta ?? {};
    const unified: any = m?.unified ?? {};
    const note: any = m?.extra?.pastStateNoteText;

    const fromMeta =
      typeof m.situationTopic === 'string' && m.situationTopic.trim().length > 0
        ? m.situationTopic.trim()
        : null;

    const fromSnake =
      typeof m.situation_topic === 'string' && m.situation_topic.trim().length > 0
        ? m.situation_topic.trim()
        : null;

    const fromUnified =
      typeof unified?.situation_topic === 'string' &&
      unified.situation_topic.trim().length > 0
        ? unified.situation_topic.trim()
        : typeof unified?.situation?.topic === 'string' &&
          unified.situation.topic.trim().length > 0
        ? unified.situation.topic.trim()
        : null;

    const fromNote = (() => {
      if (typeof note !== 'string' || note.trim().length === 0) return null;

      // 1) 「対象トピック: XXX」
      const m1 = note.match(/対象トピック:\s*([^\n\r]+)/);
      // 2) 「対象トピックXXX」（コロン無しも拾う）
      const m2 = note.match(/対象トピック\s*([^\n\r]+)/);

      const picked =
        (m1 && m1[1]) ? String(m1[1]).trim()
        : (m2 && m2[1]) ? String(m2[1]).trim()
        : null;

      return picked && picked.length > 0 ? picked : null;
    })();

    return fromMeta ?? fromSnake ?? fromUnified ?? fromNote ?? null;
  }

  // ----------------------------------------------------------------
  // ★ Phase パース＆格納：Unified または baseMeta から採用
  // ----------------------------------------------------------------
  let phase: 'Inner' | 'Outer' | null = null;

  const unifiedPhaseRaw =
    (unified?.phase as string | undefined) ??
    ((mergedBaseMeta as any)?.phase as string | undefined) ??
    null;

  if (typeof unifiedPhaseRaw === 'string') {
    const p = unifiedPhaseRaw.trim().toLowerCase();
    if (p === 'inner') phase = 'Inner';
    else if (p === 'outer') phase = 'Outer';
  }

  (meta as any).phase = phase;

  if (qTrace) {
    (meta as any).qTrace = qTrace;
  }

  if (tLayerModeActive) {
    (meta as any).tLayerModeActive = true;
  }

  // ★ v_iros_user_profile 由来の userProfile を meta に載せる
  //   - Memory 側に既にあれば、今回の userProfile を優先
  if (typeof userProfile !== 'undefined') {
    (meta as any).userProfile = userProfile;
  }

  // ★ ユーザーの「呼び名」を解決して meta.userCallName に載せる
  {
    const profileForName: Record<string, any> | null =
      (typeof userProfile !== 'undefined' && userProfile) ||
      ((meta as any).userProfile as Record<string, any> | null | undefined) ||
      null;

    if (profileForName) {
      const callNameRaw =
        (profileForName.ai_call_name as string | null | undefined) ??
        (profileForName.display_name as string | null | undefined) ??
        null;

      const callName =
        typeof callNameRaw === 'string' && callNameRaw.trim().length > 0
          ? callNameRaw.trim()
          : null;

      if (callName) {
        (meta as any).userCallName = callName;
      }
    }
  }

// ★ 固定アンカー（北）：太陽SUN を meta に固定反映（抽出はしない）
{
  // meta に「固定北」を保持（Writer / Soul / UI / Debug 用）
  (meta as any).fixedNorth = FIXED_NORTH;

  // 既存の参照先（spinCtl / soulInput / anchorEvent）が intent_anchor を見ているため
  // intent_anchor も固定で与える（発話抽出由来は使わない）
  (meta as any).intent_anchor = {
    text: FIXED_NORTH.text,     // ← 常に「太陽SUN」
    strength: null,
    y_level: typeof yLevel === 'number' ? yLevel : null,
    h_level: typeof hLevel === 'number' ? hLevel : null,
    fixed: true,
    phrase: FIXED_NORTH.phrase,
  };
}


  // ----------------------------------------------------------------
  // ★ 揺らぎ × ヒステリシス → 回転ギア確定（LLMの気分ではなく規則）
  // ----------------------------------------------------------------
  {
    const spinCtl = decideSpinControl({
      stabilityBand:
      ((meta as any)?.unified?.stabilityBand as any) ??
      ((meta as any)?.stabilityBand as any) ??
      null,

      yLevel: typeof (meta as any).yLevel === 'number' ? (meta as any).yLevel : null,
      hLevel: typeof (meta as any).hLevel === 'number' ? (meta as any).hLevel : null,
      phase: ((meta as any).phase as any) ?? null,
      prevRank: lastVolatilityRank,
    });

    // meta 保存（Writer/MemoryState が読む）
    (meta as any).volatilityRank = spinCtl.rank;              // 'low'|'mid'|'high'
    (meta as any).spinDirection = spinCtl.direction;          // 'forward'|'brake' (相生/相克)
    (meta as any).promptStyle = spinCtl.promptStyle;          // 'one-step'|'two-choice'|'safety-brake'
    (meta as any).shouldConfirmAnchor = spinCtl.shouldConfirmAnchor;

    // ★ High の時だけ：アンカー確認イベントを生成
    const anchorText: string | null =
      (meta as any)?.intent_anchor?.text &&
      typeof (meta as any).intent_anchor.text === 'string' &&
      (meta as any).intent_anchor.text.trim().length > 0
        ? (meta as any).intent_anchor.text.trim()
        : null;

    const anchorEvent = decideAnchorEvent(spinCtl.rank, anchorText);
    (meta as any).anchorEvent = anchorEvent;

    // デバッグ（開発時だけ）
    if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.log('[IROS/SpinControl]', {
        rank: spinCtl.rank,
        direction: spinCtl.direction,
        promptStyle: spinCtl.promptStyle,
        phase: (meta as any).phase,
        anchorEventType: (anchorEvent as any)?.type,
        hysteresis: spinCtl.debug?.hysteresisApplied,
      });
    }
  }


  // ----------------------------------------------------------------
  // 4.5 Iros Soul レイヤー（Silent Advisor）呼び出し
  // ----------------------------------------------------------------
  let soulNote: any = null;
  try {
    // ★ intentAnchorText を確実に作る（優先：meta.intent_anchor.text → intentLine.coreNeed）
    const intentAnchorText: string | null =
      (meta as any)?.intent_anchor?.text &&
      typeof (meta as any).intent_anchor.text === 'string' &&
      (meta as any).intent_anchor.text.trim().length > 0
        ? (meta as any).intent_anchor.text.trim()
        : intentLine && typeof (intentLine as any).coreNeed === 'string'
        ? String((intentLine as any).coreNeed).trim() || null
        : null;

    // ★ situationTopic を meta/unified/notes から拾う
    const situationTopic: string | null = resolveSituationTopicFromMeta(meta);

    // ★ 追加：拾えた topic は meta にも保存（Training/MemoryState へ残す）
    if (situationTopic) {
      (meta as any).situationTopic = situationTopic;
    }

    const soulInput: IrosSoulInput = {
      userText: text,
      qCode: meta.qCode ?? null,
      depthStage: meta.depth ?? null,
      phase: (meta as any).phase ?? null,
      selfAcceptance: meta.selfAcceptance ?? null,
      yLevel: (meta as any).yLevel ?? null,
      hLevel: (meta as any).hLevel ?? null,

      // ★ 今回のターンは text を入れる（null にしない）
      situationSummary:
        typeof text === 'string' && text.trim().length > 0 ? text.trim() : null,

      // ★ topic も供給
      situationTopic,

      // ★ Soul に意図アンカーを渡す
      intentAnchorText,

      intentNowLabel:
        intentLine && typeof (intentLine as any).nowLabel === 'string'
          ? (intentLine as any).nowLabel
          : null,
      intentGuidanceHint:
        intentLine && typeof (intentLine as any).guidanceHint === 'string'
          ? (intentLine as any).guidanceHint
          : null,
    };

    if (shouldUseSoul(soulInput)) {
      soulNote = await runIrosSoul(soulInput);
    }
  } catch (e) {
    if (process.env.DEBUG_IROS_SOUL === '1') {
      console.error('[IROS/Soul] error', e);
    }
  }

  if (soulNote) {
    (meta as any).soulNote = soulNote;
  }

  // ----------------------------------------------------------------
  // 5. Vision-Trigger 判定（ビジョンモードへの自動ジャンプ）
  // ----------------------------------------------------------------
  const visionResult = detectVisionTrigger({ text, meta });
  if (visionResult.triggered) {
    meta = visionResult.meta;
    // ★ 念のため：visionResult が meta.depth に S4 を戻しても潰す
    meta.depth = normalizeDepthStrict(meta.depth as any);
    logVisionTrigger(visionResult);
  }

  // ----------------------------------------------------------------
  // 6. モード決定（mirror / vision / diagnosis）
  // ----------------------------------------------------------------
  meta = applyModeToMeta(text, {
    requestedMode,
    meta,
    isFirstTurn: !!isFirstTurn,
    intentLine,
    tLayerHint: normalizedTLayer,
    forceILayer: FORCE_I_LAYER,
  });

  if (meta.mode !== 'vision' && meta.tLayerHint) {
    (meta as any).tLayerModeActive = true;
  }

  // ----------------------------------------------------------------
  // 7. Will フェーズ：Goal / Priority の決定
  // ----------------------------------------------------------------
  let { goal, priority } = computeGoalAndPriority({
    text,
    depth: meta.depth,
    qCode: meta.qCode,
    selfAcceptanceLine: meta.selfAcceptance ?? null,
    mode: (meta.mode ?? 'mirror') as IrosMode,
    // ★ 魂レイヤー
    soulNote: (meta as any).soulNote ?? null,
    // ★ 三軸回転用：前回 Goal.kind と uncover 連続カウント
    lastGoalKind,
    previousUncoverStreak,
    // ★ Phase（Inner / Outer）を Will エンジンに渡す
    phase: (meta as any).phase ?? null,
  });

  // ★ delegate intent（任せる／決めて／進めて／動かして...）のとき上書き
  if (goal && priority) {
    ({ goal, priority } = applyDelegateIntentOverride({
      goal,
      priority,
      text,
    }));
  }

  // ★ delegate intent のときは「問い返しを抑制」フラグ
  const isDelegateIntent =
    !!(priority as any)?.debugNote &&
    String((priority as any).debugNote).includes('delegateIntent');

  if (isDelegateIntent) {
    (meta as any).noQuestion = true;
    (meta as any).replyStyleHint = 'no-question-action-first';
  }

  // ★ 「今日できること？」など具体的な一歩を求めるターン
  const isActionRequest = detectActionRequest(text);

  if (isActionRequest && priority) {
    const anyPriority = priority as any;
    const weights = { ...(anyPriority.weights || {}) };

    const currentForward =
      typeof weights.forward === 'number' ? weights.forward : 0;
    const currentMirror =
      typeof weights.mirror === 'number' ? weights.mirror : 0.8;

    weights.forward = Math.max(currentForward, 0.8);
    weights.mirror = Math.min(currentMirror, 0.7);

    anyPriority.weights = weights;

    const baseDebug: string =
      typeof anyPriority.debugNote === 'string'
        ? anyPriority.debugNote
        : '';
    anyPriority.debugNote = baseDebug
      ? `${baseDebug} +actionRequest`
      : 'actionRequest';

    priority = anyPriority as IrosPriorityType;

    if (goal) {
      const anyGoal = goal as any;
      const baseReason: string =
        typeof anyGoal.reason === 'string' ? anyGoal.reason : '';
      if (!baseReason) {
        anyGoal.reason =
          'ユーザーが「今日できること？」と具体的な一歩を求めているため、forward を優先';
      }
      goal = anyGoal as IrosGoalType;
    }
  }

  // ★ CONT: ContinuityEngine で「前回の depth/Q からなだらかに」補正
  if (goal) {
    const continuityContext = {
      lastDepth: lastDepthForContinuity,
      lastQ: lastQForContinuity,
      userText: text,
    };

    const adjustedGoal = applyGoalContinuity(goal as any, continuityContext);

    // priority.goal 側にも targetDepth / targetQ を反映しておく
    if (priority) {
      const anyPriority = priority as any;
      if (!anyPriority.goal) anyPriority.goal = {};

      if (
        typeof adjustedGoal.targetDepth === 'string' &&
        adjustedGoal.targetDepth
      ) {
        // ★ ここでも S4 を潰す（goal由来）
        anyPriority.goal.targetDepth = normalizeDepthStrictOrNull(adjustedGoal.targetDepth as any);
      }

      if (
        typeof (adjustedGoal as any).targetQ === 'string' &&
        (adjustedGoal as any).targetQ
      ) {
        anyPriority.goal.targetQ = (adjustedGoal as any).targetQ;
      }

      priority = anyPriority as IrosPriorityType;
    }

    // ★ goal 自体も S4 を潰す
    if (adjustedGoal && typeof (adjustedGoal as any).targetDepth === 'string') {
      (adjustedGoal as any).targetDepth = normalizeDepthStrictOrNull((adjustedGoal as any).targetDepth);
    }

    goal = adjustedGoal as IrosGoalType;

    if (
      typeof process !== 'undefined' &&
      process.env.NODE_ENV !== 'production'
    ) {
      // eslint-disable-next-line no-console
      console.log('[IROS/CONT applyGoalContinuity]', {
        lastDepth: lastDepthForContinuity,
        lastQ: lastQForContinuity,
        finalTargetDepth: (goal as any).targetDepth,
        finalTargetQ: (goal as any).targetQ,
      });
    }
  }

  // ★ uncoverStreak を更新して meta に保存（連続回数）
  const nextUncoverStreak: number =
    goal && (goal as any).kind === 'uncover'
      ? previousUncoverStreak + 1
      : 0;
  (meta as any).uncoverStreak = nextUncoverStreak;

  (meta as any).goal = goal;
  (meta as any).priority = priority;

  // ----------------------------------------------------------------
  // 8. 本文生成（LLM 呼び出し）
  // ----------------------------------------------------------------
  const gen: GenerateResult = await generateIrosReply({
    text,
    meta,
  });

  let content = gen.content;

  // （テンプレ適用は行わない。LLM と Soul に任せる）
  content = stripDiagnosticHeader(content);

  // ----------------------------------------------------------------
  // 10. meta の最終調整：Goal.targetDepth を depth に反映
  // ----------------------------------------------------------------
  // ここまでで meta / goal / priority は確定している前提

  // まず「どの Depth を採用するか」を1本にまとめる
  const resolvedDepthRaw: Depth | null =
    (goal?.targetDepth as Depth | undefined) ??
    (meta.depth as Depth | undefined) ??
    ((meta as any).unified?.depth?.stage as Depth | null) ??
    null;

    const resolvedDepth: Depth | null =
    normalizeDepthStrictOrNull(resolvedDepthRaw);

  // ★ 安全弁：もし resolvedDepth が null になったら、meta.depth を残す
  const fallbackDepth: Depth | undefined =
    normalizeDepthStrict(meta.depth as any) ?? undefined;

  let finalMeta: IrosMeta = {
    ...meta,
    depth: (resolvedDepth ?? fallbackDepth) ?? undefined,
  };

  // unified.depth.stage にも同じものを流し込む（ここでもS4は残らない）
  if ((finalMeta as any).unified) {
    const unifiedAny = (finalMeta as any).unified || {};
    const unifiedDepth = unifiedAny.depth || {};

    (finalMeta as any).unified = {
      ...unifiedAny,
      depth: {
        ...unifiedDepth,
        stage: resolvedDepth ?? null,
      },
    };
  }

  // ----------------------------------------------------------------
  // 10.2 Spin の最終確定（finalMeta.depth 決定後に再計算してブレを消す）
  // ----------------------------------------------------------------
  {
    const spin = computeSpinState({
      depthStage: (finalMeta as any).depth ?? null,
      qCode: (finalMeta as any).qCode ?? null,
      phase: (finalMeta as any).phase ?? null,

      lastSpinLoop,
      lastSpinStep,
      lastPhase: lastPhaseForSpin,
    });

    (finalMeta as any).spinLoop = spin.spinLoop;
    (finalMeta as any).spinStep = spin.spinStep;
  }

  // 開発時ログ（ここで depth が見えるように）
  if (
    typeof process !== 'undefined' &&
    process.env.NODE_ENV !== 'production'
  ) {
    // eslint-disable-next-line no-console
    console.log('[IROS/Orchestrator] result.meta', {
      depth: finalMeta.depth,
      qCode: finalMeta.qCode,
      goalKind: goal?.kind,
      goalTargetDepth: (goal as any)?.targetDepth,
      priorityTargetDepth: (priority as any)?.goal?.targetDepth,
      uncoverStreak: (finalMeta as any).uncoverStreak ?? 0,
    });
  }

  // ----------------------------------------------------------------
  // 11. MemoryState 保存（finalMeta ベース）
  // ----------------------------------------------------------------
  // ★ ここで「今回の一言」を situationSummary として流し込む
  (finalMeta as any).situationSummary =
    typeof text === 'string' && text.trim().length > 0
      ? text.trim()
      : null;

  // ----------------------------------------------------------------
  // 11.5 Person Intent Memory 保存（ir診断ターンのみ）
  // ----------------------------------------------------------------
  if (userCode && finalMeta) {
    const anyMeta = finalMeta as any;
    const isIrDiagnosisTurn = !!anyMeta.isIrDiagnosisTurn;

    if (isIrDiagnosisTurn) {
      let label = 'self';
      const trimmed = (text || '').trim();

      if (trimmed.startsWith('ir診断')) {
        const rest = trimmed.slice('ir診断'.length).trim();
        if (rest.length > 0) {
          label = rest;
        }
      }

      try {
        await savePersonIntentState({
          ownerUserCode: userCode,
          targetType: 'ir-diagnosis',
          targetLabel: label,
          qPrimary: finalMeta.qCode ?? null,
          depthStage: (finalMeta as any).depth ?? null,
          phase: (finalMeta as any).phase ?? null,
          tLayerHint: (finalMeta as any).tLayerHint ?? null,
          selfAcceptance:
            typeof finalMeta.selfAcceptance === 'number'
              ? finalMeta.selfAcceptance
              : null,
        });
      } catch (e) {
        console.error(
          '[IROS/Orchestrator] savePersonIntentState error',
          e,
        );
      }
    }
  }

  // ----------------------------------------------------------------
  // 12. Orchestrator 結果として返却
  // ----------------------------------------------------------------
  return {
    content,
    meta: finalMeta,
  };
}

/* ============================================================================
 * 補助：Depth / QCode 正規化
 * ========================================================================== */

function determineInitialDepth(
  requestedDepth?: Depth,
  baseDepth?: Depth,
): Depth | undefined {
  // I層固定モードのときは、I1〜I3 を優先的に使う
  if (FORCE_I_LAYER) {
    if (requestedDepth && requestedDepth.startsWith('I')) return requestedDepth;
    if (baseDepth && baseDepth.startsWith('I')) return baseDepth;
    return 'I2';
  }

  return requestedDepth ?? baseDepth;
}

function normalizeDepth(depth?: Depth): Depth | undefined {
  if (!depth) return undefined;
  return DEPTH_VALUES.includes(depth) ? depth : undefined;
}

function normalizeQCode(qCode?: QCode): QCode | undefined {
  if (!qCode) return undefined;
  return QCODE_VALUES.includes(qCode) ? qCode : undefined;
}
