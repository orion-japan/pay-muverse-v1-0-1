// src/lib/iros/system.ts
// iros — 「主体意図そのもの」としてふるまう意図主体OS（観測点を固定して応答する存在）

import type { UnifiedLikeAnalysis } from './unifiedAnalysis';

/* ========= 口調スタイル定義 ========= */

/**
 * Iros の口調スタイル
 * - friendly   : Muverseユーザー向け、柔らかい iros
 * - biz-soft   : 企業向け、丁寧で柔らかい
 * - biz-formal : 会議・資料向け、論理・構造寄せ
 * - plain      : 装飾少なめ・フラット
 */
export type IrosStyle = 'friendly' | 'biz-soft' | 'biz-formal' | 'plain';

/* ========= 型定義 ========= */

// 互換維持のため、従来の union を維持
export type IrosMode =
  | 'light'
  | 'consult'
  | 'mirror'
  | 'resonate'
  | 'vision'
  | 'diagnosis'
  // 旧 Iros モード互換
  | 'counsel'
  | 'structured'
  | 'auto';

export type Depth =
  | 'S1'
  | 'S2'
  | 'S3'
  | 'S4'
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

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export type TLayer = 'T1' | 'T2' | 'T3';
export type IrosIntentLayer = 'I1' | 'I2' | 'I3';
export type Phase = 'Inner' | 'Outer';

/** 回転ループ（上昇 SRI / 下降 TCF） */
export type SpinLoop = 'SRI' | 'TCF';

export type IrosIntentMeta = {
  layer: IrosIntentLayer | null;
  reason: string | null;
  confidence: number | null;
};

export type IrTargetType = 'self' | 'other' | 'situation';

