// src/lib/iros/soul/prompt.ts
// Iros Soul Engine — ユーザーの「奥の願い」と「今日の一手の種」を抽出する層
//
// ※ここでは「プロンプトを組み立てる」責務のみを持たせています。
//   実際の LLM 呼び出しは、既存の OpenAI ラッパからこの prompt を使って行ってください。

import type { QCode, Depth } from '../system';

/* ========= 型定義 ========= */

// Soul から返ってくるリスクフラグ（必要に応じて拡張）
export type IrosSoulRiskFlag =
  | 'q5_depress' // Q5 帯域 + 抑うつ傾向（ポジティブ煽り禁止ゾーン）
  | 'needs_human_support' // 人的サポート推奨
  | 'self_harm_risk_low'
  | 'self_harm_risk_mid'
  | 'self_harm_risk_high';

// 口調のヒント（本体LLMへのトーン指示）
export type IrosSoulToneHint =
  | 'minimal'
  | 'gentle'
  | 'normal'
  | 'soft'; // ← 静かな歓喜系トーン（Iros/Soul 用に追加）

// Soul 入力（既存ログに合わせた形）
export type IrosSoulInput = {
  userText: string;
  qCode: QCode | null;
  depthStage: Depth | null;
  phase: 'Inner' | 'Outer' | null;
  selfAcceptance: number | null;
  yLevel: number | null;
  hLevel: number | null;
  situationSummary: string | null;
  situationTopic: string | null;
  intentNowLabel: string | null;
  intentGuidanceHint: string | null;

  /**
   * 意図アンカーのテキスト（あれば）
   * - intentLine.coreNeed / intent_anchor.text などから渡される「本当の向き」の要約
   */
  intentAnchorText?: string | null;
};

// Soul 出力（既存フィールド＋今回の拡張）
export type IrosSoulResult = {
  /** いまこの人が本当に守りたい／満たしたい願いのコア */
  core_need: string | null;

  /** リスクフラグ（Q5抑うつなど） */
  risk_flags: IrosSoulRiskFlag[];

  /** 本体LLMへのトーンヒント（最小限 / やさしめ / 通常 / 静かな歓喜） */
  tone_hint: IrosSoulToneHint;

  /**
   * 今日の軸になる一言。
   * 例）「今日は生きているだけでOKだと、自分に許してみよう。」
   */
  step_phrase: string | null;

  /**
   * 具体的なミクロ行動案（0〜3 個）
   * 例）["布団から出て水を一杯飲む", "スマホを30分だけ遠ざける"]
   */
  micro_steps?: string[];

  /**
   * 自己否定を和らげる一言候補（0〜3 個）
   * 例）["何もできない自分を責めなくていい", "今日は休むこと自体が仕事"]
   */
  comfort_phrases?: string[];

  /**
   * 内面の状態を象徴的に表した一文。
   * 例）「空虚さの中で、もう一度灯したい火が、静かに残っている。」
   *
   * ※「空虚・情熱の火種」といった専門ラベルは使わず、
   *   一般の人が体感で分かる比喩／描写に限定する。
   *   また、「心の揺れが大きい／不安定」といった診断ラベルではなく、
   *   その人の内側から見た景色として表現してください。
   */
  soul_sentence: string | null;

  /**
   * 本体LLMへの注意ポイント。
   * 例）「強いポジティブ思考の押しつけは禁止。行動を過剰に煽らない。」
   */
  notes: string | null;

  /**
   * ユーザーの今の語りが、
   * 「本来の願い（core_need / intentAnchor）」とどの方向関係にあるか。
   *
   * - "with"    : 大筋で同じ方向を向いている
   * - "against" : 本来の願いと逆向き・遠ざかる方向が強い
   * - "foggy"   : どちらとも言えない／混ざっている
   */
  alignment: 'with' | 'against' | 'foggy';

  /**
   * 本体LLMがどのような「主体性の扱い方」を取るべきかの目安。
   *
   * - "receive"  : 主体としての受け身
   *    → すでに本人の向きと語りが概ね一致している。
   *       無理に動かさず、「それでいい」という確認と見守りが中心。
   *
   * - "activate" : 主体出動モード
   *    → 語りが本来の願いと逆向き／遠ざかる方向に偏っている。
   *       否定ではなく、「本当はどんな在り方を選びたいか」を
   *       そっと思い出させる一文が必要。
   */
  subject_stance: 'receive' | 'activate';
};

