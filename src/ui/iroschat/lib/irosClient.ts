'use client';

import { getAuth } from 'firebase/auth';

// ---- 共通：メッセージ正規化 ----
type RawMsg = any;
type Msg = { id: string; role: 'user' | 'assistant'; text: string; ts: number };

function normalizeMessages(rows: RawMsg[]): Msg[] {
  return (rows || []).map((m) => ({
    id: String(m.id ?? (globalThis.crypto?.randomUUID?.() ?? String(Math.random()))),
    role: m.role === 'user' ? 'user' : 'assistant',
    text: String(m.text ?? m.content ?? ''),
    ts: m.ts
      ? Number(m.ts)
      : m.created_at
        ? Date.parse(m.created_at)
        : Date.now(),
  }));
}

async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const auth = getAuth();
  const u = auth.currentUser;
  const token = u ? await u.getIdToken(false) : null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };

  const res = await fetch(input, { ...init, headers, credentials: 'include', cache: 'no-store' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  return res;
}

type SendParams = { conversationId?: string; text: string };

export default {
  // 会話一覧
  async listConversations(): Promise<Array<{ id: string; title: string; updated_at?: string }>> {
    const r = await authFetch('/api/agent/iros/conversations', { method: 'GET' });
    const j = await r.json();
    // API差異: conversations / rows の両対応
    const list = Array.isArray(j?.conversations) ? j.conversations : Array.isArray(j?.rows) ? j.rows : [];
    return list.map((c: any) => ({
      id: String(c.id),
      title: String(c.title ?? ''),
      updated_at: c.updated_at ?? null,
    }));
  },

  // メッセージ一覧
  async fetchMessages(conversationId: string): Promise<Msg[]> {
    const r = await authFetch(
      `/api/agent/iros/messages?conversation_id=${encodeURIComponent(conversationId)}`,
      { method: 'GET' },
    );
    const j = await r.json();
    const raw = Array.isArray(j?.messages) ? j.messages : Array.isArray(j?.rows) ? j.rows : [];
    return normalizeMessages(raw);
  },

  // 会話作成（空テキストでも発番）
  async createConversation(): Promise<{ conversationId: string }> {
    // 標準: POST /api/agent/iros/conversations
    try {
      const r = await authFetch('/api/agent/iros/conversations', {
        method: 'POST',
        body: JSON.stringify({ action: 'create' }),
      });
      const j = await r.json();
      const cid: string =
        j?.conversationId ||
        j?.conversation_id ||
        j?.id ||
        j?.data?.id ||
        (Array.isArray(j?.conversations) ? j.conversations[0]?.id : undefined);
      if (!cid) throw new Error('no id');
      return { conversationId: String(cid) };
    } catch {
      // フォールバック: 旧 /api/agent/iros
      const r2 = await authFetch('/api/agent/iros', {
        method: 'POST',
        body: JSON.stringify({ text: '' }),
      });
      const j2 = await r2.json();
      const cid2: string =
        j2?.meta?.conversation_id ||
        j2?.meta?.conversationId ||
        j2?.conversation_id ||
        j2?.conversationId;
      if (!cid2) throw new Error('Failed to create conversation');
      return { conversationId: String(cid2) };
    }
  },

  // 送信（保存→解析の2段）
  async sendText({
    conversationId,
    text,
  }: SendParams): Promise<{ conversationId?: string; messages: Msg[] }> {
    const t = (text ?? '').trim();
    if (!t) return { conversationId, messages: [] };

    // 会話IDが無い場合は発番
    let cid = conversationId;
    if (!cid) {
      const created = await this.createConversation();
      cid = created.conversationId;
    }

    // 1) 保存（/messages）
    const r1 = await authFetch('/api/agent/iros/messages', {
      method: 'POST',
      body: JSON.stringify({ conversation_id: cid, role: 'user', text: t }),
    });
    const j1 = await r1.json();
    const msgId = String(j1?.message?.id ?? j1?.id ?? `${Date.now()}`);

    // 2) 解析（/analyze）— 失敗は握りつぶす
    try {
      await authFetch('/api/agent/iros/analyze', {
        method: 'POST',
        body: JSON.stringify({ conversation_id: cid, text: t }),
      });
    } catch {
      // no-op
    }

    // 3) draft（最低限の即時反映） → 完全な状態は上位で再取得
    const draft: Msg[] = [{ id: msgId, role: 'user', text: t, ts: Date.now() }];

    return { conversationId: cid, messages: draft };
  },

  // タイトル変更
  async renameConversation(conversationId: string, title: string): Promise<void> {
    // PATCH が無い環境もあるので POST(action) にフォールバック
    try {
      const r = await authFetch('/api/agent/iros/conversations', {
        method: 'PATCH',
        body: JSON.stringify({ conversationId, title }),
      });
      await r.json().catch(() => null);
    } catch {
      const r2 = await authFetch('/api/agent/iros/conversations', {
        method: 'POST',
        body: JSON.stringify({ action: 'rename', id: conversationId, title }),
      });
      await r2.json().catch(() => null);
    }
  },

  // 会話削除
  async deleteConversation(conversationId: string): Promise<void> {
    try {
      const r = await authFetch('/api/agent/iros/conversations', {
        method: 'DELETE',
        body: JSON.stringify({ conversationId }),
      });
      await r.json().catch(() => null);
    } catch {
      const r2 = await authFetch('/api/agent/iros/conversations', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete', id: conversationId }),
      });
      await r2.json().catch(() => null);
    }
  },

  // ユーザー情報
  async getUserInfo(): Promise<{ id: string; name: string; userType: string; credits: number }> {
    // 新: /api/agent/iros/userinfo → 旧: /api/get-user-info → 最後に unified
    try {
      const r0 = await authFetch('/api/agent/iros/userinfo', { method: 'GET' });
      const j0 = await r0.json();
      const u0 = j0?.user ?? j0 ?? {};
      return {
        id: String(u0?.id ?? u0?.user_code ?? 'me'),
        name: String(u0?.name ?? u0?.displayName ?? 'You'),
        userType: String(u0?.userType ?? u0?.type ?? 'member'),
        credits: Number(u0?.credits ?? u0?.credit ?? 0),
      };
    } catch {
      try {
        const r = await authFetch('/api/get-user-info', { method: 'GET' });
        const u = await r.json();
        return {
          id: String(u?.id ?? 'me'),
          name: String(u?.name ?? 'You'),
          userType: String(u?.userType ?? 'member'),
          credits: Number(u?.credits ?? u?.sofia_credit ?? 0),
        };
      } catch {
        const r2 = await authFetch('/api/q/unified?user_code=self', { method: 'GET' });
        const j = await r2.json();
        const u = j?.user ?? j ?? {};
        return {
          id: String(u.id ?? 'me'),
          name: String(u.name ?? 'You'),
          userType: String(u.userType ?? 'member'),
          credits: Number(u.credits ?? u.sofia_credit ?? 0),
        };
      }
    }
  },
};
