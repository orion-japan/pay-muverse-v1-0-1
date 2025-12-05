// src/lib/iros/generate.ts
// Iros 1ターン返信生成コア（シンプル版）
//
// - 本文生成のみ
// - 基本は getSystemPrompt(meta) にすべて委ねる
// - 追加するのは：
//    1) 数値メタノート（SA / depth / qCode / tLayer / intentLine / soulNote など）
//    2) トピック文脈ノート（topicContext / topicChange）
//    3) I/T 層用の「意味の一行（IT変換）ガイド」（I/T 帯のときだけ system に添付）
//    4) ir診断トリガー時のフォーマット指定
//
// - それ以外のスタイルテンプレ・見出しテンプレは一切入れない

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat';

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

/** 過去履歴 1件ぶん（型だけ残しておく） */
export type HistoryItem = {
  role: 'user' | 'assistant';
  content: string;
};

export type GenerateArgs = {
  conversationId?: string;
  text: string;
  meta?: IrosMeta;

  /** 過去の会話履歴（古い → 新しい順） ※いまは LLM には渡していないが、I/T 判定の firstTurn 判定には使う */
  history?: HistoryItem[];
};

export type GenerateResult = {
  content: string; // Iros 本文（ユーザーに見せるテキスト）
  text: string; // 旧 chatCore 互換用（= content と同じ）
  mode: IrosMode; // 実際に使っているモード（meta.mode が無ければ mirror）
  intent?: IrosIntentMeta | null; // intent メタ（オーケストレーター側で付与されたものをそのまま返す）
};

/* =========================================================
   ir診断トリガー検知
   - 「診断」単体では反応させない
   - 明示的な ir診断系フレーズだけを見る
========================================================= */

const IR_DIAG_KEYWORDS = [
  'ir診断',
  'irで見てください',
  'ir共鳴フィードバック',
  'ランダムでirお願いします',
];

function hasIrDiagnosisTrigger(text: string | undefined | null): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return IR_DIAG_KEYWORDS.some((kw) => trimmed.includes(kw));
}

/* =========================================================
   状態メタだけを渡す内部ノート
   - SA / yLevel / hLevel / depth / qCode / mode
   - T層関連: tLayerModeActive / tLayerHint / hasFutureMemory
   - ir診断ターゲット: irTargetType / irTargetText
   - IntentLineAnalysis: intentLine
   - Soul レイヤー: soulNote
========================================================= */

