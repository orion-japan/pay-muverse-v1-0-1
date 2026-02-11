// src/lib/iros/orchestratorWill.ts
// iros Orchestrator — Will パート集約
// - Goal / Continuity / Priority / SA補正 / Rotation をまとめて扱うヘルパー

import type { Depth, QCode, IrosMode, SpinLoop } from '@/lib/iros/system';
import { DEPTH_VALUES } from '@/lib/iros/system';

import { deriveIrosGoal } from './will/goalEngine';
import type { IrosGoalKind } from './will/goalEngine';

import { applyGoalContinuity, type ContinuityContext } from './will/continuityEngine';

import { deriveIrosPriority } from './will/priorityEngine';

import { adjustPriorityWithSelfAcceptance } from './orchestratorPierce';

// ★ 置き換え：shouldRotateBand → decideRotation
import { decideRotation } from './will/rotationEngine';
import type { DescentGate } from './will/rotationEngine';

// ✅ 追加：Vent/Will detector（continuity の Q 継続/遮断の判断材料）
import { detectVentWill } from './will/detectVentWill';

// 返り値の型は元の関数からそのまま推論
export type IrosGoalType = ReturnType<typeof deriveIrosGoal>;
export type IrosPriorityType = ReturnType<typeof deriveIrosPriority>;

export type ComputeGoalAndPriorityArgs = {
  /** ✅ 追加：観測ログの追跡用（orchestrator から渡す） */
  conversationId?: string | null;

  /** 今回のユーザ入力テキスト */
  text: string;

  /** 今回の解析で決まった depth / qCode */
  depth?: Depth;
  qCode?: QCode;

  /** リクエストで指定された depth / qCode（あれば） */
  requestedDepth?: Depth;
  requestedQCode?: QCode;

  /** 直前ターンの depth / qCode（連続性のため） */
  lastDepth?: Depth;
  lastQ?: QCode;

  /** 解析後に決まった mode（mirror / vision / diagnosis など） */
  mode: IrosMode;

  /** SelfAcceptance ライン（0〜1, null 可） */
  selfAcceptanceLine: number | null;

  /** ★ 魂レイヤー（Silent Advisor）からのノート（任意） */
  soulNote?: {
    risk_flags?: string[] | null;
    tone_hint?: string | null;
  } | null;

  /** ★ 三軸回転：前回 Goal.kind ／ uncover 連続カウント */
  lastGoalKind?: IrosGoalKind | null;
  previousUncoverStreak?: number;

  /** ★ Phase（Inner / Outer）— Y軸トルク用。未解決なら null */
  phase?: 'Inner' | 'Outer' | null;

  /** ✅ 追加：MemoryState から渡す「前回の回転状態」 */
  spinLoop?: SpinLoop | null;
  descentGate?: DescentGate | null;
};

export type ComputeGoalAndPriorityResult = {
  goal: IrosGoalType;
  priority: IrosPriorityType;
};

/* =========================================================
   内部ユーティリティ：Depth を厳密正規化（S4は潰す）
========================================================= */

const DEPTH_SET = new Set<string>(DEPTH_VALUES as unknown as string[]);

/** Depth として採用できる文字列だけ通す。S4 は null に落とす。 */
function normalizeDepthStrictOrNull(v: unknown): Depth | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;

  // ★ S4 は「存在しない扱い」にする（ここが重要）
  if (s === 'S4') return null;

  if (DEPTH_SET.has(s)) return s as Depth;
  return null;
}

/**
 * Goal / Continuity / Priority / SA補正 / Rotation をひとまとめにしたユーティリティ。
 * runIrosTurn からはこの関数ひとつを呼べばよい。
 */
