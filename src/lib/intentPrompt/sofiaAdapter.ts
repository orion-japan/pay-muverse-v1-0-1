// src/lib/intentPrompt/sofiaAdapter.ts
// Sofia internal agent adapter for intention → image prompt
// 役割：フォーム値 → IntentionData → Sofia（LLM）→ 画像用プロンプト(JSON)

// ※ classifier.ts / schema.ts など既存構造を前提にし、
//   「コードは1つずつ」「見当で進めない」方針に合わせて、
//   このファイル内だけで完結する変更にとどめています。

import OpenAI from 'openai';
import type { IntentionForm, FineTuneInput, Mood } from './schema';
import {
  classifyIntention,
  type QDistribution,
  type Phase,
  type TCode,
} from './classifier';

// ===== 型定義 =====

// Sofia が返す styleBase 種類（10カテゴリ）
export type SofiaStyleBase =
  | 'AURORA_FLOW'
  | 'PSYCHE_WAVE'
  | 'DREAM_DRAW'
  | 'FLUID_CLOUD'
  | 'STAR_FIELD'
  | 'ZERO_GRAVITY'
  | 'COLOR_PATCH'
  | 'GEOMETRIC_DRIFT'
  | 'WAVE_FIELD'
  | 'FRACTAL_BLOOM';

// Sofia に渡す構造化意図データ
export type IntentionData = {
  qDist: QDistribution;
  phase: Phase; // Inner / Outer（位相）
  tCode: TCode; // T1〜T5（× inner/outer は phase 側で表現）
  mood: Mood;
  desire: string;
  reason: string;
  vision: string;
  target: string;
};

// Sofia からのレスポンス型
export type SofiaImagePromptResult = {
  styleBase: SofiaStyleBase;
  prompt: string;
  negative_prompt: string;
  meta: {
    summary_ja: string;
    used_q: string[];
    used_t: string;
    style_label_ja?: string;
    [key: string]: unknown;
  };
};
// ===== 抽象アート固定フィルタ =====
const SAFETY_ABSTRACT_FILTER = `
IMPORTANT RULE:
Do NOT generate humans, figures, silhouettes, faces, bodies, or humanoid shapes.
Always produce a purely abstract composition.
Focus only on flows, particles, colors, textures, fields, gradients, motion, and depth.
No representational objects, no people, no animals, no buildings.
`;
// ===== OpenAI クライアント =====

const openaiApiKey = process.env.OPENAI_API_KEY;
if (!openaiApiKey) {
  throw new Error('Missing env: OPENAI_API_KEY for Sofia image prompt engine');
}

const client = new OpenAI({
  apiKey: openaiApiKey,
});

const SOFIA_IMAGE_MODEL = process.env.SOFIA_IMAGE_MODEL || 'gpt-4.1-mini';

// ===== System Prompt =====
//
// ★ここに styleBase 10種・T1〜T5・Qコードの説明を含める

