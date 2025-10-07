/* eslint-disable @typescript-eslint/no-explicit-any */

import { fetchWithIdToken } from '@/lib/fetchWithIdToken';
import type {
  Agent,
  ConvListItem,
  Message,
  Role,
  SofiaGetList,
  SofiaGetMessages,
} from './types';

/* =========================================================
 * Agent 正規化
 * =======================================================*/
export const normalizeAgent = (a?: string): Agent => {
  const s = (a ?? '').toLowerCase();
  if (s.startsWith('mu')) return 'mu';
  if (s.startsWith('mirra') || s === 'm' || s === 'mr') return 'mirra';
  return 'iros';
};

/* =========================================================
 * 送信モード（任意）
 * =======================================================*/
export type SendMode = 'talk' | 'analysis';

/* =========================================================
 * Utilities
 * =======================================================*/
async function tryFetchJson(
  url: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; json: any; text?: string }> {
  let r: Response;
  try {
    r = await fetchWithIdToken(url, init);
  } catch {
    return { ok: false, status: 0, json: null };
  }
  let json: any = null;
  try {
    json = await r.json();
  } catch {
    try {
      const t = await r.text();
      if (t) return { ok: r.ok, status: r.status, json: null, text: t };
    } catch {}
  }
  return { ok: r.ok, status: r.status, json };
}

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** ローカル開発時のみ Mui API にユーザーを伝えるヘッダー */
const devHeaders = (userCode?: string) => {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.NODE_ENV !== 'production' && userCode) {
    h['x-mu-user'] = userCode; // app/api/agent/mui/route.ts の開発フォールバックが読む
  }
  return h;
};

/* =========================================================
 * 会話一覧
 * =======================================================*/
export async function listConversations(
  agent: Agent,
  userCode: string,
  _urlCid?: string
): Promise<ConvListItem[]> {
  if (agent === 'mu') {
    const primary = await tryFetchJson('/api/agent/muai/conversations');
    const r = primary.ok ? primary : await tryFetchJson('/api/mu/list');
    if (!r.ok) throw new Error(`mu list ${r.status || 'noresp'}`);

    const js: any = r.json ?? {};
    const list: ConvListItem[] = (js.items ?? [])
      .map((x: any) => ({
        id: String(x.conversation_id ?? x.id ?? x.master_id ?? ''),
        title: String(x.title ?? 'Mu 会話'),
        updated_at: x.updated_at ?? x.created_at ?? null,
      }))
      .filter((x: any) => x.id);
    list.sort(
      (a, b) =>
        new Date(b.updated_at ?? 0).getTime() - new Date(a.updated_at ?? 0).getTime()
    );
    return list;
  }

  if (agent === 'mirra') {
    const r1 = await tryFetchJson('/api/agent/mtalk/history?agent=mirra');
    const r = r1.ok ? r1 : await tryFetchJson('/api/agent/mtalk/conversations?limit=100');
    if (!r.ok) throw new Error(`mirra list ${r.status || 'noresp'}`);

    const js: any = r.json ?? {};
    const items = Array.isArray(js.items) ? js.items : Array.isArray(js) ? js : [];
    const list: ConvListItem[] = items
      .map((it: any) => ({
        id: String(it.conversation_id ?? it.id ?? ''),
        title: String(it.title ?? 'mirra 会話'),
        updated_at: it.updated_at ?? it.created_at ?? null,
      }))
      .filter((x: any) => x.id);
    list.sort(
      (a, b) =>
        new Date(b.updated_at ?? 0).getTime() - new Date(a.updated_at ?? 0).getTime()
    );
    return list;
  }

  // iros
  const r = await fetchWithIdToken(
    `/api/sofia?user_code=${encodeURIComponent(userCode)}`
  );
  if (!r.ok) throw new Error(`list ${r.status}`);
  const js: SofiaGetList = await r.json().catch(() => ({} as any));
  const list: ConvListItem[] = (js.items ?? [])
    .map((row) => ({
      id: String(row.conversation_code ?? ''),
      title:
        row.title ??
        (row.updated_at
          ? `会話 (${new Date(row.updated_at).toLocaleString()})`
          : '新しい会話'),
      updated_at: row.updated_at ?? null,
    }))
    .filter((x) => x.id);
  list.sort(
    (a, b) =>
      new Date(b.updated_at ?? 0).getTime() - new Date(a.updated_at ?? 0).getTime()
  );
  return list;
}

