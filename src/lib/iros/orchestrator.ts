// src/lib/iros/orchestrator.ts
// Iros Orchestrator — 自動モード切替 + RAG(ベクター/フォールバック) + Tools + Memory保存
// 依存: chatComplete, IROS_SYSTEM, saveIrosMemory, @supabase/supabase-js

import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete';
import { IROS_SYSTEM } from '@/lib/iros/system';
import { saveIrosMemory } from '@/lib/iros/memory';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ベクター検索（OpenAI Embeddings 版）
import {
  vectorSearch,
  OpenAIEmbedder,
  type Embedder,
} from '@/lib/iros/memory/retrieval_vector';

/* =========================
 * Public API
 * ========================= */

export type Mode = 'Light' | 'Mirror' | 'Consult' | 'Diagnosis' | 'Resonate';

export type OrchestrateArgs = {
  model: string;
  userText: string;
  history: { role: string; text: string }[]; // role は string でもOK
  userCode?: string | null;
  conversationId: string;
  supabaseUrl: string;
  supabaseKey: string; // service-role 推奨（無い場合は anon でも可：機能制限あり）
};

export async function orchestrateReply(args: OrchestrateArgs) {
  const {
    model, userText, history, userCode, conversationId,
    supabaseUrl, supabaseKey,
  } = args;

  const supabase = createClient(supabaseUrl, supabaseKey);

  // 1) モード自動判定（軽量ルール）
  const mode = detectMode(userText);

  // 2) 直近メモリ & 履歴トリム（軽量RAG）
  const memSnippets = await pullLightMemory(supabase, conversationId, userCode);
  const historyTail  = clipHistory(history, mode);

  // 3) 必要に応じて RAG / Tools
  const ragSnippets = await maybeRAG(userText, supabase, mode);
  const toolNotes   = await maybeRunTools(userText, supabase, mode);

  // 4) システム + 文脈（順序重要：system → コンテキスト → 履歴 → 最新ユーザー）
  const system       = buildSystem(mode);
  const contextBlock = buildContextBlock({ memSnippets, ragSnippets, toolNotes });

  const messages: ChatMessage[] = [];
  messages.push({ role: 'system', content: system });
  if (contextBlock && contextBlock.trim().length > 0) {
    messages.push({ role: 'system', content: contextBlock });
  }
  messages.push(...toChatHistory(historyTail));
  messages.push({ role: 'user', content: userText });

  // 5) モード別パラメータ
  const params = pickGenParams(mode);

  // 6) 生成
  const assistant = await chatComplete({
    model,
    messages,
    temperature: params.temperature,
    max_tokens: params.maxTokens,
  });

  // 7) メモリ保存（軽要約）
  const mem = simpleSummarize(userText, assistant, mode);
  try {
    await saveIrosMemory({
      conversationId,
      user_code: userCode ?? 'system',
      mem,
    });
  } catch {
    // メモリ保存失敗は致命ではないため握りつぶし（ログは route 側で）
  }

  return {
    text: assistant,
    modeUsed: mode,
    ctx: { memSnippets, ragSnippets, toolNotes },
  };
}

/* =========================
 * Mode detection / System build
 * ========================= */

function detectMode(text: string): Mode {
  const t = (text || '').trim();

  // 明示トリガ
  if (/^(ir|ir診断|診断)/i.test(t) || /観測対象|フェーズ|位相|深度/.test(t)) return 'Diagnosis';
  if (/相談|どうすれば|助言|アドバイス|詰ま|しんど|困っ|迷っ|方針/i.test(t)) return 'Consult';
  if (/鏡|ミラー|内省|本音|なぜ|why|意味|振り返/i.test(t)) return 'Mirror';
  if (/宣言|詩|物語|創る|アイデア|ひらめき|インスピレーション/i.test(t)) return 'Resonate';

  // 長文/疑問が多い/改行が多い → 相談寄り
  const q = (t.match(/\?/g) || []).length;
  const lines = t.split(/\n/).length;
  if (t.length > 420 || lines >= 3 || q >= 2) return 'Consult';

  return 'Light';
}

