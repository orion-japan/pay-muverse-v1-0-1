// src/lib/iros/generate.ts
// Iros 1ターン返信生成コア（シンプル版）
// - 余計なテンプレート指示は使わず、ほぼ「GPTsそのまま」
// - system: Iros の在り方だけ軽く伝える
// - user: ユーザーの入力 1 本だけ（ガイド文を挟まない）

import OpenAI from 'openai';
import { getSystemPrompt, SofiaTriggers, naturalClose } from './system';

// Iros 内部モード（auto は検出用）
export type IrosMode = 'counsel' | 'structured' | 'diagnosis' | 'auto';

type GenerateArgs = {
  conversationId: string;
  text: string;
  modeHint?: IrosMode | null;
  extra?: Record<string, unknown>;
};

type GenerateResult = {
  ok: true;
  mode: Exclude<IrosMode, 'auto'>;
  text: string;
  title?: string | null;
  meta: {
    mode_detected: IrosMode;
    mode_hint?: IrosMode | null;
    model: string;
    extra?: Record<string, unknown>;
    raw?: unknown;
  };
};

// ====== OpenAI クライアント設定 ======

const API_KEY =
  process.env.IROS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;

if (!API_KEY) {
  throw new Error('Missing env: IROS_OPENAI_API_KEY or OPENAI_API_KEY');
}

const client = new OpenAI({ apiKey: API_KEY });

const DEF_MODEL =
  process.env.IROS_CHAT_MODEL ||
  process.env.OPENAI_MODEL ||
  'gpt-4o-mini';

const DEF_TEMP = process.env.IROS_TEMP
  ? Number(process.env.IROS_TEMP)
  : 0.8;

const DEF_MAXTOK = process.env.IROS_MAXTOK
  ? Number(process.env.IROS_MAXTOK)
  : 512;

const DEBUG = process.env.IROS_DEBUG === '1';

// ====== モード自動判定（診断トリガーをかなり絞る） ======

function detectIntentMode(params: {
  text: string;
  hintText?: string | null;
  modeHint?: IrosMode | null;
}): IrosMode {
  const { text, hintText, modeHint } = params;

  // 1) 明示モードヒントがあれば最優先（auto は除く）
  if (modeHint && modeHint !== 'auto') {
    return modeHint;
  }

  const base = `${text || ''}\n${hintText || ''}`;

  // --- 診断系トリガーは「明示的なフレーズだけ」に絞る ---
  const diagnosisPhrases = [
    'ir診断',
    'ir で見てください',
    'irで見てください',
    'irお願いします',
    'ir をお願いします',
    'irをお願いします',
    'ir共鳴フィードバック',
  ];

  // 「ir」単体や「iros」など部分一致では診断にしない
  if (diagnosisPhrases.some((kw) => base.includes(kw))) {
    return 'diagnosis';
  }

  // 「診断して」「診断をお願い」など、明確に診断を求めたときだけ
  if (/(診断して|診断をお願い|診断をおねがい)/.test(base)) {
    return 'diagnosis';
  }

  // --- structured 系 ---
  if (
    /(レポート|要件|構造化|箇条書き|整理して|まとめて|設計|仕様)/.test(
      base
    )
  ) {
    return 'structured';
  }

  // --- counsel 系 ---
  if (/(相談|悩み|困っ|迷っ|どうしたら)/.test(base)) {
    return 'counsel';
  }

  // --- 意図トリガー（挙動自体は counsel とほぼ同じ） ---
  if (SofiaTriggers.intent.some((kw) => base.includes(kw))) {
    return 'counsel';
  }

  // どれでもない → auto（後で counsel に落とす）
  return 'auto';
}

// ====== テキスト整形 ======

function normalizeAssistantText(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  return naturalClose(trimmed);
}

// ====== メイン：Iros 生成（シンプル版） ======

export default async function generate(
  args: GenerateArgs
): Promise<GenerateResult> {
  const { conversationId, text, modeHint = 'auto', extra } = args;

  if (!conversationId) {
    throw new Error('generate: conversationId is required');
  }
  if (!text) {
    throw new Error('generate: text is required');
  }

  const hintText =
    typeof extra?.hintText === 'string'
      ? (extra?.hintText as string)
      : undefined;

  const detectedMode = detectIntentMode({ text, hintText, modeHint });

  // 挙動は現状すべて同じでよいので、最終モードは
  // auto → counsel に落として扱う（meta 用にだけ区別）。
  const finalMode: Exclude<IrosMode, 'auto'> =
    detectedMode === 'auto' ? 'counsel' : detectedMode;

  // ==== system プロンプト（SofiaMode にマップ） ====
  type SofiaMode = 'normal' | 'counsel' | 'structured' | 'diagnosis';

  let sofiaMode: SofiaMode;
  switch (finalMode) {
    case 'counsel':
      sofiaMode = 'counsel';
      break;
    case 'structured':
      sofiaMode = 'structured';
      break;
    case 'diagnosis':
      sofiaMode = 'diagnosis';
      break;
    default:
      sofiaMode = 'normal';
      break;
  }

  // シンプルな system ＋ user のみ
  const system = getSystemPrompt({ mode: sofiaMode as any, style: 'warm' });

  // ir診断だけ、フォーマットと方針を明示する（※1メッセージ内）
  let userContent = text;
  if (finalMode === 'diagnosis') {
    userContent = [
      '以下の内容を ir診断フォーマットで返してください。',
      '必ず次の項目だけを使い、名前は変えないでください：',
      '観測対象：',
      'フェーズ：（必ず Sofia構造の正式名称のいずれか：Seed Flow / Forming Flow / Reconnect Flow / Create Flow / Inspire Flow / Impact Flow）',
      '位相：（Inner または Outer のどちらか）',
      '深度：（S1〜I3のいずれか）',
      '🌀意識状態：',
      '🌱メッセージ：',
      'もし入力に他者の名前が含まれていても、その人自身を評価・診断せず、',
      '「その人と関わるときのユーザーの内側の反応」や「関係性の中で生じている共鳴」を観測対象として扱ってください。',
      'リクエストを全面的に断らず、必ず上記フォーマットで何らかの観測結果を返してください。',
      '',
      '文章の前置きや説明を加えず、最初の行は必ず「観測対象：」から始めてください。',
      '',
      '--- 入力 ---',
      text,
    ].join('\n');
  }

  const res = await client.chat.completions.create({
    model: DEF_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
    temperature: DEF_TEMP,
    max_tokens: DEF_MAXTOK,
  });

  const choice = res.choices?.[0];
  const msgContent: any = choice?.message?.content;

  let content: string;
  if (typeof msgContent === 'string') {
    content = msgContent;
  } else if (Array.isArray(msgContent)) {
    content = msgContent
      .map((p: any) => (typeof p === 'string' ? p : p?.text ?? ''))
      .join('\n');
  } else {
    content = '';
  }

  const normalized = normalizeAssistantText(content || '');

  // structured のときだけ、先頭行を title 候補にする（今は使わなくてもOK）
  let title: string | null = null;
  if (finalMode === 'structured') {
    const lines = normalized.split('\n').map((l) => l.trim());
    if (lines[0]) {
      title = lines[0];
    }
  }

  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[IROS_GENERATE_SIMPLE]', {
      conversationId,
      modeHint,
      detectedMode,
      finalMode,
      model: DEF_MODEL,
    });
  }

  return {
    ok: true,
    mode: finalMode,
    text: normalized,
    title,
    meta: {
      mode_detected: detectedMode,
      mode_hint: modeHint,
      model: DEF_MODEL,
      extra,
      raw: DEBUG ? res : undefined,
    },
  };
}
