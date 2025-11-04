import type { Message, PostMessageParams, MessageRole } from './types';

/** 会話一覧取得（/api/sofia GET?user_code=...） */
export async function getConversations(user_code: string) {
  if (!user_code) return { data: [] };
  const url = `/api/sofia?user_code=${encodeURIComponent(user_code)}`;
  const rs = await fetch(url, { method: 'GET', cache: 'no-store' });
  const js = await rs.json().catch(() => ({}));

  // /api/sofia の GET は { items: [{conversation_code, title, updated_at, last_text}] }
  const data = (js?.items ?? []).map((r: any) => ({
    id: String(r.conversation_code),
    title: r.title ?? '新しい会話',
    updated_at: r.updated_at ?? null,
    last_text: r.last_text ?? null,
  }));

  return { data };
}

/** メッセージ取得（/api/sofia GET?user_code=...&conversation_code=...） */
export async function getMessages(
  user_code: string,
  conversation_code: string,
): Promise<Message[]> {
  if (!user_code || !conversation_code) return [];
  const url = `/api/sofia?user_code=${encodeURIComponent(user_code)}&conversation_code=${encodeURIComponent(conversation_code)}`;
  const rs = await fetch(url, { method: 'GET', cache: 'no-store' });
  const js = await rs.json().catch(() => ({}));

  const rows = (js?.messages ?? []) as Array<{ role: string; content: string }>;

  // 🔧 サーバーは role を string で返すので、 期待型にアサート
  return rows.map((m, i) => ({
    id: `${i}`,
    role: (m.role as MessageRole) ?? 'assistant',
    content: m.content ?? '',
  }));
}

/** 送信（/api/sofia POST）→ 返信＆conversation_code を返す */
export async function postMessage(payload: PostMessageParams): Promise<{
  conversation_id?: string;
  credits?: number;
  metadata?: any;
  alertMessage?: string;
  error?: string;
  needed?: boolean;
}> {
  const body = {
    user_code: payload.user, // ← API 仕様に合わせる
    conversation_code: payload.conversation_id,
    mode: 'normal',
    // クライアント側は user 入力だけを渡す
    messages: [{ role: 'user', content: payload.query }],
  };

  const rs = await fetch('/api/sofia', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const js = await rs.json().catch(() => ({}));

  // /api/sofia の戻り値: { conversation_code, reply, meta }
  return {
    conversation_id: js?.conversation_code,
    metadata: js?.meta,
  };
}
