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

// ✅ 1) import を追加（他の import 群のどこでもOK。おすすめは spin周りの近く）
import type { DescentGateState } from './rotation/rotationLoop';

// 🔸 Iros Soul（Silent Advisor）レイヤー
import { shouldUseSoul } from './soul/shouldUseSoul';
import { runIrosSoul } from './soul/runIrosSoul';
import type { IrosSoulInput } from './soul/types';

// ★ 今日できること？トリガー検出
import { detectActionRequest } from './will/detectActionRequest';

import { applyDelegateIntentOverride } from './will/delegateIntentOverride';

// ★ CONT: 意志の連続性（Depth / Q のなだらか化）
import { applyGoalContinuity } from './will/continuityEngine'; // ★ CONT 追加

import { buildSlots, type NoDeltaKind } from './language/slotBuilder';
import { classifyInputKind } from './language/inputKind';
import { detectILayerForce } from './rotation/iLayerForce';
import { selectFrame, type FrameKind } from './language/frameSelector';
import { computeITTrigger } from '@/lib/iros/rotation/computeITTrigger';

import { readIrosFeatureFlags } from './server/featureFlags';
import { canUseFullAuto, shouldEnableFeature } from './server/fullAutoGuard';


import { decideDescentGate } from './rotation/rotationLoop';
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

    /** ✅ NEW: LLM / ITDemoGate / repeat 用の履歴（handleIrosReply 側で渡せる） */
    history?: unknown[];
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
    conversationId,
    text,
    requestedMode,
    requestedDepth,
    requestedQCode,
    baseMeta,
    isFirstTurn,
    userCode,
    userProfile,
    style, // ★ 追加
    history, // ✅ NEW（ここに入れる）
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
  // mergedBaseMeta に無い場合は MemoryState のキー名（depthStage / qPrimary）から拾う
  const ms: any = loadResult?.memoryState ?? null;

  const lastDepthForContinuity: Depth | null =
    normalizeDepthStrict(
      (mergedBaseMeta.depth as any) ??
      (ms?.depthStage as any) ??
      undefined
    ) ?? null;

  // ★ CONT: lastQ は必ず「正規化済み QCode or null」に固定（undefined を持たない）
  const lastQForContinuity: QCode | null =
    normalizeQCode(
      (mergedBaseMeta.qCode as any) ??
      (ms?.qPrimary as any) ??
      undefined
    ) ?? null;


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
  (requestedQCode as QCode | undefined) ?? undefined;

  // ★ ここでも S4 を潰す（入口）
  const normalizedDepth = normalizeDepthStrict(initialDepth);
  const normalizedQCode = normalizeQCode(initialQCode);

  // ② runIrosTurn() 内：mergedBaseMeta 構築後（lastDepthForContinuity の近く）に追加
  //    ※「前回の spin / phase」を控える（慣性と反転条件のため）
  const lastSpinLoop: SpinLoop | null =
    (((mergedBaseMeta as any).spinLoop ?? ms?.spinLoop) as SpinLoop | undefined) ?? null;

  const lastSpinStep: SpinStep | null =
    (typeof ((mergedBaseMeta as any).spinStep ?? ms?.spinStep) === 'number'
      ? (((mergedBaseMeta as any).spinStep ?? ms?.spinStep) as SpinStep)
      : null);

  const lastPhaseForSpin: 'Inner' | 'Outer' | null = (() => {
    const p = ((mergedBaseMeta as any).phase ?? ms?.phase) as any;
    return p === 'Inner' || p === 'Outer' ? p : null;
  })();

  // ★ 前回ターンの揺らぎランク（ヒステリシス用）
  const lastVolatilityRank: 'low' | 'mid' | 'high' | null =
    ((mergedBaseMeta as any).volatilityRank === 'low' ||
    (mergedBaseMeta as any).volatilityRank === 'mid' ||
    (mergedBaseMeta as any).volatilityRank === 'high')
      ? ((mergedBaseMeta as any).volatilityRank as 'low' | 'mid' | 'high')
      : null;

  // ★ 追加：前回ターンの descentGate（下降の扉）
  const lastDescentGate: 'closed' | 'offered' | 'accepted' | null = (() => {
    const dg = ((mergedBaseMeta as any).descentGate ?? ms?.descentGate) as any;
    return dg === 'closed' || dg === 'offered' || dg === 'accepted' ? dg : null;
  })();

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
// ✅ meta 初期化（解析結果を反映）
// ここだけ差し替え：depth が決まらないターンで depth_stage:null を量産しない
let meta: IrosMeta = {
  ...(mergedBaseMeta as IrosMeta),

  unified: (unified as any) ?? (mergedBaseMeta as any).unified ?? null,

  // ★ 修正：analysis由来 > 継続（前回） > 既定値（S2）
  // これで depth_stage:null の大量発生を止める
  depth: analyzedDepth ?? lastDepthForContinuity ?? ('S2' as Depth),

  // ★優先順位：analysis（今回観測） > 明示指定 > 継続（lastQ） > null
  qCode: resolvedQCode ?? normalizedQCode ?? lastQForContinuity ?? undefined,

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

  // ✅ qTrace を meta に載せる（analysis由来）
  if (qTrace) {
    (meta as any).qTrace = qTrace;

    // ✅ postprocess が確実に拾うための互換キー
    // （handleIrosReply.postprocess.ts の qTraceUpdated 取得用）
    (meta as any).qTraceUpdated = qTrace;
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
  // ✅ meta が作られた直後〜SoulInput を作る前に置く
  const thisTurnText = String(text ?? '').trim();

  if (thisTurnText) {
    const s = String((meta as any)?.situationSummary ?? '').trim();

    // ✅ 「未設定/空」のときだけ、このターンの入力で補完する
    // （解析が作った summary を潰さない）
    if (!s) {
      (meta as any).situationSummary = thisTurnText;
    }
  }

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

// ---- full-auto flags / guard (env controlled) ----
const ff = readIrosFeatureFlags();

// qCode: 'Q1'..'Q5' -> number 1..5
const qNum: number | null = (() => {
  const qc = meta?.qCode ?? null;
  if (!qc) return null;
  const m = String(qc).match(/^Q([1-5])$/);
  return m ? Number(m[1]) : null;
})();

const guardInputBase = {
  userCode: userCode ?? null,
  isDev: process.env.NODE_ENV !== 'production',

  // ※この2つは後で繋ぐ（今は安全側）
  consentGiven: false,
  stability: null,

  depth: meta?.depth ?? null,
  q: qNum,

  riskSignals: null,
} as const;

const fullAutoDecision = canUseFullAuto(guardInputBase);

// 個別機能のON/OFF（fullautoDecision.ok=falseでも frameだけ例外など可能）
const fullAutoFeatures = {
  autonomousShift: shouldEnableFeature('autonomous_shift', guardInputBase).enabled,
  intentTrigger: shouldEnableFeature('intent_trigger', guardInputBase).enabled,
  frameAutoSwitch: shouldEnableFeature('frame_auto_switch', guardInputBase).enabled,
  leapAllowed: shouldEnableFeature('leap_allowed', guardInputBase).enabled,
  reframeMeaning: shouldEnableFeature('reframe_meaning', guardInputBase).enabled,
  storytelling: shouldEnableFeature('storytelling', guardInputBase).enabled,
  loopShake: shouldEnableFeature('loop_shake', guardInputBase).enabled,
};

// meta に乗せる（UI/ログで一望できる）
(meta as any).fullAuto = {
  flags: ff,
  decision: fullAutoDecision,
  features: fullAutoFeatures,
};




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

  // ★ CONT: null は渡さない（undefined へ寄せる）
  lastDepth: lastDepthForContinuity ?? undefined,
  lastQ: lastQForContinuity ?? undefined,

  selfAcceptanceLine: meta.selfAcceptance ?? null,
  mode: (meta.mode ?? 'mirror') as IrosMode,
  soulNote: (meta as any).soulNote ?? null,
  lastGoalKind,
  previousUncoverStreak,
  phase: (meta as any).phase ?? null,

  spinLoop: (typeof lastSpinLoop !== 'undefined' ? lastSpinLoop : null) ?? null,
  descentGate:
    (typeof lastDescentGate !== 'undefined' ? lastDescentGate : null) ?? null,
});

