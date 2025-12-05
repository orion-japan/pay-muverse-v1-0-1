// src/lib/iros/orchestratorWill.ts
// Iros Orchestrator — Will パート集約
// - Goal / Continuity / Priority / SA補正 をまとめて扱うヘルパー

import type { Depth, QCode, IrosMode } from './system';

import { deriveIrosGoal } from './will/goalEngine';

import {
  applyGoalContinuity,
  type ContinuityContext,
} from './will/continuityEngine';

import { deriveIrosPriority } from './will/priorityEngine';

import { adjustPriorityWithSelfAcceptance } from './orchestratorPierce';

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
    soulNote,
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
     ①.5 魂レイヤーによる Goal の補正（Q5_depress 保護）
     - Q5 かつ soulNote.risk_flags に 'q5_depress' が含まれる場合、
       goal.kind を 'stabilize' 優先に切り替える
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
        // 主目的を「安定・保護」に寄せる
        anyGoal.kind = 'stabilize';

        // 既存の detail があれば壊さないように軽くマーキングだけ追加
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
    // ここで失敗しても致命的ではないのでログだけに留める（必要なら DEBUG フラグで出力）
    if (process.env.DEBUG_IROS_WILL === '1') {
      // eslint-disable-next-line no-console
      console.error('[IROS/Will] soul-based goal adjustment failed', e);
    }
  }

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
