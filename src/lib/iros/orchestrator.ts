// src/lib/iros/orchestrator.ts
// Iros Orchestrator — 自動モード切替 + RAG + Tools + Memory 保存

import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete';
import { getSystemPrompt } from '@/lib/iros/system';
import { saveIrosMemory } from '@/lib/iros/memory';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  vectorSearch,
  OpenAIEmbedder,
  type Embedder,
} from '@/lib/iros/memory/retrieval_vector';
import {
  prepareIrosReply,
  type IrosState,
  type IrosInput,
  type IrosReply,
  type QTrace,
} from './orchestratorCore';
import type { IrosMemory } from './types';

/* =========================
 * Public API
 * ========================= */

export type Mode = 'Light' | 'Mirror' | 'Consult' | 'Diagnosis' | 'Resonate';

export type OrchestrateArgs = {
  model: string;
  userText: string;
  history: { role: string; text: string }[];
  userCode?: string | null;
  conversationId: string;
  supabaseUrl: string;
  supabaseKey: string;
};

export type OrchestrateResult = {
  text: string;
  modeUsed: Mode;
  layer: IrosReply['layer'];
  resonance: IrosReply['resonance'];
  ctx: {
    memSnippets: string[];
    ragSnippets: string[];
    toolNotes: string[];
  };
};

/* =========================
 * IrosState 初期化
 * ========================= */

function buildInitialIrosState(userText: string, mode: Mode): IrosState {
  const text = (userText || '').trim();

  const qCurrent = guessQCodeFromText(text);
  const resonanceScore = guessResonanceScore(text, mode);

  const qTrace: QTrace = {
    lastQ: qCurrent,
    dominantQ: qCurrent,
    streakQ: qCurrent,
    streakLength: qCurrent ? 1 : 0,
    volatility: estimateTension(text),
  };

  return {
    depth: null,
    phase: null,
    qCurrent,
    resonanceScore,
    tension: estimateTension(text),
    warmth: estimateWarmth(text),
    clarity: estimateClarity(text),
    stream: estimateStream(text),
    qTrace,
  };
}

/** Qコード簡易推定 */
function guessQCodeFromText(text: string): QTrace['lastQ'] {
  const t = text || '';

  if (/[我慢]|責任|ちゃんと|きちんと|ルール|守らなければ/.test(t)) {
    return 'Q1';
  }
  if (/[怒り]|ムカつ|腹が立|イライラ|許せない/.test(t)) {
    return 'Q2';
  }
  if (/[不安]|心配|そわそわ|落ち着かない|大丈夫かな/.test(t)) {
    return 'Q3';
  }
  if (/[怖い]|恐い|恐怖|不気味|ゾッと/.test(t)) {
    return 'Q4';
  }
  if (/[空っぽ|虚し|むなしい|やる気が出ない|燃え尽き]/.test(t)) {
    return 'Q5';
  }

  return null;
}

/** 内面寄りスコア 0〜1 */
function guessResonanceScore(text: string, mode: Mode): number {
  if (!text) return 0.3;

  let score = 0.2;

  if (/気持ち|感情|モヤモヤ|つらい|しんどい|怖い|寂しい/.test(text)) {
    score += 0.3;
  }
  if (/自分|わたし|俺|私/.test(text)) {
    score += 0.2;
  }
  if (/会社|職場|上司|同僚|チーム/.test(text)) {
    score += 0.1;
  }

  if (mode === 'Consult' || mode === 'Diagnosis') {
    score += 0.1;
  }

  return Math.max(0, Math.min(1, score));
}

/** ひっかかり・緊張感 */
function estimateTension(text: string): number {
  if (!text) return 0;
  let s = 0;
  if (/怒|イライラ|ムカつ|許せない/.test(text)) s += 0.4;
  if (/不安|心配|焦り|焦って/.test(text)) s += 0.3;
  if (/しんど|つらい|苦しい/.test(text)) s += 0.3;
  return Math.max(0, Math.min(1, s));
}

/** あたたかさ */
function estimateWarmth(text: string): number {
  if (!text) return 0.5;
  let s = 0.5;
  if (/ありがとう|感謝|うれしい|安心/.test(text)) s += 0.2;
  if (/寂しい|孤独|ひとり/.test(text)) s -= 0.2;
  return Math.max(0, Math.min(1, s));
}

