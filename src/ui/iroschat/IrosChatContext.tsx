// /src/ui/iroschat/IrosChatContext.tsx
'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import * as irosClientModule from './lib/irosClient'; // default／named 両対応
import { getAuth } from 'firebase/auth';

/* ========= Types ========= */
export type UserInfo = {
  id: string;
  name: string;
  userType: string;
  credits: number;
};

export type IrosConversation = { id: string; title: string; updated_at?: string | null };
export type IrosMessage = { id: string; role: 'user' | 'assistant'; text: string; ts: number };

/* ---- irosClient の暫定型定義（unknown撲滅） ---- */
type IrosAPI = {
  createConversation(): Promise<{ conversationId: string }>;
  listConversations(): Promise<IrosConversation[]>;
  fetchMessages(conversationId: string): Promise<IrosMessage[]>;
  renameConversation(conversationId: string, title: string): Promise<{ ok: true } | void>;
  deleteConversation(conversationId: string): Promise<{ ok: true } | void>;
  postMessage(args: { conversationId: string; text: string; role?: 'user' | 'assistant' }): Promise<{ ok: true }>;
  reply(args: {
    conversationId?: string;
    user_text: string;
    mode?: 'Light' | 'Deep' | 'Transcend' | 'Harmony' | string;
    model?: string;
  }): Promise<
    | { ok: boolean; message?: { id?: string; content: string } } // 旧フォーマット
    | { ok: boolean; assistant?: string; mode?: string; systemPrompt?: string } // 新フォーマット
  >;
  getUserInfo(): Promise<UserInfo | null>;

  // ★ 追加：保存付き返信（assistant発話を /messages に保存まで担保）
  replyAndStore(args: {
    conversationId: string;
    user_text: string;
    mode?: string;
    model?: string;
  }): Promise<
    | { ok: boolean; message?: { id?: string; content: string } }
    | { ok: boolean; assistant?: string; mode?: string; systemPrompt?: string }
  >;
};