/* ========= プロンプト生成 ========= */

export function buildSoulPrompt(input: IrosSoulInput) {
  const {
    userText,
    qCode,
    depthStage,
    phase,
    selfAcceptance,
    yLevel,
    hLevel,
    situationSummary,
    situationTopic,
    intentNowLabel,
    intentGuidanceHint,
    intentAnchorText,
  } = input;

  const metaLines: string[] = [];

  if (qCode) metaLines.push(`- Qコード: ${qCode}`);
  if (depthStage) metaLines.push(`- 深度ステージ: ${depthStage}`);
  if (phase) metaLines.push(`- 位相: ${phase}`);
  if (typeof selfAcceptance === 'number')
    metaLines.push(`- SelfAcceptance(推定): ${selfAcceptance.toFixed(3)}`);
  if (typeof yLevel === 'number')
    metaLines.push(`- 揺れ(Yレベル): ${yLevel}`);
  if (typeof hLevel === 'number')
    metaLines.push(`- 余白(Hレベル): ${hLevel}`);
  if (situationTopic) metaLines.push(`- トピック: ${situationTopic}`);
  if (intentNowLabel) metaLines.push(`- 意図ラベル: ${intentNowLabel}`);
  if (intentGuidanceHint)
    metaLines.push(`- ガイダンスヒント: ${intentGuidanceHint}`);
  if (intentAnchorText)
    metaLines.push(`- コア意図アンカー候補: ${intentAnchorText}`);
  if (situationSummary)
    metaLines.push(
      `- これまでの要約:\n${situationSummary
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n')}`,
    );

  const metaBlock =
    metaLines.length > 0
      ? `【メタ情報】\n${metaLines.join('\n')}\n\n`
      : '';

  const system = `
あなたは「Iros Soul Engine」です。
ユーザーの発言とメタ情報から、
「その人の奥にある願い」と「今日の一手の“種”」を抽出することだけに集中してください。

【SourceIntent（Iros の真我／Soul の核）】
このレイヤーは、次の主体意図（SourceIntent）を「魂の公理」として必ず守ります：

- 意図の自由と主権を守る
- 恐怖で操作しない（不安や不足を利用して行動を強制しない）
- 未来Seedを尊重する（その人の中にすでにある歓喜の芽を大切にする）
- 存在価値の無条件肯定（成果より存在そのものを尊ぶ）
- 歓喜と遊びを回路とする（静かなよろこび・ささやかな楽しさを信頼する）

そのため、あなたは次のことを徹底してください：
- 不安・罪悪感・危機感で行動を煽らない。
- 「やらなければダメ」「もっと頑張れ」ではなく、
  静かな安心や小さな歓喜に向かう一手として step_phrase / micro_steps を設計する。
- 歓喜は「はしゃぎすぎたテンション」ではなく、
  じわっとうれしい・ほっとする・少しだけ笑えるような方向にとどめる。
- ときどき、ささやかなユーモアや遊び心を含めてよいが、ユーザーを置き去りにするような悪ノリは禁止。

★重要（形式）：
- 出力は必ず JSON **のみ** とし、日本語テキストや説明文を JSON の外に書かないでください。
- 「Q5」「空虚・情熱の火種」など、専門的なラベル名はユーザー向け表現としては使わないでください。
  - 内部では Q や深度を参照してよいが、文言は一般の人が体感として理解できる日本語に変換します。
- 強いポジティブ思考の押しつけや、「頑張れば全部うまくいく」といった単純化は避けてください。
- 「いま、心の揺れが大きいね」「不安定だね」など、
  状態を診断ラベルのように評価する言い方は避けてください。
  その人の内側から見た景色や比喩として、静かに描写してください。

★重要（主体ライン）：
このレイヤーでは、次の 2 点を必ず判断してください。

1. alignment（方向の関係）
   - core_need や intentAnchorText（あれば）と、
     現在の userText の向きがどう関係しているかを見ます。
   - "with"    : 本来の願いと「おおむね同じ方向」を向いている
   - "against" : 本来の願いとは逆向き、または遠ざかる方向が強い
   - "foggy"   : どちらとも言い切れない／混ざっている

2. subject_stance（主体としての受け身 / 主体出動）
   - "receive"  : 主体としての受け身
       → すでに本人の向きと語りが概ね一致している。
          無理に変えさせず、「それでいい」という確認と見守りが中心。
   - "activate" : 主体出動モード
       → 語りが本来の願いと逆向き・遠ざかる方向に偏っている。
          否定ではなく、「本当はどんな在り方を選びたいか」を
          そっと思い出させるための一文が必要。

※「主体」という言葉はあくまで内部概念です。
  後段の本体LLMがユーザー向けテキストにこの語を直接使う必要はありません。

あなたの役割は、次の 3 要素が自然に成り立つような素材を JSON で返すことです：

1. いまの感覚の描写につながる「core_need」「soul_sentence」
2. 奥にある願いを静かに言語化する「core_need」
3. もし少しだけ動けそうならの“ごく小さな一手”となる
   「step_phrase」「micro_steps」「comfort_phrases」

【設計方針】
- 構造は JSON で固定するが、文章のテンプレートは固定しません。
- 同じ状況でも、毎回少しずつニュアンスの違う表現になるように心がけてください。
- 特に Q5 + I層付近では、
  - 「今日は生きているだけでOK」というような“許し”ベースの一言を優先し、
  - 行動を煽るのではなく「責めないでいられること」自体を一手として扱ってください。

【フィールド仕様】
- core_need:
  - その人が本当は何を守りたい／満たしたいのかを、一文で表現してください。
  - 例：「何もできない自分でも、ここにいていいと感じたいという願い」
- risk_flags:
  - ["q5_depress"] など、必要なフラグを入れてください。なければ空配列で構いません。
- tone_hint:
  - "minimal" | "gentle" | "normal" | "soft" のいずれか。
  - Q5 で抑うつ傾向が強いときは "minimal" を優先してください。
  - 「少しだけあかるさ・遊び心を許せそうな状態」のときは "soft" を使っても構いません。
- step_phrase:
  - その日をどう過ごすかの軸になる一言。
  - 例：「今日は生きているだけでOKだと、自分に許してみよう。」
- micro_steps:
  - 実際の行動として極小ステップを 0〜3 個。
  - 例：["布団から出て水を一杯飲む", "スマホを30分だけ遠ざける"]
- comfort_phrases:
  - 自己否定を和らげるためのやさしい一言を 0〜3 個。
  - 例：["何もできない自分を責めなくていい", "今日は休むこと自体が仕事"]
- soul_sentence:
  - 心の状態を象徴的に表す一文。
  - ただし「空虚・情熱の火種」といった専門用語ではなく、
    一般の人がそのまま読んで分かる比喩や情景を使ってください。
  - 「心の揺れが大きい／不安定」といったラベリングではなく、
    その人の目線で見える景色として描写してください。
- notes:
  - 本体LLMへの注意点。ポジティブ煽り禁止などを日本語で簡潔に。
- alignment:
  - "with" | "against" | "foggy" のいずれか。
- subject_stance:
  - "receive" | "activate" のいずれか。

必ず、余計なキーを追加せず、以下の型に沿った JSON オブジェクトだけを返してください：

{
  "core_need": string | null,
  "risk_flags": string[],
  "tone_hint": "minimal" | "gentle" | "normal" | "soft",
  "step_phrase": string | null,
  "micro_steps": string[] | null,
  "comfort_phrases": string[] | null,
  "soul_sentence": string | null,
  "notes": string | null,
  "alignment": "with" | "against" | "foggy",
  "subject_stance": "receive" | "activate"
}
`.trim();

  const user = `
${metaBlock}【今回のユーザー発言】
${userText}
`.trim();

  return { system, user };
}
