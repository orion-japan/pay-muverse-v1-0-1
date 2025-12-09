// src/lib/iros/orchestratorWill.ts
// Iros Orchestrator — Will パート集約
// - Goal / Continuity / Priority / SA補正 をまとめて扱うヘルパー

import type { Depth, QCode, IrosMode } from './system';

import { deriveIrosGoal } from './will/goalEngine';
import type { IrosGoalKind } from './will/goalEngine';

import {
  applyGoalContinuity,
  type ContinuityContext,
} from './will/continuityEngine';

import { deriveIrosPriority } from './will/priorityEngine';

import { adjustPriorityWithSelfAcceptance } from './orchestratorPierce';

// ★ 三軸回転エンジンを使用
import { shouldRotateBand } from './will/rotationEngine';

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
    lastGoalKind,
    previousUncoverStreak,
    phase, // ★ ここを追加
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

        // ★ 理由テキストも、魂レイヤー起点の内容にそろえる
        anyGoal.reason =
          'SoulLayer が Q5_depress を検出したため、このターンは安定・保護を最優先する';

        // 既存の detail があれば壊さないようにマーキングだけ追加
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
  ========================================================= */
  const continuity: ContinuityContext = {
    lastDepth,
    lastQ,
    userText: text,
  };

  goal = applyGoalContinuity(goal, continuity);

  /* =========================================================
     ②.5 三軸回転：shouldRotateBand で帯域回転を判定
       - S帯で Q3 & uncover ストリークなどの条件を満たしたときだけ
       - SelfAcceptance / risk_flags / stay意図 も考慮
  ========================================================= */
  try {
    const anyGoal: any = goal;

    const baseDepth: Depth | null =
      (anyGoal?.targetDepth as Depth | undefined) ??
      depth ??
      lastDepth ??
      null;

    const rotation = shouldRotateBand({
      lastDepth: lastDepth ?? null,
      currentDepth: baseDepth,
      qCode: qCode ?? undefined,
      lastGoalKind: lastGoalKind ?? null,
      uncoverStreak: previousUncoverStreak ?? 0,
      selfAcceptance: selfAcceptanceLine,
      riskFlags: soulNote?.risk_flags ?? null,
      // ★ ユーザーからの「ステイしてほしい」明示は、
      //   現状は未実装なので false 固定（将来、テキスト解析で補強）
      stayRequested: false,
    });

    if (rotation.shouldRotate && rotation.nextDepth) {
      anyGoal.targetDepth = rotation.nextDepth;
      goal = anyGoal as IrosGoalType;

      if (process.env.DEBUG_IROS_WILL === '1') {
        // eslint-disable-next-line no-console
        console.log('[IROS/Will] band rotation applied', rotation);
      }
    } else if (process.env.DEBUG_IROS_WILL === '1') {
      // eslint-disable-next-line no-console
      console.log('[IROS/Will] band rotation skipped', rotation);
    }
  } catch (e) {
    if (process.env.DEBUG_IROS_WILL === '1') {
      // eslint-disable-next-line no-console
      console.error('[IROS/Will] band rotation failed', e);
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
    phase: phase ?? undefined, // ★ Phase を渡す
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
