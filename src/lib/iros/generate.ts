// src/lib/iros/generate.ts
// Iros 1ターン返信生成コア（テンプレ極小版）
// - 本文生成のみ
// - ここではスタイルテンプレや I層テンプレは一切指示しない
// - 履歴と状態メタ（SA / depth / qCode / intentLine など）はそのまま system に渡す

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
  content: string; // Iros 本文（ユーザーに見せるテキスト）
  text: string; // 旧 chatCore 互換用（= content と同じ）
  mode: IrosMode; // 実際に使っているモード（meta.mode が無ければ mirror）
  intent?: IrosIntentMeta | null; // intent メタ（オーケストレーター側で付与されたものをそのまま返す）
};

/* =========================================================
   状態メタだけを渡す内部ノート
   - SA / yLevel / hLevel / depth / qCode / mode / intentLine
   - irTargetType / irTargetText / pierceMode / pierceReason なども
     そのまま載せておく（判断は system.ts / LLM 側に委ねる）
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

  // ir診断ターゲット系（あればそのまま載せるだけで、ここでは何もしない）
  const irTargetType = anyMeta.irTargetType;
  const irTargetText = anyMeta.irTargetText;
  if (typeof irTargetType === 'string') {
    payload.irTargetType = irTargetType;
  }
  if (typeof irTargetText === 'string') {
    payload.irTargetText = irTargetText;
  }

  // pierceMode / pierceReason も meta 経由で渡すだけ
  if (typeof anyMeta.pierceMode === 'boolean') {
    payload.pierceMode = anyMeta.pierceMode;
  }
  if (typeof anyMeta.pierceReason === 'string') {
    payload.pierceReason = anyMeta.pierceReason;
  }

  // IntentLineAnalysis は構造だけ（説明文もそのまま載せるが、ここではスタイル指示はしない）
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
   本体：Iros 応答 1ターン生成（テンプレ極小）
   - SYSTEM: getSystemPrompt(meta)
   - 状態メタ JSON
   - irモード専用のテンプレ・追加 SYSTEM は一切使わない
========================================================= */

export async function generateIrosReply(
  args: GenerateArgs,
): Promise<GenerateResult> {
  const { text, meta, history } = args;

  // ベースの SYSTEM
  let system = getSystemPrompt(meta);

  // 状態メタ（数値・コード）を JSON で system にだけ載せる
  const numericMetaNote = buildNumericMetaNote(meta);
  if (numericMetaNote && numericMetaNote.trim().length > 0) {
    system = `${system}\n\n${numericMetaNote}`;
  }

  // デバッグログ（ir専用のフラグはここでは見ない）
  console.log('[IROS][generate] text =', text);
  console.log('[IROS][generate] meta snapshot =', {
    depth: (meta as any)?.depth,
    qCode: (meta as any)?.qCode,
    mode: (meta as any)?.mode,
    pierceReason: (meta as any)?.pierceReason,
    irTargetType: (meta as any)?.irTargetType,
    irTargetText: (meta as any)?.irTargetText,
  });

  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: system,
    },
    ...buildHistoryMessages(history),
    {
      role: 'user',
      content: text,
    },
  ];

  const res = await client.chat.completions.create({
    model: IROS_MODEL,
    messages,
    temperature: 0.7,
  });

  const rawContent =
    res.choices[0]?.message?.content?.toString().trim() ?? '';

  // 「いまの構図：〜」の行だけ削除（残りはすべて LLM 任せ）
  const content = stripImanoKozuLine(rawContent);

  const currentMode: IrosMode = meta?.mode ?? 'mirror';
  const mode: IrosMode = currentMode ?? 'mirror';

  const intent: IrosIntentMeta | null =
    meta && (meta as any).intent
      ? ((meta as any).intent as IrosIntentMeta)
      : null;

  const finalContent = content;

  return {
    content: finalContent,
    text: finalContent,
    mode,
    intent,
  };
}

/* =========================================================
   履歴メッセージの整形（そのまま維持）
========================================================= */

const MAX_HISTORY_ITEMS = 20;

function buildHistoryMessages(
  history?: HistoryItem[],
): ChatCompletionMessageParam[] {
  if (!history || !Array.isArray(history) || history.length === 0) {
    return [];
  }

  const sliced = history.slice(-MAX_HISTORY_ITEMS);

  return sliced
    .map((h): ChatCompletionMessageParam | null => {
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
    .filter((m): m is ChatCompletionMessageParam => m !== null);
}
