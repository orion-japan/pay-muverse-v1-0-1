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
import type { ResonanceState, IntentPulse } from '@/lib/iros/config';
import type { IrosConversation, IrosMessage, IrosUserInfo } from './types';

/* ========= DEV logger ========= */
const __DEV__ = process.env.NODE_ENV !== 'production';
const dbg = (...a: any[]) => {
  if (__DEV__) console.log('[IROS/CTX]', ...a);
};

/* ---- irosClient の暫定型定義（unknown撲滅） ---- */
type IrosAPI = {
  createConversation(): Promise<{ conversationId: string }>;
  listConversations(): Promise<IrosConversation[]>;
  fetchMessages(conversationId: string): Promise<IrosMessage[]>;
  renameConversation(conversationId: string, title: string): Promise<{ ok: true } | void>;
  deleteConversation(conversationId: string): Promise<{ ok: true } | void>;
  /** ※ 残すが UI 側では使わない（/messages 直叩きは二重化の原因になるため） */
  postMessage(args: { conversationId: string; text: string; role?: 'user' | 'assistant' }): Promise<{ ok: true }>;
  reply(args: {
    conversationId?: string;
    user_text: string;
    mode?: 'Light' | 'Deep' | 'Transcend' | 'Harmony' | string;
    model?: string;
    resonance?: ResonanceState;
    intent?: IntentPulse;
    headers?: Record<string, string>; // 冪等キー付与用
  }): Promise<
    | { ok: boolean; message?: { id?: string; content: string } } // 旧フォーマット
    | { ok: boolean; assistant?: string; mode?: string; systemPrompt?: string } // 新フォーマット
  >;
  /** ★ 追加：/reply の戻りを正規化し、未保存なら assistant を保存する */
  replyAndStore(args: {
    conversationId: string;
    user_text: string;
    mode?: string;
    model?: string;
  }): Promise<{ assistant: string } & Record<string, any>>;
  getUserInfo(): Promise<IrosUserInfo | null>;
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
    if (__DEV__) console.warn('[IROS/CTX] authFetch error', res.status, t);
    throw new Error(`HTTP ${res.status} ${t}`);
  }
  return res;
}

