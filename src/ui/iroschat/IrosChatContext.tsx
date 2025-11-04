// src/ui/iroschat/IrosChatContext.tsx
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
import irosClient from './lib/irosClient';

export type UserInfo = {
  id: string;
  name: string;
  userType: string;
  credits: number;
};

export type IrosConversation = { id: string; title: string; updated_at?: string | null };
export type IrosMessage = { id: string; role: 'user' | 'assistant'; text: string; ts: number };

type Ctx = {
  loading: boolean;
  error?: string;
  conversations: IrosConversation[];
  conversationId?: string;
  messages: IrosMessage[];
  userInfo: UserInfo | null;

  /** 追加：新規会話を作って切替える */
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
          /\b(401|403)\b/.test(msg) ||
          /unauthorized/i.test(msg) ||
          /forbidden/i.test(msg);
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
      const created = await irosClient.createConversation(); // POST /api/agent/iros（空でもOK）
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

  const refreshMessages = useCallback(async () => {
    if (fetchLock.current) return;
    fetchLock.current = true;
    try {
      const cid = await ensureConversationId();
      const list = await retryAuth(() => irosClient.fetchMessages(cid));
      setMessages(list ?? []);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      fetchLock.current = false;
    }
  }, [ensureConversationId]);

  const selectConversation = useCallback(
    async (id: string) => {
      setConversationId(id);
      setError(undefined);
      setLoading(true);
      try {
        const list = await retryAuth(() => irosClient.fetchMessages(id));
        setMessages(list ?? []);
        router.replace(`/iros?cid=${encodeURIComponent(id)}&agent=iros`, { scroll: false });
        didSyncUrlRef.current = true;
      } catch (e: any) {
        setError(e?.message ?? String(e));
        setMessages([]);
      } finally {
        setLoading(false);
      }
    },
    [router],
  );

  const newConversation = useCallback(async () => {
    setError(undefined);
    setLoading(true);
    try {
      const { conversationId: cid } = await retryAuth(() => irosClient.createConversation());
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

  const send = useCallback(
    async (text: string) => {
      const t = (text ?? '').trim();
      if (!t) return;

      setError(undefined);
      setLoading(true);
      try {
        const baseCid = await ensureConversationId();
        const { conversationId: cid, messages: draft } = await retryAuth(() =>
          irosClient.sendText({ conversationId: baseCid, text: t }),
        );

        // 初回発番だった場合のURL同期
        if (!conversationId && cid) {
          setConversationId(cid);
          router.replace(`/iros?cid=${encodeURIComponent(cid)}&agent=iros`, { scroll: false });
          didSyncUrlRef.current = true;
        }

        if (draft && Array.isArray(draft)) {
          setMessages(draft as IrosMessage[]);
        }

        // サーバ保存反映後のリロード
        await retry(async () => {
          const target = (cid || conversationId || baseCid)!;
          const list = await irosClient.fetchMessages(target);
          setMessages(list ?? []);
        }, { tries: 3, baseMs: 250 });
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    },
    [conversationId, ensureConversationId, router],
  );

  const rename = useCallback(
    async (title: string) => {
      if (!conversationId) return;
      setError(undefined);
      await retryAuth(() => irosClient.renameConversation(conversationId, title));
      setConversations(prev => prev.map(c => (c.id === conversationId ? { ...c, title } : c)));
    },
    [conversationId],
  );

  const remove = useCallback(async () => {
    if (!conversationId) return;
    setError(undefined);
    await retryAuth(() => irosClient.deleteConversation(conversationId));
    setConversations(prev => prev.filter(c => c.id !== conversationId));
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

// ---- 通常リトライ（非認証系）----
async function retry<T>(fn: () => Promise<T>, opt: { tries: number; baseMs: number }) {
  let lastErr: any;
  for (let i = 0; i < opt.tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      await new Promise(r => setTimeout(r, opt.baseMs * Math.pow(2, i)));
    }
  }
  throw lastErr;
}
