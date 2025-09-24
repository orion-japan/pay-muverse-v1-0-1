import { fetchWithIdToken } from '@/lib/fetchWithIdToken';
import type { Agent, ConvListItem, Message, Role, SofiaGetList, SofiaGetMessages } from './types';

export const normalizeAgent = (a?: string): Agent => {
  const s = (a ?? '').toLowerCase();
  if (s.startsWith('mu')) return 'mu';
  if (s.startsWith('mirra') || s === 'm' || s === 'mr') return 'mirra';
  return 'iros';
};

/* ===== list conversations ===== */
export async function listConversations(agent: Agent, userCode: string, urlCid?: string): Promise<ConvListItem[]> {
  if (agent === 'mu') {
    const r =
      (await fetchWithIdToken('/api/agent/muai/conversations').catch(() => null)) ||
      (await fetchWithIdToken('/api/mu/list').catch(() => null));
    if (!r || !r.ok) throw new Error(`mu list ${r?.status ?? 'noresp'}`);
    const js: any = await r.json().catch(() => ({}));
    return (js.items ?? [])
      .map((x: any) => ({
        id: String(x.conversation_id ?? x.id ?? x.master_id ?? ''),
        title: String(x.title ?? 'Mu 会話'),
        updated_at: x.updated_at ?? null,
      }))
      .filter((x: any) => x.id);
  }

  if (agent === 'mirra') {
    const r = await fetchWithIdToken('/api/agent/mtalk/conversations', { cache: 'no-store' });
    if (!r.ok) throw new Error(`mirra list ${r.status}`);
    const j: any = await r.json().catch(() => ({}));
    return (j.items ?? [])
      .map((x: any) => ({
        id: String(x.conversation_id ?? x.id ?? ''),
        title: String(x.title ?? 'mirra 会話'),
        updated_at: x.updated_at ?? null,
      }))
      .filter((x: any) => x.id);
  }

  // iros
  const r = await fetchWithIdToken(`/api/sofia?user_code=${encodeURIComponent(userCode)}`);
  if (!r.ok) throw new Error(`list ${r.status}`);
  const js: SofiaGetList = await r.json().catch(() => ({}));
  return (js.items ?? [])
    .map((row) => ({
      id: String(row.conversation_code ?? ''),
      title:
        row.title ??
        (row.updated_at ? `会話 (${new Date(row.updated_at).toLocaleString()})` : '新しい会話'),
      updated_at: row.updated_at ?? null,
    }))
    .filter((x) => x.id);
}

/* ===== fetch messages ===== */
export async function fetchMessages(agent: Agent, userCode: string, convId: string): Promise<Message[]> {
  if (agent === 'mu') {
    const r = await fetchWithIdToken(`/api/agent/muai/turns?conv_id=${encodeURIComponent(convId)}`);
    if (!r.ok) throw new Error(`mu turns ${r.status}`);
    const js: any = await r.json().catch(() => ({}));
    return (js.items ?? []).map((m: any) => ({
      id: m.id,
      role: (m.role as Role) ?? 'assistant',
      content: m.content,
      created_at: m.created_at,
    }));
  }

  if (agent === 'mirra') {
    const r = await fetchWithIdToken(
      `/api/agent/mtalk/messages?conversation_id=${encodeURIComponent(convId)}`,
      { cache: 'no-store' }
    );
    if (!r.ok) throw new Error(`mirra messages ${r.status}`);
    const j: any = await r.json().catch(() => ({}));
    const raw = Array.isArray(j?.messages) ? j.messages : Array.isArray(j?.items) ? j.items : [];
    return raw.map((m: any, i: number) => ({
      id: String(m.id ?? `${i}-${m.role}-${String(m.content ?? '').slice(0, 8)}`),
      role: (m.role as Role) ?? 'assistant',
      content: String(m.content ?? ''),
      created_at: m.created_at ?? undefined,
      meta: m.meta ?? undefined,
    }));
  }

  // iros
  const r = await fetchWithIdToken(
    `/api/sofia?user_code=${encodeURIComponent(userCode)}&conversation_code=${encodeURIComponent(convId)}`
  );
  if (!r.ok) throw new Error(`messages ${r.status}`);
  const js: SofiaGetMessages = await r.json().catch(() => ({}));
  return (js.messages ?? []).map((m, i) => ({
    id: `${i}-${m.role}-${m.content.slice(0, 8)}`,
    role: (m.role as Role) ?? 'assistant',
    content: m.content,
  })) as Message[];
}

