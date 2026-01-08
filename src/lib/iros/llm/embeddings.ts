// src/lib/iros/llm/embeddings.ts
// iros — Single Embeddings Exit (/v1/embeddings)
// 方針：
// - Embeddings の「出口」はここだけ
// - OpenAI SDK（import OpenAI）は使わない（fetchで統一）
// - 返却は number[][]（入力順を保つ）
// - 失敗時は status + body を含めて落とす（原因追跡）

export type EmbeddingPurpose = 'retrieval' | 'memory' | 'search';

export type EmbedArgs = {
  purpose: EmbeddingPurpose; // ✅ 必須（ログ/制御用）
  input: string[];          // ✅ 必須
  model?: string;           // 例: 'text-embedding-3-large'（未指定なら ENV/fallback）
  apiKey?: string;          // 省略時は process.env.OPENAI_API_KEY
  endpoint?: string;        // 既定: https://api.openai.com/v1/embeddings
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  trace?: {
    traceId?: string | null;
    conversationId?: string | null;
    userCode?: string | null;
  };
};

function nowMs() {
  return Date.now();
}

function pickDefaultEmbeddingModel() {
  return (
    process.env.EMB_MODEL ||
    process.env.OPENAI_EMB_MODEL ||
    'text-embedding-3-large'
  );
}

function safeTrimEnd(s: unknown): string {
  return String(s ?? '').replace(/\r\n/g, '\n').trimEnd();
}

export async function embedTexts(args: EmbedArgs): Promise<number[][]> {
  const {
    purpose,
    input,
    model = pickDefaultEmbeddingModel(),
    apiKey = process.env.OPENAI_API_KEY || '',
    endpoint = 'https://api.openai.com/v1/embeddings',
    extraHeaders = {},
    extraBody = {},
    trace,
  } = args;

  if (!apiKey) throw new Error('OPENAI_API_KEY is missing');
  if (!purpose) throw new Error('embedTexts: purpose is required');
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('embedTexts: input is required');
  }

  const started = nowMs();

  const body: Record<string, any> = {
    model,
    input,
    ...extraBody,
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });

  const elapsed = nowMs() - started;

  if (!res.ok) {
    const text = safeTrimEnd(await res.text().catch(() => ''));
    throw new Error(
      `EMB HTTP ${res.status} (${purpose}) ${trace?.traceId ? `[trace:${trace.traceId}] ` : ''}${text}`,
    );
  }

  const data = await res.json();
  const arr = data?.data;

  if (!Array.isArray(arr)) {
    throw new Error(`EMB returned invalid data (${purpose}): data.data is not an array`);
  }

  const vectors: number[][] = arr.map((d: any) => d?.embedding).filter(Boolean);

  if (vectors.length !== input.length) {
    // OpenAI側が何らかの理由で欠損を返した場合に備えて落とす（検索品質が壊れる）
    throw new Error(
      `EMB count mismatch (${purpose}): input=${input.length} output=${vectors.length}`,
    );
  }

  // ✅ 観測ログ（必要十分）
  try {
    const usage = data?.usage ?? null;
    // eslint-disable-next-line no-console
    console.log('[EMB]', {
      purpose,
      model,
      ms: elapsed,
      ok: true,
      usage,
      traceId: trace?.traceId ?? null,
      conversationId: trace?.conversationId ?? null,
      userCode: trace?.userCode ?? null,
      n: input.length,
    });
  } catch {}

  return vectors;
}
