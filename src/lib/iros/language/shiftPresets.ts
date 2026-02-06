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
 * - “意味確定 / 次の指示 / 結論” を避け、曖昧さと比喩は許可
 */
export const SHIFT_PRESET_C_SENSE_HINT: ShiftPreset = {
  kind: 'sense_hint',

  rules: {
    // ❌ 意味を確定しない
    no_definition: true,
    no_naming: true,

    // ❌ 結論・答え・未来誘導をしない
    no_conclusion: true,
    no_future_instruction: true,

    // ❌ 教える・説明する構文を禁止
    no_lecture: true,
    no_checklist: true,

    // ❌ 質問で前に進めない（C層保持）
    questions_max: 0,

    // ✅ 形式：短くてよい（薄い一言でもOKなレーン）
    lines_max: 3,
  },

  tone: {
    tentative: true, // 意味は断定しない
    observational: true, // 観測語りのみ
  },

  allow: {
    metaphor: true, // 比喩OK
    ambiguity: true, // 曖昧さOK
    short_reply_ok: true, // 短文OK（Cは許可）
  },
};

/**
 * T_CONCRETIZE
 * - T層の「実装・検証・次の一手」レーン
 * - “意味の断定”はしないが、“行動の断定”はしてよい
 * - 薄い1行を禁止し、最低2行以上の厚みを保証する
 */
export const SHIFT_PRESET_T_CONCRETIZE: ShiftPreset = {
  kind: 't_concretize',

  rules: {
    // ❌ 意味を確定しない（核は上流で前提として固定する）
    no_definition: true,

    // ✅ 固有名詞/キー名は出してよい（抽象逃げを防ぐ）
    no_naming: false,

    // ✅ 未来誘導はしない（行動・時間の指示を抑える）
    no_future_instruction: true,

    // ❌ 教える・説明する構文を抑制（説教化防止）
    no_lecture: true,
    no_checklist: true,

    // ✅ 質問で進めない（提示で進める）
    questions_max: 0,

    // ✅ 形式：上限は短く、薄さは抑える
    lines_max: 4,
    min_lines: 2,

    // ✅ “対象1点” を必須化（行動は必須にしない）
    require_focus_line: true,

    // ❌ 時間/行動/反復の強制は廃止
    require_next_step_10min: false,
    require_repeat_condition: false,
  },

  tone: {
    // ✅ 命令口調に倒れないように戻す
    tentative: true,
    observational: true,
  },

  allow: {
    metaphor: false,
    ambiguity: false,

    // ✅ 短文OK（MIN_OK_LEN=24 と整合）
    short_reply_ok: true,

    // ❌ 具体行動を“要求する”レーンではない
    concrete_reply: false,
  },
};

