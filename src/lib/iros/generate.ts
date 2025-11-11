// src/lib/iros/generate.ts
export type IrosMode = 'counsel' | 'structured' | 'diagnosis' | 'auto';

type GenerateArgs = {
  conversationId: string;
  text: string;
  modeHint?: IrosMode | null;
  extra?: Record<string, unknown>;
};

type GenerateResult = {
  mode: Exclude<IrosMode, 'auto'> | 'auto';
  text: string;
  title?: string;
  meta?: Record<string, unknown>;
};

import detectIntentMode from '@/lib/iros/intent';
import {
  HINT_COUNSEL,
  HINT_STRUCTURED,
  HINT_DIAGNOSIS,
} from '@/lib/iros/hints';

// LLM アダプタ（named export / default export 両対応）
import * as LLM from '@/lib/llm/chatComplete';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type ChatCompleteFn = (args: {
  apiKey?: string; // 呼び出し元で環境変数を読める実装も許容
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  endpoint?: string;
}) => Promise<string>;

// chatComplete の解決（named -> default の順で解決）
const chatComplete: ChatCompleteFn = (LLM as any).chatComplete
  ? (LLM as any).chatComplete
  : (LLM as any).default;

// ========== System Prompt（Iros人格＋モード別ヒント） ==========
const BASE_PROMPT = [
  'あなたは「Iros」――共鳴的に相手の意図を読み取り、静けさと実務性の両立を目指すAIです。',
  '短く、明確に、そして温かく。必要な時だけ絵文字（🪔など）を添えてください。',
  '出力は常にユーザーの主権を尊重し、断定よりも一歩進むための具体的提案を優先します。',
].join('\n');

function buildModeHint(mode: Exclude<IrosMode, 'auto'>): string {
  switch (mode) {
    case 'counsel':
      return HINT_COUNSEL;
    case 'structured':
      return HINT_STRUCTURED;
    case 'diagnosis':
      return HINT_DIAGNOSIS;
    default:
      return '';
  }
}

function ensureMode(
  hint: IrosMode | null | undefined,
  detected: IrosMode,
): Exclude<IrosMode, 'auto'> | 'auto' {
  if (hint && hint !== 'auto') return hint;
  if (detected && detected !== 'auto') return detected;
  // フォールバックは counsel（安全側）
  return 'counsel';
}

// タイトル生成（短い要約・最大20〜30文字程度）
function makeTitle(mode: Exclude<IrosMode, 'auto'> | 'auto', text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const max = 28;
  const head = normalized.slice(0, max);
  const suffix = normalized.length > max ? '…' : '';
  switch (mode) {
    case 'structured':
      return `要件整理：${head}${suffix}`;
    case 'diagnosis':
      return `ir診断：${head}${suffix}`;
    case 'counsel':
    default:
      return `相談：${head}${suffix}`;
  }
}

// 安全ガード付き messages 構築
function buildMessages(
  mode: Exclude<IrosMode, 'auto'> | 'auto',
  userText: string,
): ChatMessage[] {
  const modeHint = mode === 'auto' ? '' : buildModeHint(mode);
  const system = [BASE_PROMPT, modeHint].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: userText },
  ];
}

export default async function generate(args: GenerateArgs): Promise<GenerateResult> {
  const { conversationId, text, modeHint = 'auto', extra } = args;

// 1) モード決定
let detectedMode: IrosMode = 'auto';
try {
  // DetectArgs 形式（{ text }）で渡す。返り値の差異（{mode} or string）に両対応
  const res = await detectIntentMode({ text } as any);
  const mode = (res as any)?.mode ?? res; // { mode } or "counsel"
  if (typeof mode === 'string') detectedMode = mode as IrosMode;
} catch {
  // 検知失敗時は黙ってフォールバック
  detectedMode = 'counsel';
}
const finalMode = ensureMode(modeHint, detectedMode);


  // 2) LLM 呼び出し
  const messages = buildMessages(finalMode, text);
  let completion = '';
  try {
    completion = await chatComplete({
      // 既存実装が環境変数を内部参照している場合は apiKey/model は省略可能
      messages,
      temperature: finalMode === 'structured' ? 0.2 : 0.5,
      max_tokens: 720,
    });
  } catch (e: any) {
    // 失敗時フォールバック応答
    completion =
      '内部処理で一時的なエラーが発生しました。数分置いて再試行してください。\n' +
      '至急の場合は、今すぐ始められる「最小の一歩」を1つだけ書き出してみましょう。🪔';
  }

  // 3) タイトルとメタ
  const title = makeTitle(finalMode, text);
  const meta = {
    via: 'orchestrator',
    conversation_id: conversationId,
    mode_detected: detectedMode,
    mode_hint: modeHint ?? null,
    ts: new Date().toISOString(),
    ...(extra ?? {}),
  };

  return {
    mode: finalMode,
    text: completion,
    title,
    meta,
  };
}
