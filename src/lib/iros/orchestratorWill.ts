// src/lib/iros/orchestratorWill.ts
// iros Orchestrator — Will パート集約
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

// ✅ 追加：Vent/Will detector（continuity の Q 継続/遮断の判断材料）
import { detectVentWill } from './will/detectVentWill';

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
     0) Vent/Will 判定（Q continuity に lastQ を載せるか切るか）
     - 意志より感情にのまれやすい：基本は「感情継続」（lastQ を渡す）
     - ただし、強い前向き意志が明確（willTag）なら「操縦席に戻った」扱いで lastQ を切る
  ========================================================= */
  const vw = detectVentWill(text);

  // v1 ルール：
  // - willTag=true → Q continuity を遮断（lastQ を null）
  // - willTag=false → Q continuity を継続（lastQ を渡す）
  const continuityLastQ: QCode | null = vw.willTag ? null : (lastQ ?? null);

  if (process.env.DEBUG_IROS_WILL === '1') {
    // eslint-disable-next-line no-console
    console.log('[IROS/VentWill]', {
      ventScore: vw.ventScore,
      willScore: vw.willScore,
      willTag: vw.willTag,
      ventHits: vw.reasons.ventHits,
      willHits: vw.reasons.willHits,
      continuityLastQ,
    });
  }

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

  // ✅ デバッグ/学習用：goal.detail に Vent/Will の痕跡を残す（任意）
  try {
    const anyGoal: any = goal;
    anyGoal.detail = {
      ...(anyGoal.detail && typeof anyGoal.detail === 'object'
        ? anyGoal.detail
        : {}),
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

  // ✅ Q continuity を切ったターンは「このターンの qCode」を goal.targetQ に同期する
  // - willTag=true などで continuityLastQ=null になった場合、
  //   deriveIrosGoal が lastQ 起点で targetQ を埋めてしまうズレをここで潰す
  if (continuityLastQ === null && qCode) {
    const anyGoal: any = goal;
    const prev = typeof anyGoal.targetQ === 'string' ? anyGoal.targetQ : null;

    if (prev !== qCode) {
      anyGoal.targetQ = qCode;
      anyGoal.detail = {
        ...(anyGoal.detail && typeof anyGoal.detail === 'object' ? anyGoal.detail : {}),
        targetQForcedToCurrent: true,
        targetQPrev: prev,
        targetQNow: qCode,
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
    lastDepth: lastDepth ?? null,
    lastQ: continuityLastQ, // ✅ ここが肝：Vent/Will 判定で Q の継続/遮断
    userText: text,
  };

  // ★ safety: goal.targetQ が空なら「このターンで決まった qCode」を入れておく
  // （continuity が “lastQ に戻す” 系の補正をするなら、ここを起点に挙動が見える）
  if (!goal.targetQ && qCode) {
    (goal as any).targetQ = qCode;
  }

  // ✅ 追加ログ：applyGoalContinuity の入出力を確定させる
  // （ctx 未定義エラーを避けるため continuity を参照する）
  // eslint-disable-next-line no-console
  console.log('[IROS/GOAL_CONT] applyGoalContinuity', {
    goal_in: goal,
    ctx: {
      lastQ: continuity.lastQ,
      lastDepth: continuity.lastDepth,
      // 任意（型に無ければ null）
      qTrace: (continuity as any)?.qTrace ?? null,
      memoryQ: (continuity as any)?.memoryState?.qPrimary ?? null,
    },
  });

  goal = applyGoalContinuity(goal, continuity);

  // eslint-disable-next-line no-console
  console.log('[IROS/GOAL_CONT]  result', { goal_out: goal });

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

      // ✅ 前回状態
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