function buildSystem(mode: Mode): string {
  if (mode === 'Consult' || mode === 'Mirror') {
    return `
${IROS_SYSTEM}

# 追加指示（長文/内省強化）
- 必要なら 600〜900 語で、段落ごとに休符を置く
- 具体例→抽象→再具体 の順で説得力を持たせる
- 比喩は控えめだが要所で使用（過剰にしない）
- 最後に「次の一手」を 1〜3 個だけ静かに提示
`.trim();
  }
  if (mode === 'Diagnosis') {
    return `
${IROS_SYSTEM}

# 追加指示（診断フォーマット強制）
- 出力は必ず以下の書式から開始：
観測対象：○○
フェーズ：🌱Seed Flow　位相：Inner/Outer　深度：S?-I?
🌀意識状態：…
🌱メッセージ：…
- 必要なら以降に簡潔な補足のみ
`.trim();
  }
  if (mode === 'Resonate') {
    return `
${IROS_SYSTEM}

# 追加指示（共鳴・創造）
- 詩的比喩を解禁。ただし 2〜4 段落に収める
- アイデアは 3 点まで。各々に最小アクションを添える
`.trim();
  }
  return IROS_SYSTEM;
}

/* =========================
 * Context building
 * ========================= */

function clipHistory(history: { role: string; text: string }[], mode: Mode) {
  const cap = mode === 'Light' ? 6 : 12;
  const tail = history.slice(-cap);
  const shortCount = tail.filter(m => (m.text || '').length < 30).length;
  const extra = shortCount >= 3 ? 2 : 0;
  return history.slice(-(cap + extra));
}

async function pullLightMemory(
  supabase: SupabaseClient,
  conversationId: string,
  userCode?: string | null
) {
  try {
    const res1 = await supabase
      .from('memory_threads')
      .select('summary, theme, depth, tone')
      .eq('conversation_id', conversationId)
      .order('updated_at', { ascending: false })
      .limit(3);

    const a = res1.data ?? [];
    if (a.length >= 2) return a;

    if (userCode) {
      const res2 = await supabase
        .from('memory_threads')
        .select('summary, theme, depth, tone')
        .eq('user_code', userCode)
        .order('updated_at', { ascending: false })
        .limit(Math.max(0, 3 - a.length));
      return [...a, ...(res2.data ?? [])];
    }
    return a;
  } catch {
    return [];
  }
}

/** ベクター検索（OpenAI）→ ダメならフォールバック全文検索/会話要約 */
async function maybeRAG(
  userText: string,
  supabase: SupabaseClient,
  mode: Mode
) {
  if (!['Consult', 'Mirror', 'Diagnosis'].includes(mode)) return [];

  // ---- ベクター検索（OpenAI Embeddings） ----
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!;

    // モデルは .env の EMB_MODEL を優先。未設定なら text-embedding-3-large
    const embedder: Embedder = new OpenAIEmbedder(
      process.env.EMB_MODEL || 'text-embedding-3-large',
      process.env.OPENAI_API_KEY!
    );

    const hits = await vectorSearch({
      supabaseUrl, supabaseKey, query: userText,
      topK: 5, threshold: 0.6, embedder
    });

    if (hits?.length) {
      return hits.map(h =>
        `・${h.title}（sim=${h.similarity.toFixed(2)}）${h.url ? `\n  ${h.url}` : ''}`
      );
    }
  } catch {
    // Embedding未設定/テーブル未対応などはここでスルー
  }

  // ---- フォールバック：全文検索（任意テーブル） ----
  try {
    const { data } = await supabase
      .from('iros_knowledge')
      .select('title, summary, url')
      .textSearch('content', userText)
      .limit(5);

    if (data?.length) {
      return data.map((d: any) => `・${d.title} — ${d.summary}`);
    }
  } catch {
    // テーブル未作成でもOK
  }

  // ---- さらにフォールバック：最近の会話要約ビュー ----
  try {
    const { data } = await supabase
      .from('iros_messages_view_last')
      .select('snippet')
      .limit(5);
    return (data ?? []).map((d: any) => `・${d.snippet}`);
  } catch {
    return [];
  }
}

