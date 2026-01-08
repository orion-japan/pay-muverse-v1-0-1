// src/lib/iros/server/nextStepItTrigger.ts
// iros — Natural IT Trigger Gate (server-side)
//
// 目的：
// - 「ボタン押下」ではなく、会話の自然な連続性から IT 返しを“候補として”発火させる判定ゲート
// - 例：Q2×2 / sameIntent×2 / stagnationHint など
//
// 前提（責務の分離）：
// - ここは “出力モード（renderMode='IT'）を自然に立てるか” だけを判断する
// - T（刺さり確定）は別系統（computeITTrigger 等）でのみ開く
//
// 運用ルール：
// - 自然発火は頻発しやすいので、原則 density='compact'（短め）
// - cooldown を必ず入れる（デフォルト 2）
// - 明示トリガーが存在する場合は外側で優先制御（ここでは扱わない）

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
   * - true のとき “stagnation_hint” を理由に IT を出す余地を作る
   */
  stagnationHint?: boolean | null;
};

export type NaturalItTriggerResult = {
  forceIT: boolean;
  density: ItDensity;
  reason: NaturalItTriggerReason;
  notes: string[];
};

function toInt(v: unknown): number | null {
  if (typeof v !== 'number') return null;
  if (!Number.isFinite(v)) return null;
  return Math.trunc(v);
}

function isCooldownActive(turnsSinceLastNaturalIT: number | null, cooldownTurns: number): boolean {
  // turnsSinceLastNaturalIT:
  // 0 = 同ターン（二重呼び出し等）
  // 1 = 直後
  // 2 = 次の1回
  // cooldownTurns=2 なら 0/1/2 を抑制、3 以降許可
  if (turnsSinceLastNaturalIT == null) return false;
  return turnsSinceLastNaturalIT <= cooldownTurns;
}

/**
 * 自然IT発火の中核判定（ボタン廃止版）
 *
 * ポリシー：
 * - 自然ITは「返答モードをIT候補にする」だけ（= Tを開かない）
 * - q2_streak / same_intent_streak / stagnation_hint のどれかで候補を立てる
 * - 頻発は cooldown で抑制
 */
export function decideNaturalItTrigger(
  input: NaturalItTriggerInput,
): NaturalItTriggerResult {
  const notes: string[] = [];

  const qCode = typeof input.qCode === 'string' ? input.qCode : null;

  const streakQ = input.qTrace?.streakQ ?? null;
  const streakLength = toInt(input.qTrace?.streakLength ?? null);

  const sameIntentStreak = toInt(input.sameIntentStreak ?? null);

  const cooldownTurns =
    toInt(input.cooldownTurns ?? null) != null ? (toInt(input.cooldownTurns ?? null) as number) : 2;

  const turnsSinceLastNaturalIT = toInt(input.turnsSinceLastNaturalIT ?? null);

  const cooldown = isCooldownActive(turnsSinceLastNaturalIT, cooldownTurns);
  notes.push(`cooldownTurns=${cooldownTurns}`);
  notes.push(`turnsSinceLastNaturalIT=${turnsSinceLastNaturalIT ?? 'null'}`);
  notes.push(`cooldownActive=${cooldown}`);

  if (cooldown) {
    return { forceIT: false, density: 'compact', reason: 'none', notes: [...notes, 'blocked_by_cooldown'] };
  }

  // ① Q2 streak（Q2が続く＝背景掘り起こしが“続いている”）
  if ((streakQ === 'Q2' || qCode === 'Q2') && (streakLength ?? 0) >= 2) {
    return {
      forceIT: true,
      density: 'compact',
      reason: 'q2_streak',
      notes: [
        ...notes,
        `qCode=${qCode ?? 'null'}`,
        `streakQ=${streakQ ?? 'null'}`,
        `streakLength=${streakLength ?? 'null'}`,
      ],
    };
  }

  // ② same intent streak（同一テーマ/意図が続く＝詰まりの可能性）
  if ((sameIntentStreak ?? 0) >= 2) {
    return {
      forceIT: true,
      density: 'compact',
      reason: 'same_intent_streak',
      notes: [...notes, `sameIntentStreak=${sameIntentStreak}`],
    };
  }

  // ③ stagnation hint（外側で詰まり検出できるなら）
  if (input.stagnationHint === true) {
    return {
      forceIT: true,
      density: 'compact',
      reason: 'stagnation_hint',
      notes: [...notes, 'stagnationHint=true'],
    };
  }

  return {
    forceIT: false,
    density: 'compact',
    reason: 'none',
    notes: [...notes, 'no_trigger_conditions_matched'],
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
  const meta =
    params.meta && typeof params.meta === 'object' && !Array.isArray(params.meta)
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