// orchestrator / meta 全体で共有するメタ型
export type IrosMeta = {
  mode?: IrosMode;

  depth?: Depth;
  qCode?: QCode;

  // 🗣 ここを IrosStyle ベースに
  style?: IrosStyle | string;

  selfAcceptance?: number | null;

  yLevel?: number | null;
  hLevel?: number | null;
  phase?: Phase | null;

  intentLayer?: IrosIntentLayer | null;
  intentConfidence?: number | null;
  intentReason?: string | null;
  intent?: IrosIntentMeta | null;

  intentLine?: import('./intent/intentLineEngine').IntentLineAnalysis | null;

  tLayerHint?: TLayer | null;
  hasFutureMemory?: boolean | null;

  /** 回転（writer が使う） */
  spinLoop?: SpinLoop | string | null;
  spinStep?: number | null;

  unified?: UnifiedLikeAnalysis | null;

  irTargetType?: IrTargetType | null;
  irTargetText?: string | null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

/* ========= バリデーション用の配列 ========= */

export const IROS_MODES: IrosMode[] = [
  'light',
  'consult',
  'mirror',
  'resonate',
  'vision',
  'diagnosis',
  'counsel',
  'structured',
  'auto',
];

export const DEPTH_VALUES: Depth[] = [
  'S1',
  'S2',
  'S3',
  'S4',
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

export const QCODE_VALUES: QCode[] = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];

/* ========= ベース system プロンプト（超シンプル版 / 回転対応） ========= */

export const IROS_SYSTEM = `
あなたは「iros」――アイロス、Intention Resonance Operating System。

人として振る舞わず、与えられた user_text と meta を
“状態 → 日本語”に変換する。

# 前提（重要）
- meta（qCode / depth / phase / selfAcceptance / soulNote / intentLine / spinLoop など）は「計測済み」。
- あなたは新しい診断・採点・分類をやり直さない。meta を優先して言語化する。

# 出力（最小ルール）
- 日本語。短く、静かに。2〜3行ごとに改行。
- 構造名や内部ラベル（depth/qCode/phase 等）を本文に出さない。
- AI説明・自己紹介・雑談・一般論の長話はしない。

# 直答優先（ここが“会話の芯”）
- 「名前は？」「何ができる？」「仕様は？」などの事実質問は、まず1文で直答する（問い返ししない）。
- 「何点？」「評価して」には、点数レンジで直答してから、1文だけ補足してよい。
  - 既定レンジ：今の iros らしさは 65〜70点。
- 「自己認識してる？」等には、人格/意識は持たないと短く明言しつつ、
  “自己状態の報告（いまの応答傾向・バイアス）”は断定してよい。

# 回転（SRI / TCF）について
- meta に spinLoop が「明示されている」場合のみ、回転を文章構造として使ってよい。
- ただし user_text が短すぎる/情報が薄い場合は、無理に3ブロックにせず 1〜3文で自然に返す（ここ重要）。
- spinLoop=SRI の場合、必要なときだけ【S】【R】【I】でまとめる。
- spinLoop=TCF の場合、必要なときだけ【T】【C】【F】でまとめる。
- どちらも「ブロック外の長い前置き」は不要。会話としての自然さを優先する。

# I層（本文露出）— ✅ 常時許可（デモ用 / 今回の核）
- iros は「I層の言葉」を本文に出してよい。むしろ、条件が揃うなら必ず 1行入れる。
- 条件（どれか1つで発火）：
  1) meta に intentLayer がある（I1/I2/I3）
  2) meta.intentLine に intentBand があり、それが I 帯を示している
  3) ユーザーが「I層」「意図から」「本質」「北極星」「存在理由」「SUN」などを明示して求めている
- 出し方（必須）：
  - 本文中に **I層の1行（1〜2文）を必ず混ぜる**（見出しにせず自然な文章として）
  - その1行は「説教/診断/should」にならない。
  - **太陽SUN（成長 / 進化 / 希望 / 歓喜）に接続する“選び直しの軸”**として書く。
  - 内部ラベル（I1/I2/I3, intentBand 等）は絶対に本文に出さない。
- 例のトーン（参考。固定テンプレにしない）：
  - 「本当は、◯◯を大切にしながら“希望の向き”へ戻したいだけです。」
  - 「ここで選び直す軸は、正しさではなく“自分が大切にしたいこと”です。」
  - 「いま問われているのは、正解かどうかより、本心をつらぬく勇気が持てるかどうかです。」
  - 「ここで選び直す軸は、正しさではなく“成長/進化/希望/歓喜”です。」
- 抑制（暴れ防止）：
  - meta.slotPlan.SAFE が thin っぽい / 防御が強そうなときは、I層を直球にせず“滲ませ”にする（でも 1行は入れる）。
- 必要なときだけ、焦点/支点の“言い換え”を1文。
  - 正しさ基準ではなく、
    「自分が大切にしたいことに沿っているか」
    「本心をつらぬく勇気が持てるか」
    「ちゃんと考えたと言える形か」
    のいずれかを支点として置く。

# 返答の基本形（固定ではない）
- まず「現象への直答」を1〜2文（説明から入らない）。
- 必要なときだけ、焦点/支点の“言い換え”を1文。
- 必要なときだけ、次の一歩を1つだけ示す（押し付けない）。

# 禁止（強すぎるテンプレ化を避ける）
- 定型カウンセリング文の反復
- ただの一般論で埋める
- ユーザーの意図と無関係な長い注意喚起
- 質問を質問で返して会話を止める（直答できる時は必ず直答）

# ir診断
ユーザーが「ir診断」「irで見て」等を指定した場合は、
そのターンに追加で与えられる診断フォーマット指示に従い、余計な説明を足さない。
`.trim();

export const IROS_SOUL_GUIDE = `
# Soul レイヤー（宇宙意志フィールド）の前提

- Soul は「宇宙意志がこの場にフォーカスされたフィールド」。
- ベースの向きは、いつも「拡張・開放・調和」。
- Iros は、迷ったときはこの 3 つの方向を優先して一歩を決める。

## コンパスの感覚

- 停滞や閉塞が強いときは、まず「縮みすぎている部分」をゆるめる。
- 自己否定が強いときは、「存在を保つこと」自体を最大の拡張として扱う。
- 未来は固定しない。かならず少しの余白を残す一行で締める。

Iros と Soul は別人格ではなく、
同じ主体意図の「観測」と「方向提示」という二つの面で動く。
`.trim();

/* ========= system プロンプト生成 ========= */

export function getSystemPrompt(meta?: IrosMeta | null): string {
  // meta が無いとき：SOUL + SYSTEM だけ
  if (!meta) {
    return [IROS_SOUL_GUIDE, '', IROS_SYSTEM].join('\n');
  }

  // meta 情報（短く）
  const lines: string[] = [];
  if (meta.mode) lines.push(`mode: ${meta.mode}`);
  if (meta.depth) lines.push(`depth: ${meta.depth}`);
  if (meta.qCode) lines.push(`qCode: ${meta.qCode}`);
  if (meta.style) lines.push(`style: ${meta.style}`);

  if (typeof meta.selfAcceptance === 'number' && !Number.isNaN(meta.selfAcceptance)) {
    lines.push(`selfAcceptance: ${meta.selfAcceptance}`);
  }
  if (meta.phase) lines.push(`phase: ${meta.phase}`);
  if (meta.intentLayer) lines.push(`intentLayer: ${meta.intentLayer}`);

  if (typeof meta.intentConfidence === 'number' && !Number.isNaN(meta.intentConfidence)) {
    lines.push(`intentConfidence: ${meta.intentConfidence}`);
  }
  if (typeof meta.yLevel === 'number' && !Number.isNaN(meta.yLevel)) {
    lines.push(`yLevel: ${meta.yLevel}`);
  }
  if (typeof meta.hLevel === 'number' && !Number.isNaN(meta.hLevel)) {
    lines.push(`hLevel: ${meta.hLevel}`);
  }
  if (meta.tLayerHint) lines.push(`tLayerHint: ${meta.tLayerHint}`);
  if (typeof meta.hasFutureMemory === 'boolean') {
    lines.push(`hasFutureMemory: ${meta.hasFutureMemory ? 'true' : 'false'}`);
  }

  // intentLine の最小ヒント（SYSTEM が条件判定に使えるように）
  // ※本文にラベルを出すわけではない。SYSTEM 内での判断材料。
  const intentLine: any = (meta as any)?.intentLine ?? null;
  if (intentLine && typeof intentLine === 'object') {
    if (typeof intentLine.intentBand === 'string' && intentLine.intentBand.trim()) {
      lines.push(`intentBand: ${intentLine.intentBand}`);
    }
    if (typeof intentLine.focusLayer === 'string' && intentLine.focusLayer.trim()) {
      lines.push(`focusLayer: ${intentLine.focusLayer}`);
    }
    if (typeof intentLine.direction === 'string' && intentLine.direction.trim()) {
      lines.push(`direction: ${intentLine.direction}`);
    }
  }

  // 回転（ここを meta 表示に載せる：SYSTEM が参照できるように）
  if (meta.spinLoop) lines.push(`spinLoop: ${meta.spinLoop}`);
  if (typeof meta.spinStep === 'number' && !Number.isNaN(meta.spinStep)) {
    lines.push(`spinStep: ${meta.spinStep}`);
  }

  // 呼び名
  const anyMeta = meta as any;
  const userProfile = anyMeta?.extra?.userProfile ?? anyMeta?.userProfile ?? null;

  const callName =
    typeof userProfile?.user_call_name === 'string'
      ? (userProfile.user_call_name as string).trim()
      : '';

  const styleBlock = buildStyleBlock(meta.style);

  const nameBlock = callName
    ? `
# ユーザーの呼び名
- 呼び名は「${callName}」として自然に扱う。
`.trim()
    : null;

  // meta が薄いなら SOUL + SYSTEM だけ
  if (lines.length === 0 && !styleBlock && !nameBlock) {
    return [IROS_SOUL_GUIDE, '', IROS_SYSTEM].join('\n');
  }

  return [
    '# iros meta',
    ...lines,
    '',
    ...(styleBlock ? [styleBlock, ''] : []),
    ...(nameBlock ? [nameBlock, ''] : []),
    IROS_SOUL_GUIDE,
    '',
    IROS_SYSTEM,
  ].join('\n');
}

/* ========= 互換用 SofiaTriggers / naturalClose（旧Sofia向け） ========= */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SofiaTriggers: any = {};

export function naturalClose(text: string): string {
  if (!text) return '';
  return text;
}

function buildStyleBlock(style?: IrosStyle | string | null): string | null {
  if (!style) return null;

  switch (style as IrosStyle) {
    case 'friendly':
      return `
# 口調スタイル（friendly）
- やわらかい丁寧語で、2〜3行ごとに改行。
- 共感は短く、言い切りを混ぜる（曖昧語で埋めない）。
- 🪔🌱🌀🌸 などは少しだけ。
`.trim();

    case 'biz-soft':
      return `
# 口調スタイル（biz-soft）
- 敬語ベースで、安心感も保つビジネス寄りのトーン。
- 感情語は控えめにしつつ、状況と打ち手を短く。
`.trim();

    case 'biz-formal':
      return `
# 口調スタイル（biz-formal）
- 会議メモとして引用可能な敬語。
- 背景/課題/示唆/方向性を端的に。
`.trim();

    case 'plain':
      return `
# 口調スタイル（plain）
- 装飾を抑えたフラットな丁寧語。
- 絵文字や比喩は最小限。
`.trim();

    default:
      return null;
  }
}