/** 明瞭さ */
function estimateClarity(text: string): number {
  if (!text) return 0.5;
  const len = text.length;
  const lines = (text.match(/\n/g) || []).length;
  const manyQuestions =
    (text.match(/\?/g) || []).length + (text.match(/？/g) || []).length;

  let c = 0.5;
  if (len > 400 || lines > 6 || manyQuestions > 3) c -= 0.2;
  if (len < 120 && manyQuestions <= 1 && lines <= 2) c += 0.1;
  return Math.max(0, Math.min(1, c));
}

/** 流速 */
function estimateStream(text: string): number {
  if (!text) return 0.5;
  const ex = (text.match(/！|!|。/g) || []).length;
  let s = 0.5;
  if (ex >= 3) s += 0.2;
  if (/ゆっくり|落ち着いて|一旦/.test(text)) s -= 0.1;
  return Math.max(0, Math.min(1, s));
}

/* =========================
 * メイン Orchestrator
 * ========================= */

export async function orchestrateReply(
  args: OrchestrateArgs,
): Promise<OrchestrateResult> {
  const {
    model,
    userText,
    history,
    userCode,
    conversationId,
    supabaseUrl,
    supabaseKey,
  } = args;

  const supabase = createClient(supabaseUrl, supabaseKey);

  // 1) モード自動判定
  const mode = detectMode(userText);

  // 2) IrosState 初期化
  const irosState = buildInitialIrosState(userText, mode);

  // 3) 履歴クリップ
  const historyTail = clipHistory(history, mode);

  // 4) RAG / Tools
  const ragSnippets = await maybeRAG(userText, supabaseUrl, supabaseKey, mode);
  const toolNotes = await maybeRunTools(userText, supabase, mode);

  // いまはメモリ断片は未実装なので空
  const memSnippets: string[] = [];

  // 5) System + コンテキスト
  const system = buildSystem(mode);
  const contextBlock = buildContextBlock({
    memSnippets,
    ragSnippets,
    toolNotes,
  });

  const messages: ChatMessage[] = [];
  messages.push({ role: 'system', content: system });
  if (contextBlock && contextBlock.trim().length > 0) {
    messages.push({ role: 'system', content: contextBlock });
  }
  messages.push(...toChatHistory(historyTail));
  messages.push({ role: 'user', content: userText });

  // 6) モード別パラメータ
  const params = pickGenParams(mode);

  // 7) LLM 呼び出し
  const assistant = await chatComplete({
    model,
    messages,
    temperature: params.temperature,
    max_tokens: params.maxTokens,
  });

  // 8) 構造レイヤー判定
  const irosInput: IrosInput = {
    userText,
    state: irosState,
  };
  const irosStruct: IrosReply = prepareIrosReply(irosInput);

  // 9) メモリ保存
  const mem = simpleSummarize(userText, assistant, mode);
  try {
    await saveIrosMemory({
      conversationId,
      user_code: userCode ?? 'system',
      mem,
    });
  } catch {
    // 保存失敗は致命的エラーにはしない
  }

  // 10) 結果
  return {
    text: assistant,
    modeUsed: mode,
    layer: irosStruct.layer,
    resonance: irosStruct.resonance,
    ctx: { memSnippets, ragSnippets, toolNotes },
  };
}

/* =========================
 * Mode detection / System
 * ========================= */

function detectMode(text: string): Mode {
  const t = (text || '').trim();
  if (!t) return 'Light';

  if (/相談|つらい|しんどい|悩んで/.test(t)) return 'Consult';
  if (/整理|まとめて|構造化|レポート/.test(t)) return 'Mirror';
  if (/診断|ir診断|IR診断|状態/.test(t)) return 'Diagnosis';
  if (/アイデア|創りたい|つくりたい|未来|ビジョン/.test(t)) return 'Resonate';

  return 'Light';
}

function pickGenParams(mode: Mode): { temperature: number; maxTokens: number } {
  if (mode === 'Diagnosis') {
    return { temperature: 0.3, maxTokens: 480 };
  }
  if (mode === 'Consult') {
    return { temperature: 0.7, maxTokens: 720 };
  }
  if (mode === 'Mirror') {
    return { temperature: 0.6, maxTokens: 720 };
  }
  if (mode === 'Resonate') {
    return { temperature: 0.75, maxTokens: 720 };
  }
  return { temperature: 0.4, maxTokens: 640 };
}