// ----------------------------------------------------------------
// targetQ が undefined に落ちるケースを補正
// ----------------------------------------------------------------
{
  const q = meta.qCode ?? null;
  if (q) {
    if (goal && (goal as any).targetQ == null) (goal as any).targetQ = q;
    if (priority?.goal && (priority.goal as any).targetQ == null) {
      (priority.goal as any).targetQ = q;
    }
  }
}

// ----------------------------------------------------------------
// meta.rotationState.reason の欠落防止
// ----------------------------------------------------------------
{
  const g: any = goal as any;
  const rs = g?.rotationState ?? null;

  (meta as any).rotationState = {
    spinLoop:
      (rs && typeof rs.spinLoop === 'string' ? rs.spinLoop : null) ??
      ((meta as any).spinLoop ?? null),
    descentGate:
      (rs && typeof rs.descentGate === 'string' ? rs.descentGate : null) ??
      ((meta as any).descentGate ?? null),
    depth:
      (rs && typeof rs.depth === 'string' ? rs.depth : null) ??
      ((meta as any).depth ?? null),
    reason:
      (rs && typeof rs.reason === 'string' ? rs.reason : null) ??
      'rotationState: reason not provided',
  };
}

// ----------------------------------------------------------------
// delegate intent 上書き（※ デモ寄せ：フラグで制御）
// ----------------------------------------------------------------
const enableDelegateOverride =
  process.env.IROS_ENABLE_DELEGATE_OVERRIDE === '1';

