// src/lib/iros/memory/retrieval_vector.ts
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export class OpenAIEmbedder implements Embedder {
  private openai: OpenAI;
  private model: string;

  constructor(model = (process.env.EMB_MODEL || 'text-embedding-3-large')!, apiKey = process.env.OPENAI_API_KEY!) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is missing');
    this.openai = new OpenAI({ apiKey });
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const resp = await this.openai.embeddings.create({
      model: this.model,
      input: texts,
    });
    return resp.data.map(d => d.embedding as number[]);
  }
}

export async function vectorSearch({
  supabaseUrl,
  supabaseKey,
  query,
  topK = 5,
  threshold = 0.6,
  embedder,
}: {
  supabaseUrl: string;
  supabaseKey: string;
  query: string;
  topK?: number;
  threshold?: number;
  embedder: Embedder;
}) {
  const sb = createClient(supabaseUrl, supabaseKey);
  const [qv] = await embedder.embed([query]);

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
