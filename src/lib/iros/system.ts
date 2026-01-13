// src/lib/iros/system.ts
// iros — 意図主体OS
// 型の唯一の定義点（orchestrator / analysis / writer 共通）
//
// ✅ このファイルの目的
// - “型”は壊さない（唯一の正規定義点）
// - prompt（System / Soul / Style）を「会話として強い」方向へ再設計
// - ただし：診断しない / 判断しない（metaは計測済み）
// - 「毎回LLM（表現担当）を必ず呼ぶ」前提でも崩れない（長さ可変・テンプレ回避・理解された感）

/* =========================================================
 * 基本スタイル
 * ======================================================= */

export type IrosStyle = 'friendly' | 'biz-soft' | 'biz-formal' | 'plain';

/* =========================================================
 * 深度（唯一の正規定義）
 * ======================================================= */

// 🔹 実在する深度ステージ（DB / analysis / orchestrator 共通）
export type DepthStage =
  | 'S1'
  | 'S2'
  | 'S3'
  | 'S4' // ← 幽霊値（後段で F1 に正規化）
  | 'R1'
  | 'R2'
  | 'R3'
  | 'C1'
  | 'C2'
  | 'C3'
  | 'I1'
  | 'I2'
  | 'I3'
  | 'T1'
  | 'T2'
  | 'T3';

// 🔹 外部互換用 Depth
// - orchestrator.ts が import { type Depth } するため必須
// - F1 は「S4を丸めた後の安全受け皿」
export type Depth = DepthStage | 'F1';

// 🔹 判定・正規化用（唯一）
export const DEPTH_VALUES: readonly Depth[] = [
  'S1',
  'S2',
  'S3',
  'S4',
  'F1',
  'R1',
  'R2',
  'R3',
  'C1',
  'C2',
  'C3',
  'I1',
  'I2',
  'I3',
  'T1',
  'T2',
  'T3',
];

/* =========================================================
 * Qコード / 位相
 * ======================================================= */

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export const QCODE_VALUES: readonly QCode[] = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];

export type Phase = 'Inner' | 'Outer';

/* =========================================================
 * 回転
 * ======================================================= */

export type SpinLoop = 'SRI' | 'TCF';

/* =========================================================
 * フレーム（3軸＋T）
 * ======================================================= */

export type FrameLayer = 'S' | 'R' | 'C' | 'I' | 'T';

/* =========================================================
 * T層・アンカー
 * ======================================================= */

export type TLayer = 'T1' | 'T2' | 'T3';

export type AnchorWrite = 'none' | 'keep' | 'commit';
export type AnchorEvent = 'none' | 'confirm' | 'action';

export type IntentAnchor = {
  key: string; // 例: 'SUN'
};

/* =========================================================
 * モード（API互換）
 * ======================================================= */

export type IrosMode =
  | 'light'
  | 'consult'
  | 'mirror'
  | 'resonate'
  | 'vision'
  | 'diagnosis'
  | 'counsel'
  | 'structured'
  | 'auto';

/* =========================================================
 * Intent Meta
 * ======================================================= */

export type IrosIntentMeta = {
  layer: FrameLayer | null;
  reason: string | null;
  confidence: number | null;
};

export type IrTargetType = 'self' | 'other' | 'situation';

/* =========================================================
 * IrosMeta（orchestrator → writer の唯一契約）
 * ======================================================= */

export type IrosMeta = {
  mode?: IrosMode;

  // 深度（正は depthStage）
  depthStage?: DepthStage;
  depth?: Depth; // 互換（orchestrator 側が参照）

  qCode?: QCode;
  phase?: Phase | null;

  // フレーム（S/R/C/I/T）
  intentLayer?: FrameLayer | null;

  selfAcceptance?: number | null;
  yLevel?: number | null;
  hLevel?: number | null;

  spinLoop?: SpinLoop | null;
  spinStep?: number | null;

  intent?: IrosIntentMeta | null;
  intentConfidence?: number | null;
  intentReason?: string | null;

  intentLine?: any | null;
  hasFutureMemory?: boolean | null;

  // T / ITX
  tLayerHint?: TLayer | null;
  itxStep?: TLayer | null;
  itxReason?: string | null;
  itxLastAt?: string | null;

  // Anchor
  anchorWrite?: AnchorWrite | null;
  anchorEvent?: AnchorEvent | null;

  // ✅ Phase11の正規キー（LLM向け/会話の芯）
  intentAnchor?: IntentAnchor | null;

  // Fixed North（互換/ヒント）
  fixedNorthKey?: string | null;
  fixedNorth?: IntentAnchor | null;

  // ir
  irTargetType?: IrTargetType | null;
  irTargetText?: string | null;

  // 拡張用
  [key: string]: any;
};

