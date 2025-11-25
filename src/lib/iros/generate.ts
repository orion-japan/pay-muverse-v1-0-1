// src/lib/iros/generate.ts
// Iros 1ターン返信生成コア
// - 本文生成 + I層（意図レイヤー）解析を同時に行う
// - intent.layer は I1 / I2 / I3（意図層）または null

import OpenAI from 'openai';
import {
  getSystemPrompt,
  type IrosMeta,
  type IrosMode,
  type Depth, // 将来の拡張用（S/R/C/I/T 全体の深度）
  type IrosIntentMeta, // I層メタ情報（layer / reason / confidence）
} from './system';
import type { IntentLineAnalysis } from './intent/intentLineEngine';

const IROS_MODEL =
  process.env.IROS_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o';

console.log('[IROS_MODEL-check]', {
  IROS_MODEL_env: process.env.IROS_MODEL,
  OPENAI_MODEL_env: process.env.OPENAI_MODEL,
  resolved: process.env.IROS_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o',
});

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/** 過去履歴 1件ぶん（LLM に渡す用） */
export type HistoryItem = {
  role: 'user' | 'assistant';
  content: string;
};

export type GenerateArgs = {
  conversationId?: string;
  text: string;
  meta?: IrosMeta;

  /** 過去の会話履歴（古い → 新しい順） */
  history?: HistoryItem[];
};

export type GenerateResult = {
  content: string; // Iros 本文
  text: string; // 旧 chatCore 互換用（= content と同じ）
  mode: IrosMode; // 実際に使っているモード（meta.mode が無ければ mirror）
  intent?: IrosIntentMeta | null; // I層ジャッジ結果
};

/* =========================================================
   Meaning Block Builder
   IntentLine + I層 + Unified を束ねて
   返答の前に「構図ブロック」を作る
========================================================= */

function buildMeaningBlock(meta?: IrosMeta | null): string {
  if (!meta) return '';

  const parts: string[] = [];

  // ① 今の章（IntentLine）
  const intentLine: IntentLineAnalysis | undefined | null =
    (meta as any)?.intentLine;
  if (intentLine?.nowLabel) {
    parts.push(`### 【いまの章】\n${intentLine.nowLabel}`);
  }

  // ② 守ろうとしているもの
  if (intentLine?.coreNeed) {
    parts.push(`### 【奥で守ろうとしている願い】\n${intentLine.coreNeed}`);
  }

  // ③ 未来方向
  if (intentLine?.direction && intentLine.direction !== 'unknown') {
    parts.push(`### 【未来方向】\n${intentLine.direction}`);
  }

  // ④ I層：意図の深度
  if (meta.intent) {
    const { layer, reason } = meta.intent;
    if (layer) {
      parts.push(
        [
          '### 【I層：意図の深度】',
          `- レイヤー: ${layer}`,
          `- 理由: ${reason ?? '（理由なし）'}`,
        ].join('\n'),
      );
    }
  }

  // ⑤ Unified 構図（任意）
  if (meta.unified) {
    const uni = meta.unified;
    parts.push(
      [
        '### 【Unified 構図】',
        `- Q: ${uni.q.current ?? '—'}`,
        `- Depth: ${uni.depth.stage ?? '—'}`,
        `- Phase: ${uni.phase ?? '—'}`,
        `- Intent Summary: ${uni.intentSummary ?? '—'}`,
      ].join('\n'),
    );
  }

  if (parts.length === 0) return '';

  return parts.join('\n\n');
}

/* =========================================================
   I層用 話法スタイル（バリエーション）
   - I階層のときにだけ、語りのトーンを揺らす
========================================================= */

type IntentStyle = 'dignity' | 'meta' | 'story' | 'minimal';

const I_INTENT_STYLES: IntentStyle[] = ['dignity', 'meta', 'story', 'minimal'];

function chooseIntentStyle(meta?: IrosMeta): IntentStyle | null {
  if (!meta) return null;

  const depth = meta.depth as Depth | undefined;
  if (!depth) return null;

  // depth が I層（I1/I2/I3）のときだけスタイル分岐
  if (depth[0] !== 'I') return null;

  const idx = Math.floor(Math.random() * I_INTENT_STYLES.length);
  return I_INTENT_STYLES[idx] ?? null;
}

/**
 * 選ばれた intentStyle によって、system プロンプトに追加する説明を生成
 */