export function computeGoalAndPriority(args: ComputeGoalAndPriorityArgs): ComputeGoalAndPriorityResult {
  const {
    conversationId,

    text,
    depth,
    qCode,
    requestedDepth,
    requestedQCode,
    lastDepth,
    lastQ,
    mode,
    selfAcceptanceLine,
    soulNote,
    lastGoalKind,
    previousUncoverStreak,
    phase,

    spinLoop,
    descentGate,
  } = args;

  // この関数内では “今ターンで扱う深度/Q” を null/undefined 混在させない
  const depthNow: Depth | null = (typeof depth === 'string' ? (depth as Depth) : null) ?? null;
  const qNow: QCode | null = (typeof qCode === 'string' ? (qCode as QCode) : null) ?? null;
  const lastDepthNow: Depth | null = (typeof lastDepth === 'string' ? (lastDepth as Depth) : null) ?? null;
  const lastQNow: QCode | null = (typeof lastQ === 'string' ? (lastQ as QCode) : null) ?? null;
  const sa = typeof selfAcceptanceLine === 'number' ? selfAcceptanceLine : null;

  /* =========================================================
     0) Vent/Will 判定（Q continuity に lastQ を載せるか切るか）
  ========================================================= */
  const vw = detectVentWill(text);

  // v1 ルール：
  // - willTag=true → Q continuity を遮断（lastQ を null）
  // - willTag=false → Q continuity を継続（lastQ を渡す）
  const continuityLastQ: QCode | null = vw.willTag ? null : (lastQNow ?? null);

  if (process.env.DEBUG_IROS_WILL === '1') {
    // eslint-disable-next-line no-console
    console.log('[IROS/VentWill]', {
      ventScore: vw.ventScore,
      willScore: vw.willScore,
      willTag: vw.willTag,
      ventHits: vw.reasons.ventHits,
      willHits: vw.reasons.willHits,
      continuityLastQ,
      conversationId: conversationId ?? null,
    });
  }

  /* =========================================================
     ① Goal Engine：今回の "意志" を生成
  ========================================================= */
  let goal = deriveIrosGoal({
    userText: text,
    lastDepth: lastDepthNow ?? undefined,
    lastQ: lastQNow ?? undefined,
    requestedDepth,
    requestedQCode,

    // ★ 三軸回転用
    lastGoalKind: lastGoalKind ?? undefined,
    uncoverStreak: previousUncoverStreak ?? 0,
  });

  // ✅ デバッグ/学習用：goal.detail に Vent/Will の痕跡を残す（任意）
  try {
    const anyGoal: any = goal;
    anyGoal.detail = {
      ...(anyGoal.detail && typeof anyGoal.detail === 'object' ? anyGoal.detail : {}),
      ventWill: {
        ventScore: vw.ventScore,
        willScore: vw.willScore,
        willTag: vw.willTag,
        ventHits: vw.reasons.ventHits,
        willHits: vw.reasons.willHits,
        continuityLastQ,
      },
    };
    goal = anyGoal as IrosGoalType;
  } catch {
    // no-op
  }

  /* =========================================================
     ①.5 魂レイヤーによる Goal の補正（Q5_depress 保護）
  ========================================================= */
  try {
    const riskFlags = soulNote?.risk_flags ?? null;
    const hasQ5Depress = qNow === 'Q5' && Array.isArray(riskFlags) && riskFlags.includes('q5_depress');

    if (hasQ5Depress && goal) {
      const anyGoal: any = goal;

      if (typeof anyGoal.kind === 'string') {
        anyGoal.kind = 'stabilize';
        anyGoal.reason = 'SoulLayer が Q5_depress を検出したため、このターンは安定・保護を最優先する';

        anyGoal.detail = {
          ...(anyGoal.detail && typeof anyGoal.detail === 'object' ? anyGoal.detail : {}),
          bySoulQ5Depress: true,
        };
      }

      goal = anyGoal as IrosGoalType;
    }
  } catch (e) {
    if (process.env.DEBUG_IROS_WILL === '1') {
      // eslint-disable-next-line no-console
      console.error('[IROS/Will] soul-based goal adjustment failed', e);
    }
  }

  // ✅ Q continuity を切ったターンは「このターンの qCode」を goal.targetQ に同期する
  if (continuityLastQ === null && qNow) {
    const anyGoal: any = goal;
    const prev = typeof anyGoal.targetQ === 'string' ? anyGoal.targetQ : null;

    if (prev !== qNow) {
      anyGoal.targetQ = qNow;
      anyGoal.detail = {
        ...(anyGoal.detail && typeof anyGoal.detail === 'object' ? anyGoal.detail : {}),
        targetQForcedToCurrent: true,
        targetQPrev: prev,
        targetQNow: qNow,
        targetQReason: 'continuityLastQ is null → prefer current decided qCode',
      };
      goal = anyGoal as IrosGoalType;
    }
  }

  /* =========================================================
     ② Continuity Engine：前回の意志を踏まえて補正（Goal 用）
     ※ ContinuityContext は「null運用」(undefined禁止) に統一
  ========================================================= */
  const continuity: ContinuityContext = {
    lastDepth: lastDepthNow ?? null,
    lastQ: continuityLastQ,
    userText: text,
  };

  // ★ safety: goal.targetQ が空なら「このターンで決まった qCode」を入れておく
  if (!(goal as any).targetQ && qNow) {
    (goal as any).targetQ = qNow;
  }

  // eslint-disable-next-line no-console
  console.log('[IROS/GOAL_CONT] applyGoalContinuity', {
    conversationId: conversationId ?? null,
    goal_in: goal,
    ctx: {
      lastQ: continuity.lastQ,
      lastDepth: continuity.lastDepth,
      qTrace: (continuity as any)?.qTrace ?? null,
      memoryQ: (continuity as any)?.memoryState?.qPrimary ?? null,
    },
  });

  goal = applyGoalContinuity(goal, continuity);

  // eslint-disable-next-line no-console
  console.log('[IROS/GOAL_CONT]  result', {
    conversationId: conversationId ?? null,
    goal_out: goal,
  });

  /* =========================================================
     ②.5 三軸回転：decideRotation で帯域回転 + gate/loop を更新
     ※ ここでは “meta” は存在しない。入口は goal（orchestratorWill の責務範囲）
  ========================================================= */
  try {
    const anyGoal: any = goal;

    // targetDepth は string 混入があり得るので「Depth or null」へ正規化
    const baseDepth: Depth | null =
      (typeof anyGoal?.targetDepth === 'string' ? normalizeDepthStrictOrNull(anyGoal.targetDepth) : null) ??
      depthNow ??
      lastDepthNow ??
      null;

    const rotation = decideRotation({
      lastDepth: lastDepthNow ?? null,
      currentDepth: baseDepth ?? null,
      qCode: qNow ?? null,

      lastGoalKind: lastGoalKind ?? null,
      uncoverStreak: typeof previousUncoverStreak === 'number' ? previousUncoverStreak : 0,

      selfAcceptance: sa ?? null,
      riskFlags: soulNote?.risk_flags ?? null,

      stayRequested: false,

      lastSpinLoop: spinLoop ?? null,
      lastDescentGate: descentGate ?? null,

      // ✅ LLM signals（密度ヒント）
      // - 生成元は rephraseEngine.full.ts の meta.extra.llmSignals（保存されるなら goal/extra に載る）
      // - orchestratorWill は “meta” を参照しない（この関数の責務外）
      llmSignals: (anyGoal as any)?.extra?.llmSignals ?? (anyGoal as any)?.llmSignals ?? null,

      // 未配線（後で繋ぐ）
      actionSignal: null,
      delegateLevel: null,
      userAcceptedDescent: null,
    });

    // rotationState は必ず残す（観測可能性）
    anyGoal.rotationState = {
      spinLoop: rotation.nextSpinLoop,
      descentGate: rotation.nextDescentGate,
      depth: rotation.nextDepth,
      reason: rotation.reason,
    };

    // apply: shouldRotate の時だけ goal.targetDepth を更新（単一決定者へ寄せる）
    if (rotation.shouldRotate && rotation.nextDepth) {
      anyGoal.targetDepth = rotation.nextDepth;
    }

    goal = anyGoal as IrosGoalType;

    // [IROS/DEPTH_WRITE] ROTATION（自然回転の確定ログ）
    try {
      // eslint-disable-next-line no-console
      console.log('[IROS/DEPTH_WRITE]', {
        route: 'ROTATION',
        where: 'orchestratorWill',
        conversationId: conversationId ?? null,
        baseDepth,
        goalTargetDepth: (goal as any)?.targetDepth ?? null,
        rotationDepth: rotation.nextDepth ?? null,
        spinLoop: rotation.nextSpinLoop ?? null,
        descentGate: rotation.nextDescentGate ?? null,
        shouldRotate: rotation.shouldRotate ?? null,
        reason: rotation.reason ?? null,
      });
    } catch {
      // no-op
    }

    if (process.env.DEBUG_IROS_WILL === '1') {
      // eslint-disable-next-line no-console
      console.log('[IROS/Will] rotation decided', {
        conversationId: conversationId ?? null,
        rotationState: (goal as any)?.rotationState ?? null,
      });
    }
  } catch (e) {
    if (process.env.DEBUG_IROS_WILL === '1') {
      // eslint-disable-next-line no-console
      console.error('[IROS/Will] rotation failed', e);
    }
  }

  /* =========================================================
     ③ Priority Engine：Goal の意志に基づき重み計算
  ========================================================= */
  const priorityBase = deriveIrosPriority({
    goal,
    mode,
    depth: depthNow ?? undefined,
    qCode: qNow ?? undefined,
    phase: phase ?? undefined,
  });

  const priority = adjustPriorityWithSelfAcceptance(priorityBase, sa);

  return {
    goal,
    priority,
  };
}
