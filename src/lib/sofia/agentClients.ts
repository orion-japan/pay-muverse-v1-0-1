// src/lib/sofia/agentClients.ts

/**
 * Sofia / Iros 共通のクライアント呼び出しユーティリティ。
 * - UI からは sendText(agent, payload) を呼べばOK
 * - 既存の Sofia ルート: /api/agent/chat
 * - 新規の Iros ルート:   /api/agent/iros
 */

export type Agent = 'sofia' | 'iros';

export type SendPayload = {
  text: string;
  userCode?: string;
  conversationId?: string;
};

export type SendResult = {
  ok: boolean;
  reply: string;
  rows?: Array<string | Record<string, any>>;
  meta?: Record<string, any>;
};

/** 既存：Sofia 用 API 呼び出し */
export async function callSofiaAPI(payload: SendPayload): Promise<SendResult> {
  const res = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Sofia API error: ${res.status}`);
  return (await res.json()) as SendResult;
}

/** 新規：Iros 用 API 呼び出し */
export async function callIrosAPI(payload: SendPayload): Promise<SendResult> {
  const res = await fetch('/api/agent/iros', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Iros API error: ${res.status}`);
  return (await res.json()) as SendResult;
}

/**
 * UI からはこの1本を使う想定。
 * agent に応じて適切な API へ振り分ける。
 */
export async function sendText(agent: Agent, payload: SendPayload): Promise<SendResult> {
  if (agent === 'iros') return await callIrosAPI(payload);
  return await callSofiaAPI(payload);
}

/**
 * クエリパラメータから agent を推定（例：?agent=iros）
 * SSRでも型エラーしないように try-catch で保護。
 */
export function detectAgentFromLocation(defaultAgent: Agent = 'sofia'): Agent {
  try {
    if (typeof window === 'undefined') return defaultAgent;
    const u = new URL(window.location.href);
    const a = (u.searchParams.get('agent') || '').toLowerCase();
    return a === 'iros' ? 'iros' : 'sofia';
  } catch {
    return defaultAgent;
  }
}