const irosClient: IrosAPI = {
  async createConversation() {
    if (typeof _raw.createConversation === 'function') return _raw.createConversation();
    dbg('createConversation() fallback');
    const r = await authFetch('/api/agent/iros/conversations', {
      method: 'POST',
      body: JSON.stringify({ action: 'create', title: '新しい会話' }),
    });
    const j = await r.json();
    const id = String(j.conversationId || j.id || '');
    dbg('createConversation ->', id);
    return { conversationId: id };
  },
  async listConversations() {
    if (typeof _raw.listConversations === 'function') return _raw.listConversations();
    dbg('listConversations() fallback');
    const r = await authFetch('/api/agent/iros/conversations', { method: 'GET' });
    const j = await r.json();
    const arr = Array.isArray(j?.conversations) ? j.conversations : [];
    return arr.map((c: any) => ({
      id: String(c.id),
      title: String(c.title ?? '新規セッション'),
      created_at: c.created_at ?? null,
      updated_at: c.updated_at ?? c.created_at ?? null,
      agent: c.agent ?? 'iros',
    })) as IrosConversation[];
  },
  async fetchMessages(conversationId: string) {
    if (typeof _raw.fetchMessages === 'function') return _raw.fetchMessages(conversationId);
    dbg('fetchMessages() fallback', conversationId);
    const r = await authFetch(
      `/api/agent/iros/messages?conversation_id=${encodeURIComponent(conversationId)}`,
    );
    const j = await r.json();
    const rows = Array.isArray(j?.messages) ? j.messages : [];
    return rows.map((m: any) => ({
      id: String(m.id),
      role: (m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user') as IrosMessage['role'],
      text: String(m.content ?? m.text ?? ''),
      content: String(m.content ?? m.text ?? ''),
      created_at: m.created_at ?? null,
      ts: m.ts ? Number(m.ts) : new Date(m.created_at || Date.now()).getTime(),
      meta: m.meta ?? null,
    })) as IrosMessage[];
  },
  async renameConversation(conversationId: string, title: string) {
    if (typeof _raw.renameConversation === 'function')
      return _raw.renameConversation(conversationId, title);
    dbg('renameConversation() fallback', conversationId, title);
    await authFetch('/api/agent/iros/conversations', {
      method: 'POST',
      body: JSON.stringify({ action: 'rename', id: conversationId, title }),
    });
    return { ok: true as const };
  },
  async deleteConversation(conversationId: string) {
    if (typeof _raw.deleteConversation === 'function') return _raw.deleteConversation(conversationId);
    dbg('deleteConversation() fallback', conversationId);
    await authFetch('/api/agent/iros/conversations', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', id: conversationId }),
    });
    return { ok: true as const };
  },
  async postMessage(args: { conversationId: string; text: string; role?: 'user' | 'assistant' }) {
    if (typeof _raw.postMessage === 'function') return _raw.postMessage(args);
    dbg('postMessage() fallback', { len: args.text?.length, role: args.role });
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
    dbg('reply() fallback', { mode: args.mode, hasCid: !!args.conversationId });
    const r = await authFetch('/api/agent/iros/reply', {
      method: 'POST',
      headers: args.headers ?? undefined,
      body: JSON.stringify({
        conversationId: args.conversationId,
        user_text: args.user_text,
        mode: args.mode ?? 'Light',
        history: [],
        model: args.model,
        // 可変の非言語を渡す（無ければ undefined になるのでOK）
        resonance: (window as any)?.__iros?.resonance ?? args.resonance,
        intent: (window as any)?.__iros?.intent ?? args.intent,
      }),
    });
    return r.json();
  },
  async replyAndStore(args) {
    // 既存実装があればそれを尊重
    if (typeof _raw.replyAndStore === 'function') {
      return _raw.replyAndStore(args);
    }
    // フォールバック：/reply → 正規化 → 未保存なら assistant を保存
    const r: any = await this.reply({
      conversationId: args.conversationId,
      user_text: args.user_text,
      mode: args.mode ?? 'Light',
      model: args.model,
    });

    // 正規化（代表的なキーを総当り）
    let t =
      r?.assistant ??
      r?.message?.content ??
      r?.choices?.[0]?.message?.content ??
      r?.output_text ??
      '';

    if (typeof t !== 'string') t = String(t ?? '');
    t = (t ?? '').trim();
    if (t && !/[。！？!?🪔]$/.test(t)) t += '。';
    if (t) t = t.replace(/🪔+/g, '') + '🪔';
    const safe = t || 'はい。🪔';

    const serverPersisted =
      !!(r?.saved || r?.persisted || r?.db_saved || r?.message_id || r?.messageId);

    if (!serverPersisted) {
      await this.postMessage({
        conversationId: args.conversationId,
        text: safe,
        role: 'assistant',
      });
    }
    return { ...r, assistant: safe };
  },
  async getUserInfo() {
    if (typeof _raw.getUserInfo === 'function') return _raw.getUserInfo();
    dbg('getUserInfo() fallback');
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
};

/* ========= Context 型 ========= */
type Ctx = {
  loading: boolean;
  error?: string;
  conversations: IrosConversation[];
  conversationId?: string;
  messages: IrosMessage[];
  userInfo: IrosUserInfo | null;

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
  const [userInfo, setUserInfo] = useState<IrosUserInfo | null>(null);

  const didInit = useRef(false);
  const fetchLock = useRef(false);
  const didSyncUrlRef = useRef(false);
  const inFlightRef = useRef(false); // ★ 送信多重ガード
  const lastUserInfoAt = useRef(0);  // ★ 追加：userinfo スロットル用

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
        const wait = baseMs * Math.pow(1.8, i);
        dbg('retryAuth backoff', { i, wait, msg });
        await new Promise((r) => setTimeout(r, wait));
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
    dbg('ensureConversationId ->', cid);
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
        dbg('init loaded', { cid, convs: (list ?? []).length, msgs: (msgs ?? []).length });
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
    dbg('url sync ->', conversationId);
  }, [conversationId, router, urlParams]);

  // ---- Public actions ----
  const refreshConversations = useCallback(async () => {
    const list = await retryAuth(() => irosClient.listConversations());
    setConversations(list ?? []);
    dbg('refreshConversations', list?.length ?? 0);
  }, []);

  const refreshUserInfo = useCallback(async () => {
    const now = Date.now();

    // ★ 5 秒以内の連続呼び出しはスキップ
    if (now - lastUserInfoAt.current < 5000) {
      dbg('refreshUserInfo: skip (too frequent)');
      return;
    }
    lastUserInfoAt.current = now;

    const u = await retryAuth(() => irosClient.getUserInfo());
    setUserInfo(u ?? null);
    dbg('refreshUserInfo');
  }, []);


  // 共有ヘルパ：ロック/エラー処理/セットを1か所に
  const loadMessages = useCallback(
    async (targetId?: string) => {
      if (fetchLock.current) return;
      fetchLock.current = true;
      try {
        const cid = targetId ?? (await ensureConversationId());
        const list = await retryAuth(() => irosClient.fetchMessages(cid));
        setMessages(list ?? []);
        dbg('loadMessages', { cid, count: list?.length ?? 0 });
      } catch (e: any) {
        setError(e?.message ?? String(e));
        if (!targetId) setMessages([]); // 任意：現在会話時のみクリア
      } finally {
        fetchLock.current = false;
      }
    },
    [ensureConversationId],
  );

  // 置き換え：現在会話の再読込
  const refreshMessages = useCallback(async () => {
    await loadMessages(); // current cid
  }, [loadMessages]);

  // 置き換え：会話切替
  const selectConversation = useCallback(
    async (id: string) => {
      setConversationId(id);
      setError(undefined);
      setLoading(true);
      try {
        await loadMessages(id); // 明示的に対象IDを読む
        router.replace(`/iros?cid=${encodeURIComponent(id)}&agent=iros`, { scroll: false });
        didSyncUrlRef.current = true;
        dbg('selectConversation ->', id);
      } catch (e: any) {
        setError(e?.message ?? String(e));
        setMessages([]);
      } finally {
        setLoading(false);
      }
    },
    [loadMessages, router],
  );

  const newConversation = useCallback(
    async () => {
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
        dbg('newConversation ->', cid);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    },
    [refreshConversations, router],
  );

  /** 送信フロー：楽観追加 → user発話を保存 → replyAndStore → 最終同期
   *  ※ /messages を UI からは呼ばない（保存は API 側 or ここで担保） */
  /** 送信フロー：楽観追加 → user発話を保存 → replyAndStore → 最終同期
   *  ※ /messages を UI からは呼ばない（保存は API 側 or ここで担保） */
   const send = useCallback(
    async (text: string) => {
      const t = (text ?? '').trim();
      if (!t) return;
      if (inFlightRef.current) return; // 多重送信ガード

      setError(undefined);
      setLoading(true);
      inFlightRef.current = true;

      try {
        const cid = await ensureConversationId();

        // 1) 楽観追加（自分の発話）
        const tempId = `temp-${Date.now()}`;
        const now = Date.now();
        setMessages((prev) => [...prev, { id: tempId, role: 'user', text: t, ts: now }]);

        // 2) ユーザー発話を先に確定保存
        await retryAuth(() =>
          irosClient.postMessage({ conversationId: cid, text: t, role: 'user' }),
        );

        // 3) 返信を生成し、未保存なら assistant を保存
        //    ★ ここで /reply のフルJSON（meta含む）を受け取る
        const reply: any = await retryAuth(() =>
          irosClient.replyAndStore({ conversationId: cid, user_text: t, mode: 'Light' }),
        );

        // 4) 最終同期（DBの正を採用）
        const list = await retryAuth(() => irosClient.fetchMessages(cid));
        if (Array.isArray(list)) setMessages(list);

        // 5) 会話一覧も更新
        const convs = await retryAuth(() => irosClient.listConversations());
        if (Array.isArray(convs)) setConversations(convs);

        // ★ ChatInput などから meta を受け取れるように返す
        return reply;
      } catch (e: any) {
        setError(e?.message ?? String(e));
        dbg('send: error', e?.message ?? e);
      } finally {
        inFlightRef.current = false;
        setLoading(false);
      }
    },
    [ensureConversationId],
  );


  const rename = useCallback(
    async (title: string) => {
      if (!conversationId) return;
      setError(undefined);
      await retryAuth(() => irosClient.renameConversation(conversationId as string, title));
      setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, title } : c)));
      dbg('rename ->', title);
    },
    [conversationId],
  );

  const remove = useCallback(async () => {
    if (!conversationId) return;
    setError(undefined);
    await retryAuth(() => irosClient.deleteConversation(conversationId as string));
    setConversations((prev) => prev.filter((c) => c.id !== conversationId));
    setConversationId(undefined);
    setMessages([]);
    dbg('remove ->', conversationId);
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