/* =========================================================
 * メッセージ取得
 * =======================================================*/
export async function fetchMessages(
  agent: Agent,
  _userCode: string,
  convId: string
): Promise<Message[]> {
  if (agent === 'mu') {
    const r = await fetchWithIdToken(
      `/api/agent/muai/turns?conv_id=${encodeURIComponent(convId)}`
    );
    if (!r.ok) throw new Error(`mu turns ${r.status}`);
    const js: any = await r.json().catch(() => ({}));
    return (js.items ?? []).map((m: any) => ({
      id: String(m.id),
      role:
        (m.role === 'bot' ? 'assistant' : (m.role as Role)) ?? ('assistant' as Role),
      content: String(m.content ?? ''),
      created_at: m.created_at ?? m.inserted_at ?? undefined,
      meta: m.meta ?? undefined,
    }));
  }

  if (agent === 'mirra') {
    const r = await fetchWithIdToken(
      `/api/agent/mtalk/messages?conversation_id=${encodeURIComponent(convId)}`,
      { cache: 'no-store' }
    );
    if (!r.ok) throw new Error(`mirra messages ${r.status}`);
    const j: any = await r.json().catch(() => ({}));
    const raw = Array.isArray(j?.messages)
      ? j.messages
      : Array.isArray(j?.items)
      ? j.items
      : [];
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
    `/api/sofia?user_code=${encodeURIComponent(
      _userCode
    )}&conversation_code=${encodeURIComponent(convId)}`
  );
  if (!r.ok) throw new Error(`messages ${r.status}`);
  const js: SofiaGetMessages = await r.json().catch(() => ({} as any));
  return (js.messages ?? []).map((m, i) => ({
    id: `${i}-${m.role}-${m.content.slice(0, 8)}`,
    role: (m.role as Role) ?? 'assistant',
    content: m.content,
  })) as Message[];
}

/* =========================================================
 * Mu 送信（Mui API 経由）
 * =======================================================*/
// src/components/SofiaChat/agentClients.ts

// 旧: Mui API 経由
async function sendMuViaMuiAPI(args: {
  userCode: string;
  conversationId?: string;
  messagesSoFar: Message[];
  text: string;
}) {
  // 直近 50 件 + 今回の user を渡す（履歴はサーバでも復元されるので必須ではない）
  const hist = (Array.isArray(args.messagesSoFar) ? args.messagesSoFar : []).slice(-50);
  const messages = [
    ...hist.map((m) => ({ role: m.role, content: String(m.content ?? '') })),
    { role: 'user' as const, content: args.text },
  ];

  // 🔁 ここを /api/agent/muai に
  // 🔁 認証付き fetch を使う（fetchWithIdToken）
  const r = await fetchWithIdToken('/api/agent/muai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // muai は message が必須。ID はあれば両方で渡す（互換）
      message: args.text,
      ...(args.conversationId
        ? { master_id: args.conversationId, conversation_id: args.conversationId }
        : {}),
      source_type: 'chat',
      // 旧 mui の use_kb 等は muai では不要
    }),
  });

  let js: any = {};
  try {
    js = await r.json();
  } catch {
    try { js = { reply: await r.text() }; } catch {}
  }

  // muai の返り値に合わせて解決
  const nextConvId =
    js?.conversation_id ??
    js?.master_id ??
    js?.meta?.master_id ??
    args.conversationId ??
    null;

  const replyText = js?.reply ?? js?.reply_text ?? js?.message ?? '';

  return {
    conversationId: nextConvId,
    replyText,
    rows: null as Message[] | null, // 保存はサーバで済むので、直後に fetchMessages で補完
    meta: js?.meta,
    credit: js?.credit_balance ?? js?.credit ?? null,
  };
}


