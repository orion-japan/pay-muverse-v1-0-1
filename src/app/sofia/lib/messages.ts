// sofia/lib/messages.ts
import { fetchWithIdToken } from '@/lib/fetchWithIdToken';

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  uploaded_image_urls?: string[];
  isPreview?: boolean;
};

export type PostMessageParams = {
  query: string;
  user: string;                  // user_code
  conversation_id?: string;      // sofia: conversation_code
  response_mode?: 'blocking';
  inputs?: Record<string, any>;
  files?: Array<{
    type: 'image';
    transfer_method: 'local_file';
    upload_file_id: string;
  }>;
};

/** 会話一覧取得（/api/sofia?user_code=...） */
export async function getConversations(userCode: string) {
  const r = await fetchWithIdToken(
    `/api/sofia?user_code=${encodeURIComponent(userCode)}`
  );
  const js = await r.json().catch(() => ({}));
  // sofia_conversations -> {conversation_code, title}
  const data = (js?.items ?? []).map((it: any) => ({
    id: String(it.conversation_code),
    name: it.title ?? '新しい会話',
  }));
  return { data };
}

/** 会話メッセージ取得（/api/sofia?user_code&conversation_code） */
export async function getMessages(userCode: string, convId: string): Promise<Message[]> {
  const r = await fetchWithIdToken(
    `/api/sofia?user_code=${encodeURIComponent(userCode)}&conversation_code=${encodeURIComponent(convId)}`
  );
  const js = await r.json().catch(() => ({}));
  const msgs = Array.isArray(js?.messages) ? js.messages : [];
  // sofia は id を持たないので、クライアント側で合成
  return msgs.map((m: any, i: number) => ({
    id: `${convId}-${i}-${m.role}-${(m.content ?? '').slice(0, 8)}`,
    role: m.role,
    content: m.content ?? '',
  }));
}

/** 送信（/api/sofia POST）。現在の履歴にユーザー発言を足して送る */
export async function postMessage(params: PostMessageParams): Promise<{
  conversation_id?: string;
  metadata?: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; total_price?: number } };
  credits?: number;
  alertMessage?: string;
  error?: string;
  needed?: boolean;
}> {
  const userCode = params.user;
  const convId = params.conversation_id ?? '';

  // 既存履歴を取ってからユーザー発言を追加
  const history = convId ? await getMessages(userCode, convId) : [];
  const next = [
    ...history.map(({ role, content }) => ({ role, content })),
    { role: 'user' as const, content: params.query }
  ];

  const r = await fetchWithIdToken('/api/sofia', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user_code: userCode,
      conversation_code: convId,
      mode: 'normal',
      messages: next,
    }),
  });

  const js = await r.json().catch(() => ({}));
  // sofia の応答は { conversation_code, reply, meta }
  // 見本の戻り値に寄せて最低限合わせる
  return {
    conversation_id: js?.conversation_code,
    metadata: { usage: undefined },
    credits: undefined,
    alertMessage: undefined,
    error: r.ok ? undefined : 'send_failed',
    needed: r.ok ? undefined : true,
  };
}