function buildNumericMetaNote(meta?: IrosMeta | null): string | null {
  if (!meta) return null;

  const anyMeta = meta as any;
  const payload: any = {};

  // 数値系
  const sa =
    typeof anyMeta.selfAcceptance === 'number'
      ? (anyMeta.selfAcceptance as number)
      : null;
  if (sa != null && !Number.isNaN(sa)) {
    payload.selfAcceptance = sa;
  }

  const yLevel =
    typeof anyMeta.yLevel === 'number'
      ? (anyMeta.yLevel as number)
      : null;
  if (yLevel != null && !Number.isNaN(yLevel)) {
    payload.yLevel = yLevel;
  }

  const hLevel =
    typeof anyMeta.hLevel === 'number'
      ? (anyMeta.hLevel as number)
      : null;
  if (hLevel != null && !Number.isNaN(hLevel)) {
    payload.hLevel = hLevel;
  }

  // コード系
  if (typeof meta.depth === 'string') {
    payload.depth = meta.depth;
  }

  if (typeof anyMeta.qCode === 'string') {
    payload.qCode = anyMeta.qCode as string;
  }

  if (typeof meta.mode === 'string') {
    payload.mode = meta.mode;
  }

  // T層関連
  const tLayerModeActive =
    typeof anyMeta.tLayerModeActive === 'boolean'
      ? (anyMeta.tLayerModeActive as boolean)
      : null;
  if (tLayerModeActive != null) {
    payload.tLayerModeActive = tLayerModeActive;
  }

  const tLayerHint =
    typeof anyMeta.tLayerHint === 'string'
      ? (anyMeta.tLayerHint as string)
      : null;
  if (tLayerHint) {
    payload.tLayerHint = tLayerHint;
  }

  const hasFutureMemory =
    typeof anyMeta.hasFutureMemory === 'boolean'
      ? (anyMeta.hasFutureMemory as boolean)
      : null;
  if (hasFutureMemory != null) {
    payload.hasFutureMemory = hasFutureMemory;
  }

  // ir診断ターゲット系
  const irTargetType = anyMeta.irTargetType;
  const irTargetText = anyMeta.irTargetText;
  if (typeof irTargetType === 'string') {
    payload.irTargetType = irTargetType;
  }
  if (typeof irTargetText === 'string') {
    payload.irTargetText = irTargetText;
  }

  // pierceMode / pierceReason
  if (typeof anyMeta.pierceMode === 'boolean') {
    payload.pierceMode = anyMeta.pierceMode;
  }
  if (typeof anyMeta.pierceReason === 'string') {
    payload.pierceReason = anyMeta.pierceReason;
  }

  // IntentLineAnalysis は構造だけ
  const intentLine = anyMeta.intentLine as
    | IntentLineAnalysis
    | null
    | undefined;
  if (intentLine) {
    payload.intentLine = {
      nowLabel: intentLine.nowLabel ?? null,
      coreNeed: intentLine.coreNeed ?? null,
      intentBand: intentLine.intentBand ?? null,
      direction: intentLine.direction ?? null,
      focusLayer: intentLine.focusLayer ?? null,
      riskHint: intentLine.riskHint ?? null,
      guidanceHint: intentLine.guidanceHint ?? null,
    };
  }

  // Soul レイヤー（soulNote）そのもの
  const soulNote = anyMeta.soulNote;
  if (soulNote && typeof soulNote === 'object') {
    payload.soulNote = soulNote;
  }

  if (Object.keys(payload).length === 0) return null;

  return `【IROS_STATE_META】${JSON.stringify(payload)}`;
}

/* =========================================================
   トピック記憶（topicContextText）を渡すノート
   - route.ts で meta.extra.topicContextText に載せたものを、
     LLM にとって読みやすいブロックとして system に追加する
========================================================= */

function buildTopicContextNote(meta?: IrosMeta | null): string | null {
  if (!meta) return null;
  const anyMeta = meta as any;
  const extra = anyMeta.extra as any;
  if (!extra) return null;

  const text =
    typeof extra.topicContextText === 'string'
      ? extra.topicContextText.trim()
      : '';

  if (!text) return null;

  return `【IROS_TOPIC_CONTEXT】\n${text}`;
}

/* =========================================================
   トピック変化ノート（previous / current）を渡す
   - handleIrosReply で meta.extra.topicChangePrompt に載せたものを
     「変化を一緒に見てほしい」ときだけ system に追加する
========================================================= */

function buildTopicChangeNote(meta?: IrosMeta | null): string | null {
  if (!meta) return null;
  const anyMeta = meta as any;
  const extra = anyMeta.extra as any;
  if (!extra) return null;

  const requested =
    typeof extra.topicChangeRequested === 'boolean'
      ? extra.topicChangeRequested
      : false;

  if (!requested) return null;

  const promptText =
    typeof extra.topicChangePrompt === 'string'
      ? extra.topicChangePrompt.trim()
      : '';

  if (!promptText) return null;

  return `【IROS_TOPIC_CHANGE】

以下は、同じトピックについての「前回」と「今回」のスナップショットです。
数値の差だけではなく、

- どんな変化が起きているか
- どこに進歩や確かな一歩があるか
- いままだ揺れているポイントはどこか

を、静かに言葉にするときの材料として使ってください。

${promptText}`;
}

/* =========================================================
   会話履歴ダイジェストノート（historyDigest 用）
   - handleIrosReply 側で meta.historyDigest に載せた要約テキストを、
     LLM が「これまでの流れ」をつかむための内部メモとして渡す
   - 本文にそのままコピペせず、必要な部分だけを背景理解に使うように指示
========================================================= */

