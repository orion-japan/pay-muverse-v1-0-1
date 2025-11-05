// /src/ui/iroschat/lib/irosApi.ts
'use client';
import { getAuth } from 'firebase/auth';

export type IrosMessage = { id: string; role: 'user'|'assistant'; text: string; ts: number };
export type IrosConversation = { id: string; title: string; updated_at?: string|null };
export type UserInfo = { id: string; name: string; userType: string; credits: number };

async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const u = getAuth().currentUser;
  const token = u ? await u.getIdToken(false) : null;
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers as Record<string,string> | undefined),
  };
  const res = await fetch(input, { ...init, headers, credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(()=> '')}`);
  return res;
}

const randId = () => globalThis.crypto?.randomUUID?.() ?? String(Date.now());

export async function listConversations(): Promise<IrosConversation[]> {
  const j = await (await authFetch('/api/agent/iros/conversations')).json();
  const list = Array.isArray(j?.conversations) ? j.conversations : Array.isArray(j?.rows) ? j.rows : [];
  return list.map((c: any) => ({ id: String(c.id), title: String(c.title ?? ''), updated_at: c.updated_at ?? null }));
}

export async function fetchMessages(conversationId: string): Promise<IrosMessage[]> {
  const j = await (await authFetch(`/api/agent/iros/messages?conversation_id=${encodeURIComponent(conversationId)}`)).json();
  const raw = Array.isArray(j?.messages) ? j.messages : Array.isArray(j?.rows) ? j.rows : [];
  return (raw || []).map((m: any) => ({
    id: String(m.id ?? randId()),
    role: m.role === 'user' ? 'user' : 'assistant',
    text: String(m.text ?? m.content ?? ''),
    ts: m.ts ? Number(m.ts) : (m.created_at ? Date.parse(m.created_at) : Date.now()),
  }));
}

export async function createConversation(): Promise<{ conversationId: string }> {
  try {
    const j = await (await authFetch('/api/agent/iros/conversations', { method: 'POST', body: JSON.stringify({ action: 'create' })})).json();
    const cid = j?.conversationId || j?.conversation_id || j?.id || j?.data?.id || (Array.isArray(j?.conversations) ? j.conversations[0]?.id : undefined);
    if (!cid) throw new Error('no id');
    return { conversationId: String(cid) };
  } catch {
    const j2 = await (await authFetch('/api/agent/iros', { method: 'POST', body: JSON.stringify({ text: '' })})).json();
    const cid2 = j2?.meta?.conversation_id || j2?.meta?.conversationId || j2?.conversation_id || j2?.conversationId;
    if (!cid2) throw new Error('Failed to create conversation');
    return { conversationId: String(cid2) };
  }
}

export async function postMessage(args: { conversationId: string; text: string }) {
  await authFetch('/api/agent/iros/messages', { method: 'POST', body: JSON.stringify({ conversation_id: args.conversationId, role: 'user', text: args.text }) });
  return { ok: true as const };
}

export async function renameConversation(conversationId: string, title: string) {
  try {
    await (await authFetch('/api/agent/iros/conversations', { method: 'PATCH', body: JSON.stringify({ conversationId, title })})).json().catch(()=>null);
  } catch {
    await (await authFetch('/api/agent/iros/conversations', { method: 'POST', body: JSON.stringify({ action: 'rename', id: conversationId, title })})).json().catch(()=>null);
  }
}

export async function deleteConversation(conversationId: string) {
  try {
    await (await authFetch('/api/agent/iros/conversations', { method: 'DELETE', body: JSON.stringify({ conversationId })})).json().catch(()=>null);
  } catch {
    await (await authFetch('/api/agent/iros/conversations', { method: 'POST', body: JSON.stringify({ action: 'delete', id: conversationId })})).json().catch(()=>null);
  }
}

export async function getUserInfo(): Promise<UserInfo> {
  try {
    const j0 = await (await authFetch('/api/agent/iros/userinfo')).json();
    const u0 = j0?.user ?? j0 ?? {};
    return { id: String(u0?.id ?? u0?.user_code ?? 'me'), name: String(u0?.name ?? u0?.displayName ?? 'You'), userType: String(u0?.userType ?? u0?.type ?? 'member'), credits: Number(u0?.credits ?? u0?.credit ?? 0) };
  } catch {
    try {
      const u = await (await authFetch('/api/get-user-info')).json();
      return { id: String(u?.id ?? 'me'), name: String(u?.name ?? 'You'), userType: String(u?.userType ?? 'member'), credits: Number(u?.credits ?? u?.sofia_credit ?? 0) };
    } catch {
      const j = await (await authFetch('/api/q/unified?user_code=self')).json();
      const u = j?.user ?? j ?? {};
      return { id: String(u.id ?? 'me'), name: String(u.name ?? 'You'), userType: String(u.userType ?? 'member'), credits: Number(u.credits ?? u.sofia_credit ?? 0) };
    }
  }
}

/** 送信→保存→（任意で）/analyze を叩くユーティリティ */
export async function sendText(args: { conversationId?: string; text: string }) {
  const t = (args.text ?? '').trim();
  if (!t) return { conversationId: args.conversationId, messages: [] as IrosMessage[] };

  let cid = args.conversationId;
  if (!cid) cid = (await createConversation()).conversationId;

  const j1 = await (await authFetch('/api/agent/iros/messages', { method: 'POST', body: JSON.stringify({ conversation_id: cid, role: 'user', text: t }) })).json();
  const msgId = String(j1?.message?.id ?? j1?.id ?? Date.now());

  try { await authFetch('/api/agent/iros/analyze', { method: 'POST', body: JSON.stringify({ conversation_id: cid, text: t }) }); } catch {}

  return { conversationId: cid, messages: [{ id: msgId, role: 'user', text: t, ts: Date.now() }] as IrosMessage[] };
}