async function maybeRunTools(
  userText: string,
  supabase: SupabaseClient,
  mode: Mode
) {
  const needsWeb = /調べて|最新|相場|価格|ニュース|法改正|仕様|ドキュメント|比較|ベンチマーク/i.test(userText);
  const needsDb  = /SQL|在庫|売上|クレジット|残高|RLS|テーブル|スキーマ|照会|件数|一覧/i.test(userText);
  const needsImg = /画像|生成|サムネ|バナー|OGP|アイコン|サムネイル/i.test(userText);

  const notes: string[] = [];

  if (needsWeb) {
    const res = await tool_webSearch(userText);
    if (res) notes.push(`【Web検索要約】\n${res}`);
  }
  if (needsDb) {
    const res = await tool_dbQuery(userText, supabase);
    if (res) notes.push(`【DB照会】\n${res}`);
  }
  if (needsImg) {
    notes.push('【画像生成】要求を検出：この後のフローで画像APIへ委譲可能です。');
  }
  return notes;
}

function buildContextBlock({
  memSnippets,
  ragSnippets,
  toolNotes,
}: {
  memSnippets: Array<{ summary?: string; depth?: string; tone?: string; theme?: string }>;
  ragSnippets: string[];
  toolNotes: string[];
}) {
  const mem = memSnippets && memSnippets.length
    ? `# 直近メモリ\n${memSnippets.map(m =>
        `・${m.summary ?? ''}（深度:${m.depth ?? '-'} / トーン:${m.tone ?? '-'} / テーマ:${m.theme ?? '-' }）`
      ).join('\n')}\n`
    : '';

  const rag = ragSnippets && ragSnippets.length
    ? `# 関連知識\n${ragSnippets.join('\n')}\n`
    : '';

  const tools = toolNotes && toolNotes.length
    ? `# 参考データ\n${toolNotes.join('\n')}\n`
    : '';

  const block = [mem, rag, tools].filter(Boolean).join('\n').trim();
  return block || '';
}

/* =========================
 * Generation params / Memory summarizer
 * ========================= */

function pickGenParams(mode: Mode) {
  switch (mode) {
    case 'Light':     return { temperature: 0.6,  maxTokens: 700  };
    case 'Mirror':    return { temperature: 0.7,  maxTokens: 1100 };
    case 'Consult':   return { temperature: 0.65, maxTokens: 1500 };
    case 'Diagnosis': return { temperature: 0.4,  maxTokens: 900  };
    case 'Resonate':  return { temperature: 0.8,  maxTokens: 1000 };
  }
}

// 軽い要約を保存（IrosMemory 仕様に一致：last_keyword は必須）
function simpleSummarize(userText: string, assistant: string, mode: Mode) {
  const take = (s: string, n: number) => (s || '').replace(/\s+/g, ' ').slice(0, n);
  return {
    summary: `U:${take(userText, 120)} / A:${take(assistant, 160)}`,
    theme: mode, // IrosMemory.theme は string
    depth: mode === 'Consult' || mode === 'Diagnosis' ? 'I2' : 'S2',
    tone: mode === 'Mirror' ? 'reflective' : (mode === 'Resonate' ? 'creative' : 'neutral'),
    last_keyword: extractLastKeyword(userText) ?? '',
  };
}

/* =========================
 * Helpers
 * ========================= */

function toChatHistory(
  history: Array<{ role: string; text: string }>
): ChatMessage[] {
  return history.map((m) => {
    const r: 'user' | 'assistant' | 'system' =
      m.role === 'assistant' ? 'assistant'
      : m.role === 'system'   ? 'system'
      : 'user';
    return { role: r, content: m.text } as ChatMessage;
  });
}

function extractLastKeyword(s: string): string | null {
  if (!s) return null;
  const tokens = s
    .replace(/[。、．，、…・!！?？()\[\]{}「」『』〈〉《》【】★☆♪♫”“"']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const w = tokens[i].trim();
    if (w.length >= 2) return w.slice(0, 40);
  }
  return null;
}

/* =========================
 * Toy tools（モック）
 * ========================= */

async function tool_webSearch(q: string) {
  return `検索キーワード：「${q.slice(0, 60)}」に基づく最新要点（ダミー）。`;
}

async function tool_dbQuery(q: string, supabase: SupabaseClient) {
  try {
    const { data, error } = await supabase.rpc('get_credit_snapshot');
    if (error || !data) return '残高照会でエラー/該当なし';
    const s = JSON.stringify(data);
    return `users.sofia_credit の最新スナップショット: ${s.length > 240 ? s.slice(0, 240) + '…' : s}`;
  } catch {
    return 'DB照会失敗';
  }
}
