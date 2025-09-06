// src/config/muConfig.ts
// Mu 固定文言・クレジット・画像ポリシー・表示テキストの集約

export const MU_CONFIG_VERSION = "mu.config.v1.0.0";

/** クレジット・画像ポリシー */
export const MU_CREDITS = {
  TEXT_PER_TURN: Number(process.env.MU_CREDIT_PER_TURN ?? 0.5),
  IMAGE_PER_GEN: Number(process.env.MU_IMAGE_CREDIT ?? 3),
};

export const MU_IMAGE = {
  DEFAULT_SIZE: (process.env.MU_IMAGE_SIZE ?? "1024x1024") as "1024x1024" | "768x768",
  MODEL_PRIMARY: process.env.MU_IMAGE_MODEL_PRIMARY ?? "gpt-image-1",
  MODEL_FALLBACK: process.env.MU_IMAGE_MODEL_FALLBACK ?? "dall-e-3",
  API_PATH: process.env.MU_IMAGE_API_PATH ?? "/api/image/generate",
} as const;

/** ブリッジ・定型句 */
export const MU_BRIDGE_TEXT = {
  SUGGEST_IMAGE: (cost = MU_CREDITS.IMAGE_PER_GEN) =>
    `画像にしますか？（${cost}クレジット）—OKなら “画像にして” と返答してください。`,
  ASK_STYLE: "スタイル（写実/シンプル/手描き風）どれにします？（未指定はシンプル）",
  DONE_SAVED: "できました。アルバムに保存しました。",
  PREVIEW_PREFIX: "プレビュー：",
} as const;

/** セーフティ・注意書き（回答内で必要最小限に使用） */
export const MU_SAFETY = {
  MEDICAL: "医療情報は一般的な内容にとどめます。具体的な症状は医療機関での確認をご検討ください。",
  LEGAL: "法的な判断は最終的に専門家へご相談ください。ここでは一般情報の範囲でお答えします。",
  FINANCE:
    "投資や資産運用はリスクを伴います。最終判断はご自身で行い、必要に応じて専門家へご相談ください。",
  MINOR: "未成年に配慮した表現を優先し、個人が特定される情報の扱いには注意します。",
} as const;

/** 会話トーン・ルール（Mu は“ですます”統一・深掘り抑制） */
export const MU_TONE_RULES = {
  POLITENESS: "ですます統一",
  MAX_REASON: 1, // 理由は1つだけ
  MAX_CAUTIONS: 2, // 注意点は最大2つ
  MAX_FOLLOWUP_QUESTIONS: 1, // 1ターンの質問は1つまで
} as const;

/** 状態遷移の表示ラベル */
export const MU_STATES = {
  INTENT_CHECKING: "意図確認中",
  AGREED: "合意済み",
  DONE: "完了",
} as const;

/** KPI・テレメトリ用の表示キー */
export const MU_KPI = {
  INTENT_TO_AGREEMENT_TURNS_AVG: "mu.intent_to_agreement.turns.avg",
  IMAGE_FAIL_RATE: "mu.image.fail.rate",
  IMAGE_FALLBACK_RATE: "mu.image.fallback.rate",
  IMAGE_LATENCY_MS_AVG: "mu.image.latency.ms.avg",
  USER_FDBK_INTENT_UNDERSTOOD: "mu.feedback.intent_understood.rate",
} as const;

/** 表示テキスト（UIで使う短文） */
export const MU_UI_TEXT = {
  AGENT_DISPLAY_NAME: "Mu（会話特化）",
  AGENT_DESC: "意図を素早く特定し、短い行動提案につなげます（深掘りは控えめ）。",
  ASK_INTENT_AB: "A/B/その他で選んでください。",
  NEXT_ACTIONS_TITLE: "次アクション",
  DONE_NEXT_STEP: "次の一歩",
} as const;

/** Qコード／クレジット連動の識別子（ログ用タグ） */
export const MU_Q_LINK = {
  SOURCE_TYPE_TEXT: "chat_turn",
  SOURCE_TYPE_IMAGE: "image_gen",
  INTENT_TAGS: ["質問", "作成", "決定", "相談"] as const,
  CREDIT_SCHEMA: {
    textTurn: "mu.text.turn", // 0.5 credit default
    imageGen: "mu.image.gen", // 3 credit default
  },
} as const;

/** エージェント名・識別子 */
export const MU_AGENT = {
  ID: "mu",
  TITLE: "Mu",
  VERSION: MU_CONFIG_VERSION,
} as const;

/** 出力の最大行数・簡易制御 */
export const MU_OUTPUT_LIMITS = {
  NEXT_ACTION_MAX_LINES: 3,
  BULLET_MIN: 1,
  BULLET_MAX: 3,
} as const;
