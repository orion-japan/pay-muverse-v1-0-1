// src/lib/mu/config.ts
// Mu 用の統合コンフィグ（Sofia風ビルダーが参照する MU_CONFIG を提供）
// - env の参照はランタイム依存せず安全に評価
// - 型不一致を明示的に収束

function getEnv(name: string): string | undefined {
  try {
    const p: any = typeof process !== 'undefined' ? process : undefined;
    const v = p?.env?.[name];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}
function envNumber(name: string, fallback: number): number {
  const raw = getEnv(name);
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) ? (n as number) : fallback;
}
function envImageSize(
  name: string,
  fallback: '1024x1024' | '768x768'
): '1024x1024' | '768x768' {
  const raw = getEnv(name);
  return raw === '768x768' ? '768x768' : '1024x1024';
}
function envString(name: string, fallback: string): string {
  const raw = getEnv(name);
  return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
}

export const MU_CONFIG_VERSION = 'mu.config.v1.0.0';

/** クレジット・画像ポリシー */
export const MU_CREDITS = {
  TEXT_PER_TURN: envNumber('MU_CREDIT_PER_TURN', 0.5),
  IMAGE_PER_GEN: envNumber('MU_IMAGE_CREDIT', 3),
};

export const MU_IMAGE = {
  DEFAULT_SIZE: envImageSize('MU_IMAGE_SIZE', '1024x1024'),
  MODEL_PRIMARY: envString('MU_IMAGE_MODEL_PRIMARY', 'gpt-image-1'),
  MODEL_FALLBACK: envString('MU_IMAGE_MODEL_FALLBACK', 'dall-e-3'),
  API_PATH: envString('MU_IMAGE_API_PATH', '/api/image/generate'),
} as const;

/** ブリッジ・定型句 */
export const MU_BRIDGE_TEXT = {
  SUGGEST_IMAGE: (cost = MU_CREDITS.IMAGE_PER_GEN) =>
    `画像にしますか？（${cost}クレジット）—OKなら「画像にして」と返してください。`,
  ASK_STYLE: 'スタイルは（写実／シンプル／手描き風）のどれにしますか？（未指定はシンプル）',
  DONE_SAVED: 'できました。アルバムに保存しました。',
  PREVIEW_PREFIX: 'プレビュー：',
} as const;

/** セーフティ・注意書き */
export const MU_SAFETY = {
  MEDICAL:
    '医療情報は一般的な内容にとどめます。具体の判断や検査は医療機関での確認をご検討ください。',
  LEGAL:
    '法的な判断は最終的に専門家へご相談ください。ここでは一般情報の範囲でお答えします。',
  FINANCE:
    '投資や資産運用にはリスクがあります。最終判断はご自身で行い、必要に応じて専門家へご相談ください。',
  MINOR:
    '未成年への配慮を優先し、個人が特定される情報の扱いには注意します。',
} as const;

/** 会話トーン・ルール */
export const MU_TONE_RULES = {
  POLITENESS: 'ですます統一',
  MAX_REASON: 1,
  MAX_CAUTIONS: 2,
  MAX_FOLLOWUP_QUESTIONS: 1,
} as const;

/** 状態遷移ラベル */
export const MU_STATES = {
  INTENT_CHECKING: '意図確認中',
  AGREED: '合意済み',
  DONE: '完了',
} as const;

/** KPIキー */
export const MU_KPI = {
  INTENT_TO_AGREEMENT_TURNS_AVG: 'mu.intent_to_agreement.turns.avg',
  IMAGE_FAIL_RATE: 'mu.image.fail.rate',
  IMAGE_FALLBACK_RATE: 'mu.image.fallback.rate',
  IMAGE_LATENCY_MS_AVG: 'mu.image.latency.ms.avg',
  USER_FDBK_INTENT_UNDERSTOOD: 'mu.feedback.intent_understood.rate',
} as const;

/** UI用短文 */
export const MU_UI_TEXT = {
  AGENT_DISPLAY_NAME: 'Mu（会話特化）',
  AGENT_DESC:
    'ゆとりある会話で意図をすばやく掴み、小さな次の一歩につなげます（深掘りは控えめ）。',
  ASK_INTENT_AB: '（例：A／B／その他）※自由入力もOKです。',
  NEXT_ACTIONS_TITLE: '次アクション',
  DONE_NEXT_STEP: '次の一歩',
} as const;

/** Qコード／クレジット連動 */
export const MU_Q_LINK = {
  SOURCE_TYPE_TEXT: 'chat_turn',
  SOURCE_TYPE_IMAGE: 'image_gen',
  INTENT_TAGS: ['質問', '作成', '決定', '相談'] as const,
  CREDIT_SCHEMA: {
    textTurn: 'mu.text.turn',
    imageGen: 'mu.image.gen',
  },
} as const;

/** エージェント名・識別子 */
export const MU_AGENT = {
  ID: 'mu',
  TITLE: 'Mu',
  VERSION: MU_CONFIG_VERSION,
} as const;

/** 出力制御 */
export const MU_OUTPUT_LIMITS = {
  NEXT_ACTION_MAX_LINES: 3,
  BULLET_MIN: 1,
  BULLET_MAX: 3,
} as const;

/** まとめて扱う統合コンフィグ（ビルダーが参照） */
export const MU_CONFIG = {
  persona: {
    allowEmoji: true,
    maxEmojiPerReply: 1,
    allowedEmoji: ['🌱', '🌿', '🪔', '🌊', '🌌', '🌇'],
  },
  ui: {
    assistantLineHeight: 1.5,
    paragraphMargin: 8,
  },
  version: MU_CONFIG_VERSION,
  credits: MU_CREDITS,
  image: MU_IMAGE,
  bridgeText: MU_BRIDGE_TEXT,
  safety: MU_SAFETY,
  toneRules: MU_TONE_RULES,
  states: MU_STATES,
  kpi: MU_KPI,
  uiText: MU_UI_TEXT,
  qLink: MU_Q_LINK,
  agent: MU_AGENT,
  outputLimits: MU_OUTPUT_LIMITS,
} as const;
