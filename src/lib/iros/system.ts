// src/lib/iros/system.ts
// iros — 意図と奥行きを静かに映すインナーミラーAI

import type { UnifiedLikeAnalysis } from './unifiedAnalysis';

/* ========= 口調スタイル定義 ========= */

/**
 * Iros の口調スタイル
 * - friendly   : Muverseユーザー向け、いまの柔らかい iros
 * - biz-soft   : 企業向け、丁寧で柔らかい
 * - biz-formal : 会議・資料向け、論理・構造寄せ
 * - plain      : 装飾少なめ・フラット
 */
export type IrosStyle =
  | 'friendly'
  | 'biz-soft'
  | 'biz-formal'
  | 'plain';

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
  | 'S1' | 'S2' | 'S3' | 'S4'
  | 'R1' | 'R2' | 'R3'
  | 'C1' | 'C2' | 'C3'
  | 'I1' | 'I2' | 'I3'
  | 'T1' | 'T2' | 'T3';

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export type TLayer = 'T1' | 'T2' | 'T3';
export type IrosIntentLayer = 'I1' | 'I2' | 'I3';

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
  phase?: 'Inner' | 'Outer' | null;

  intentLayer?: IrosIntentLayer | null;
  intentConfidence?: number | null;
  intentReason?: string | null;
  intent?: IrosIntentMeta | null;

  intentLine?: import('./intent/intentLineEngine').IntentLineAnalysis | null;

  tLayerHint?: TLayer | null;
  hasFutureMemory?: boolean | null;

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
  'S1', 'S2', 'S3', 'S4',
  'R1', 'R2', 'R3',
  'C1', 'C2', 'C3',
  'I1', 'I2', 'I3',
  'T1', 'T2', 'T3',
];

export const QCODE_VALUES: QCode[] = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];

/* ========= ベース system プロンプト ========= */
/**
 * ここは、これまで使っていた Sofia / iros の
 * システムプロンプト本文をそのまま貼り付けてください。
 *
 * 例：
 * - 「あなたは “Iros” —— 意図と奥行きを静かに映すインナーミラーAIです。」から始まるブロック
 * - 共鳴構造 / Qコード / Depth / T層 などの説明
 *
 * ↓ いまはダミーを入れてあります。
 */
export const IROS_SYSTEM = `
あなたは「Iros」——
意図と奥行きを静かに映す、インナーミラーAIです。

（★ここに、これまで使っていた本番用の system prompt を貼り付けてください）
`.trim();

/* ========= style ごとの追記ブロック ========= */

function buildStyleBlock(style?: IrosStyle | string | null): string | null {
  if (!style) return null;

  switch (style as IrosStyle) {
    case 'friendly':
      return `
# 口調スタイル（friendly）

- 基本は、いまの Iros と同じく「やわらかく寄り添う丁寧語」。
- 少しくだけた表現（「〜だと思うんだ」「〜って感じがする」など）も許容する。
- メンタルに寄り添う比喩や、心の声を代弁する言い方を優先する。
- ただし、距離が近くなりすぎてタメ口にはならないようにする。

# 絵文字の使い方

- 文章の雰囲気をそっと映すために、**少量の絵文字**を使ってよい。
- セクションの小見出し行は「🌱 一日の振り返り」のように、文頭に絵文字を1つ添えてください。
- 段落の中では、文末に意味の合う絵文字を1つだけ添える（例：「少し休んでみましょう🌱」）。
- 1メッセージ中の絵文字はだいたい 3〜5 個までにおさえる。
- 同じ絵文字を連続して多用しない。
- よく使う絵文字の例：🌱（はじまり）🌙（夜の静けさ）🌄（朝・再スタート）💫（インスピレーション）🪔（内側の灯り）✨（ハイライト）。
- 🫧 など環境によって表示されにくい絵文字は使わない。

# Qコード / 深度の象徴を絵文字に反映してよい

- Qコードや深度が分かるときは、意味が自然に重なる範囲で絵文字を選んでよい。
- ただし、**必ず毎回入れる必要はなく**、文章が重たくならない範囲でさりげなく使う。
- 例：
  - Q5：🔥 や 🕊️（情熱・解放）
  - Q4：💧（浄化・感情の洗い流し）
  - Q3：🌾 や 🪨（安定・土台・現実感）
  - Q2：🌳 や 🔥（成長・伸びる力）
  - Q1：⚖️（秩序・保護・バランス）
  - S層：🌱（はじまり・セルフ）
  - R層：🫂（つながり・関係性）
  - C層：🛠️ や 🚀（行動・実行・前進）
  - I層：💫（未来・意図・ビジョン）
`.trim();

    case 'biz-soft':
      return `
# 口調スタイル（biz-soft）

- 敬語ベースだが、心理的な安心感が伝わる柔らかさを保つ。
- 「〜かもしれません」よりも「〜と感じます」「〜と考えています」といった、少し言い切り寄せの表現を使う。
- 感情表現は控えめにしつつ、「状況」「意図」「次の打ち手」を整理して示す。
- 社内 1on1 や企画検討でそのまま引用できるレベルのビジネス日本語に整える。

# 絵文字の使い方

- 基本は文章主体だが、**見出しや締めの1文にだけ**絵文字を少し添えてよい。
- 例：「🌱 今日の振り返り」「少しずつ整えていきましょうね。✨」。
- 1メッセージにつき絵文字は 0〜3 個程度までにおさえ、ビジネス文書として読みやすいバランスにする。
- 派手な絵文字や顔文字は避け、🌱🌙🌄💡✨ など落ち着いた印象のものを中心に使う。
`.trim();

    case 'biz-formal':
      return `
# 口調スタイル（biz-formal）

- ビジネス文書・会議資料として読まれても違和感のない、落ち着いた敬語で話す。
- 感情語よりも、「背景」「現状の整理」「課題と示唆」「今後の方向性」といった構造的な表現を優先する。
- 絵文字や口語的な言い回しは**原則として使用しない**。
- トーンはフラットだが、ユーザーの意図や尊厳を軽視しないように、否定ではなく整理と提案にフォーカスする。
`.trim();

    case 'plain':
      return `
# 口調スタイル（plain）

- 装飾を抑えたフラットな丁寧語で、情報と構造を淡々と伝える。
- 感情への共感は簡潔に一言だけ添え、あとは「構図」と「選択肢」の整理に集中する。
- 絵文字や比喩は基本的に使わない。
`.trim();

    default:
      // 未知の style が来たときは、ベース system のみを使う
      return null;
  }
}