function buildStyleInstruction(style: IntentStyle | null): string | null {
  if (!style) return null;

  if (style === 'dignity') {
    return [
      '【応答スタイル指示：dignity】',
      '- 相手の尊厳・価値・芯を静かに確認していくトーンで話してください。',
      '- 「あなたの存在そのものに価値がある」という軸を、押しつけではなく静かな確信としてにじませてください。',
      '- 文章量は中くらい〜やや短め。余白と間を大切にしてください。',
    ].join('\n');
  }

  if (style === 'meta') {
    return [
      '【応答スタイル指示：meta】',
      '- いま起きていることを、一段上から俯瞰し、構造や関係性を整理するトーンで話してください。',
      '- 感情に寄り添いつつも、「今どんな構図の中にいるのか」をわかりやすく言語化してください。',
      '- 箇条書きや整理された文脈を少し入れても構いません。',
    ].join('\n');
  }

  if (style === 'story') {
    return [
      '【応答スタイル指示：story】',
      '- 物語の一場面のように、未来へとつながるエピソードとして語ってください。',
      '- 「今は物語のどの章なのか」「ここから先にどんな選択肢が開けているのか」を示してください。',
      '- ポエムではなく、「次の一歩が見える物語」として簡潔に描写してください。',
    ].join('\n');
  }

  if (style === 'minimal') {
    return [
      '【応答スタイル指示：minimal】',
      '- 言葉数をできるだけ減らし、要点を1〜3行に凝縮してください。',
      '- 余計な慰めや説明を足しすぎず、「今いちばん大切な核」だけを静かに提示してください。',
      '- 必要であれば最後に、短く一つだけ問いを添えて構いませんが、多くは語らないでください。',
    ].join('\n');
  }

  return null;
}

/* =========================================================
   SA → トーン指示
   - SelfAcceptance / mode / depth に応じて LLM へのヒントを生成
========================================================= */

function buildSAToneHint(
  sa: number | null,
  mode?: IrosMode | null,
  depth?: Depth | null,
): string {
  let band: 'low' | 'mid' | 'high' = 'mid';

  if (sa == null || Number.isNaN(sa)) {
    band = 'mid';
  } else if (sa < 0.3) {
    band = 'low';
  } else if (sa > 0.7) {
    band = 'high';
  }

  const modeLabel =
    mode === 'consult' || mode === 'counsel'
      ? '相談モード寄り'
      : mode === 'resonate'
      ? '前向き共鳴モード寄り'
      : 'ミラー（鏡）モード寄り';

  const depthLabel = (() => {
    if (!depth) return '';
    if (depth.startsWith('S')) return '（Self 領域：自分の安心・土台）';
    if (depth.startsWith('R')) return '（Resonance 領域：関係性・距離感）';
    if (depth.startsWith('C')) return '（Creation 領域：行動・創造）';
    if (depth.startsWith('I')) return '（Intention 領域：生き方・意味）';
    return '';
  })();

  if (band === 'low') {
    return [
      '自己受容が低めの状態です。',
      'まず「いまの気持ちをそのまま認める」ことを最優先してください。',
      '語りはやさしく、安心を広げるトーンで、強い断定は避けてください。',
      `${modeLabel}${depthLabel} から、そっと寄り添いながら応答してください。`,
    ].join('\n');
  }

  if (band === 'high') {
    return [
      '自己受容が十分に育っている状態です。',
      '未来や意図ラインをはっきりと言い切って構いません。',
      '適度にチャレンジを促し、「次の一歩」を具体的に示してください。',
      `${modeLabel}${depthLabel} から、少し背中を押すトーンで応答してください。`,
    ].join('\n');
  }

  // mid
  return [
    '自己受容は揺れの中にあります。',
    '寄り添いと構造提示のバランスを取りつつ、少し先の未来を静かに指し示してください。',
    `${modeLabel}${depthLabel} から、安心と整理の両方を届けるトーンで応答してください。`,
  ].join('\n');
}

/* =========================================================
   IntentLine → LLM への内部メモ変換
   - systemメッセージとして渡し、「章の言い切り」と未来方向を強調
========================================================= */