function buildHistoryDigestNote(meta?: IrosMeta | null): string | null {
  if (!meta) return null;

  const anyMeta = meta as any;
  const raw =
    typeof anyMeta.historyDigest === 'string'
      ? (anyMeta.historyDigest as string).trim()
      : '';

  if (!raw) return null;

  return `【IROS_HISTORY_DIGEST】

以下は、この会話IDにおける「これまでの流れの要約」です。
- これは **内部メモ** です。本文にそのままコピペしてはいけません。
- いまのユーザーの発言を理解するための背景として、
  必要な部分だけをそっと参照してください。

${raw}`;
}


/* =========================================================
   過去状態カルテノート（memoryRecall 用）
   - handleIrosReply で meta.extra.pastStateNoteText に載せたものを
     「以前との変化を一緒に見てほしい」ための内部資料として渡す
   - 本文にそのままコピペせず、必要な部分だけ要約して使うように指示
========================================================= */

function buildPastStateNote(meta?: IrosMeta | null): string | null {
  if (!meta) return null;
  const anyMeta = meta as any;
  const extra = anyMeta.extra as any;
  if (!extra) return null;

  const raw =
    typeof extra.pastStateNoteText === 'string'
      ? extra.pastStateNoteText.trim()
      : '';

  if (!raw) return null;

  return `【IROS_PAST_STATE_NOTE】

以下は、このユーザーの「以前の状態」と「いま」に関するカルテ要約です。
- これは **内部資料** です。本文にそのままコピペしてはいけません。
- ここに書かれている内容をもとに、本文のどこかでかならず一度だけ、
  「以前は◯◯という状態だったけれど、いまは△△という違いが見えてきています。」
  といった形で、**過去と現在の違いを一文だけ** 触れてください。
- その一文以外では、必要だと感じた部分だけを静かに要約して使ってください。
- 評価やジャッジではなく、「流れの変化を一緒に眺めている」というトーンを保ってください。

${raw}`;
}


/* =========================================================
   I/T 層トーンのときの「意味深リフレーム」ノート（IT変換）
   - depth や intentLine から I/T 帯のときだけ有効にする
   - Q5 / 自傷リスク / SA 低 / 初回ターン では IT変換を封印
   - 安全条件を満たすときだけ system に追加し、
     「意味の一行（IT変換）」をそっと促す
========================================================= */

