// src/lib/llm/chatComplete.ts
// iros — Single LLM Exit (chat.completions)
//
// 方針：
// - OpenAI への「出口」はここだけ
// - 用途は purpose で切り替える（writer/judge/digest/title/soul/reply）
// - 「黙らせる」はしない。生成は常に行い、採用/不採用は上位で決める。
//   ※ただし「SCAFFOLDでwriterを呼ぶ」など“設計違反”は、任意でガードできる（後述）
//
// 追加（監査）：
// - 呼び出しの事実を [IROS/LLM][CALL] に必ず残す（writer が呼ばれていない証拠化）
// - 任意の強制ガード：SCAFFOLD で writer を呼んだら例外（IROS_LLM_GUARD!=0 のとき）

import crypto from 'node:crypto';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ChatPurpose = 'writer' | 'judge' | 'digest' | 'title' | 'soul' | 'reply';

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }; // Chat Completions の response_format

type ChatArgs = {
  // ✅ 必須（用途でログ/制御する）
  purpose: ChatPurpose;

  // ✅ 必須
  messages: ChatMessage[];

  // ✅ 推奨：envで統一（未指定なら fallback）
  model?: string;

  // ✅ 省略可
  apiKey?: string;
  temperature?: number;
  max_tokens?: number;

  // 既定: chat.completions
  endpoint?: string;

  // 追加ヘッダ / body 拡張
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;

  // JSON強制など
  responseFormat?: ResponseFormat;

  // 観測用（上位から traceId を渡せる）
  trace?: {
    traceId?: string | null;
    conversationId?: string | null;
    userCode?: string | null;
  };

  // ✅ 監査用（上位の状態を渡せる：証拠強化 / ガード条件に使用）
  audit?: {
    slotPlanPolicy?: 'FINAL' | 'SCAFFOLD' | string | null;
    mode?: string | null;
    qCode?: string | null;
    depthStage?: string | null;
  };

  // 空を許容するか（基本 false。例外が必要なら呼び元で明示）
  allowEmpty?: boolean;
};

function nowMs() {
  return Date.now();
}

function pickDefaultModel() {
  // ✅ “推測で進めない”ため、最終的には ENV で揃える前提。
  // ただし実行不能になるのを避けるため fallback は置く。
  return (
    process.env.IROS_MODEL ||
    process.env.OPENAI_MODEL ||
    process.env.OPENAI_DEFAULT_MODEL ||
    'gpt-4o'
  );
}

function defaultTempByPurpose(purpose: ChatPurpose): number {
  // ✅ soul は JSON司令なので 0 固定を推奨
  if (purpose === 'soul') return 0;
  // ✅ judge/digest/title は揺れを抑える
  if (purpose === 'judge' || purpose === 'digest' || purpose === 'title') return 0.2;
  // ✅ reply は用途が混ざりやすいので揺れを抑え目
  if (purpose === 'reply') return 0.35;
  // ✅ writer は少しだけ息を入れる（ただし上位で制御可）
  return 0.6;
}

function safeTrimEnd(s: unknown): string {
  return String(s ?? '').replace(/\r\n/g, '\n').trimEnd();
}

function makeCallId() {
  // Node なら randomUUID があるが、互換のため short id を採用
  return crypto.randomBytes(6).toString('hex');
}

export async function chatComplete(args: ChatArgs): Promise<string> {
  const {
    purpose,
    messages,
    model = pickDefaultModel(),
    apiKey = process.env.OPENAI_API_KEY || '',
    temperature = defaultTempByPurpose(purpose),
    max_tokens = 512,
    endpoint = 'https://api.openai.com/v1/chat/completions',
    extraHeaders = {},
    extraBody = {},
    responseFormat,
    trace,
    audit,
    allowEmpty = false,
  } = args;

  if (!apiKey) throw new Error('OPENAI_API_KEY is missing');
  if (!purpose) throw new Error('chatComplete: purpose is required');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('chatComplete: messages is required');
  }

  const callId = makeCallId();
  const started = nowMs();

  // ✅ 任意の強制ガード：SCAFFOLD で writer を呼ぶのは設計違反（最短方針A）
  // - IROS_LLM_GUARD=0 で無効化（本番など）
  const guardOn = process.env.IROS_LLM_GUARD !== '0';
  if (guardOn && audit?.slotPlanPolicy === 'SCAFFOLD' && purpose === 'writer') {
    const msg = `[IROS/LLM][GUARD] writer called under SCAFFOLD (callId=${callId})`;
    // eslint-disable-next-line no-console
    console.error(msg, {
      callId,
      purpose,
      model,
      temperature,
      traceId: trace?.traceId ?? null,
      conversationId: trace?.conversationId ?? null,
      userCode: trace?.userCode ?? null,
      slotPlanPolicy: audit?.slotPlanPolicy ?? null,
      mode: audit?.mode ?? null,
      qCode: audit?.qCode ?? null,
      depthStage: audit?.depthStage ?? null,
    });
    throw new Error(msg);
  }

  const body: Record<string, any> = {
    model,
    messages,
    temperature,
    max_tokens,
    ...extraBody,
  };

  if (responseFormat && responseFormat.type !== 'text') {
    body.response_format = responseFormat; // { type: 'json_object' }
  }

  // ✅ 監査ログ（CALLの事実を必ず残す）
  // - 「writer が一度も呼ばれていない」証拠化は、このログを grep するだけで成立する