if (enableDelegateOverride && goal && priority) {
  ({ goal, priority } = applyDelegateIntentOverride({
    goal,
    priority,
    text,
    meta,
  }));
}

// ----------------------------------------------------------------
// delegate intent → 問い返し抑制
// ----------------------------------------------------------------
const isDelegateIntent =
  !!(priority as any)?.debugNote &&
  String((priority as any).debugNote).includes('delegateIntent');

if (isDelegateIntent) {
  (meta as any).noQuestion = true;
  (meta as any).replyStyleHint = 'no-question-action-first';
}

// ----------------------------------------------------------------
// 「今日できること？」などの行動要求
// ----------------------------------------------------------------
const isActionRequest = detectActionRequest(text);

if (isActionRequest && priority) {
  const anyPriority = priority as any;
  const weights = { ...(anyPriority.weights || {}) };

  weights.forward = Math.max(weights.forward ?? 0, 0.8);
  weights.mirror = Math.min(weights.mirror ?? 0.8, 0.7);

  anyPriority.weights = weights;
  anyPriority.debugNote = anyPriority.debugNote
    ? `${anyPriority.debugNote} +actionRequest`
    : 'actionRequest';

  priority = anyPriority as IrosPriorityType;

  if (goal) {
    const anyGoal = goal as any;
    if (!anyGoal.reason) {
      anyGoal.reason =
        'ユーザーが「今日できること？」と具体的な一歩を求めているため、forward を優先';
    }
    goal = anyGoal as IrosGoalType;
  }
}