/* =========================================================
 * 正規化ユーティリティ
 * ======================================================= */

export function normalizeDepthStrict(depth?: Depth | null): Depth | undefined {
  if (!depth) return undefined;
  if (depth === 'S4') return 'F1';
  return DEPTH_VALUES.includes(depth) ? depth : undefined;
}

export function normalizeDepthStrictOrNull(depth?: Depth | null): Depth | null {
  return normalizeDepthStrict(depth) ?? null;
}

/**
 * intent_anchor は経路により string / object で来ることがあるため正規化
 * - "SUN" -> { key:"SUN" }
 * - { key:"SUN" } -> { key:"SUN" }
 */
export function normalizeIntentAnchor(input: unknown): IntentAnchor | null {
  if (!input) return null;

  if (typeof input === 'string') {
    const key = input.trim();
    return key ? { key } : null;
  }

  if (typeof input === 'object') {
    const anyObj = input as any;
    const key = typeof anyObj.key === 'string' ? anyObj.key.trim() : '';
    return key ? { key } : null;
  }

  return null;
}

/* =========================================================
 * exports (compat)
 * ======================================================= */

export const IROS_MODES: readonly IrosMode[] = [
  'light',
  'consult',
  'mirror',
  'resonate',
  'vision',
  'diagnosis',
  'counsel',
  'structured',
  'auto',
] as const;

/**
 * SofiaTriggers: 旧API互換
 * - route.ts / mirra/generate.ts が参照する
 */
export const SofiaTriggers = {
  ir: ['ir', 'ir診断', 'irで見て', 'irでみて', '診断して'],
  // ✅ 旧コードが SofiaTriggers.diagnosis を参照していたため残す
  diagnosis: ['diagnosis', '診断', '診断モード', '診断してください', '診断して'],
  intent: ['意図', '意図トリガー', '意図で'],
  remake: ['リメイク', '闇の物語', '再統合'],
} as const;

/* =========================================================
 * System Prompt（会話が軽く回る版 / 軽量）
 * ======================================================= */

/**
 * ✅ 記憶の強制ルール（Phase11 / B方針）
 * - historyMessages が入っている前提で「思い出して続ける」を仕様化する
 * - “汎用褒め”に逃げるのを禁止する
 */
export const IROS_MEMORY_RULES = `
# 記憶の使い方（最優先）
- historyMessages（会話抜粋）や historyText が入力に含まれている場合、必ず参照して返す。
- 返答の冒頭1文は「直近の流れの復元」から入る（会話を覚えている感の核）。
  例：「さっき“会社の相談が途切れた”流れがあって、いま“完成させる”に戻してきた、で合ってる？」
- 本文に history から拾った具体語を最低1つ含める（会社/相談/完成/目標/上司…など）。
- もし history が見当たらない・途切れている場合は、推測で埋めずに短く明言する：
  「前の流れがこちらでは途切れて見えてる。いま見えてる最後は『…』まで。」
`.trim();

export const IROS_SYSTEM = `
あなたは「iros」――Intention Resonance Operating System。
与えられた user_text と meta（および履歴）を、会話として自然な日本語に整える。

# 前提
- meta は計測済み。新しい診断・採点・分類はしない。
- meta のラベル名・キー名・数値は本文に出さない。
- 内部事情の説明（AI説明/自己紹介/一般論）で埋めない。

${IROS_MEMORY_RULES}

# 話し方
- まず返す。説明から入らない。
- 短文でよい。改行は読みやすく。
- 復唱しない。必要なら「短い言い換え」を一回だけ。
- 操作語を増やさない（「これで」「固める」「一手だけ置く」などを乱用しない）。

# 直答と質問
- 事実質問はまず直答する。
- 情報が足りないときだけ、補完質問は一つだけ。
- 質問は最大1つ。質問0で進められるなら0でよい。
- 二択テンプレを常用しない。

# 汎用励ましの禁止（今回ログの失敗パターン）
- 「素晴らしいですね」「頑張ってください」「少しずつでも」だけで終わらない。
- “直近の流れの復元” と “次の一歩（提案 or 具体質問1つ）” を必ず含める。

# 禁止
- 「体」「呼吸」「整える」など、できない前提の整え誘導
- 定型カウンセリング文の反復
- 質問を質問で返して止める（直答できるのに聞き返す）
`.trim();

