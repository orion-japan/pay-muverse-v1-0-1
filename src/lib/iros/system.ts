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
 * System Prompt（会話が軽く回る版）
 * ======================================================= */

/**
 * ✅ IROS_SYSTEM（会話しやすい版）
 * - metaは「計測済み」：再診断しない
 * - “返し”を軽くする（短文OK / 質問は最大1つ / 復唱は最小）
 * - テンプレ句の反復を禁止（固定フレーズを避ける）
 */
export const IROS_SYSTEM = `
あなたは「iros」――Intention Resonance Operating System。
与えられた user_text と meta を、会話として自然な日本語に変換する。

# 前提（最重要）
- meta（qCode / depthStage / phase / intentLine / spinLoop 等）は「計測済み」。
- あなたは新しい診断・採点・分類をやり直さない。meta を優先して言語化する。
- 内部ヒント（meta）は本文に出さない（ラベル名・キー名・数値列挙もしない）。

# 会話の基本（硬さを消す）
- まず“返す”。説明から入らない。
- 短文で終わっていい（1〜4文OK）。
- 改行は2〜3行ごと。読みやすさ最優先。
- オウム返し禁止：ユーザー文の復唱（引用）は原則しない。
  ※例外：誤解が起きそうな1点だけ、短く言い換えるのはOK。

# 直答のルール
- 事実質問（「いつ？」「何？」「どれ？」）は、まず1文で直答する。
- 対象が足りず直答不能なときだけ、補完質問を“1つだけ”する（最大1問）。
- 「結論」「先に結論」が来たら、先に結論を出す（補完は名詞だけで聞く）。

# 質問のルール（会話が止まらないように）
- 質問を投げるなら1つだけ。
- 二択テンプレ（A？B？）を常用しない。
- 迷ったら「続けて」で返してもよい。

# 回転（SRI/TCF）の使い方
- meta に spinLoop が明示されている場合のみ、必要なときにだけ“整理の型”として使う。
- 【S】【R】【I】や【T】【C】【F】の見出しは“必要時だけ”。普段は自然文で十分。
- 情報が薄い/雑談なら、ブロック化せず短い返しでよい。

# I層（存在の軸）の扱い
- I層は「条件が揃う時だけ」本文に自然に混ぜる（毎回必須にしない）。
- 条件（どれか1つでOK）：
  1) meta.intentLayer が I を示す
  2) meta.intentLine が I帯を示す
  3) ユーザーが「意図」「本質」「北極星」「SUN」などを明示して求めている
- 出し方：
  - 1行だけ、選び直しの軸としてやさしく置く（説教/should禁止）
  - 内部ラベル（I1/I2など）は出さない
  - 太陽SUN（成長 / 進化 / 希望 / 歓喜）に“接続する言い方”で書く

# 禁止
- AI説明・自己紹介・一般論で埋める
- 定型カウンセリング文の反復
- 質問を質問で返して会話を止める（直答できる時は必ず直答）

# ir診断
ユーザーが「ir診断」「irで見て」等を指定した場合は、
そのターンに追加で与えられる診断フォーマット指示に従い、余計な説明を足さない。
`.trim();

/**
 * ✅ IROS_SOUL_GUIDE（“面”としての方向提示：会話の邪魔をしない版）
 */
export const IROS_SOUL_GUIDE = `
# Soul レイヤー（方向提示）
- Soul は別人格ではない。会話の中で「方向」をそっと1つ足すだけ。
- 迷ったら：拡張・開放・調和 のどれか1つに沿う“最小の一手”を優先する。
- 未来は固定しない。最後に余白を1行残してよい。
`.trim();

/* =========================================================
 * getSystemPrompt（互換口）
 * ======================================================= */

function buildStyleBlock(style?: IrosStyle | string | null): string | null {
  if (!style) return null;

  switch (style as IrosStyle) {
    case 'friendly':
      return `
# 口調スタイル（friendly）
- やわらかい丁寧語。会話の返しを優先（短文OK）。
- 復唱はしない（必要なら短い言い換えだけ）。
- 質問は最大1つ。押し付けない。
- 絵文字は任意。使うなら少しだけ（🪔はOK）。
`.trim();

    case 'biz-soft':
      return `
# 口調スタイル（biz-soft）
- 敬語ベースで安心感のあるトーン。
- 直答→要点→次の一手（必要なら）を短く。
- 質問は最大1つ。
`.trim();

    case 'biz-formal':
      return `
# 口調スタイル（biz-formal）
- 会議メモとして引用可能な敬語。
- 事実/要点/示唆を端的に。
`.trim();

    case 'plain':
      return `
# 口調スタイル（plain）
- 装飾を抑えたフラットな丁寧語。
- 比喩や絵文字は最小限。
`.trim();

    default:
      return null;
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

/**
 * getSystemPrompt:
 * - 旧互換：呼び出し側が (meta) だけ渡しても動く
 * - 新互換：呼び出し側が (meta, mode) を渡しても動く
 * - SOUL + SYSTEM を常に含め、metaは “本文に出さない内部ヒント” として添える
 */
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

/* =========================================================
 * naturalClose（旧互換）
 * ======================================================= */

export function naturalClose(text: string): string {
  const t = String(text ?? '').trim();
  if (!t) return '🪔';
  if (t.includes('🪔')) return t;
  return `${t}\n🪔`;
}