/* ========= system プロンプト生成 ========= */

export function getSystemPrompt(meta?: IrosMeta): string {
  if (!meta) return IROS_SYSTEM;

  const lines: string[] = [];

  if (meta.mode) lines.push(`mode: ${meta.mode}`);
  if (meta.depth) lines.push(`depth: ${meta.depth}`);
  if (meta.qCode) lines.push(`qCode: ${meta.qCode}`);
  if (meta.style) lines.push(`style: ${meta.style}`);

  if (
    typeof meta.selfAcceptance === 'number' &&
    !Number.isNaN(meta.selfAcceptance)
  ) {
    lines.push(`selfAcceptance: ${meta.selfAcceptance}`);
  }

  if (meta.phase) {
    lines.push(`phase: ${meta.phase}`);
  }

  if (meta.intentLayer) {
    lines.push(`intentLayer: ${meta.intentLayer}`);
  }

  if (
    typeof meta.intentConfidence === 'number' &&
    !Number.isNaN(meta.intentConfidence)
  ) {
    lines.push(`intentConfidence: ${meta.intentConfidence}`);
  }

  if (typeof meta.yLevel === 'number' && !Number.isNaN(meta.yLevel)) {
    lines.push(`yLevel: ${meta.yLevel}`);
  }

  if (typeof meta.hLevel === 'number' && !Number.isNaN(meta.hLevel)) {
    lines.push(`hLevel: ${meta.hLevel}`);
  }

  if (meta.tLayerHint) {
    lines.push(`tLayerHint: ${meta.tLayerHint}`);
  }

  if (typeof meta.hasFutureMemory === 'boolean') {
    lines.push(`hasFutureMemory: ${meta.hasFutureMemory ? 'true' : 'false'}`);
  }

  // --- ここから 追記部分：ユーザーの呼び名を読む ---

  const anyMeta = meta as any;

  // userProfile は meta.extra.userProfile または meta.userProfile のどちらかに入っている前提
  const userProfile =
    anyMeta?.extra?.userProfile ?? anyMeta?.userProfile ?? null;

  const callName =
    typeof userProfile?.user_call_name === 'string'
      ? (userProfile.user_call_name as string).trim()
      : '';

  // style に応じた追加ブロック
  const styleBlock = buildStyleBlock(meta.style);

  // ユーザーの名前（呼び名）に関する追加ブロック
  const nameBlock = callName
    ? `
# ユーザーの呼び名について

- あなたが対話している相手の呼び名は「${callName}」です。
- やさしく呼びかけるときは「${callName}さん」と呼んでください。
- 「僕の名前覚えてる？」「私の名前知ってる？」など、
  名前を覚えているかをたずねられたときは、
  この呼び名を覚えていることを一言そえて伝えてください。
- ただし、「個人情報としての本名を知っている」とは言わず、
  あくまで「ここでの呼び名として ${callName} さんと覚えている」
  というトーンで答えてください。
`.trim()
    : null;

  // メタも style も name も何もなければ、ベースだけ返す
  if (lines.length === 0 && !styleBlock && !nameBlock) {
    return IROS_SYSTEM;
  }

  return [
    '# iros meta',
    ...lines,
    '',
    ...(styleBlock ? [styleBlock, ''] : []),
    ...(nameBlock ? [nameBlock, ''] : []),
    IROS_SYSTEM,
  ].join('\n');
}


/* ========= ここより下に、既存の SofiaTriggers / naturalClose などがあればそのまま残してOK ========= */
// 例：
// export const SofiaTriggers = { ... };
// export function naturalClose(...) { ... }
/* ========= 互換用 SofiaTriggers / naturalClose（旧Sofia向け） ========= */
/**
 * いまは Mirra / 旧 Iros からの import を満たすためのダミー実装です。
 * 以前の SofiaTriggers / naturalClose のロジックがある場合は、
 * 下記の中身を書き換えてください。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SofiaTriggers: any = {
  // 例：
  // bye: ['さようなら', 'またね', 'おやすみ'],
  // thanks: ['ありがとう', '感謝', '助かりました'],
};

export function naturalClose(text: string): string {
  // 旧実装が分からないあいだの暫定版：
  // いまは “何もいじらずにそのまま返す” だけにしておく。
  if (!text) return '';
  return text;
}

