// src/lib/iros/orchestratorWill.ts
// Iros Orchestrator — Will パート集約
// - Goal / Continuity / Priority / SA補正 をまとめて扱うヘルパー

import type { Depth, QCode, IrosMode } from './system';
import { DEPTH_VALUES } from './system';

import { deriveIrosGoal } from './will/goalEngine';
import type { IrosGoalKind } from './will/goalEngine';

import {
  applyGoalContinuity,
  type ContinuityContext,
} from './will/continuityEngine';

import { deriveIrosPriority } from './will/priorityEngine';

import { adjustPriorityWithSelfAcceptance } from './orchestratorPierce';

// ★ 置き換え：shouldRotateBand → decideRotation
import { decideRotation } from './will/rotationEngine';

// 返り値の型は元の関数からそのまま推論
export type IrosGoalType = ReturnType<typeof deriveIrosGoal>;
export type IrosPriorityType = ReturnType<typeof deriveIrosPriority>;

export type ComputeGoalAndPriorityArgs = {
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

  // ✅ 追加：MemoryState から渡す「前回の回転状態」
  spinLoop?: 'SRI' | 'TCF' | null;
  descentGate?: 'closed' | 'offered' | 'accepted' | null;
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
 * Goal / Continuity / Priority / SA補正 をひとまとめにしたユーティリティ。
 * runIrosTurn からはこの関数ひとつを呼べばよい。
 */
export function computeGoalAndPriority(
  args: ComputeGoalAndPriorityArgs,
): ComputeGoalAndPriorityResult {
  const {
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

    // ✅ 追加（前回回転状態）
    spinLoop,
    descentGate,
  } = args;

  /* =========================================================
     ① Goal Engine：今回の "意志" を生成
  ========================================================= */
  let goal = deriveIrosGoal({
    userText: text,
    lastDepth,
    lastQ,
    requestedDepth,
    requestedQCode,
    // ★ 三軸回転用
    lastGoalKind: lastGoalKind ?? undefined,
    uncoverStreak: previousUncoverStreak ?? 0,
  });

  /* =========================================================
     ①.5 魂レイヤーによる Goal の補正（Q5_depress 保護）
  ========================================================= */
  try {
    const riskFlags = soulNote?.risk_flags ?? null;
    const hasQ5Depress =
      qCode === 'Q5' &&
      Array.isArray(riskFlags) &&
      riskFlags.includes('q5_depress');

    if (hasQ5Depress && goal) {
      const anyGoal: any = goal;

      if (typeof anyGoal.kind === 'string') {
        anyGoal.kind = 'stabilize';
        anyGoal.reason =
          'SoulLayer が Q5_depress を検出したため、このターンは安定・保護を最優先する';

        if (anyGoal.detail && typeof anyGoal.detail === 'object') {
          anyGoal.detail = {
            ...anyGoal.detail,
            bySoulQ5Depress: true,
          };
        } else {
          anyGoal.detail = {
            bySoulQ5Depress: true,
          };
        }
      }

      goal = anyGoal as IrosGoalType;
    }
  } catch (e) {
    if (process.env.DEBUG_IROS_WILL === '1') {
      // eslint-disable-next-line no-console
      console.error('[IROS/Will] soul-based goal adjustment failed', e);
    }
  }

  /* =========================================================
     ② Continuity Engine：前回の意志を踏まえて補正（Goal 用）
     ※ ContinuityContext は「null運用」(undefined禁止) に統一
  ========================================================= */
  const continuity: ContinuityContext = {
    lastDepth: lastDepth ?? null,
    lastQ: lastQ ?? null,
    userText: text,
  };

  goal = applyGoalContinuity(goal, continuity);

  /* =========================================================
     ②.5 三軸回転：decideRotation で帯域回転 + gate/loop を更新
  ========================================================= */
  try {
    const anyGoal: any = goal;

    // targetDepth は string 混入があり得るので「Depth or null」へ正規化
    const baseDepth: Depth | null =
      (typeof anyGoal?.targetDepth === 'string'
        ? normalizeDepthStrictOrNull(anyGoal.targetDepth)
        : null) ??
      (typeof depth === 'string' ? (depth as Depth) : null) ??
      (typeof lastDepth === 'string' ? (lastDepth as Depth) : null) ??
      null;

    const rotation = decideRotation({
      lastDepth:
        (typeof lastDepth === 'string' ? (lastDepth as Depth) : null) ?? null,
      currentDepth: baseDepth,

      // ★ undefined じゃなく null 統一
      qCode: (typeof qCode === 'string' ? (qCode as QCode) : null) ?? null,

      lastGoalKind: lastGoalKind ?? null,
      uncoverStreak:
        typeof previousUncoverStreak === 'number' ? previousUncoverStreak : 0,

      selfAcceptance: selfAcceptanceLine ?? null,
      riskFlags: soulNote?.risk_flags ?? null,

      stayRequested: false,

      // ✅ 前回状態（args に追加したので any 不要）
      lastSpinLoop: spinLoop ?? null,
      lastDescentGate: descentGate ?? null,

      // いま未配線なら null でOK（後で繋ぐ）
      actionSignal: null,
      delegateLevel: null,
      userAcceptedDescent: null,
    });

    // ✅ 回転で depth を更新（回転しない場合も nextDepth は baseDepth を返す設計）
    if (rotation.shouldRotate && rotation.nextDepth) {
      anyGoal.targetDepth = rotation.nextDepth;
      goal = anyGoal as IrosGoalType;
    }

    // ✅ 常に rotationState を残す（ログ reason が埋まる＝動いてる証拠）
    anyGoal.rotationState = {
      spinLoop: rotation.nextSpinLoop,
      descentGate: rotation.nextDescentGate,
      depth: rotation.nextDepth,
      reason: rotation.reason,
    };
    goal = anyGoal as IrosGoalType;

    if (process.env.DEBUG_IROS_WILL === '1') {
      // eslint-disable-next-line no-console
      console.log('[IROS/Will] rotation decided', anyGoal.rotationState);
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
    depth,
    qCode,
    phase: phase ?? undefined, // ★ Phase を渡す（ここは engine 側が optional ならOK）
  });

  // ★ SelfAcceptance ラインを使って Priority を補正
  const priority = adjustPriorityWithSelfAcceptance(
    priorityBase,
    selfAcceptanceLine,
  );

  return {
    goal,
    priority,
  };
}
