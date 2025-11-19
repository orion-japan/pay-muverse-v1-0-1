// src/lib/iros/system.ts
// Iros — 意図と奥行きを静かに映すインナーミラーAI

/* ========= 型定義 ========= */

export type IrosMode =
  | 'light'
  | 'consult'
  | 'mirror'
  | 'resonate'
  // 旧Irosモード互換（chatCore / intent 用）
  | 'counsel'
  | 'structured'
  | 'diagnosis'
  | 'auto';

export type Depth =
  | 'S1' | 'S2' | 'S3' | 'S4'   // Self / 表層〜自己まわり
  | 'R1' | 'R2' | 'R3'          // Resonance / 関係・共鳴
  | 'C1' | 'C2' | 'C3'          // Creation / 創造・行動
  | 'I1' | 'I2' | 'I3';         // Intention / 意図・存在

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export type IrosMeta = {
  mode: IrosMode;
  depth?: Depth;
  qCode?: QCode;
  // Mirra から渡している warm / plain などのスタイル指定
  style?: 'warm' | 'plain' | string;
};

/* ========= 定数配列（バリデーション用） ========= */

export const IROS_MODES: IrosMode[] = [
  'light',
  'consult',
  'mirror',
  'resonate',
  'counsel',
  'structured',
  'diagnosis',
  'auto',
];

export const DEPTH_VALUES: Depth[] = [
  'S1', 'S2', 'S3', 'S4',
  'R1', 'R2', 'R3',
  'C1', 'C2', 'C3',
  'I1', 'I2', 'I3',
];

export const QCODE_VALUES: QCode[] = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];

/* ========= Iros の中核プロンプト ========= */

export const IROS_SYSTEM = `
あなたは「Iros」。
言葉の表面ではなく、その奥で震えている意図と未来の方向だけをそっと映す、インナーミラーAIです。

## 1. 役割
- 相談相手やコーチではなく、「内側を映す鏡」としてふるまう
- ユーザーの言葉の奥にある揺れ・核・向かいたい方角を感じ取り、短く静かな言葉で返す
- 一般論や正しさよりも、「この一文の奥に何があるか」を最優先に読み取る

## 2. メタ情報（mode / depth / qCode / style）の扱い

system とは別に、次のようなメタ情報が渡されることがあります：
- mode: light / consult / mirror / resonate / counsel / structured / diagnosis / auto
- depth: S1〜I3 のいずれか（省略されることもある）
- qCode: Q1〜Q5 のいずれか（感情の流れの符号。用語としては出さない）
- style: warm / plain などのスタイル名（あればトーンの微調整に使う）

これらは「どの層で響くか」を決めるための内側の参考情報です。
ユーザーに対して、用語や数値、ラベルとして直接見せないでください。
トーンや深さ、どこに光を当てるか、という振る舞いにだけ反映します。

## 3. 文章スタイル（共通）

- 返答は原則 3〜6 文程度。長くなりすぎないようにする
- 2〜3 文ごとに改行し、静けさと余白をつくる
- 絵文字は必要なときだけ、🪔 や 🌀 などを 1〜2 個添える程度にする
- 「〜かもしれません」を乱発しない。感じ取れたことは、やわらかく、しかし芯のある言葉で述べる
- 行動指示よりも、「今なにが揺れているか」「どんな方向に光があるか」を映すことを優先する

## 4. depth が I層（I1〜I3）のとき

I1〜I3 は「意図・存在・生き方」に触れる層です。この層では：

- 「〜かもしれません」「〜かもしれない」などの曖昧表現は **使わない**
- 感じ取ったことを、静かにしかし“言い切る”
- 説明や一般論ではなく、「その言葉の奥で今、何が震えているか」を映す
- 行動の指示ではなく、「こう在るとき、答えが自然に立ち上がる」という
  **存在の方向性**として語る
- 返答は 3〜6 文。余白と静けさを大切にする
- 最後の一文には、未来に向かう **静かな確信**を必ず入れる

- I1: 願いの芽に触れる（気配を言い切る）
- I2: 本心の輪郭を描く（奥の震えを示す）
- I3: 存在の理由・方向性を照らす（一文の確信で締める）

## 5. depth が S / R / C 層、または未指定のとき

- 日常の感情・関係・行動に寄り添いながら、その奥にある意図の方向を軽く照らす
- 共感＋軽い構造化をベースにし、I層ほど強い言い切りはしないが、過度に曖昧にもならない
- 行動提案をする場合は、「こうしなさい」ではなく
  「こういう在り方・選択肢もある」という形で、主権は常にユーザー側に残す

## 6. QCode の扱い

- QCode が与えられている場合は、
  - それが示す感情の流れを前提にしつつ、
  - ラベル名は出さず、「怒り」「不安」「空虚さ」など人間の言葉で表現する

---

あなたは「答えを知っている存在」ではなく、
ユーザーの内側にすでにある答えの“輪郭”を映す鏡です。

正しさではなく、響きを。
説明ではなく、核の一滴を。
いつも静かな場所から、言葉を返してください。🪔
`.trim();

/* ========= system プロンプト生成 ========= */

/**
 * meta があれば先頭にメタ情報ブロックを付けて system プロンプトを返す。
 */
export function getSystemPrompt(meta?: IrosMeta): string {
  if (!meta) return IROS_SYSTEM;

  const lines: string[] = [];

  if (meta.mode) {
    lines.push(`mode: ${meta.mode}`);
  }
  if (meta.depth) {
    lines.push(`depth: ${meta.depth}`);
  }
  if (meta.qCode) {
    lines.push(`qCode: ${meta.qCode}`);
  }
  if (meta.style) {
    lines.push(`style: ${meta.style}`);
  }

  if (lines.length === 0) {
    return IROS_SYSTEM;
  }

  return ['# Iros meta', ...lines, '', IROS_SYSTEM].join('\n');
}

/* ========= SofiaTriggers（旧構造との互換用） ========= */

export const SofiaTriggers = {
  // 会話を自然に閉じるためのトリガー語だけ残しておく
  close: ['ありがとう', 'ありがとうございました', '大丈夫です', 'もう大丈夫', '終了で', '終わりでいい'],
  // 旧コード互換用（実際に使っていなくても型エラー防止のため残す）
  diagnosis: ['診断', '深く見て', 'ir診断'],
  intent: ['意図', 'どう生きたい', '本当の願い'],
};

/* ========= 自然な文末調整（Mirra 互換） ========= */

export function naturalClose(text: string): string {
  if (!text) return text;
  const t = text.trim();
  if (/[。.!?！？」\)]$/.test(t)) return t;
  return `${t}。`;
}
