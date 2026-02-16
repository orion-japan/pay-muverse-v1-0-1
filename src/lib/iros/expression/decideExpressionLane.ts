// src/lib/iros/expression/decideExpressionLane.ts
// iros — Expression Lane (pure)
// - 進行(Depth/Phase/Lane)は絶対に変えない
// - writer前: preface(1行) を seed に混ぜる用途
// - writer後: polish可否ヒントだけ返す（内容追加は禁止）
//
// 将来拡張：Technique registry に追加するだけで増やせる

export type ExpressionLaneKey = 'OFF' | 'PREFACE_1LINE' | 'POLISH_ONLY';

export type ExpressionReason =
  | 'AFTER_DOWNSHIFT'
  | 'I_PLATEAU'
  | 'OUTER_GUCHI'
  | 'ALLOW_METAPHOR'
  | 'DEFAULT';

export type ExpressionBlock =
  | 'STALL_HARD'
  | 'T_CONCRETIZE'
  | 'COMMIT_EVIDENCE'
  | 'HOWTO_QUESTION'
  | 'DIRECT_TASK'
  | 'DISABLED';

export type LaneKey = 'IDEA_BAND' | 'T_CONCRETIZE' | string;
export type PhaseIO = 'Inner' | 'Outer' | string;
export type DepthStage = string;

export type AllowHint = {
  metaphor?: boolean;
  ambiguity?: boolean;
  short_reply_ok?: boolean;
  concrete_reply?: boolean;
  [k: string]: any;
};

export type FlowCtx = {
  ageSec?: number | null;
  flowDelta?: string | null; // e.g. 'RETURN'
  returnStreak?: number | null;
  fresh?: boolean | null;
  sessionBreak?: boolean | null;
  [k: string]: any;
};

export type ExpressionSignals = {
  // 将来追加しても引数増殖しないように “signals” に閉じ込める
  looksOuterGuchi?: boolean;
  iPlateauLike?: boolean; // 抽象反復（上流で検出できるなら入れる）
  afterDownshift?: boolean; // stallHard->IDEA_BAND 強制などの直後
  howToQuestionLike?: boolean;
  directTask?: boolean;
  commitEvidenceJustNow?: boolean;
  [k: string]: any;
};

export type ExpressionFlags = {
  enabled?: boolean;
  stallHard?: boolean;
  [k: string]: any;
};

export type ExpressionContext = {
  // 観測値（変更禁止）
  laneKey: LaneKey;
  phase: PhaseIO | null;
  depth: DepthStage | null;

  allow?: AllowHint | null;
  flow?: FlowCtx | null;

  // 上流で作れるなら渡す（なければfalse扱い）
  signals?: ExpressionSignals | null;

  // hard block / feature flag
  flags?: ExpressionFlags | null;

  // ログ用（pureだが返すだけ）
  traceId?: string | null;
};

export type ExpressionDecision = {
  fired: boolean;
  lane: ExpressionLaneKey;
  reason: ExpressionReason;
  blockedBy: ExpressionBlock | null;

  // writer前に 1行だけ混ぜる（存在しないなら null）
  prefaceLine: string | null;

  // writer後整形の許可（内容追加は禁止）
  shouldPolish: boolean;

  // 将来拡張用：meta.extra などに「追記するだけ」
  // ※深度/phase/laneKey を変える patch は禁止
  metaPatch?: Record<string, any> | null;

  // 監査用
  debug?: {
    laneKey: string;
    phase: string | null;
    depth: string | null;
    allowMetaphor: boolean;
    flowDelta: string | null;
    returnStreak: number | null;
  };
};

// ---------------------------
// Technique registry
// ---------------------------

type Technique = {
  id: string;
  // 発火条件（blockは別で先に判定）
  matches: (ctx: ExpressionContext) => boolean;
  // 1行生成（nullなら生成なし）
  composePreface: (ctx: ExpressionContext) => string | null;
  reason: ExpressionReason;
};

// 将来ここに追加していく（登録順が優先度）
const TECHNIQUES: Technique[] = [
  {
    id: 'after_downshift',
    reason: 'AFTER_DOWNSHIFT',
    matches: (ctx) => !!ctx.signals?.afterDownshift,
    composePreface: () => 'いまは「戻す」より、流れをもう一度つなぎ直すターンです。',
  },
  {
    id: 'outer_guchi',
    reason: 'OUTER_GUCHI',
    // ✅ signals が未配線でも、Outer×C帯域なら “外側→内側” の入口として preface を許可する
    matches: (ctx) =>
      !!ctx.signals?.looksOuterGuchi ||
      (String(ctx.phase ?? '') === 'Outer' &&
        /^C\d+/.test(String(ctx.depth ?? '')) &&
        String(ctx.laneKey ?? '') === 'IDEA_BAND'),
    composePreface: () => '外側の出来事を一度ほどいて、内側で何が揺れたのかだけ拾い直します。',
  },

  // ✅ NEW: RETURN(1回目)でも、Inner×IDEA_BAND なら “流れをつなぐ1行” を許可
  // - 乱発防止：Outerは対象外 / T_CONCRETIZEは decideBlock で既にブロック
  // - 目的：いまの「変わらない」問題（returnStreak=1でtech不発）を解消
  {
    id: 'return_first_connect',
    reason: 'AFTER_DOWNSHIFT',
    matches: (ctx) =>
      (ctx.flow?.flowDelta === 'RETURN') &&
      ((ctx.flow?.returnStreak ?? 0) >= 1) &&
      (String(ctx.phase ?? '') === 'Inner') &&
      (String(ctx.laneKey ?? '') === 'IDEA_BAND'),
    composePreface: () => 'いまは結論を急がず、流れだけつなぎ直します。',
  },

  {
    id: 'i_plateau',
    reason: 'I_PLATEAU',
    matches: (ctx) =>
      !!ctx.signals?.iPlateauLike ||
      (ctx.flow?.flowDelta === 'RETURN' && (ctx.flow?.returnStreak ?? 0) >= 2),
    composePreface: () =>
      '同じところを回っているので、候補をいくつか出して前に進めますか？',
  },
  {
    id: 'offer_candidates_on_repeat',
    reason: 'I_PLATEAU',
    // ✅ stallHard/soft のときに「候補出しますか？」を1行だけ提案
    matches: (ctx) =>
      (ctx.flags?.stallHard === true) ||
      (ctx.flow?.flowDelta === 'RETURN' && (ctx.flow?.returnStreak ?? 0) >= 2) ||
      !!ctx.signals?.iPlateauLike,
    composePreface: () => '同じ所を回っているので、候補をいくつか出しますか？',
  },

  {
    id: 'allow_metaphor',
    reason: 'ALLOW_METAPHOR',
    matches: (ctx) => !!ctx.allow?.metaphor,
    composePreface: () => '比喩で一度だけ置き換えて、刺さる輪郭を先に出します。',
  },
];