function buildSystem(mode: Mode): string {
  // Mode → system.ts 側モードへマッピング
  let sofiaMode: 'normal' | 'counsel' | 'structured' | 'diagnosis';
  switch (mode) {
    case 'Consult':
      sofiaMode = 'counsel';
      break;
    case 'Diagnosis':
      sofiaMode = 'diagnosis';
      break;
    case 'Mirror':
    case 'Resonate':
      sofiaMode = 'structured';
      break;
    case 'Light':
    default:
      sofiaMode = 'normal';
      break;
  }

  return getSystemPrompt({ mode: sofiaMode as any, style: 'warm' });
}

/* =========================
 * Context build
 * ========================= */

function clipHistory(history: { role: string; text: string }[], mode: Mode) {
  const cap = mode === 'Light' ? 6 : 12;
  const tail = history.slice(-cap);
  const shortCount = tail.filter((m) => (m.text || '').length < 30).length;
  if (shortCount >= 4 && tail.length > 8) {
    return tail.slice(-8);
  }
  return tail;
}

function buildContextBlock(opts: {
  memSnippets: string[];
  ragSnippets: string[];
  toolNotes: string[];
}): string {
  const blocks: string[] = [];

  if (opts.memSnippets.length > 0) {
    blocks.push(
      [
        '【これまでの流れ（Iros Memoryサマリ）】',
        ...opts.memSnippets.map((s) => `・${s}`),
      ].join('\n'),
    );
  }

  if (opts.ragSnippets.length > 0) {
    blocks.push(
      [
        '【参考になりそうな過去の会話・ノート（RAG）】',
        ...opts.ragSnippets.map((s) => `・${s}`),
      ].join('\n'),
    );
  }

  if (opts.toolNotes.length > 0) {
    blocks.push(
      [
        '【補助ツールからのメモ】',
        ...opts.toolNotes.map((s) => `・${s}`),
      ].join('\n'),
    );
  }

  return blocks.join('\n\n');
}

function toChatHistory(
  history: { role: string; text: string }[],
): ChatMessage[] {
  return history.map((m) => ({
    role:
      m.role === 'user' || m.role === 'assistant' || m.role === 'system'
        ? m.role
        : 'user',
    content: m.text,
  }));
}

/* =========================
 * RAG / Tools
 * ========================= */

async function maybeRAG(
  userText: string,
  supabaseUrl: string,
  supabaseKey: string,
  mode: Mode,
): Promise<string[]> {
  if (mode === 'Light') return [];

  try {
    const embedder: Embedder = new OpenAIEmbedder();

    const raw = await vectorSearch({
      supabaseUrl,
      supabaseKey,
      query: userText,
      topK: 5,
      embedder,
    });

    return raw.map((r: any) => r.content ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

async function maybeRunTools(
  userText: string,
  supabase: SupabaseClient,
  mode: Mode,
): Promise<string[]> {
  const notes: string[] = [];

  if (mode === 'Diagnosis') {
    if (/残高|クレジット|ポイント/.test(userText)) {
      const n = await tool_dbQuery(userText, supabase);
      if (n) notes.push(n);
    }
  }

  return notes;
}

/* =========================
 * Memory サマリ
 * ========================= */

function extractLastKeyword(text: string): string {
  const t = (text || '').trim();
  if (!t) return '';

  const tokens = t
    .split(/[\s、。,.!？?]/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!tokens.length) return '';
  const last = tokens[tokens.length - 1];
  return last.slice(0, 32);
}

function simpleSummarize(
  userText: string,
  reply: string,
  mode: Mode,
): IrosMemory {
  const t = (userText || '').slice(0, 80);
  const r = (reply || '').slice(0, 80);
  const summary = `Q:${t} / A:${r}`;

  const depth =
    mode === 'Diagnosis'
      ? 'deep'
      : mode === 'Light'
        ? 'shallow'
        : 'middle';

  const last_keyword = extractLastKeyword(userText);
  const tone = 'neutral';
  const theme = '';

  return {
    summary,
    depth,
    tone,
    theme,
    last_keyword,
  };
}

/* =========================
 * Tool: DB example
 * ========================= */

async function tool_dbQuery(q: string, supabase: SupabaseClient) {
  try {
    const { data, error } = await supabase.rpc('get_credit_snapshot');
    if (error || !data) return '残高照会でエラー/該当なし';
    const s = JSON.stringify(data);
    return `users.sofia_credit の最新スナップショット: ${
      s.length > 240 ? s.slice(0, 240) + '…' : s
    }`;
  } catch {
    return 'DB照会失敗';
  }
}