// ----------------------------------------------------------------
// 7.5 DescentGate + Frame + Slots（唯一の決定点 / 正規化版）
// ----------------------------------------------------------------
{
  const inputKind = classifyInputKind(text);
  (meta as any).inputKind = inputKind;

  type TargetKind = 'stabilize' | 'expand' | 'pierce' | 'uncover';

  const normalizeTargetKind = (v: unknown): TargetKind => {
    if (typeof v !== 'string') return 'stabilize';
    const s = v.trim().toLowerCase();

    if (s === 'stabilize') return 'stabilize';
    if (s === 'expand') return 'expand';
    if (s === 'pierce') return 'pierce';
    if (s === 'uncover') return 'uncover';

    // bridge
    if (s === 'enableaction') return 'expand';
    if (s === 'action') return 'expand';
    if (s === 'create') return 'expand';

    return 'stabilize';
  };

  // 優先順位：meta → goal.kind
  const rawTargetKind =
    (meta as any).targetKind ??
    (meta as any).target_kind ??
    (goal as any)?.kind ??
    null;

  const targetKindNorm = normalizeTargetKind(rawTargetKind);

  (meta as any).targetKind = targetKindNorm;
  (meta as any).target_kind = targetKindNorm;

  // ----------------------------------------------------------------
  // DescentGate 決定（自然回転）
  // ----------------------------------------------------------------
  const dg = decideDescentGate({
    qCode: meta.qCode ?? null,
    sa: typeof meta.selfAcceptance === 'number' ? meta.selfAcceptance : null,
    depthStage:
      typeof meta.depth === 'string' && meta.depth.length > 0
        ? meta.depth
        : null,
    targetKind: targetKindNorm,
    prevDescentGate: (mergedBaseMeta as any).descentGate ?? null,
  });

  (meta as any).descentGate = dg.descentGate;
  (meta as any).descentGateReason = dg.reason;

  // ----------------------------------------------------------------
  // Frame 決定（自然選択）
  // ----------------------------------------------------------------
  const frameSelected = selectFrame(
    {
      depth:
        typeof meta.depth === 'string' && meta.depth.length > 0
          ? meta.depth
          : null,
      descentGate: (meta as any).descentGate ?? null,
    },
    inputKind
  );

  const frame: FrameKind = frameSelected;
  (meta as any).frame = frame;

  // ----------------------------------------------------------------
  // NO_DELTA 判定（slot 用）
  // ここが強すぎると「動いてるのに stuck 扱い」になりがちなので、
  // “短文だけ”で noDelta にしない（= 反応が止まりやすい）
  // ----------------------------------------------------------------
  const rotationReason = String((meta as any)?.rotationState?.reason ?? '');
  const spinStepNow =
    typeof (meta as any).spinStep === 'number'
      ? (meta as any).spinStep
      : null;

  const nd = (() => {
    const t = String(text ?? '').trim();

    const isRepeatWarning =
      /同じ注意|何度も|繰り返し|変わらない|分かっている.*変わらない|わかっている.*変わらない/.test(
        t
      );

    // ✅ “短い＝noDelta” をやめる（短くても前進はある）
    // 短文は noDelta の「補助条件」に落とす
    const isVeryShort = t.length <= 8;
    const isShortLoopContext = inputKind === 'chat' || inputKind === 'question';

    const looksStoppedByReason =
      rotationReason.length > 0 &&
      (rotationReason.includes('回転') ||
        rotationReason.includes('満たしていない') ||
        rotationReason.includes('起きない'));

    const looksStoppedByMeta =
      spinStepNow === 0 && rotationReason.length > 0;

    // ✅ noDelta は “根拠がある停止” か “反復警告” を主因にする
    const noDelta =
      isRepeatWarning ||
      looksStoppedByReason ||
      looksStoppedByMeta ||
      (isVeryShort && isShortLoopContext && looksStoppedByReason);

    let kind: NoDeltaKind | null = null;
    if (noDelta) {
      if (isRepeatWarning) kind = 'repeat-warning';
      else if (isVeryShort) kind = 'short-loop';
      else kind = 'stuck';
    }

    return { noDelta, kind };
  })();

  (meta as any).noDelta = nd.noDelta;
  (meta as any).noDeltaKind = nd.kind;

  // ----------------------------------------------------------------
  // SlotBuilder（ここで完全確定）
  // ----------------------------------------------------------------
  const slotPlan = buildSlots(frame, {
    descentGate: (meta as any).descentGate,
    spinLoop: (meta as any).spinLoop ?? null,
    noDelta: nd.noDelta === true,
    noDeltaKind: nd.kind ?? null,
    iLayerDual: (meta as any).iLayerDual === true,
  });

  (meta as any).frame = frame;
  (meta as any).slotPlan = slotPlan.slots;
}