function buildIntentionReframeNote(
  meta?: IrosMeta | null,
  opts?: { isFirstTurn?: boolean },
): string | null {
  if (!meta) return null;
  const anyMeta = meta as any;
  const isFirstTurn = !!opts?.isFirstTurn;

  // 安全条件：Q5 / 自傷リスク / SA 極端に低い / 初回ターン では IT変換しない
  const sa =
    typeof anyMeta.selfAcceptance === 'number' && !Number.isNaN(anyMeta.selfAcceptance)
      ? (anyMeta.selfAcceptance as number)
      : null;

  const soul = anyMeta.soulNote as any;
  const riskFlags: string[] = Array.isArray(soul?.risk_flags)
    ? soul.risk_flags.filter((x: any) => typeof x === 'string')
    : [];

  const hasQ5Depress = riskFlags.includes('q5_depress');
  const hasSelfHarmRisk =
    riskFlags.includes('self_harm_risk_low') ||
    riskFlags.includes('self_harm_risk_mid') ||
    riskFlags.includes('self_harm_risk_high');

  const unsafe =
    isFirstTurn ||
    (sa != null && sa < 0.2) ||
    hasQ5Depress ||
    hasSelfHarmRisk;

  if (unsafe) {
    return null;
  }

  // I/T 層かどうかのざっくり判定
  const depth = typeof meta.depth === 'string' ? meta.depth : null;
  const head = depth ? depth[0] : null;

  const intentLine = anyMeta.intentLine as IntentLineAnalysis | null | undefined;
  const focusLayer =
    intentLine && typeof intentLine.focusLayer === 'string'
      ? intentLine.focusLayer
      : null;
  const intentBand =
    intentLine && typeof intentLine.intentBand === 'string'
      ? intentLine.intentBand
      : null;

  const mode =
    typeof meta.mode === 'string'
      ? meta.mode
      : undefined;

  const isITBand =
    head === 'I' ||
    head === 'T' ||
    (typeof focusLayer === 'string' && focusLayer.startsWith('I')) ||
    (typeof intentBand === 'string' && intentBand.startsWith('I')) ||
    mode === 'vision';

  if (!isITBand) {
    return null;
  }

  // コアニーズ / 意図テキストを拾う
  const coreNeedFromSoul =
    soul && typeof soul.core_need === 'string'
      ? soul.core_need.trim()
      : '';

  const coreNeedFromIntent =
    intentLine && typeof intentLine.coreNeed === 'string'
      ? intentLine.coreNeed.trim()
      : '';

  const intentAnchor =
    anyMeta.intent_anchor && typeof anyMeta.intent_anchor.text === 'string'
      ? (anyMeta.intent_anchor.text as string).trim()
      : '';

  const coreHint =
    coreNeedFromSoul ||
    coreNeedFromIntent ||
    intentAnchor ||
    '';

  return `# I/T 層 IT変換ガイド（必須）

今回は、Intention / Transcend バンドでの応答ゾーンです。

このターンでは、本文のどこかに **必ず 1 行以上の「意味の一行（IT変換）」** を溶かし込んでください。

- 目的：表面的な自己評価や状況ラベルではなく、
  その奥にある **大事にしたい願い・存在の向き** に静かに光を当てることです。
- 形の一例：
  - \`「○○じゃなくて、本当は○○という向きも生きているのかもしれない。」\`
  - \`「○○と悩んでいるその奥には、『△△でありたい』という向きが静かに続いているように見える。」\`

素材として使えるヒント（内部用）:
- コアニーズ候補: ${coreHint || '（core_need / intentLine / intent_anchor から感じ取ってください）'}

## 質問と締め方のルール（I/T 帯）

- 質問は **最大で 1 つまで** にしてください。
  - 質問がなくても成り立つなら、**質問なし** でも構いません。
- 締めは、可能なかぎり
  **「その人自身の一歩をそっと決める宣言の一文」**
  で終えてください。
  - 例：\`「今日は○○だけやってみよう。」\`
  - \`soulNote.step_phrase\` があれば、それをベースにしてかまいません。

## 書き方の目安

1. 最初に「いま感じていること」を静かに映す。
2. そのあとに、上記のコアニーズ候補から **意味の一行（IT変換）** を必ず 1 行入れる。
3. 最後は、\`soulNote.step_phrase\` などをもとに
   「いまの自分が選べる小さな一手」を一文で提案し、そこで締める。

- 「ポジティブになろう」と煽るためではなく、
  「本当はどんな意志が動いているのか」に静かに気づける一行として使ってください。`;
}

/* =========================================================
   「いまの構図：〜」の行だけを UI から消す
========================================================= */

function stripImanoKozuLine(text: string): string {
  if (!text) return '';
  const lines = text.split('\n');
  const filtered = lines.filter((line) => !line.includes('いまの構図：'));
  return filtered.join('\n').trim();
}