/* ===== send text ===== */
export async function sendText(agent: Agent, args: {
  userCode: string;
  conversationId?: string;
  messagesSoFar: Message[];
  text: string;
}) {
  const { userCode, conversationId, messagesSoFar, text } = args;

  if (agent === 'mirra') {
    const tid = conversationId ?? `mirra-${userCode}`;
    const candidates = [
      { url: '/api/agent/mtalk',         body: { text, thread_id: tid, user_code: userCode } },
      { url: '/api/mtalk/mirra',         body: { text, thread_id: tid, user_code: userCode } },
      { url: '/api/agent/mtalk/message', body: { text, thread_id: tid, user_code: userCode } },
      { url: '/api/talk',                body: { text, threadId: tid, thread_id: tid, user_code: userCode } },
    ];
    let js: any = null, res: Response | null = null;
    for (const { url, body } of candidates) {
      try {
        res = await fetchWithIdToken(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-code': userCode },
          body: JSON.stringify(body),
        });
      } catch { res = null; }
      if (!res || res.status === 401 || res.status === 404) continue;

      try { js = await res.json(); } catch {
        try { const t = await res.text(); if (t) js = { reply: t }; } catch {}
      }
      break;
    }
    if (!js) throw new Error('mirra send failed');

    const nextConvId = js?.conversation_id || js?.thread_id || js?.threadId || conversationId || tid;
    let replyText =
      typeof js?.reply === 'string' ? js.reply :
      typeof js?.reply_text === 'string' ? js.reply_text :
      typeof js?.message === 'string' ? js.message :
      typeof js === 'string' ? js : '';

    // 応答空→再取得（サーバ保存前提）
    if (!replyText && nextConvId) {
      const rows = await fetchMessages('mirra', userCode, nextConvId);
      return { conversationId: nextConvId, replyText: '', rows, meta: js?.meta, credit: js?.credit_balance };
    }

    return { conversationId: nextConvId, replyText, rows: null, meta: js?.meta, credit: js?.credit_balance };
  }

  if (agent === 'mu') {
    const subId = crypto.randomUUID?.() ?? `sub-${Date.now()}`;
    const r = await fetchWithIdToken('/api/agent/muai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        master_id: conversationId ?? undefined,
        sub_id: subId,
        thread_id: null,
        board_id: null,
        source_type: 'chat',
      }),
    });
    let js: any = {};
    try { js = await r.json(); } catch { try { js = { reply: await r.text() }; } catch {} }
    return {
      conversationId: js?.conversation_id ?? conversationId,
      replyText: js?.reply ?? js?.reply_text ?? js?.message ?? '',
      rows: null,
      meta: js?.meta,
      credit: js?.credit_balance
    };
  }

  // iros
  const r = await fetchWithIdToken('/api/sofia', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_code: conversationId ?? '',
      mode: 'normal',
      messages: [
        ...messagesSoFar.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: text },
      ],
    }),
  });
  let js: any = {};
  try { js = await r.json(); } catch { try { js = { reply: await r.text() }; } catch {} }
  return {
    conversationId: js?.conversation_code ?? conversationId,
    replyText: js?.reply ?? js?.reply_text ?? js?.message ?? '',
    rows: null,
    meta: js?.meta,
    credit: js?.credit_balance
  };
}

/* ===== rename / delete ===== */
export async function renameConversation(agent: Agent, id: string, newTitle: string) {
  if (agent === 'mu') {
    await fetchWithIdToken('/api/agent/muai/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: id, title: newTitle }),
    });
    return;
  }
  if (agent === 'mirra') {
    await fetchWithIdToken(`/api/agent/mtalk/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle }),
    });
    return;
  }
  await fetchWithIdToken('/api/sofia/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_code: id, title: newTitle }),
  });
}

export async function deleteConversation(agent: Agent, id: string) {
  if (agent === 'mu') {
    await fetchWithIdToken('/api/agent/muai/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: id }),
    });
    return;
  }
  if (agent === 'mirra') {
    await fetchWithIdToken(`/api/agent/mtalk/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return;
  }
  await fetchWithIdToken('/api/sofia/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_code: id }),
  });
}
