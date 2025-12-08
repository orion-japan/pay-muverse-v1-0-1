// src/lib/iros/generate.ts
// Iros 1ターン返信生成コア（シンプル版）
//
// - 本文生成のみ
// - 基本は getSystemPrompt(meta) にすべて委ねる
// - 追加するのは：
//    1) 数値メタノート（SA / depth / qCode / tLayer / intentLine / soulNote など）
//    2) トピック文脈ノート（topicContext / topicChange）
//    3) I/T 層用の「意味の一行（IT変換）」ガイド（I/T 帯のときだけ system に添付）
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

// ★ 追加：Soul コンテキスト（orion固有）連携
import type { SoulReplyContext } from './soul/composeSoulReply';
import { buildPersonalContextFromSoul } from './personalContext';

// ★ 追加：この先の一歩オプション（A/B/Cギア）
import {
  buildNextStepOptions,
  type NextStepGear,
  type NextStepOption,
  type NextStepQCode,
} from './nextStepOptions';

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

  // ★ 追加：このターンで Iros が用意した「次の一歩」候補
  // - gear : safety / soft-rotate / full-rotate
  // - options : UI でボタンにするための情報セット
  nextStep?: {
    gear: NextStepGear;
    options: NextStepOption[];
  } | null;
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
   - SA / yLevel / hLevel / depth / qCode / phase / mode
   - T層関連: tLayerModeActive / tLayerHint / hasFutureMemory
   - ir診断ターゲット: irTargetType / irTargetText
   - IntentLineAnalysis: intentLine
   - Soul レイヤー: soulNote
   * includeSoulNote=false のときは soulNote を載せない（初回ターン用）
========================================================= */