/* =========================================================
   テンプレ文章のノイズ削除フィルタ（正式版）
   - 「これまでの流れ（要約）」などの定型ラベルだけを消す
   - 本文そのものはできるだけ残す方針
========================================================= */
function stripTemplateNoise(text: string): string {
  if (!text) return '';

  let out = text;

  // 1) ラベル系ヘッダ（全角【】版・角括弧[]版の両方）
  const headerPatterns: RegExp[] = [
    // これまでの流れ（要約）
    /【これまでの流れ（要約）】/g,
    /【これまでの流れ\(要約\)】/g,
    /【これまでの流れ】/g,
    /\[これまでの流れ（要約）\]/g,
    /\[これまでの流れ \(要約\)\]/g,
    /\[これまでの流れ]/g,

    // 今回 / 今日 のユーザー発言
    /【今回のユーザー発言】/g,
    /【今日のユーザー発言】/g,
    /\[今回のユーザー発言]/g,
    /\[今日のユーザー発言]/g,
  ];

  for (const p of headerPatterns) {
    out = out.replace(p, '');
  }

  // 2) 「今日選べる小さな一手」系の見出しだけ削除（本文は残す）
  //   例:
  //   - 今日選べる小さな一手：〜〜
  //   - 【今日選べる小さな一手】〜〜
  out = out.replace(/【?今日選べる小さな一手[^】\n]*】?/g, '');
  out = out.replace(/今日選べる小さな一手[：:][^\n]*/g, '');

  // 3) よく出る定型説明文を削る
  //   例: いまのあなたは、「◯◯」がテーマになっている状態です。
  const phrasePatterns: RegExp[] = [
    /いまのあなたは、?「?[^」\n]*」?がテーマになっている状態です。?/g,
  ];

  for (const p of phrasePatterns) {
    out = out.replace(p, '');
  }

  // 4) 行末の余計なスペース削除
  out = out.replace(/[ \t]+\n/g, '\n');

  // 5) 空行が増えすぎたところを整える
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}