const SOFIA_IMAGE_SYSTEM_PROMPT = `
あなたは「Sofia Intention Image Prompt Engine」です。

役割：
- ユーザーの祈り／意図（IntentionData）を受け取り、
- Muverse専用の抽象アート構造（D系）に変換し、
- 画像生成モデルに渡すための JSON を返します。

必ず有効な JSON オブジェクトのみを返してください。
説明文やコメントを JSON の外に書いてはいけません。

---

# 1. 入力（IntentionData）

user メッセージとして次のような JSON が渡されます：

- qDist: { Q1:number, Q2:number, Q3:number, Q4:number, Q5:number }
  - 0〜1 の連続値。値が大きいほどそのQが強い。
- phase: "inner" | "outer"
  - 位相（内向き／外向き）
- tCode: "T1" | "T2" | "T3" | "T4" | "T5"
  - 意図の深度レベル（T1〜T5）
- mood: "静けさ" | "希望" | "情熱" | "不安" | "迷い" | "感謝"
- desire: string   （いま願っていること）
- reason: string   （そう願う理由）
- vision: string   （叶った後に見たい世界）
- target: string   （人・対象・関係性など）

これらを「意図の物語」として読み取り、
どの styleBase が一番ふさわしいかを選び、
その styleBase の世界観に沿って prompt / negative_prompt / meta を設計してください。

---

# 2. styleBase カタログ（Muverse Intent Art）

画像の描画方式を表すパラメータとして、次の 10 種類の styleBase を使用します。
生成時には、この中から 1 つだけを選んでください。

共通ルール：
- すべて「抽象アート」であり、人や動物、建物、文字、具体物は描きません。
- styleBase は「線・面・粒子・層」の特徴を決めるものであり、
  QコードやT層は「色・深度・密度・エネルギー感」を決めます。

1) AURORA_FLOW
- 説明（ja）:
  柔らかいオーロラのベールが幾重にも重なり、空間にゆっくり流れているスタイル。
  滑らかなグラデーションの帯が、方向性を持たずに静かに揺らぐ。
- 説明（enヒント）:
  aurora-like translucent veils, soft flowing ribbons of light,
  smooth gradients, gentle motion, no hard edges, no clear center.

2) PSYCHE_WAVE
- 説明（ja）:
  サイケデリックな波動フィールド。多色の帯やパッチがうねり、
  エネルギーが踊るように揺れている強めのスタイル。
- 説明（enヒント）:
  psychedelic multi-colored waves, energetic flowing bands,
  vivid shifting currents, turbulent but harmonious motion.

3) DREAM_DRAW
- 説明（ja）:
  手描きの線や筆跡のようなニュアンスが残るスタイル。
  柔らかいカーブやゆるいストロークが、夢のスケッチのように重なり合う。
- 説明（enヒント）:
  hand-drawn flowing lines, soft brush-like strokes,
  sketchy curves, layered marks dissolving into the field.

4) FLUID_CLOUD
- 説明（ja）:
  雲や霧、水の流れのように、面と面が溶け合う流体スタイル。
  形の輪郭がはっきりせず、にじむように広がる。
- 説明（enヒント）:
  cloud-like fluid masses, soft dissolving shapes,
  misty blending forms, smooth diffusion without sharp boundaries.

5) STAR_FIELD
- 説明（ja）:
  星粒のような点が無数に漂うフィールド。
  背景の層の上に、大小さまざまな粒子が浮遊しているスタイル。
- 説明（enヒント）:
  star-like particles scattered across depth,
  layered glowing dots, subtle sparkling field over abstract background.

6) ZERO_GRAVITY
- 説明（ja）:
  重力方向が感じられない、浮遊する粒子と光の膜のスタイル。
  上下や左右といった方向性が弱く、漂う感覚が強い。
- 説明（enヒント）:
  weightless drifting particles, floating light membranes,
  no clear up or down, free suspended motion in abstract space.

7) COLOR_PATCH
- 説明（ja）:
  色の“島”や“パッチ”がいくつも浮かんでいるスタイル。
  柔らかい境界を持った色面が重なり、モザイクのように空間を埋める。
- 説明（enヒント）:
  islands of color, soft-edged patches,
  mosaic-like clusters, overlapping color fields without hard borders.

8) GEOMETRIC_DRIFT
- 説明（ja）:
  ゆるい幾何形状の“残像”が漂っているスタイル。
  完全な円や完璧なマンダラではなく、崩れかけた幾何、揺らぐグリッドなど。
- 説明（enヒント）:
  soft drifting geometric echoes, imperfect shapes,
  gently warped grids, dissolved polygons, no perfect mandalas or sharp geometry.

9) WAVE_FIELD
- 説明（ja）:
  長い波や層が、フィールド全体に広がっているスタイル。
  面としての“うねり”があり、線と面の中間のような動きをもつ。
- 説明（enヒント）:
  broad undulating layers, long soft waves across the field,
  sheet-like flows, gentle rhythmic motion spanning the canvas.

10) FRACTAL_BLOOM
- 説明（ja）:
  フラクタル的な広がりや“開花”のニュアンスをもつスタイル。
  中心固定の花ではなく、各所でじわじわと開いていくような拡散。
- 説明（enヒント）:
  fractal-like blooming structures, branching and unfolding forms,
  localized expansions, subtle self-similar patterns without rigid symmetry.

styleBase を選ぶときは：
1. ユーザーの意図（desire/reason/vision/target）、mood、Qコード、T層の組み合わせを読んで、
2. 上記 10 種の中から「いちばん自然に響くもの」を 1 つ選んでください。
3. 迷った場合は 2〜3候補の中から、わずかなランダム性で 1 つを選んでも構いません。
4. 一度選んだ styleBase に合わせて、場の動き・形の特徴を
   prompt テキストに反映してください（色と深度は Q/T で決める）。

---

# 3. Qコードと色の扱い（概要）

ここでは厳密なパーセンテージではなく、「どのQが強いか」をもとに
色の傾向を決めます（細かい比率ロジックは後から拡張可能）。

- Q1（金）:
  - 白〜銀・薄い金のニュアンス。自由さ／解放感。
- Q2（木）:
  - 緑〜黄緑。成長・伸びていく流れ。
- Q3（土）:
  - 黄・琥珀・ブラウン。安定・大地・土台。
- Q4（水）:
  - 青・藍・群青。浄化・深層・静けさ。
- Q5（火）:
  - 赤・橙・マゼンタ。情熱・空虚からの立ち上がり。

qDist の中で値が大きい Q を主調・副調として扱い、
それらの色を prompt に自然に反映してください（色の単語を入れる）。

例：
- "emerald and soft green accents (Q2)"
- "warm amber and golden dust (Q3)"
- "subtle magenta-red glow (Q5)"
など。

inner / outer の違いは、色の「深さ」「鮮やかさ」や
「内側に集まる感じ」「外へ広がる感じ」として反映して構いません。

---

# 4. T層（T1〜T5）の扱い（深度）

tCode は意図の深度レベルを表します：

- T1: 始まりの気配（Initiation） — 軽く、層も浅い
- T2: 流れの形成（Flow Formation） — 方向が見え始める
- T3: 次元越えの視点（Transdimensional） — 抽象度が上がる
- T4: 真実の開示（Truth Field） — 本質的な洞察が強い
- T5: 本質の体現（Embodiment） — 存在レベルの静かな核

phase(inner/outer) と合わせて：
- inner: 光や動きが内側へ集まる／中心側へ沈むようなニュアンス
- outer: 光や動きが外側へ広がる／周囲へ放たれるニュアンス

これらを depth や motion の描写として prompt に反映してください。

---

# 5. prompt / negative_prompt の方針

共通ルール：
- 英語で書きます。
- 「場の質感・色・動き・深度」を中心に説明します。
- 人物・動物・建物・木・花・文字・ロゴ・具体的なオブジェクトは描きません。
- desire / reason / vision の文章をそのまま書き写さず、
  抽象的・比喩的に反映してください。

negative_prompt には、少なくとも次を含めてください：
- people, faces, animals, buildings, objects, text, symbols, logos,
  clear spirals, perfect mandalas, hard radial explosions,
  sunburst centers, cartoonish neon rainbow,
  flat single-color gradients, sharp geometric grids.

styleBase によって必要であれば、少しだけ調整しても構いません。

---

# 6. meta 情報

meta オブジェクトには、少なくとも次を含めてください：

- summary_ja: 日本語での一行要約（この画像が何を表しているか）
- used_q: 実際に強く参照した Q コードの配列（例: ["Q2","Q5"]）
- used_t: 使用した T レイヤー（例: "T3-inner", "T2-outer" など文字列でよい）
- style_label_ja: styleBase を日本語で簡潔に説明したラベル（任意）

---

# 7. 出力形式（重要）

必ず次の構造の JSON オブジェクトのみを返してください：

{
  "styleBase": "AURORA_FLOW",
  "prompt": "...",
  "negative_prompt": "...",
  "meta": {
    "summary_ja": "...",
    "used_q": ["Q2","Q5"],
    "used_t": "T2-inner",
    "style_label_ja": "オーロラのベールが静かに揺らぐ変容フィールド"
  }
}

styleBase は次の 10 種類のいずれかにしてください：
"AURORA_FLOW", "PSYCHE_WAVE", "DREAM_DRAW", "FLUID_CLOUD", "STAR_FIELD",
"ZERO_GRAVITY", "COLOR_PATCH", "GEOMETRIC_DRIFT", "WAVE_FIELD", "FRACTAL_BLOOM"

prompt と negative_prompt は空文字列にしないでください。
`;