// ====== フォールバックを含む irosClient ラッパー ======
const _raw = ((irosClientModule as any).default ?? irosClientModule) as Record<string, any>;

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
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${t}`);
  }
  return res;
}

const irosClient: IrosAPI = {
  async createConversation() {
    if (typeof _raw.createConversation === 'function') return _raw.createConversation();
    const r = await authFetch('/api/agent/iros/conversations', {
      method: 'POST',
      body: JSON.stringify({ action: 'create', title: '新しい会話' }),
    });
    const j = await r.json();
    return { conversationId: String(j.conversationId || j.id || '') };
  },
  async listConversations() {
    if (typeof _raw.listConversations === 'function') return _raw.listConversations();
    const r = await authFetch('/api/agent/iros/conversations');
    const j = await r.json();
    const arr = Array.isArray(j?.conversations) ? j.conversations : [];
    return arr.map((c: any) => ({
      id: String(c.id),
      title: String(c.title ?? '新規セッション'),
      updated_at: c.updated_at ?? c.created_at ?? null,
    }));
  },
  async fetchMessages(conversationId: string) {
    if (typeof _raw.fetchMessages === 'function') return _raw.fetchMessages(conversationId);
    const r = await authFetch(
      `/api/agent/iros/messages?conversation_id=${encodeURIComponent(conversationId)}`,
    );
    const j = await r.json();
    const rows = Array.isArray(j?.messages) ? j.messages : [];
    return rows.map((m: any) => ({
      id: String(m.id),
      role: m.role === 'assistant' ? 'assistant' : 'user',
      text: String(m.content ?? m.text ?? ''),
      ts: m.ts ? Number(m.ts) : new Date(m.created_at || Date.now()).getTime(),
    }));
  },
  async renameConversation(conversationId: string, title: string) {
    if (typeof _raw.renameConversation === 'function')
      return _raw.renameConversation(conversationId, title);
    await authFetch('/api/agent/iros/conversations', {
      method: 'POST',
      body: JSON.stringify({ action: 'rename', id: conversationId, title }),
    });
    return { ok: true as const };
  },
  async deleteConversation(conversationId: string) {
    if (typeof _raw.deleteConversation === 'function') return _raw.deleteConversation(conversationId);
    await authFetch('/api/agent/iros/conversations', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', id: conversationId }),
    });
    return { ok: true as const };
  },
  async postMessage(args: { conversationId: string; text: string; role?: 'user' | 'assistant' }) {
    if (typeof _raw.postMessage === 'function') return _raw.postMessage(args);
    await authFetch('/api/agent/iros/messages', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: args.conversationId, // API実装に合わせる
        text: args.text,
        role: args.role ?? 'user',
      }),
    });
    return { ok: true as const };
  },
  async reply(args) {
    if (typeof _raw.reply === 'function') return _raw.reply(args);
    const r = await authFetch('/api/agent/iros/reply', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: args.conversationId,
        user_text: args.user_text,
        mode: args.mode ?? 'Light',
        history: [],
        model: args.model,
      }),
    });
    return r.json();
  },
  async getUserInfo() {
    if (typeof _raw.getUserInfo === 'function') return _raw.getUserInfo();
    const r = await authFetch('/api/agent/iros/userinfo', { method: 'GET' });
    const j = await r.json();
    const u = j?.user;
    if (!u) return { id: 'me', name: 'You', userType: 'member', credits: 0 };
    return {
      id: String(u.id ?? 'me'),
      name: String(u.name ?? 'You'),
      userType: String(u.userType ?? 'member'),
      credits: Number(u.credits ?? 0),
    };
  },

  // ★ 追加：保存付き返信（_raw に存在すればそれを使い、無ければフォールバック）
  async replyAndStore(args) {
    if (typeof _raw.replyAndStore === 'function') {
      return _raw.replyAndStore(args);
    }

    // 1) 返信生成
    const rep =
      typeof _raw.reply === 'function'
        ? await _raw.reply(args)
        : await (async () => {
            const r = await authFetch('/api/agent/iros/reply', {
              method: 'POST',
              body: JSON.stringify({
                conversationId: args.conversationId,
                user_text: args.user_text,
                mode: args.mode ?? 'Light',
                history: [],
                model: args.model,
              }),
            });
            return r.json();
          })();

    const assistantText =
      (rep as any)?.message?.content ??
      (rep as any)?.assistant ??
      '';

    // 2) 返信があれば /messages に保存
    if (assistantText) {
      if (typeof _raw.postMessage === 'function') {
        await _raw.postMessage({ conversationId: args.conversationId, text: assistantText, role: 'assistant' });
      } else {
        await authFetch('/api/agent/iros/messages', {
          method: 'POST',
          body: JSON.stringify({
            conversation_id: args.conversationId,
            text: assistantText,
            role: 'assistant',
          }),
        });
      }
    }
    return rep;
  },
};

/* ========= Context 型 ========= */
type Ctx = {
  loading: boolean;
  error?: string;
  conversations: IrosConversation[];
  conversationId?: string;
  messages: IrosMessage[];
  userInfo: UserInfo | null;

  newConversation: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  rename: (title: string) => Promise<void>;
  remove: () => Promise<void>;
  refreshMessages: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  refreshUserInfo: () => Promise<void>;
};

const IrosCtx = createContext<Ctx | null>(null);
export function useIrosChat(): Ctx {
  const c = useContext(IrosCtx);
  if (!c) throw new Error('IrosChatContext not mounted');
  return c;
}

/* ========= Provider ========= */
export default function IrosChatProvider({
  children,
  initialConversationId,
}: {
  children: React.ReactNode;
  initialConversationId?: string;
}) {
  const { userCode, loading: authLoading } = useAuth();
  const router = useRouter();
  const urlParams = useSearchParams();

  const canUse = !!userCode && !authLoading;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [conversations, setConversations] = useState<IrosConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [messages, setMessages] = useState<IrosMessage[]>([]);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);

  const didInit = useRef(false);
  const fetchLock = useRef(false);
  const didSyncUrlRef = useRef(false);

  // ---- 認証系バックオフ ----
  async function retryAuth<T>(
    fn: () => Promise<T>,
    opt: { tries?: number; baseMs?: number } = {},
  ): Promise<T> {
    const tries = opt.tries ?? 6;
    const baseMs = opt.baseMs ?? 500;
    let lastErr: any;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message ?? e);
        const isAuth =
          /\b(401|403)\b/.test(msg) || /unauthorized/i.test(msg) || /forbidden/i.test(msg);
        if (!isAuth && i >= 1) break;
        await new Promise((r) => setTimeout(r, baseMs * Math.pow(1.8, i)));
      }
    }
    throw lastErr;
  }

  // ---- conversationId を必ず確定 ----
  const ensureConversationId = useCallback(async (): Promise<string> => {
    if (conversationId) return conversationId;
    const cid = await retryAuth(async () => {
      const created = await irosClient.createConversation();
      if (!created?.conversationId) throw new Error('Failed to ensure conversation id');
      return created.conversationId as string;
    });
    setConversationId(cid);
    return cid;
  }, [conversationId]);

  // ---- 初期ロード（Auth準備後に1回）----
  useEffect(() => {
    if (!canUse) return;
    if (didInit.current) return;
    didInit.current = true;

    (async () => {
      setLoading(true);
      setError(undefined);
      try {
        const [list, u] = await Promise.all([
          retryAuth(() => irosClient.listConversations()),
          retryAuth(() => irosClient.getUserInfo()),
        ]);
        setConversations(list ?? []);
        setUserInfo(u ?? null);

        let cid =
          initialConversationId ||
          conversationId ||
          (list && list.length > 0 ? list[0].id : undefined);

        if (!cid) cid = await ensureConversationId();
        else setConversationId(cid);

        const msgs = await retryAuth(() => irosClient.fetchMessages(cid!));
        setMessages(msgs ?? []);
      } catch (e: any) {
        setError(e?.message ?? String(e));
        setMessages([]);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUse]);

  // initialConversationId への追随
  useEffect(() => {
    if (initialConversationId && !conversationId) setConversationId(initialConversationId);
  }, [initialConversationId, conversationId]);

  // ---- URL 同期（cid）----
  useEffect(() => {
    if (!conversationId) return;
    const currentCid = urlParams.get('cid');
    if (currentCid === conversationId) return;
    if (didSyncUrlRef.current) return;
    didSyncUrlRef.current = true;
    router.replace(`/iros?cid=${encodeURIComponent(conversationId)}&agent=iros`, {
      scroll: false,
    });
  }, [conversationId, router, urlParams]);

  // ---- Public actions ----
  const refreshConversations = useCallback(async () => {
    const list = await retryAuth(() => irosClient.listConversations());
    setConversations(list ?? []);
  }, []);

  const refreshUserInfo = useCallback(async () => {
    const u = await retryAuth(() => irosClient.getUserInfo());
    setUserInfo(u ?? null);
  }, []);

// 共有ヘルパ：ロック/エラー処理/セットを1か所に
const loadMessages = useCallback(async (targetId?: string) => {
  if (fetchLock.current) return;
  fetchLock.current = true;
  try {
    const cid = targetId ?? (await ensureConversationId());
    const list = await retryAuth(() => irosClient.fetchMessages(cid));
    setMessages(list ?? []);
  } catch (e: any) {
    setError(e?.message ?? String(e));
    if (!targetId) setMessages([]); // 任意：現在会話時のみクリア
  } finally {
    fetchLock.current = false;
  }
}, [ensureConversationId]);

// 置き換え：現在会話の再読込
const refreshMessages = useCallback(async () => {
  await loadMessages(); // current cid
}, [loadMessages]);

// 置き換え：会話切替
const selectConversation = useCallback(async (id: string) => {
  setConversationId(id);
  setError(undefined);
  setLoading(true);
  try {
    await loadMessages(id); // 明示的に対象IDを読む
    router.replace(`/iros?cid=${encodeURIComponent(id)}&agent=iros`, { scroll: false });
    didSyncUrlRef.current = true;
  } catch (e: any) {
    setError(e?.message ?? String(e));
    setMessages([]);
  } finally {
    setLoading(false);
  }
}, [loadMessages, router]);


  const newConversation = useCallback(async () => {
    setError(undefined);
    setLoading(true);
    try {
      const created = await retryAuth(() => irosClient.createConversation());
      const cid = created?.conversationId;
      if (!cid) throw new Error('createConversation failed');
      setConversationId(cid);
      setMessages([]);
      await refreshConversations();
      router.replace(`/iros?cid=${encodeURIComponent(cid)}&agent=iros`, { scroll: false });
      didSyncUrlRef.current = true;
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [refreshConversations, router]);

  /** 送信フロー：楽観追加（消さない）→ /messages 保存（user）→ replyAndStore（assistant保存）→ 最終同期 */
  const send = useCallback(
    async (text: string) => {
      const t = (text ?? '').trim();
      if (!t) return;

      setError(undefined);
      setLoading(true);
      try {
        const cid = await ensureConversationId();

        // 1) 楽観追加（自分の発話）… 最後の fetch まで消さない
        const tempId = `temp-${Date.now()}`;
        const now = Date.now();
        setMessages((prev) => [...prev, { id: tempId, role: 'user', text: t, ts: now }]);

        // 2) DB保存（/messages：自分の発話）
        await retryAuth(() =>
          irosClient.postMessage({ conversationId: cid, text: t, role: 'user' }),
        );

        // 3) 返信生成（保存付き）
        await retryAuth(() =>
          irosClient.replyAndStore({ conversationId: cid, user_text: t, mode: 'Light' }),
        );

        // 4) 最終同期（DBの正を採用）… ここで temp もDBの実体に置き換わる
        const list = await irosClient.fetchMessages(cid);
        if (Array.isArray(list)) setMessages(list);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    },
    [ensureConversationId],
  );

  const rename = useCallback(
    async (title: string) => {
      if (!conversationId) return;
      setError(undefined);
      await retryAuth(() => irosClient.renameConversation(conversationId, title));
      setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, title } : c)));
    },
    [conversationId],
  );

  const remove = useCallback(async () => {
    if (!conversationId) return;
    setError(undefined);
    await retryAuth(() => irosClient.deleteConversation(conversationId));
    setConversations((prev) => prev.filter((c) => c.id !== conversationId));
    setConversationId(undefined);
    setMessages([]);
  }, [conversationId]);

  const value = useMemo<Ctx>(
    () => ({
      loading,
      error,
      conversations,
      conversationId,
      messages,
      userInfo,
      newConversation,
      selectConversation,
      send,
      rename,
      remove,
      refreshMessages,
      refreshConversations,
      refreshUserInfo,
    }),
    [
      loading,
      error,
      conversations,
      conversationId,
      messages,
      userInfo,
      newConversation,
      selectConversation,
      send,
      rename,
      remove,
      refreshMessages,
      refreshConversations,
      refreshUserInfo,
    ],
  );

  return <IrosCtx.Provider value={value}>{children}</IrosCtx.Provider>;
}

/* ---- 通常リトライ（非認証系・未使用だが残置）---- */
async function retry<T>(fn: () => Promise<T>, opt: { tries: number; baseMs: number }) {
  let lastErr: any;
  for (let i = 0; i < opt.tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, opt.baseMs * Math.pow(2, i)));
    }
  }
  throw lastErr;
}
