// src/lib/iros/orchestratorWill.ts
// Iros Orchestrator — Will パート集約
// - Goal / Continuity / Priority / SA補正 をまとめて扱うヘルパー

import type { Depth, QCode, IrosMode } from './system';

import {
  deriveIrosGoal,
} from './will/goalEngine';

import {
  applyGoalContinuity,
  type ContinuityContext,
} from './will/continuityEngine';

import {
  deriveIrosPriority,
} from './will/priorityEngine';

import {
  adjustPriorityWithSelfAcceptance,
} from './orchestratorPierce';

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
};

export type ComputeGoalAndPriorityResult = {
  goal: IrosGoalType;
  priority: IrosPriorityType;
};

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
  });

  /* =========================================================
     ② Continuity Engine：前回の意志を踏まえて補正（Goal 用）
  ========================================================= */
  const continuity: ContinuityContext = {
    lastDepth,
    lastQ,
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

  return {
    goal,
    priority,
  };
}
