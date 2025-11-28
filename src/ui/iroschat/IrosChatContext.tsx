// src/ui/iroschat/IrosChatContext.tsx
'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { irosClient } from './lib/irosApiClient';
import type { IrosMessage, IrosConversation, IrosUserInfo } from './types';

type SendResult =
  | {
      assistant: string;
      meta?: any;
    }
  | null;

type IrosChatContextType = {
  loading: boolean;
  messages: IrosMessage[];
  conversations: IrosConversation[];
  userInfo: IrosUserInfo | null;

  activeConversationId: string | null;

  fetchMessages: (cid: string) => Promise<void>;

  // 通常メッセージ送信
  sendMessage: (text: string, mode?: string) => Promise<SendResult>;

  // ★ Future-Seed（T層デモ）専用
  sendFutureSeed: () => Promise<SendResult>;

  // 既存
  startConversation: () => Promise<string>;
  renameConversation: (cid: string, title: string) => Promise<void>;
  deleteConversation: (cid: string) => Promise<void>;
  reloadConversations: () => Promise<void>;
  reloadUserInfo: () => Promise<void>;

  // 新しいチャット制御用（Shell / Header から呼ぶ想定）
  newConversation: () => Promise<string>;
  selectConversation: (cid: string) => Promise<void>;
};

const IrosChatContext = createContext<IrosChatContextType | null>(null);

export const useIrosChat = () => useContext(IrosChatContext)!;

export const IrosChatProvider = ({ children }: { children: React.ReactNode }) => {
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<IrosMessage[]>([]);
  const [conversations, setConversations] = useState<IrosConversation[]>([]);
  const [userInfo, setUserInfo] = useState<IrosUserInfo | null>(null);

  // 表示用の state + 内部ロジック用の ref の両立
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );
  const activeConversationIdRef = useRef<string | null>(null);

  /* ========== Conversations ========== */

  const reloadConversations = useCallback(async () => {
    const list = await irosClient.listConversations();
    setConversations(list);
  }, []);

  const startConversation = useCallback(async () => {
    const r = await irosClient.createConversation();

    // ★ 新規会話なので、前のメッセージをクリアしておく
    setMessages([]);

    // 新しい会話をアクティブに
    activeConversationIdRef.current = r.conversationId;
    setActiveConversationId(r.conversationId);

    await reloadConversations();
    return r.conversationId;
  }, [reloadConversations, setMessages]);

  const renameConversation = useCallback(
    async (cid: string, title: string) => {
      await irosClient.renameConversation(cid, title);
      await reloadConversations();
    },
    [reloadConversations],
  );

  const deleteConversation = useCallback(
    async (cid: string) => {
      await irosClient.deleteConversation(cid);
      if (activeConversationIdRef.current === cid) {
        activeConversationIdRef.current = null;
        setActiveConversationId(null);
        setMessages([]);
      }
      await reloadConversations();
    },
    [reloadConversations],
  );

  /* ========== Messages ========== */

  const fetchMessages = useCallback(async (cid: string) => {
    // 会話切り替え時にアクティブ ID を更新
    activeConversationIdRef.current = cid;
    setActiveConversationId(cid);
    const rows = await irosClient.fetchMessages(cid);
    setMessages(rows);
  }, []);

  const sendMessage = useCallback(
    async (text: string, mode: string = 'auto'): Promise<SendResult> => {
      const cid = activeConversationIdRef.current;
      if (!cid) return null;

      setLoading(true);

      // ① user メッセージをローカルに即反映
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'user',
          text,
          content: text,
          created_at: new Date().toISOString(),
          ts: Date.now(),
        } as IrosMessage,
      ]);

      // DB に user メッセージ保存
      await irosClient.postMessage({
        conversationId: cid,
        text,
        role: 'user',
      });

      // ② LLM 返信＋必要なら server 側保存
      const r: any = await irosClient.replyAndStore({
        conversationId: cid,
        user_text: text,
        mode,
      });

      const assistant = (r?.assistant ?? '') as string;
      const meta = r?.meta ?? null;

      // ③ assistant をローカル state に反映
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: assistant,
          content: assistant,
          created_at: new Date().toISOString(),
          ts: Date.now(),
          meta,
        } as IrosMessage,
      ]);

      setLoading(false);

      // ④ 会話一覧の updated_at を更新
      await reloadConversations();

      // ⑤ ChatInput へ meta を返す（インジケータ用）
      return { assistant, meta: meta ?? undefined };
    },
    [reloadConversations],
  );

  // ★ Future-Seed（T層デモ）専用：/api/agent/iros/future-seed を叩く
  const sendFutureSeed = useCallback(async (): Promise<SendResult> => {
    setLoading(true);
    try {
      const res = await fetch('/api/agent/iros/future-seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // 現状はデモなのでボディ無しでOK
      });

      if (!res.ok) {
        console.error('[IROS] future-seed API error', res.status);
        return null;
      }

      const data: any = await res.json();

      // 返却形式に多少揺れがあっても耐えるよう、候補を順に見る
      const assistant =
        (data?.assistant as string | undefined) ??
        (data?.message as string | undefined) ??
        '';

      const meta = data?.meta ?? data?.result?.meta ?? null;

      // 返信テキストが空なら、メッセージは追加しない
      if (!assistant) {
        return null;
      }

      // ★ Seed メッセージをローカル state に追加（DB保存はしない）
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: assistant,
          content: assistant,
          created_at: new Date().toISOString(),
          ts: Date.now(),
          meta,
        } as IrosMessage,
      ]);

      return { assistant, meta: meta ?? undefined };
    } catch (e) {
      console.error('[IROS] future-seed failed', e);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  /* ========== User Info ========== */

  const reloadUserInfo = useCallback(async () => {
    const u = await irosClient.getUserInfo();
    setUserInfo(u);
  }, []);

  /* ========== 新しいチャット / 会話選択 API ========== */

  // 新しい会話を作って、そのまま開くためのヘルパー
  const newConversation = useCallback(async () => {
    const cid = await startConversation();
    // 念のためサーバ側状態も同期（通常は空配列が返る）
    await fetchMessages(cid);
    return cid;
  }, [startConversation, fetchMessages]);

  // 既存会話を選択して開く
  const selectConversation = useCallback(
    async (cid: string) => {
      await fetchMessages(cid);
    },
    [fetchMessages],
  );

  /* ========== 初期ロード ========== */

  useEffect(() => {
    (async () => {
      await reloadUserInfo();
      await reloadConversations();
    })();
  }, [reloadUserInfo, reloadConversations]);

  return (
    <IrosChatContext.Provider
      value={{
        loading,
        messages,
        conversations,
        userInfo,
        activeConversationId,

        fetchMessages,
        sendMessage,
        sendFutureSeed, // ★ 追加
        startConversation,
        renameConversation,
        deleteConversation,
        reloadConversations,
        reloadUserInfo,

        newConversation,
        selectConversation,
      }}
    >
      {children}
    </IrosChatContext.Provider>
  );
};
