// src/lib/iros/server/nextStepItTrigger.ts
// iros — Natural IT Trigger Gate (server-side)
//
// 目的：
// - 「ボタン押下」ではなく、会話の自然な連続性から IT 返しを発火させるための判定ゲート
// - 例：Q2×2 / sameIntent×2 など
//
// 前提（責務の分離）：
// - ボタン提示/choiceId は src/lib/iros/nextStepOptions.ts（single source of truth）
// - ここは “出力モード（renderMode='IT'）を自然に立てるか” だけを判断する
//
// 運用ルール（推奨）：
// - 自然発火は「頻発しやすい」ので、原則 density='compact'（短め）
// - 明示トリガー（ボタン等）より優先度は低い（ここでは扱わない）
//
// 使い方（想定）：
// - handleIrosReply の gates/postprocess など “metaForSave を確定する場所” で呼び出し
// - 既に renderMode が明示的に IT なら、このゲートは無視（外側で優先順位を制御）

export type ItDensity = 'compact' | 'normal';

export type NaturalItTriggerReason =
  | 'q2_streak'
  | 'same_intent_streak'
  | 'stagnation_hint'
  | 'none';

export type NaturalItTriggerInput = {
  /** 今ターンの Q（例：'Q2'） */
  qCode: string | null;

  /**
   * 連続Qの情報（なければ null でOK）
   * - streakQ: 直近の連続Q
   * - streakLength: 連続回数
   */
  qTrace?: {
    streakQ?: string | null;
    streakLength?: number | null;
  } | null;

  /**
   * “意図が同じまま停滞している” を外側で検出できるなら渡す
   * - sameIntentStreak: 同一意図（または同一topic）連続回数
   */
  sameIntentStreak?: number | null;

  /**
   * 頻発抑制：直近で自然ITを出してからの経過ターン
   * - null/undefined の場合は抑制なしとして扱う
   */
  turnsSinceLastNaturalIT?: number | null;

  /**
   * 頻発抑制：このターン数以内は自然ITを抑制
   * - デフォルト 2（= 出した直後 + 次の1回は抑える）
   */
  cooldownTurns?: number | null;

  /**
   * 任意：追加ヒント（停滞/詰まりの兆候）
   * - 例：progressDelta=0 が続いている / goalが更新されない など
   * - true のとき “stagnation_hint” を理由に IT を出す余地を作る
   */
  stagnationHint?: boolean | null;
};

export type NaturalItTriggerResult = {
  forceIT: boolean;
  /** 自然発火は基本 short */
  density: ItDensity;
  /** 発火理由（ログ/検証用） */
  reason: NaturalItTriggerReason;
  /** デバッグ用の補足 */
  notes: string[];
};

/**
 * 自然IT発火の中核判定
 *
 * デフォルト方針：
 * - Q2×2（= streakQ='Q2' & streakLength>=2）で発火
 * - sameIntent×2（sameIntentStreak>=2）でも発火
 * - stagnationHint=true も発火候補（ただし上の2つより弱い）
 * - cooldown 中は発火しない
 */
export function decideNaturalItTrigger(
  input: NaturalItTriggerInput,
): NaturalItTriggerResult {
  const notes: string[] = [];

  const cooldownTurns =
    typeof input.cooldownTurns === 'number' && Number.isFinite(input.cooldownTurns)
      ? Math.max(0, Math.round(input.cooldownTurns))
      : 2;

  const turnsSinceLast =
    typeof input.turnsSinceLastNaturalIT === 'number' &&
    Number.isFinite(input.turnsSinceLastNaturalIT)
      ? Math.max(0, Math.round(input.turnsSinceLastNaturalIT))
      : null;

  if (turnsSinceLast != null && turnsSinceLast <= cooldownTurns) {
    notes.push(
      `cooldown active: turnsSinceLastNaturalIT=${turnsSinceLast} <= cooldownTurns=${cooldownTurns}`,
    );
    return {
      forceIT: false,
      density: 'compact',
      reason: 'none',
      notes,
    };
  }

  const streakQ = (input.qTrace?.streakQ ?? null) ? String(input.qTrace?.streakQ) : null;
  const streakLenRaw = input.qTrace?.streakLength ?? null;
  const streakLength =
    typeof streakLenRaw === 'number' && Number.isFinite(streakLenRaw)
      ? Math.max(0, Math.round(streakLenRaw))
      : 0;

  const q2x2 = streakQ === 'Q2' && streakLength >= 2;
  if (q2x2) {
    notes.push(`Q2 streak: streakQ=${streakQ}, streakLength=${streakLength}`);
    return {
      forceIT: true,
      density: 'compact',
      reason: 'q2_streak',
      notes,
    };
  }

  const sameIntentStreakRaw = input.sameIntentStreak ?? null;
  const sameIntentStreak =
    typeof sameIntentStreakRaw === 'number' && Number.isFinite(sameIntentStreakRaw)
      ? Math.max(0, Math.round(sameIntentStreakRaw))
      : 0;

  const sameIntentx2 = sameIntentStreak >= 2;
  if (sameIntentx2) {
    notes.push(`sameIntent streak: sameIntentStreak=${sameIntentStreak}`);
    return {
      forceIT: true,
      density: 'compact',
      reason: 'same_intent_streak',
      notes,
    };
  }

  const stagnationHint = !!input.stagnationHint;
  if (stagnationHint) {
    notes.push(`stagnationHint=true`);
    return {
      forceIT: true,
      density: 'compact',
      reason: 'stagnation_hint',
      notes,
    };
  }

  notes.push(
    `no trigger: streakQ=${streakQ ?? 'null'}, streakLength=${streakLength}, sameIntentStreak=${sameIntentStreak}`,
  );

  return {
    forceIT: false,
    density: 'compact',
    reason: 'none',
    notes,
  };
}

/**
 * 便利関数：meta に自然ITの決定を “安全に追記” する
 *
 * - すでに meta.renderMode='IT' が入っている場合は “触らない”
 * - 立てるなら meta.extra.forceIT=true / meta.extra.itDensity='compact' を追加
 *
 * ※どのキーを最終的に採用するか（metaForSave.renderMode など）は上流で統一すること
 *   この関数は「判断結果をメタに残す」だけ。
 */
export function attachNaturalItToMeta(params: {
  meta: any;
  decision: NaturalItTriggerResult;
}): any {
  const meta = params.meta && typeof params.meta === 'object' && !Array.isArray(params.meta)
    ? params.meta
    : {};

  // 既に明示ITなら何もしない
  if ((meta as any).renderMode === 'IT') return meta;

  const decision = params.decision;

  if (!decision.forceIT) return meta;

  const baseExtra =
    meta.extra && typeof meta.extra === 'object' && !Array.isArray(meta.extra)
      ? meta.extra
      : {};

  return {
    ...meta,
    extra: {
      ...baseExtra,
      // ✅ 自然発火の事実を残す（上流で renderMode='IT' に確定する材料）
      forceIT: true,
      itDensity: decision.density,
      itNaturalReason: decision.reason,
      itNaturalNotes: decision.notes,
    },
  };
}