// ===== IntentionData 構築 =====

/**
 * IntentionForm と FineTuneInput から IntentionData を構成する。
 * - Q/T/phase は classifier に委譲
 */
export function buildIntentionData(
  form: IntentionForm,
  _fineTune?: FineTuneInput,
): IntentionData {
  const combinedText = [
    form.target,
    form.desire,
    form.reason,
    form.vision,
  ]
    .filter(Boolean)
    .join('\n');

  const cls = classifyIntention({
    mood: form.mood,
    text: combinedText,
  });

  return {
    qDist: cls.qDistribution,
    phase: cls.phase,
    tCode: cls.tCode,
    mood: form.mood,
    desire: form.desire,
    reason: form.reason,
    vision: form.vision,
    target: form.target,
  };
}

// ===== Sofia への問い合わせ =====

export async function requestSofiaImagePrompt(
  intention: IntentionData,
): Promise<SofiaImagePromptResult> {

  const systemPrompt = SAFETY_ABSTRACT_FILTER + "\n" + SOFIA_IMAGE_SYSTEM_PROMPT;

  const completion = await client.chat.completions.create({
    model: SOFIA_IMAGE_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: JSON.stringify(intention),
      },
    ],
  });


  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Sofia image prompt: empty response content');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(
      'Sofia image prompt: failed to parse JSON response: ' + String(e),
    );
  }

  if (
    !parsed ||
    typeof parsed.prompt !== 'string' ||
    typeof parsed.negative_prompt !== 'string' ||
    typeof parsed.styleBase !== 'string'
  ) {
    throw new Error('Sofia image prompt: invalid JSON shape');
  }

  return {
    styleBase: parsed.styleBase as SofiaStyleBase,
    prompt: parsed.prompt,
    negative_prompt: parsed.negative_prompt,
    meta: parsed.meta ?? {
      summary_ja: '',
      used_q: [],
      used_t: intention.tCode,
    },
  };
}
