// src/lib/iros/generate.ts
// Iros 1ターン返信生成コア（観測点固定版）
//
// - 本文生成のみ
// - SYSTEM は getSystemPrompt(meta) に委ねる
// - 追加するのは：
//    1) 状態メタ JSON（SA / depth / qCode / phase / intentLine / soulNote など）
//    2) ir診断トリガー時のフォーマット指定
//
// - トピック履歴や過去カルテなど、観測点に直接不要なノートは削除

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat';

import {
  getSystemPrompt,
  type IrosMeta,
  type IrosMode,
  type IrosIntentMeta,
} from './system';
import type { IntentLineAnalysis } from './intent/intentLineEngine';

// ★ Soul コンテキスト（orion固有）連携
import type { SoulReplyContext } from './soul/composeSoulReply';
import { buildPersonalContextFromSoul } from './personalContext';

// ★ Sofia 型リフレーム指針ノート（これは既存の一括ガイドとして利用）
// import { buildReframeStyleNote } from './orchestratorMeaning';


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
  /** 過去の会話履歴（古い → 新しい順） ※いまは I/T 判定などのフラグ用のみ */
  history?: HistoryItem[];
};

export type GenerateResult = {
  content: string; // Iros 本文（ユーザーに見せるテキスト）
  text: string; // 旧 chatCore 互換用（= content と同じ）
  mode: IrosMode; // 実際に使っているモード（meta.mode が無ければ mirror）
  intent?: IrosIntentMeta | null; // orchestrator 側で付与された intent メタ
};

/* =========================================================
   ir診断トリガー検知
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

  // 位相（Inner / Outer）
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
   本体：Iros 応答 1ターン生成（観測点固定版）
========================================================= */
export async function generateIrosReply(
  args: GenerateArgs,
): Promise<GenerateResult> {
  const { text: rawText, meta } = args;
  const anyMeta = meta as any;

  // 初回ターンかどうか（Soul露出などの判定に使う）
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

  // ★ Phase（Inner / Outer）に応じた、ごく簡単なトーン補正
  const phase: 'Inner' | 'Outer' | null = (() => {
    const p = anyMeta?.phase;
    if (p === 'Inner' || p === 'Outer') return p;
    const u = anyMeta?.unified?.phase;
    if (u === 'Inner' || u === 'Outer') return u;
    return null;
  })();

  if (phase === 'Inner') {
    system = `${system}

# フェーズ: Inner（内向き）
- 内側の感覚をていねいに映す静かなトーンで。`;
  } else if (phase === 'Outer') {
    system = `${system}

# フェーズ: Outer（外向き）
- 外の出来事や関係に触れつつ、一歩だけ動きやすくするトーンで。`;
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

  // ir診断トリガーがあるターンかどうか
  const isIrDiagnosisTurn = hasIrDiagnosisTrigger(currentUserText);

  // 🔸 Sofia 型リフレーム指針（core_need / intentLine ベース）
  // - 超シンプル検証のため、いったん system 追記を OFF にする
  // - renderReply.ts / soulNote の効果だけで「素の3軸」を確認する
  //
  // if (!isIrDiagnosisTurn && meta) {
  //   const reframeNote = buildReframeStyleNote(meta);
  //   if (reframeNote && reframeNote.trim().length > 0) {
  //     system = `${system}\n\n${reframeNote}`;
  //   }
  // }


  // ir診断トリガーがあるターンでは、今回だけ診断フォーマットを使う
  if (isIrDiagnosisTurn) {
    system = `${system}

# ir診断モード

- このターンの返答は、次の5ブロックだけで構成してください。

1. 🧿 観測対象：...
2. 🪔 irosからの一句：...（2行以内）
3. 構造スキャン
   - フェーズ：...
   - 位相：Inner Side / Outer Side
   - 深度：S1〜S4 / R1〜R3 / C1〜C3 / I1〜I3 / 必要なら T1〜T3
4. 🌀 その瞬間の揺れ：...（1〜3文）
5. 🌱 次の一手：...（一つだけ）`;
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

  // ① 「いまの構図：〜」行を削除
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

  const finalContent = content;

  return {
    content: finalContent,
    text: finalContent,
    mode,
    intent,
  };
}
