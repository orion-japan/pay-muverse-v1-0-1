// src/lib/iros/memory/retrieval_vector.ts
import { createClient } from '@supabase/supabase-js';
import { embedTexts } from '@/lib/iros/llm/embeddings';

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export async function vectorSearch({
  supabaseUrl,
  supabaseKey,
  query,
  topK = 5,
  threshold = 0.6,

  // ✅ 互換用：外から embedder を渡してる既存コードがあっても壊さない
  // 方針としては、渡さない運用に寄せていく（embedTexts が単一出口）
  embedder,

  // ✅ 追跡（必要なら呼び元で渡す）
  trace,
}: {
  supabaseUrl: string;
  supabaseKey: string;
  query: string;
  topK?: number;
  threshold?: number;

  embedder?: Embedder;

  trace?: {
    traceId?: string | null;
    conversationId?: string | null;
    userCode?: string | null;
  };
}) {
  const sb = createClient(supabaseUrl, supabaseKey);

  const [qv] = embedder
    ? await embedder.embed([query])
    : await embedTexts({
        purpose: 'retrieval',
        input: [query],
        trace,
      });

  const { data, error } = await sb.rpc('match_knowledge', {
    query_embedding: qv,
    match_count: topK,
    match_threshold: threshold,
  });
  if (error) throw error;

  return (data ?? []) as Array<{
    id: string;
    title: string;
    content: string | null;
    url: string | null;
    similarity: number;
  }>;
}