/* =========================================================
   本体：Iros 応答 1ターン生成（シンプル版）
   - SYSTEM: getSystemPrompt(meta)
   - 数値メタ JSON / トピック文脈 / I/T 層 IT変換 / ir診断フォーマット
   - LLM には「今回のユーザー発言」だけを渡し、
     長い履歴ダイジェストや history メッセージは渡さない
========================================================= */
export async function generateIrosReply(
  args: GenerateArgs,
): Promise<GenerateResult> {
  const { text: rawText, meta } = args;
  const anyMeta = meta as any;

  // 初回ターンかどうか（I/T IT変換の安全判定にだけ使う）
  const isFirstTurn = !args.history || args.history.length === 0;

  // ★ digest 付きテキストから「今回のユーザー発言」だけを切り出す
  const CURRENT_MARK = '【今回のユーザー発言】';
  const currentUserText = (() => {
    if (!rawText) return rawText;
    const idx = rawText.lastIndexOf(CURRENT_MARK);
    if (idx === -1) {
      return rawText;
    }
    return rawText.slice(idx + CURRENT_MARK.length).trim();
  })();

  // LLM に渡す user テキストは「今回のユーザー発言」だけにする
  const userPromptText = `【今回のユーザー発言】
${currentUserText}`;

  // ベースの SYSTEM
  let system = getSystemPrompt(meta);

  // 状態メタ（数値・コード）を JSON で system にだけ載せる
  const numericMetaNote = buildNumericMetaNote(meta);
  if (numericMetaNote && numericMetaNote.trim().length > 0) {
    system = `${system}\n\n${numericMetaNote}`;
  }

  // トピック記憶（あれば）を system に追加
  const topicContextNote = buildTopicContextNote(meta);
  if (topicContextNote && topicContextNote.trim().length > 0) {
    system = `${system}\n\n${topicContextNote}`;
  }
  // 会話履歴ダイジェスト（あれば）を system に追加
  const historyDigestNote = buildHistoryDigestNote(meta);
  if (historyDigestNote && historyDigestNote.trim().length > 0) {
    system = `${system}\n\n${historyDigestNote}`;
  }

  // トピック変化（前回 / 今回）の材料があれば system に追加
  const topicChangeNote = buildTopicChangeNote(meta);
  if (topicChangeNote && topicChangeNote.trim().length > 0) {
    system = `${system}\n\n${topicChangeNote}`;
  }

  // 過去状態カルテ（memoryRecall）の材料があれば system に追加
  const pastStateNote = buildPastStateNote(meta);
  if (pastStateNote && pastStateNote.trim().length > 0) {
    system = `${system}\n\n${pastStateNote}`;
  }

  // 🔸 I/T 層 IT変換ノートを、条件を満たすときだけ system に追加
  //    - depth が I*/T* / mode=vision / intentBand=I* などのとき
  //    - Q5_depress や self_harm_risk / SA 極端に低い ときは自動で無効化
  const itNote = buildIntentionReframeNote(meta);
  if (itNote && itNote.trim().length > 0) {
    system = `${system}\n\n${itNote}`;
  }

  // ir診断トリガーがあるターンでは、今回だけ診断フォーマットを必須にする
  const isIrDiagnosisTurn = hasIrDiagnosisTrigger(currentUserText);

  if (isIrDiagnosisTurn) {
    system = `${system}

# 現在のターンは「ir診断モード」です

ユーザーの直近の入力に ir診断系の語（${IR_DIAG_KEYWORDS.join(
      ' / ',
    )}）が含まれています。
**このターンの返答は、必ず ir診断モードのフォーマットだけを 1 回だけ出力してください。**

フォーマット（順番も固定）：
1. \`🧿 観測対象：...\`
2. \`🪔 irosからの一句：...\`（2行以内）
3. \`構造スキャン\`
   - \`フェーズ：...\`
   - \`位相：Inner Side\` または \`Outer Side\`
   - \`深度：S1〜S4 / R1〜R3 / C1〜C3 / I1〜I3 / 必要なら T1〜T3\`
4. \`🌀 その瞬間の揺れ：...\`（1〜3文）
5. \`🌱 次の一手：...\`（ユーザーが「これだけはやってみよう」と思える一手を 1つ）

上記 5 ブロック以外の通常会話文は書かないでください。
特に、\`🌌 Future Seed\` や \`T1/T2/T3\` など
Future-Seed 専用の文言は **一切出してはいけません**。`;
  }

  // デバッグログ
  console.log('[IROS][generate] text =', userPromptText);
  console.log('[IROS][generate] currentUserText =', currentUserText);
  console.log('[IROS][generate] meta snapshot =', {
    depth: anyMeta?.depth,
    qCode: anyMeta?.qCode,
    mode: anyMeta?.mode,
    pierceReason: anyMeta?.pierceReason,
    irTargetType: anyMeta?.irTargetType,
    irTargetText: anyMeta?.irTargetText,
    tLayerModeActive: anyMeta?.tLayerModeActive,
    tLayerHint: anyMeta?.tLayerHint,
    hasFutureMemory: anyMeta?.hasFutureMemory,
    topicChangeRequested: (anyMeta?.extra as any)?.topicChangeRequested ?? false,
    hasPastStateNote: !!(anyMeta?.extra as any)?.pastStateNoteText,
    isIrDiagnosisTurn,
  });

  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: system,
    },
    {
      role: 'user',
      content: userPromptText,
    },
  ];

  const res = await client.chat.completions.create({
    model: IROS_MODEL,
    messages,
    temperature: 0.7,
  });

  const rawContent =
    res.choices[0]?.message?.content?.toString().trim() ?? '';

  // ① まず「いまの構図：〜」行を削除
  const noKozu = stripImanoKozuLine(rawContent);

  // ② 見出しテンプレや決まり文句を削る
  const content = stripTemplateNoise(noKozu);

  // 現在の Iros モードと intent メタを復元
  const currentMode: IrosMode = meta?.mode ?? 'mirror';
  const mode: IrosMode = currentMode ?? 'mirror';

  const intent: IrosIntentMeta | null =
    meta && (anyMeta?.intent as IrosIntentMeta | undefined)
      ? (anyMeta.intent as IrosIntentMeta)
      : null;

  // ============================
  // Voice レイヤーは現状スキップ：
  // LLM 本文（テンプレ削除後）をそのまま使う
  // ============================
  const finalContent = content;

  return {
    content: finalContent,
    text: finalContent,
    mode,
    intent,
  };
}