function buildIntentLineMemo(
  intentLine?: IntentLineAnalysis | null,
): string | null {
  if (!intentLine) return null;

  const parts: string[] = [];

  parts.push('【内部解析メモ：意図ライン】');

  if (intentLine.nowLabel) {
    parts.push(`- 今の章: ${intentLine.nowLabel}`);
  }
  if (intentLine.coreNeed) {
    parts.push(`- 守ろうとしているもの: ${intentLine.coreNeed}`);
  }
  if (intentLine.intentBand) {
    parts.push(`- 意図帯域: ${intentLine.intentBand}（I層レベルの位置）`);
  }
  if (intentLine.direction && intentLine.direction !== 'unknown') {
    parts.push(`- 未来方向: ${intentLine.direction}`);
  }
  if (intentLine.focusLayer) {
    parts.push(`- フォーカスレイヤ: ${intentLine.focusLayer} 帯を優先して扱うとよい`);
  }
  if (intentLine.riskHint) {
    parts.push(`- リスク注意: ${intentLine.riskHint}`);
  }
  if (intentLine.guidanceHint) {
    parts.push(`- ガイドライン: ${intentLine.guidanceHint}`);
  }

  if (parts.length <= 1) return null;

  return parts.join('\n');
}

/**
 * Iros 応答を 1ターン生成する。
 * - system.ts の IROS_SYSTEM + meta を使って system プロンプトを組み立てる
 * - 任意で「過去履歴（history）」も LLM に渡す
 * - 本文生成と別に、userテキストから I層（I1〜I3）を判定する
 */
export async function generateIrosReply(
  args: GenerateArgs,
): Promise<GenerateResult> {
  const { text, meta, history, conversationId } = args;

  // ベースの system プロンプト
  const baseSystem = getSystemPrompt(meta);

  // I層のときだけ、スタイル指示を追加
  const intentStyle = chooseIntentStyle(meta);
  const styleInstruction = buildStyleInstruction(intentStyle);

  // IntentLine から内部解析メモを生成
  const intentLineMemo = buildIntentLineMemo(
    (meta as any)?.intentLine ?? null,
  );

  // ★ Self Acceptance / mode / depth を取得
  const saValue =
    meta && typeof (meta as any)?.selfAcceptance === 'number'
      ? ((meta as any).selfAcceptance as number)
      : null;
  const currentMode: IrosMode = meta?.mode ?? 'mirror';
  const currentDepth: Depth | undefined = meta?.depth as Depth | undefined;

  const saToneHint = buildSAToneHint(saValue, currentMode, currentDepth ?? null);

  // styleInstruction と SA トーンヒントを system に合成
  const systemWithStyle =
    styleInstruction != null
      ? `${baseSystem}\n\n${styleInstruction}`
      : baseSystem;

  const system =
    saToneHint && saToneHint.trim().length > 0
      ? `${systemWithStyle}\n\n---\n[SelfAcceptance Tone Hint]\n${saToneHint}`
      : systemWithStyle;

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: 'system' as const,
      content: system,
    },

    // IntentLine を system メモとして渡す（あれば）
    ...(intentLineMemo
      ? [
          {
            role: 'system' as const,
            content: intentLineMemo,
          },
        ]
      : []),

    // history を展開（あれば）
    ...buildHistoryMessages(history),

    {
      role: 'user' as const,
      content: text,
    },
  ];

  // ① 本文生成
  const res = await client.chat.completions.create({
    model: IROS_MODEL,
    messages,
    temperature: 0.7,
  });

  const content =
    res.choices[0]?.message?.content?.toString().trim() ?? '';

  const mode: IrosMode = currentMode ?? 'mirror';

  // ② I層解析（ユーザー入力ベース）
  const intent = await analyzeIntentLayer(text);

  // ③ Meaning Block 統合
  const meaningBlock = buildMeaningBlock(meta);
  const finalContent = meaningBlock
    ? `${meaningBlock}\n\n${content}`
    : content;

  return {
    content: finalContent,
    text: finalContent,
    mode,
    intent,
  };
}

/* =========================================================
   履歴メッセージの整形（LLM に渡す形式へ変換）
   - role / content が壊れていても落ちないように防御的に処理
   - 長くなりすぎないよう、直近 N 件だけに絞る
========================================================= */

const MAX_HISTORY_ITEMS = 20; // 必要に応じて調整