// ✅ 監査ログ（CALLの事実を必ず残す）
try {
  // 呼び出し元（1行だけ）を入れる
  // stack例: "Error\n  at chatComplete (...)\n  at <CALLER> ..."
  const caller =
    new Error().stack?.split('\n')?.[2]?.trim() ?? null;

  // eslint-disable-next-line no-console
  console.log('[IROS/LLM][CALL]', {
    callId,
    purpose,
    model,
    temperature,
    responseFormat: responseFormat?.type ?? 'text',
    endpoint,
    traceId: trace?.traceId ?? null,
    conversationId: trace?.conversationId ?? null,
    userCode: trace?.userCode ?? null,
    slotPlanPolicy: audit?.slotPlanPolicy ?? null,
    mode: audit?.mode ?? null,
    qCode: audit?.qCode ?? null,
    depthStage: audit?.depthStage ?? null,
    msgCount: Array.isArray(messages) ? messages.length : 0,
    caller,
  });
} catch {}

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
    const text = await res.text().catch(() => '');
    // ✅ ここで purpose/trace/audit を必ず残す（原因追跡）
    const errMsg = `LLM HTTP ${res.status} (${purpose}) ${trace?.traceId ? `[trace:${trace.traceId}] ` : ''}${text}`;
    // eslint-disable-next-line no-console
    console.error('[IROS/LLM][ERR]', {
      callId,
      purpose,
      model,
      ms: elapsed,
      ok: false,
      traceId: trace?.traceId ?? null,
      conversationId: trace?.conversationId ?? null,
      userCode: trace?.userCode ?? null,
      slotPlanPolicy: audit?.slotPlanPolicy ?? null,
      mode: audit?.mode ?? null,
      qCode: audit?.qCode ?? null,
      depthStage: audit?.depthStage ?? null,
      status: res.status,
      bodyHead: String(text ?? '').slice(0, 400),
    });
    throw new Error(errMsg);
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content;

  if (typeof raw !== 'string') {
    // eslint-disable-next-line no-console
    console.error('[IROS/LLM][ERR]', {
      callId,
      purpose,
      model,
      ms: elapsed,
      ok: false,
      traceId: trace?.traceId ?? null,
      conversationId: trace?.conversationId ?? null,
      userCode: trace?.userCode ?? null,
      slotPlanPolicy: audit?.slotPlanPolicy ?? null,
      mode: audit?.mode ?? null,
      qCode: audit?.qCode ?? null,
      depthStage: audit?.depthStage ?? null,
      err: `non-string content: ${typeof raw}`,
    });
    throw new Error(`LLM returned non-string content (${purpose}): ${typeof raw}`);
  }

  const out = safeTrimEnd(raw);

  // ✅ “空”は原則バグとして扱う（黙らせ制御をしないため）
  if (!allowEmpty && out.trim().length === 0) {
    // eslint-disable-next-line no-console
    console.error('[IROS/LLM][ERR]', {
      callId,
      purpose,
      model,
      ms: elapsed,
      ok: false,
      traceId: trace?.traceId ?? null,
      conversationId: trace?.conversationId ?? null,
      userCode: trace?.userCode ?? null,
      slotPlanPolicy: audit?.slotPlanPolicy ?? null,
      mode: audit?.mode ?? null,
      qCode: audit?.qCode ?? null,
      depthStage: audit?.depthStage ?? null,
      err: 'empty content',
    });
    throw new Error(`LLM empty content (${purpose})`);
  }

  const caller = new Error().stack?.split('\n')?.[2]?.trim() ?? null;


  // ✅ 観測ログ（必要十分）
  try {
    const usage = data?.usage ?? null;
    // eslint-disable-next-line no-console
    console.log('[IROS/LLM][OK]', {
      callId,
      purpose,
      model,
      ms: elapsed,
      ok: true,
      usage,
      traceId: trace?.traceId ?? null,
      conversationId: trace?.conversationId ?? null,
      userCode: trace?.userCode ?? null,
      slotPlanPolicy: audit?.slotPlanPolicy ?? null,
      mode: audit?.mode ?? null,
      qCode: audit?.qCode ?? null,
      depthStage: audit?.depthStage ?? null,
      outLen: out.length,
      outHead: out.slice(0, 80),
    });
  } catch {}

  return out;
}

// ✅ soul/digest 等で JSON を返す用途（JSON.parse 前提）
// - “自然文禁止”は system prompt 側で縛る
export async function chatCompleteJSON<T = any>(
  args: Omit<ChatArgs, 'responseFormat'> & { responseFormat?: ResponseFormat },
): Promise<T> {
  const raw = await chatComplete({
    ...args,
    responseFormat: args.responseFormat ?? { type: 'json_object' },
  });

  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[IROS/LLM][JSON_ERR]', {
      purpose: args.purpose,
      traceId: args.trace?.traceId ?? null,
      conversationId: args.trace?.conversationId ?? null,
      userCode: args.trace?.userCode ?? null,
      slotPlanPolicy: args.audit?.slotPlanPolicy ?? null,
      mode: args.audit?.mode ?? null,
      qCode: args.audit?.qCode ?? null,
      depthStage: args.audit?.depthStage ?? null,
      head: raw.slice(0, 200),
      err: String(e),
    });
    throw new Error(
      `LLM JSON parse failed (${args.purpose}): ${String(e)} | head=${raw.slice(0, 120)}`,
    );
  }
}
