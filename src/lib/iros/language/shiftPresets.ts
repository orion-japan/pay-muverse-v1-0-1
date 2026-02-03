// src/lib/iros/language/shiftPresets.ts

export type ShiftPreset = {
  kind: string;
  rules: Record<string, boolean | number>;
  tone?: Record<string, boolean>;
  allow?: Record<string, boolean>;
};

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
  },

  tone: {
    tentative: true,      // 断定しない
    observational: true,  // 観測語りのみ
  },

  allow: {
    metaphor: true,       // 比喩OK
    ambiguity: true,      // 曖昧さOK
    short_reply_ok: true, // 短文OK
  },
};
export const SHIFT_PRESET_T_CONCRETIZE: ShiftPreset = {
  kind: 't_concretize',

  rules: {
    // ❌ 意味を確定しない（核は上流で前提として固定する）
    no_definition: true,
    no_naming: true,

    // ✅ 結論は「行動」に寄せてOK（未来誘導ではなく“次の一手”）
    no_future_instruction: false,

    // ❌ 教える・説明する構文を抑制（実装優先）
    no_lecture: true,
    no_checklist: true,

    // ✅ 質問で進めない（提示で進める）
    questions_max: 0,

    // ✅ T具体化の形（writer契約）
    lines_max: 3,
    require_focus_line: true,
    require_next_step_10min: true,
    require_repeat_condition: true,
  },

  tone: {
    tentative: true,      // 意味は断定しない
    observational: false, // 観測だけで止まらない
  },

  allow: {
    metaphor: false,       // 具体化レーンでは比喩を抑える
    ambiguity: false,      // 曖昧さを抑える
    short_reply_ok: true,  // 3行で短く
    concrete_reply: true,  // 具体行動OK（※ writer側が拾う）
  },
};