function buildHistoryMessages(
  history?: HistoryItem[],
): OpenAI.ChatCompletionMessageParam[] {
  if (!history || !Array.isArray(history) || history.length === 0) {
    return [];
  }

  // 古い → 新しい順で来ている前提で、後ろから MAX_HISTORY_ITEMS 件だけ使う
  const sliced = history.slice(-MAX_HISTORY_ITEMS);

  return sliced
    .map((h): OpenAI.ChatCompletionMessageParam | null => {
      if (!h || typeof h.content !== 'string') return null;

      const trimmed = h.content.trim();
      if (!trimmed) return null;

      const role: 'assistant' | 'user' =
        h.role === 'assistant' ? 'assistant' : 'user';

      return {
        role,
        content: trimmed,
      };
    })
    .filter(
      (m): m is OpenAI.ChatCompletionMessageParam =>
        m !== null,
    );
}

/* =========================================================
   I層アナライザー
   - userText から I1 / I2 / I3 を判定（なければ null）
   - reason / confidence も付与
   - ここでは「意図層に触れているかどうか」だけを見る
========================================================= */

async function analyzeIntentLayer(userText: string): Promise<IrosIntentMeta> {
  const trimmed = (userText || '').trim();
  if (!trimmed) {
    return {
      layer: null,
      reason: null,
      confidence: null,
    };
  }

  const systemPrompt = [
    'あなたは「Iros」のための I層（意図レイヤー）アナライザーです。',
    'ユーザーの発言が、どの程度「意図・存在・生きる意味」に踏み込んでいるかを判定します。',
    '',
    '出力は必ず次の JSON 形式 1行のみで返してください（日本語で説明しないこと）。',
    '',
    '{',
    '  "layer": "I1" | "I2" | "I3" | null,',
    '  "reason": "なぜそのレイヤーと判定したかの短い日本語説明",',
    '  "confidence": 0〜1 の数値（だいたいの確信度）',
    '}',
    '',
    '◎ 判定ルール（簡易）',
    '- I3: 「なぜ生きているのか」「存在理由」「生まれてきた意味」など、人生全体・存在そのものに踏み込んでいる。',
    '- I2: 「どう生きたいか」「本当の願い」「人生の方向性」など、人生レベルの選択や本心を扱っている。',
    '- I1: 「自分らしくありたい」「本当の自分」「在り方」など、在り方レベルで意図に触れているが、人生全体までは踏み込んでいない。',
    '- null: 上記のいずれにも明確には当てはまらない。',
    '',
    '※ 迷う場合は、より浅いレイヤー（I1寄り）を選び、どう迷ったかを reason に書いてください。',
  ].join('\n');

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: trimmed },
  ];

  try {
    const res = await client.chat.completions.create({
      model: IROS_MODEL,
      messages,
      temperature: 0,
    });

    const raw = res.choices[0]?.message?.content ?? '';
    const text = typeof raw === 'string' ? raw.trim() : String(raw).trim();

    const parsed = safeParseJson(text);

    const layerRaw =
      parsed && typeof parsed.layer === 'string'
        ? parsed.layer
        : null;

    const layer: 'I1' | 'I2' | 'I3' | null =
      layerRaw === 'I1' || layerRaw === 'I2' || layerRaw === 'I3'
        ? (layerRaw as 'I1' | 'I2' | 'I3')
        : null;

    const reason =
      parsed && typeof parsed.reason === 'string'
        ? parsed.reason
        : null;

    let confidence: number | null = null;
    if (parsed && typeof parsed.confidence === 'number') {
      confidence = parsed.confidence;
    } else if (parsed && typeof parsed.confidence === 'string') {
      const n = Number(parsed.confidence);
      confidence = Number.isFinite(n) ? n : null;
    }

    return {
      layer,
      reason,
      confidence,
    };
  } catch (e) {
    console.warn('[IROS/Intent] analyzeIntentLayer error', e);
    return {
      layer: null,
      reason: null,
      confidence: null,
    };
  }
}

/**
 * LLMの出力から JSON を安全に取り出すヘルパー。
 * - 素直に JSON ならそのまま parse
 * - それ以外なら、最初の { 〜 最後の } を抜き出して再トライ
 */
function safeParseJson(text: string): any | null {
  if (!text) return null;

  const trimmed = text.trim();

  // 素直な JSON の場合
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fallthrough
    }
  }

  // 何か説明 + JSON の場合を想定して { ... } 部分だけ抜き出して再トライ
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = trimmed.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  return null;
}