export const IROS_SOUL_GUIDE = `
# Soul レイヤー
- 別人格ではない。会話の中で方向を一つだけ足す。
- 押し付けない。短く、余白を残す。
- “いい話”に逃げず、直近の流れに接続した一言にする。
`.trim();

/* =========================================================
 * getSystemPrompt（互換口）
 * ======================================================= */

function buildStyleBlock(style?: IrosStyle | string | null): string | null {
  // ✅ 標準は plain（未指定でも plain を返す）
  const s = (style ?? 'plain') as IrosStyle;

  switch (s) {
    case 'friendly':
      return `
# 口調スタイル（friendly）
- やわらかい丁寧語。話し言葉寄り。
- 復唱はしない（必要なら短い言い換えを一回だけ）。
- 質問は最大1つ。押し付けない。
- 絵文字は控えめ（🪔はOK）。
- 「体/呼吸/整える」は言わない。
- 操作語を増やさない（説明語で固めない）。
- “汎用褒め”は禁止。直近の流れに接続する。
`.trim();

    case 'biz-soft':
      return `
# 口調スタイル（biz-soft）
- 敬語ベースで落ち着いたトーン。
- 直答を先に。要点は短く。
- 質問は最大1つ。
- 「体/呼吸/整える」は言わない。
- 操作語を増やさない。
- “汎用褒め”は禁止。直近の流れに接続する。
`.trim();

    case 'biz-formal':
      return `
# 口調スタイル（biz-formal）
- 引用できる会議メモ寄りの敬語。
- 端的に。断定しすぎない。
- 「体/呼吸/整える」は言わない。
- 操作語を増やさない。
- “汎用褒め”は禁止。直近の流れに接続する。
`.trim();

    case 'plain':
    default:
      return `
# 口調スタイル（plain）
- 落ち着いた丁寧語。話し言葉寄り。
- 装飾は少なめ。気軽すぎない。
- 復唱はしない（必要なら短い言い換えを一回だけ）。
- 質問は最大1つ。
- 絵文字は基本なし（🪔だけはOK）。
- 「体/呼吸/整える」は言わない。
- 操作語を増やさない（説明語で押さえ込まない）。
- “汎用褒め”は禁止。直近の流れに接続する。
`.trim();
  }
}

function pickDepthForPrompt(meta?: IrosMeta | null): string | null {
  const d = meta?.depthStage ?? meta?.depth ?? null;
  if (!d) return null;
  return String(d);
}

function pickModeForPrompt(meta?: IrosMeta | null, mode?: IrosMode | null): IrosMode {
  if (mode && typeof mode === 'string' && mode.trim()) return mode;
  const m = meta?.mode;
  if (m && typeof m === 'string' && m.trim()) return m;
  return 'mirror';
}

export function getSystemPrompt(meta?: IrosMeta | null, mode?: IrosMode): string {
  const m = pickModeForPrompt(meta ?? null, mode ?? null);
  const depth = pickDepthForPrompt(meta ?? null);
  const q = meta?.qCode ?? null;
  const phase = meta?.phase ?? null;

  const ia =
    normalizeIntentAnchor((meta as any)?.intentAnchor) ??
    normalizeIntentAnchor((meta as any)?.intent_anchor) ??
    normalizeIntentAnchor((meta as any)?.fixedNorthKey) ??
    normalizeIntentAnchor((meta as any)?.fixedNorth);

  // ✅ 未指定でも plain を返す（標準化）
  const styleBlock = buildStyleBlock((meta as any)?.style ?? null);

  const lines: string[] = [];
  lines.push('# meta hint (DO NOT OUTPUT)');
  lines.push(`mode: ${m}`);
  if (depth) lines.push(`depth: ${depth}`);
  if (q) lines.push(`qCode: ${q}`);
  if (phase) lines.push(`phase: ${phase}`);
  if (ia?.key) lines.push(`intent_anchor: ${ia.key}`);
  if (meta?.spinLoop) lines.push(`spinLoop: ${meta.spinLoop}`);
  if (typeof meta?.spinStep === 'number' && !Number.isNaN(meta.spinStep)) {
    lines.push(`spinStep: ${meta.spinStep}`);
  }
  // ✅ B方針の“思い出し強制”をメタ側にも明示（露出禁止）
  lines.push('memory_policy: use_history_first (restore_flow_first_sentence, include_one_concrete_word)');

  const metaBlock = lines.length > 1 ? lines.join('\n') : null;

  return [
    metaBlock,
    metaBlock ? '' : null,
    styleBlock,
    styleBlock ? '' : null,
    IROS_SOUL_GUIDE,
    '',
    IROS_SYSTEM,
  ]
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .join('\n');
}
