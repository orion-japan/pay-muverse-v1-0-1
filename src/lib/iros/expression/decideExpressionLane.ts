// file: src/lib/iros/expression/decideExpressionLane.ts

export type ExpressionLaneKey =
  | 'off'
  | 'plain'
  | 'sofia'
  | 'sofia_light'
  | 'polish_only';

type DecideCtx = {
  traceId?: string | null;
  laneKey?: string | null; // iros lane (IDEA_BAND etc)
  phase?: string | null;
  depth?: string | null;

  flow?: { flowDelta?: string | null; returnStreak?: number | null } | null;

  // ここは「上流が明示的に渡す」ための入力口（未配線でもOK）
  exprMeta?: {
    lane?: ExpressionLaneKey | null;
    // 互換用：以前のメタが来ても壊さない
    techniqueId?: string | null;
    reason?: string | null;
  } | null;

  signals?: Record<string, any> | null;
  flags?: Record<string, any> | null;

  // 既存ログ用（残してOK）
  allow?: Record<string, any> | null;
};

export type ExpressionDecision = {
  fired: boolean;
  lane: ExpressionLaneKey;
  reason: string;
  blockedBy: string | null;

  // ✅ 互換のために残す（常に null）
  prefaceLine: string | null;

  // ✅ 互換（今は「許可」だけ残す）
  shouldPolish: boolean;

  metaPatch: {
    expr: {
      fired: boolean;
      lane: ExpressionLaneKey;
      techniqueId: string | null;
      reason: string;
      at: number;
    };
  };

  debug: {
    laneKey: string;
    phase: any;
    depth: any;
    flowDelta: any;
    returnStreak: any;
    techniqueId: any;
  };
};

/**
 * Expression Lane = 選択器
 * - “文章（テンプレ）を作らない”
 * - “どのレシピで書くか” だけを返す
 * - 実際の語り（Sofia構造語り等）は「表現レイヤー側」で実行する
 */
export function decideExpressionLane(ctx: DecideCtx): ExpressionDecision {
  const flowDelta = ctx.flow?.flowDelta ?? null;
  const returnStreak = ctx.flow?.returnStreak ?? 0;

  // ✅ 明示指定が最優先
  const explicitLane = (ctx.exprMeta?.lane ?? null) as ExpressionLaneKey | null;

  // ✅ デフォルトは off
  let lane: ExpressionLaneKey = 'off';
  let reason = 'DEFAULT_OFF';
  let techniqueId: string | null = null;
  let blockedBy: string | null = null;

  // ✅ enabled=false は強制OFF
  const enabled = ctx.flags?.enabled !== false;
  if (!enabled) {
    lane = 'off';
    reason = 'DISABLED_BY_FLAG';
    blockedBy = 'EXPR_DISABLED';
  } else {
    // ✅ explicit
    if (explicitLane) {
      lane = explicitLane;
      reason = 'EXPLICIT';
      techniqueId = ctx.exprMeta?.techniqueId ?? 'explicit_lane';
    }

    // ✅ stallHard（あれば）で sofia_light
    if (!explicitLane && lane === 'off' && ctx.flags?.stallHard === true) {
      lane = 'sofia_light';
      reason = 'STALL_HARD';
      techniqueId = 'stall_hard';
    }

    // ✅ ここが本命：RETURN なら sofia_light（allow に依存しない）
    if (!explicitLane && lane === 'off' && flowDelta === 'RETURN') {
      lane = 'sofia_light';
      reason = 'RETURN';
      techniqueId = 'return';
    }

    // ✅ 連続RETURNは理由を強める（可観測性）
    if (!explicitLane && lane === 'sofia_light' && flowDelta === 'RETURN' && returnStreak >= 2) {
      reason = 'RETURN_STREAK';
      techniqueId = 'return_streak';
    }
  }

  const fired = lane !== 'off';

  return {
    fired,
    lane,
    reason,
    blockedBy,

    // ✅ ここでは preface を直接入れない（注入は別レイヤーでやる）
    prefaceLine: null,

    // ✅ polish_only のときだけ true（今回使わないなら false 固定でもOK）
    shouldPolish: lane === 'polish_only',

    metaPatch: {
      expr: {
        fired,
        lane,
        techniqueId,
        reason,
        at: Date.now(),
      },
    },

    debug: {
      laneKey: String(ctx.laneKey ?? ''),
      phase: (ctx.phase ?? null) as any,
      depth: (ctx.depth ?? null) as any,
      flowDelta,
      returnStreak,
      techniqueId,
    },
  };
}
