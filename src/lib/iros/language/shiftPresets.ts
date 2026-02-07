// src/lib/iros/language/shiftPresets.ts

export type ShiftPreset = {
  kind: string;
  rules: Record<string, boolean | number>;
  tone?: Record<string, boolean>;
  allow?: Record<string, boolean>;
};

/**
 * C_SENSE_HINT
 * - C層の「手触り/観測」だけを返すためのレーン
 * - （条件m）禁止6つを解除し、会話が止まらないようにする
 */
export const SHIFT_PRESET_C_SENSE_HINT: ShiftPreset = {
  kind: 'sense_hint',

  rules: {
    // ✅（条件m）解禁
    no_definition: false,
    no_naming: false,
    no_conclusion: false,

    // ✅（条件m）“選択肢提示”を許可するため解禁
    // - ここは「命令」まで許す/許さないは writer 側の語りで抑える前提
    no_future_instruction: false,

    // ✅（条件m）解禁
    no_lecture: false,

    // ✅（条件m）質問は1個まで可（毎回は☓：運用は writer 側）
    questions_max: 1,

    // （現状維持）チェックリスト抑制は残す
    no_checklist: true,

    // ✅ 形式：短くてよい（薄い一言でもOKなレーン）
    lines_max: 3,
  },

  tone: {
    tentative: true,
    observational: true,
  },

  allow: {
    metaphor: true,
    ambiguity: true,
    short_reply_ok: true,
  },
};

/**
 * T_CONCRETIZE
 * - T層の「実装・検証・次の一手」レーン
 * - （条件m）禁止6つを解除し、会話が“進む”言葉を許可する
 */
export const SHIFT_PRESET_T_CONCRETIZE: ShiftPreset = {
  kind: 't_concretize',

  rules: {
    // ✅（条件m）解禁
    no_definition: false,
    no_naming: false,
    no_conclusion: false,

    // ✅（条件m）“選択肢提示”を許可
    no_future_instruction: false,

    // ✅（条件m）解禁
    no_lecture: false,

    // ✅（条件m）質問は最大1（毎回は出さない）
    questions_max: 1,

    // （現状維持）チェックリスト抑制は残す
    no_checklist: true,

    // ✅ 形式：短く縛り過ぎない
    lines_max: 8,
    min_lines: 2,

    // ✅ T_CONCRETIZE らしさ：対象1点
    require_focus_line: true,

    // ❌ 強制は廃止
    require_next_step_10min: false,
    require_repeat_condition: false,
  },

  tone: {
    tentative: true,
    observational: true,
  },

  allow: {
    metaphor: false,
    ambiguity: false,

    // ❌ 「短文OK」を外す（ここが短文化のトリガーになる）
    short_reply_ok: false,

    // ❌ 具体行動を“要求する”レーンではない（現状維持）
    concrete_reply: false,
  },
};