function clampOneLine(s: string): string {
  const t = String(s ?? '').replace(/\r\n/g, '\n').trim();
  if (!t) return '';
  // 1行化（改行は禁止）
  const one = t.split('\n').map((x) => x.trim()).filter(Boolean).join(' ');
  // 句点で終わらせる（日本語UIの安定）
  return /[。．.!！?？]$/.test(one) ? one : `${one}。`;
}

function decideBlock(ctx: ExpressionContext): ExpressionBlock | null {
  const enabled = ctx.flags?.enabled !== false;
  if (!enabled) return 'DISABLED';

  if (ctx.flags?.stallHard) return 'STALL_HARD';

  // 表現レーンはT_CONCRETIZEを侵食しない（原則ブロック）
  if (ctx.laneKey === 'T_CONCRETIZE') return 'T_CONCRETIZE';

  if (ctx.signals?.commitEvidenceJustNow) return 'COMMIT_EVIDENCE';

  if (ctx.signals?.howToQuestionLike) return 'HOWTO_QUESTION';

  if (ctx.signals?.directTask) return 'DIRECT_TASK';

  return null;
}

/**
 * ✅ pure entry
 * - 進行(Depth/Phase/Lane)は一切変えない
 * - fired時は prefaceLine を最大1行だけ返す
 */
export function decideExpressionLane(ctx: ExpressionContext): ExpressionDecision {
  const blockedBy = decideBlock(ctx);
  const allowMetaphor = !!ctx.allow?.metaphor;
  const flowDelta = (ctx.flow?.flowDelta ?? null) as string | null;
  const returnStreak = (ctx.flow?.returnStreak ?? null) as number | null;

  if (blockedBy) {
    return {
      fired: false,
      lane: 'OFF',
      reason: 'DEFAULT',
      blockedBy,
      prefaceLine: null,
      shouldPolish: false,
      metaPatch: {
        expr: {
          fired: false,
          blockedBy,
          at: Date.now(),
        },
      },
      debug: {
        laneKey: String(ctx.laneKey ?? ''),
        phase: (ctx.phase ?? null) as any,
        depth: (ctx.depth ?? null) as any,
        allowMetaphor,
        flowDelta,
        returnStreak,
      },
    };
  }

  // technique pick（最初にヒットしたもの）
  const tech = TECHNIQUES.find((t) => t.matches(ctx)) ?? null;

  if (!tech) {
    return {
      fired: false,
      lane: 'OFF',
      reason: 'DEFAULT',
      blockedBy: null,
      prefaceLine: null,
      shouldPolish: false,
      metaPatch: {
        expr: {
          fired: false,
          reason: 'DEFAULT',
          at: Date.now(),
        },
      },
      debug: {
        laneKey: String(ctx.laneKey ?? ''),
        phase: (ctx.phase ?? null) as any,
        depth: (ctx.depth ?? null) as any,
        allowMetaphor,
        flowDelta,
        returnStreak,
      },
    };
  }

  const prefaceRaw = tech.composePreface(ctx);
  const prefaceLine = prefaceRaw ? clampOneLine(prefaceRaw) : null;

  return {
    fired: !!prefaceLine, // prefaceが無いなら実質OFF
    lane: prefaceLine ? 'PREFACE_1LINE' : 'OFF',
    reason: tech.reason,
    blockedBy: null,
    prefaceLine,
    // writer後 polish は “許可” だけ（実際の加工は別レイヤーで）
    shouldPolish: true,
    metaPatch: {
      expr: {
        fired: !!prefaceLine,
        lane: prefaceLine ? 'PREFACE_1LINE' : 'OFF',
        techniqueId: tech.id,
        reason: tech.reason,
        at: Date.now(),
      },
    },
    debug: {
      laneKey: String(ctx.laneKey ?? ''),
      phase: (ctx.phase ?? null) as any,
      depth: (ctx.depth ?? null) as any,
      allowMetaphor,
      flowDelta,
      returnStreak,
    },
  };
}