/* =========================================================
 * 送信（LLM 呼び出しを必ず発火）
 * =======================================================*/
export async function sendText(
  agent: Agent,
  args: {
    userCode: string;
    conversationId?: string;
    messagesSoFar: Message[];
    text: string;
    mode?: SendMode;
  }
) {
  const { userCode, conversationId, messagesSoFar, text } = args;

  if (agent === 'mirra') {
    const tid = conversationId ?? `mirra-${userCode}`;
    const candidates = [
      { url: '/api/agent/mtalk', body: { text, thread_id: tid, user_code: userCode } },
      { url: '/api/mtalk/mirra', body: { text, thread_id: tid, user_code: userCode } },
      { url: '/api/agent/mtalk/message', body: { text, thread_id: tid, user_code: userCode } },
      { url: '/api/talk', body: { text, threadId: tid, thread_id: tid, user_code: userCode } },
    ] as const;

    let resp: { ok: boolean; status: number; json: any; text?: string } | null = null;
    for (const c of candidates) {
      resp = await tryFetchJson(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-code': userCode },
        body: JSON.stringify(c.body),
      });
      if (resp.ok || (resp.status !== 401 && resp.status !== 404)) break;
    }
    if (!resp) throw new Error('mirra send failed (no response)');

    const js = resp.json;
    const nextConvId = js?.conversation_id || js?.thread_id || conversationId || tid;
    const replyText =
      js?.reply ?? js?.reply_text ?? js?.message ?? resp.text ?? '';

    if (!replyText && nextConvId) {
      const rows = await fetchMessages('mirra', userCode, nextConvId);
      return { conversationId: nextConvId, replyText: '', rows, meta: js?.meta, credit: js?.credit_balance };
    }
    return { conversationId: nextConvId, replyText, rows: null, meta: js?.meta, credit: js?.credit_balance };
  }

  if (agent === 'mu') {
    // まず Mui API で生成・保存
    const res = await sendMuViaMuiAPI({ userCode, conversationId, messagesSoFar, text });

    // rows が無い場合は反映済み前提で直後に強制再取得（UI を最速更新）
    if (res.conversationId) {
      // 反映の誤差を吸収
      await new Promise((r) => setTimeout(r, 300));
      const rows = await fetchMessages('mu', userCode, res.conversationId);
      return { ...res, rows };
    }
    return res;
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
  try {
    js = await r.json();
  } catch {
    const txt = await r.text();
    js = { reply: txt };
  }
  return {
    conversationId: js?.conversation_code ?? conversationId,
    replyText: js?.reply ?? js?.reply_text ?? js?.message ?? '',
    rows: null,
    meta: js?.meta,
    credit: js?.credit_balance,
  };
}

/* =========================================================
 * rename / delete
 * =======================================================*/
export async function renameConversation(agent: Agent, id: string, newTitle: string) {
  if (agent === 'mu') {
    await fetchWithIdToken('/api/agent/muai/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: id, title: newTitle }),
    });
    return;
  }
  if (agent === 'mirra') {
    await fetchWithIdToken(
      `/api/agent/mtalk/conversations/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      }
    );
    return;
  }
  await fetchWithIdToken('/api/sofia/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_code: id, title: newTitle }),
  });
}

export async function deleteConversation(agent: Agent, id: string) {
  if (agent === 'mu') {
    // サーバ側は conversation_id / conv_id / id（ボディ or クエリ）の全てを受理
    const convId = String(id ?? '').trim();
    const qs = new URLSearchParams({ conversation_id: convId }).toString();
    await fetchWithIdToken(`/api/agent/muai/delete?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: convId, conv_id: convId, id: convId }),
    });
    return;
  }
  if (agent === 'mirra') {
    await fetchWithIdToken(
      `/api/agent/mtalk/conversations/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
    return;
  }
  await fetchWithIdToken('/api/sofia/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_code: id }),
  });
}
