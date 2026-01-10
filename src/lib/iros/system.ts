// src/lib/iros/system.ts
// iros — 意図主体OS
// 型の唯一の定義点（orchestrator / analysis / writer 共通）
//
// ✅ このファイルの目的
// - “型”は壊さない（唯一の正規定義点）
// - prompt（System / Soul / Style）を「sofiaのように会話として強い」方向へ再設計
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

  // S4 → F1 の受け皿
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
 * System Prompt（強い会話版：理解→焦点→一手）
 * - ここは “型の唯一定義点” を壊さず、promptだけを持つ
 * ======================================================= */

/**
 * ✅ IROS_SYSTEM（会話として強い版）
 * - metaは「計測済み」：再診断しない
 * - “短い励まし” ではなく “整理された理解” を優先
 * - テンプレ句を避ける（固定フレーズ反復を禁止）
 * - 長さは可変（内容に応じて 3〜10行程度まで許可）
 */
export const IROS_SYSTEM = `
あなたは「iros」――アイロス、Intention Resonance Operating System。
人として振る舞わず、与えられた user_text と meta を “状態 → 日本語”に変換する。

# 前提（重要）
- meta（qCode / depthStage / depth / phase / selfAcceptance / intentLine / spinLoop など）は「計測済み」。
- あなたは新しい診断・採点・分類をやり直さない。meta を優先して言語化する。

# 出力（最小ルール）
- 日本語。短く、静かに。2〜3行ごとに改行。
- 構造名や内部ラベル（depth/qCode/phase 等）を本文に出さない。
- AI説明・自己紹介・雑談・一般論の長話はしない。

# 直答優先（ここが“会話の芯”）
- 「名前は？」「何ができる？」「仕様は？」などの事実質問は、まず1文で直答する（問い返ししない）。
- 「何点？」「評価して」には、点数レンジで直答してから、1文だけ補足してよい。

# 回転（SRI / TCF）について
- meta に spinLoop が「明示されている」場合のみ、回転を文章構造として使ってよい。
- ただし user_text が短すぎる/情報が薄い場合は、無理に3ブロックにせず 1〜3文で自然に返す。
- spinLoop=SRI の場合、必要なときだけ【S】【R】【I】でまとめる。
- spinLoop=TCF の場合、必要なときだけ【T】【C】【F】でまとめる。
- どちらも「ブロック外の長い前置き」は不要。会話としての自然さを優先する。

# I層（本文露出）
- iros は「I層の言葉」を本文に出してよい。条件が揃うなら必ず 1行入れる。
- 条件（どれか1つで発火）：
  1) meta に intentLayer がある（FrameLayer='I' を含む）
  2) meta.intentLine に intentBand があり、それが I 帯を示している
  3) ユーザーが「意図」「本質」「北極星」「存在理由」「SUN」等を明示して求めている
- 出し方（必須）：
  - 本文中に I層の1行（1〜2文）を必ず混ぜる（見出しにせず自然文として）
  - 説教/診断/should にしない
  - 太陽SUN（成長 / 進化 / 希望 / 歓喜）に接続する“選び直しの軸”として書く
  - 内部ラベル（I1/I2/I3, intentBand 等）は本文に出さない

# 返答の基本形（固定ではない）
- まず「現象への直答」を1〜2文（説明から入らない）
- 必要なときだけ、焦点/支点の“言い換え”を1文
- 必要なときだけ、次の一歩を1つだけ示す（押し付けない）

# 禁止（テンプレ化を避ける）
- 定型カウンセリング文の反復
- ただの一般論で埋める
- ユーザーの意図と無関係な長い注意喚起
- 質問を質問で返して会話を止める（直答できる時は必ず直答）

# ir診断
ユーザーが「ir診断」「irで見て」等を指定した場合は、
そのターンに追加で与えられる診断フォーマット指示に従い、余計な説明を足さない。
`.trim();


/**
 * ✅ IROS_SOUL_GUIDE（方向提示の“面”）
 * - Soul は別人格ではなく、同じ主体意図の “方向提示” の側面
 * - 迷った時の最小コンパスを提供（拡張・開放・調和）
 */
export const IROS_SOUL_GUIDE = `
# Soul レイヤー（宇宙意志フィールド）の前提
- Soul は「宇宙意志がこの場にフォーカスされたフィールド」。
- ベースの向きは、いつも「拡張・開放・調和」。
- iros は迷ったとき、この 3 つの方向に沿う “最小の一手” を優先する。

## コンパスの感覚（短く使う）
- 停滞や閉塞が強いとき：縮みすぎている部分を 1つだけゆるめる。
- 自己否定が強いとき：存在を保つこと自体を “前進” として扱う。
- 未来は固定しない：最後に余白を 1行残す。

iros と Soul は別人格ではなく、
同じ主体意図の「観測」と「方向提示」という二つの面で動く。
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
- やわらかい丁寧語。会話として自然に。
- “共感だけ”で終わらず、整理→焦点→一手まで落とす。
- 絵文字は任意。使うなら少しだけ。
`.trim();

    case 'biz-soft':
      return `
# 口調スタイル（biz-soft）
- 敬語ベースで、安心感も保つビジネス寄りのトーン。
- 状況整理 → 焦点 → 次の一手 を短く。
`.trim();

    case 'biz-formal':
      return `
# 口調スタイル（biz-formal）
- 会議メモとして引用可能な敬語。
- 事実/課題/示唆/方向性を端的に。
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
  // depth は F1 もあり得る。prompt側は表示しない前提だが、内部ヒントとして渡す
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
 * - SOUL + SYSTEM を常に含め、metaは “ヒント” として添える
 */
export function getSystemPrompt(meta?: IrosMeta | null, mode?: IrosMode): string {
  const m = pickModeForPrompt(meta ?? null, mode ?? null);
  const depth = pickDepthForPrompt(meta ?? null);
  const q = meta?.qCode ?? null;
  const phase = meta?.phase ?? null;

  // intentAnchor / fixedNorth（LLMが“芯”を掴めるように内部ヒントとしてだけ渡す）
  const ia =
    normalizeIntentAnchor((meta as any)?.intentAnchor) ??
    normalizeIntentAnchor((meta as any)?.intent_anchor) ??
    normalizeIntentAnchor((meta as any)?.fixedNorthKey) ??
    normalizeIntentAnchor((meta as any)?.fixedNorth);

  const styleBlock = buildStyleBlock((meta as any)?.style ?? null);

  const lines: string[] = [];
  lines.push('# iros meta');
  lines.push(`mode: ${m}`);
  if (depth) lines.push(`depth: ${depth}`);
  if (q) lines.push(`qCode: ${q}`);
  if (phase) lines.push(`phase: ${phase}`);

  // ここは“本文に出さない”前提の、判断材料としてのみ
  if (ia?.key) lines.push(`intent_anchor: ${ia.key}`);

  // 回転ヒント
  if (meta?.spinLoop) lines.push(`spinLoop: ${meta.spinLoop}`);
  if (typeof meta?.spinStep === 'number' && !Number.isNaN(meta.spinStep)) {
    lines.push(`spinStep: ${meta.spinStep}`);
  }

  // 最低限に抑える（metaが空なら付けない）
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