// ----------------------------------------------------------------
// 7.75 IT Trigger（I→T の扉） + I語彙の表出許可（別レーン）
// ✅ 重要：generate より “前” に動かす（本文に反映させるため）
// ----------------------------------------------------------------
{
  const it = computeITTrigger({
    text,
    history: Array.isArray(history) ? history : [],
    meta: {
      depthStage: meta.depth ?? null,
      intentLine: (meta as any).intentLine ?? null,
    },
  });

  // ✅ iLexemeForce は「このターンの判定 + 手動固定(true)」のORだけ許可（stickyはtrueのみ）
  (meta as any).iLexemeForce =
    (meta as any).iLexemeForce === true || it.iLayerForce === true;

  // ✅ Tレーン系は sticky禁止：毎ターン決定（成立しなければ必ず閉じる）
  (meta as any).tLayerModeActive = it.ok && it.tLayerModeActive === true;
  (meta as any).tLayerHint =
    (meta as any).tLayerModeActive
      ? (it.tLayerHint ?? 'T2')
      : null;
  (meta as any).tVector =
    (meta as any).tLayerModeActive ? (it.tVector ?? null) : null;

  if (typeof process !== 'undefined' && process.env.DEBUG_IROS_IT === '1') {
    // eslint-disable-next-line no-console
    console.log('[IROS/IT_TRIGGER]', {
      ok: it.ok,
      reason: it.reason,
      flags: it.flags,
      iLexemeForce: (meta as any).iLexemeForce ?? null,
      tLayerModeActive: (meta as any).tLayerModeActive ?? null,
      tLayerHint: (meta as any).tLayerHint ?? null,
      tVector: (meta as any).tVector ?? null,
    });
  }
}

// ----------------------------------------------------------------
// DEBUG: IT決定がこのターンで確実に「閉じ/開き」されているか確認
// - tLayerModeActive が true/false/null のまま残留していないか
// - renderMode を使っていない（唯一の正は tLayerModeActive）
// ----------------------------------------------------------------
if (typeof process !== 'undefined' && process.env.DEBUG_IROS_IT === '1') {
  // eslint-disable-next-line no-console
  console.log('[IROS/IT_DECISION][orch]', {
    // 入力
    textLen: String(text ?? '').length,
    hasHistory: Array.isArray(history) ? history.length : 0,

    // ITレーン決定（唯一の正）
    tLayerModeActive: (meta as any).tLayerModeActive ?? null,
    tLayerHint: (meta as any).tLayerHint ?? null,
    tVector: (meta as any).tVector ?? null,

    // I語彙の許可（sticky trueのみ）
    iLexemeForce: (meta as any).iLexemeForce ?? null,

    // 参考：analysis由来（残骸チェック）
    analysis_tLayerHint: (analysis as any)?.tLayerHint ?? null,
    analysis_tLayerModeActive: (analysis as any)?.tLayerModeActive ?? null,

    // 参考：前段の状態（安全確認）
    mode: (meta as any).mode ?? null,
    depth: (meta as any).depth ?? null,
    qCode: (meta as any).qCode ?? null,

    // 事故検出：renderMode が残っても “無視する” ための観測だけ
    legacy_renderMode:
      (meta as any)?.extra?.renderMode ??
      (meta as any)?.renderMode ??
      null,
  });
}




  // ----------------------------------------------------------------
  // 8. 本文生成（LLM 呼び出し）
  // ✅ generate に history を渡す（ITDemoGate / writerが使える）
  // ----------------------------------------------------------------
  const gen: GenerateResult = await generateIrosReply({
    text,
    meta,
    history: Array.isArray(history) ? history : [],
    memoryState, // ← ★これを追加
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

// ✅ 7.5で確定した “安全/器/枠” を finalMeta に確実に引き継ぐ
(finalMeta as any).descentGate = (meta as any).descentGate ?? (finalMeta as any).descentGate ?? null;
(finalMeta as any).descentGateReason = (meta as any).descentGateReason ?? (finalMeta as any).descentGateReason ?? null;
(finalMeta as any).descentGateDebug = (meta as any).descentGateDebug ?? (finalMeta as any).descentGateDebug ?? null;

(finalMeta as any).inputKind = (meta as any).inputKind ?? (finalMeta as any).inputKind ?? null;
(finalMeta as any).frame = (meta as any).frame ?? (finalMeta as any).frame ?? null;
(finalMeta as any).slotPlan = (meta as any).slotPlan ?? (finalMeta as any).slotPlan ?? null;


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