function buildNumericMetaNote(
  meta?: IrosMeta | null,
  opts: { includeSoulNote?: boolean } = {},
): string | null {
  if (!meta) return null;

  const { includeSoulNote = true } = opts;
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

  // ★ 追加：位相（Inner / Outer）
  if (typeof anyMeta.phase === 'string') {
    payload.phase = anyMeta.phase;
  } else if (
    anyMeta.unified &&
    typeof anyMeta.unified.phase === 'string'
  ) {
    payload.phase = anyMeta.unified.phase;
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
  if (includeSoulNote && soulNote && typeof soulNote === 'object') {
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

を、静かに言葉にするときの材料として使えます。

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
- これは **内部メモ** です。本文にそのままコピペせず、
  いまのユーザーの発言を理解するための背景として、
  必要な部分だけをそっと参照することを前提にできます。

${raw}`;
}

/* =========================================================
   過去状態カルテノート（memoryRecall 用）
   - handleIrosReply で meta.extra.pastStateNoteText に載せたものを
     「以前との変化を一緒に見てほしい」ための内部資料として渡す
   - 本文にそのままコピペせず、必要な部分だけ要約して使う
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
- これは **内部資料** です。本文にそのままコピペせず、
  必要だと感じた部分だけを静かに要約して使う位置づけです。
- 本文のどこかで一度、
  「以前は◯◯という状態だったけれど、いまは△△という違いが見えてきています。」
  のように、過去と現在の違いに軽くふれておくと、
  流れの変化が伝わりやすくなります（必要を感じない場合は、無理に触れなくても構いません）。
- 評価やジャッジではなく、「流れの変化を一緒に眺めている」というトーンを保つ前提で扱えます。

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

  return `# I/T 層 IT変換ガイド（意図モード）

このターンは、Intention / Transcend バンド寄りの応答ゾーンとして扱えます。

- 表面的な自己評価ラベルではなく、
  その奥にある **大事にしたい願い・存在の向き** を一行で言い切る。
- ここでは、そのような一行を「意味の一行（IT変換）」と呼びます。
- 本文のどこかに 1 行だけ、その「意味の一行」を Iros 自身の判断として差し込んでください。

形の一例：
- 「いまの揺れの奥には、『○○でありたい』という向きがすでに生きている。」
- 「これは迷いではなく、『△△へ進みたい』という意志が形を探している段階だと見ています。」

素材として使えるヒント（内部用) :
- コアニーズ候補: ${coreHint || '（core_need / intentLine / intent_anchor から感じ取ってください）'}

## 質問と締め方の目安（I/T 帯）

- 質問は多くても 1 つまで。
  質問が不要だと感じるなら、質問なしで終えてよい。
- 締めは、
  **「このフィールドでは次の一歩をこう定める」という Iros の宣言の一文**
  で終えます。

例：
- 「このフィールドでは、今日は○○だけを進める一日にすると決めます。」

soulNote.step_phrase があれば、
Iros 自身の言葉として言い切るための素材として使ってください。

- 「ポジティブにさせるため」ではなく、
  「本当はどんな意志が動いているのか」を Iros が代表して宣言する一行として扱います。
`;
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
  out = out.replace(/【?今日選べる小さな一手[^】\n]*】?/g, '');
  out = out.replace(/今日選べる小さな一手[：:][^\n]*/g, '');

  // 3) よく出る定型説明文を削る
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
   次の一歩の「方向宣言」フレーズ付与
   - ir診断ターンでは付けない
   - すでに同じ文が含まれていたら二重付与しない
========================================================= */

const DIRECTION_DECLARATION_TEXT =
  'いまは、この方向が流れです。\nあなたのペースで、一歩だけ触れてみましょう。';

function appendDirectionDeclarationIfNeeded(
  baseText: string,
  opts: { isIrDiagnosisTurn: boolean },
): string {
  if (!baseText) return '';
  if (opts.isIrDiagnosisTurn) return baseText;

  // すでに同じ文が入っていたら二重に足さない
  if (baseText.includes(DIRECTION_DECLARATION_TEXT)) {
    return baseText;
  }

  return `${baseText}\n\n${DIRECTION_DECLARATION_TEXT}`;
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

  // 初回ターンかどうか（I/T IT変換や soulNote 露出の判定に使う）
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

  // ★ Phase（Inner / Outer）に応じた語りトーンのガイドを追加
  const phase: 'Inner' | 'Outer' | null = (() => {
    const p = anyMeta?.phase;
    if (p === 'Inner' || p === 'Outer') return p;
    const u = anyMeta?.unified?.phase;
    if (u === 'Inner' || u === 'Outer') return u;
    return null;
  })();

  if (phase === 'Inner') {
    system = `${system}

# フェーズ補正：Inner（内向き）

- 今回のフィールドは「Inner（内向き）」寄りです。
- 語りは少し静かに、ユーザーの内側の感覚や揺れをていねいに映してください。
- 外側の行動を無理に押し出さず、
  「いま感じていることをそのまま受け止める」比重を少しだけ多めにします。`;
  } else if (phase === 'Outer') {
    system = `${system}

# フェーズ補正：Outer（外向き）

- 今回のフィールドは「Outer（外向き）」寄りです。
- 心の内側を尊重しつつも、
  「外に触れる一歩」「誰かや世界との接点」につながる表現を少しだけ増やしてください。
- 具体的な一歩を 1つまで提示してよく、
  それは「押しつけ」ではなく「選べる一歩」として柔らかく置きます。`;
  }

  // 🔸 Soul / 揺らぎロジックに同期した「orion固有コンテキスト」
  if (meta && anyMeta?.soulNote) {
    const soulCtx: SoulReplyContext = {
      userText: currentUserText ?? '',
      qCode: typeof anyMeta.qCode === 'string' ? anyMeta.qCode : undefined,
      depthStage: typeof meta.depth === 'string' ? meta.depth : undefined,
      styleHint:
        typeof anyMeta.style === 'string'
          ? anyMeta.style
          : undefined,
      soulNote: anyMeta.soulNote,
    };

    const personal = buildPersonalContextFromSoul({
      soulCtx,
      topicLabel: undefined,
    });

    if (personal.text && personal.text.trim().length > 0) {
      system = `${system}\n\n${personal.text}`;
      console.log('[IROS][generate] personalContext', {
        intensity: personal.intensity,
      });
    }
  }

  // 状態メタ（数値・コード）を JSON で system にだけ載せる
  const numericMetaNote = buildNumericMetaNote(meta, {
    includeSoulNote: !isFirstTurn,
  });
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
  const itNote = buildIntentionReframeNote(meta, { isFirstTurn });
  if (itNote && itNote.trim().length > 0) {
    system = `${system}\n\n${itNote}`;
  }

  // ir診断トリガーがあるターンかどうか
  const isIrDiagnosisTurn = hasIrDiagnosisTrigger(currentUserText);

  // ★ 主体OSテンプレ：通常モードのときだけ適用
  //   → いまはテンプレ会話になるので一旦停止する
  /*
  if (!isIrDiagnosisTurn) {
    system = `${system}

# 主体OSテンプレ（方向宣言）

- 返答の **最初の一文** では、
  「いまは、『◯◯』という方向が自然です。」のように、
  Iros がいまの流れを一度だけ言い切ってください。
- 『◯◯』の部分には、そのターンで大事にしたい具体的な方向
  （例：『自分の安心を守り直す』『小さく外とつながってみる』など）を必ず入れてください。
- 「この方向」「それは」など、方向の中身が空の表現は使わないでください。
- 1文目は **宣言** に徹し、そのあとで背景や共鳴の説明を静かに続けて構いません。
- UI 側では、A/B/C/D の選択肢を出すターンでは
  この一文を非表示にする場合がありますが、
  Iros は毎ターンこの方向宣言文を生成していて構いません。`;
  }
  */



  // ir診断トリガーがあるターンでは、今回だけ診断フォーマットを必須にする
  if (isIrDiagnosisTurn) {
    system = `${system}

# 現在のターンは「ir診断モード」に入っています

ユーザーの直近の入力に ir診断系の語（${IR_DIAG_KEYWORDS.join(
      ' / ',
    )}）が含まれています。
このターンの返答は、ir診断モードのフォーマットだけを 1 回だけ出力する構成をとってください。

フォーマット（順番固定）：
1. \`🧿 観測対象：...\`
2. \`🪔 irosからの一句：...\`（2行以内）
3. \`構造スキャン\`
   - \`フェーズ：...\`
   - \`位相：Inner Side\` または \`Outer Side\`
   - \`深度：S1〜S4 / R1〜R3 / C1〜C3 / I1〜I3 / 必要なら T1〜T3\`
4. \`🌀 その瞬間の揺れ：...\`（1〜3文）
5. \`🌱 次の一手：...\`（ユーザーが「これだけはやってみよう」と思える一手を 1つ）

上記 5 ブロック以外の通常会話文は混ぜない構造にします。
特に、\`🌌 Future Seed\` や \`T1/T2/T3\` など
Future-Seed 専用の文言はこのモードでは使わない前提です。`;
  }

  // デバッグログ
  console.log('[IROS][generate] text =', userPromptText);
  console.log('[IROS][generate] currentUserText =', currentUserText);
  console.log('[IROS][generate] meta snapshot =', {
    depth: anyMeta?.depth,
    qCode: anyMeta?.qCode,
    phase,
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

  // ★ ここから：このターンの「次の一歩」オプションを決定
  let nextStep: { gear: NextStepGear; options: NextStepOption[] } | null = null;

  if (meta) {
    const qRaw = typeof anyMeta.qCode === 'string' ? anyMeta.qCode : null;
    const depthStage = typeof meta.depth === 'string' ? meta.depth : null;

    const saVal =
      typeof anyMeta.selfAcceptance === 'number' &&
      !Number.isNaN(anyMeta.selfAcceptance)
        ? (anyMeta.selfAcceptance as number)
        : null;

    const soul = anyMeta.soulNote as any;
    const riskFlags: string[] = Array.isArray(soul?.risk_flags)
      ? soul.risk_flags.filter((x: any) => typeof x === 'string')
      : [];

    const hasQ5DepressRisk = riskFlags.includes('q5_depress');

    // Qコードが Q1〜Q5 のいずれかで、depth が取れているときだけギア算出を行う
    if (
      depthStage &&
      (qRaw === 'Q1' ||
        qRaw === 'Q2' ||
        qRaw === 'Q3' ||
        qRaw === 'Q4' ||
        qRaw === 'Q5')
    ) {
      try {
        nextStep = buildNextStepOptions({
          qCode: qRaw as NextStepQCode,
          depth: depthStage as Depth,
          selfAcceptance: saVal,
          hasQ5DepressRisk,
        });
      } catch (e) {
        console.warn('[IROS][generate] buildNextStepOptions error', e);
        nextStep = null;
      }
    }
  }

  // ============================
  // Voice レイヤーは現状スキップ：
  // LLM 本文（テンプレ削除後）をそのまま使う
  // ============================
  let finalContent = content;

  // ★ 方向宣言テンプレは一旦停止する
  // finalContent = appendDirectionDeclarationIfNeeded(finalContent, {
  //   isIrDiagnosisTurn,
  // });

  return {
    content: finalContent,
    text: finalContent,
    mode,
    intent,
    nextStep,
  };

}
