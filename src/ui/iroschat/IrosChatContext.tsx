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
import type { IrosStyle } from './lib/irosApiClient';
import type { IrosMessage, IrosConversation, IrosUserInfo } from './types';
import { auth } from '@/lib/firebase';

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

  /** 現在の Iros 口調スタイル（settings で選択されたもの） */
  style: IrosStyle;

  fetchMessages: (cid: string) => Promise<void>;

  // 通常のチャット送信
  sendMessage: (text: string, mode?: string) => Promise<SendResult>;

  // ★ ギア選択（nextStep ボタン）からの送信
  sendNextStepChoice: (opt: {
    key: string;
    label: string;
    gear?: string | null;
  }) => Promise<SendResult>;

  // ★ Future-Seed 用（T層デモ）
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

const STYLE_STORAGE_KEY = 'iros.style';

/**
 * ✅ サーバーから返ってくる message.text が object になっても、
 * UI に meta ダンプが表示されないように「必ず文字列」に正規化する。
 */
function normalizeText(t: unknown): string {
  if (typeof t === 'string') return t;
  if (t == null) return '';

  // object の場合、よくあるキーを優先して拾う
  if (typeof t === 'object') {
    const o = t as any;

    if (typeof o.assistant === 'string') return o.assistant;
    if (typeof o.reply === 'string') return o.reply;
    if (typeof o.message === 'string') return o.message;
    if (typeof o.content === 'string') return o.content;
    if (typeof o.text === 'string') return o.text;

    // それでもダメなら「表示しない」（ここが重要）
    return '';
  }

  // number / boolean などは文字列化
  try {
    return String(t);
  } catch {
    return '';
  }
}

function normalizeMessages(rows: IrosMessage[]): IrosMessage[] {
  return (rows || []).map((m) => {
    const t = normalizeText((m as any)?.text);
    const c = normalizeText((m as any)?.content ?? (m as any)?.text);

    return {
      ...m,
      text: t,
      content: c || t,
    } as IrosMessage;
  });
}

export const IrosChatProvider = ({ children }: { children: React.ReactNode }) => {
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<IrosMessage[]>([]);
  const [conversations, setConversations] = useState<IrosConversation[]>([]);
  const [userInfo, setUserInfo] = useState<IrosUserInfo | null>(null);

  // 口調スタイル（/iros-ai/settings で localStorage に保存した値を読む）
  const [style, setStyle] = useState<IrosStyle>('friendly');

  // 表示用の state + 内部ロジック用の ref の両立
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );
  const activeConversationIdRef = useRef<string | null>(null);

  /* ========== Style 初期ロード ========== */

  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      const v = window.localStorage.getItem(STYLE_STORAGE_KEY);
      if (
        v === 'friendly' ||
        v === 'biz-soft' ||
        v === 'biz-formal' ||
        v === 'plain'
      ) {
        setStyle(v);
      }
    } catch {
      // localStorage が使えない環境ではデフォルト(friendly)のまま
    }
  }, []);

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
  }, [reloadConversations]);

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

  const fetchMessages = useCallback(
    async (cid: string) => {
      // 直前の会話IDを保持しておく（会話が変わったかどうか判定するため）
      const prevCid = activeConversationIdRef.current;

      // 会話切り替え時にアクティブ ID を更新
      activeConversationIdRef.current = cid;
      setActiveConversationId(cid);

      const rowsRaw = await irosClient.fetchMessages(cid);
      const rows = normalizeMessages(rowsRaw);

      setMessages((prev) => {
        // 会話が変わっていたら、過去の Seed は引き継がずにサーバー結果だけにする
        if (prevCid !== cid) {
          return rows;
        }

        // 同じ会話IDのままリロードされた場合、
        // フロント専用の Future-Seed メッセージだけを残してマージする
        const seedMsgs = (prev || []).filter(
          (m) =>
            m &&
            m.role === 'assistant' &&
            (m as any).meta &&
            (m as any).meta.tLayerModeActive === true,
        );

        if (!seedMsgs.length) {
          return rows;
        }

        return [...rows, ...seedMsgs];
      });
    },
    [],
  );

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
        // ★ ここで現在の style をサーバーに渡す
        style,
      });

      const assistant = normalizeText(r?.assistant ?? '');
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
    [reloadConversations, style],
  );

  /* ========== NextStep（ギア選択） ========== */

  const sendNextStepChoice = useCallback(
    async (opt: {
      key: string;
      label: string;
      gear?: string | null;
    }): Promise<SendResult> => {
      const cid = activeConversationIdRef.current;
      if (!cid) return null;

      setLoading(true);

      // ★ ユーザー側の見た目としては通常メッセージと同じ 1 行にする
      const payloadText = `[${opt.key}] ${opt.label}`;

      // ① user メッセージをローカルに即反映（choice 情報だけ meta に保持）
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'user',
          text: payloadText,
          content: payloadText,
          created_at: new Date().toISOString(),
          ts: Date.now(),
          meta: {
            nextStepChoice: {
              key: opt.key,
              label: opt.label,
              gear: opt.gear ?? null,
            },
          },
        } as IrosMessage,
      ]);

      // ② DB に user メッセージ保存（構造は sendMessage と同じで text のみ）
      await irosClient.postMessage({
        conversationId: cid,
        text: payloadText,
        role: 'user',
      });

      // ③ WILLエンジンに「ギア選択が行われた」ことを渡す
      //    ※ mode: 'nextStep' / nextStepChoice はサーバ側で拾えるようにする
      const r: any = await irosClient.replyAndStore({
        conversationId: cid,
        user_text: payloadText,
        mode: 'nextStep',
        style,
        nextStepChoice: {
          key: opt.key,
          label: opt.label,
          gear: opt.gear ?? null,
        },
      });

      const assistant = normalizeText(r?.assistant ?? '');
      const meta = r?.meta ?? null;

      // ④ assistant をローカル state に反映
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

      // ⑤ 会話一覧の updated_at を更新
      await reloadConversations();

      return { assistant, meta: meta ?? undefined };
    },
    [reloadConversations, style],
  );

  /* ========== Future-Seed（T層デモ） ========== */

  const sendFutureSeed = useCallback(
    async (): Promise<SendResult> => {
      // 優先順：
      // 1) ref に入っている activeConversationId
      // 2) state に入っている activeConversationId
      // 3) conversations の先頭
      let cid = activeConversationIdRef.current;

      if (!cid) {
        if (activeConversationId) {
          cid = activeConversationId;
        } else if (conversations && conversations.length > 0) {
          cid = conversations[0].id;
        }

        if (cid) {
          console.log(
            '[IROS] Future-Seed: activeConversationId を補完しました',
            cid,
          );
          activeConversationIdRef.current = cid;
          setActiveConversationId(cid);
        }
      }

      console.log('[IROS] Seed ボタンが押されました（Future-Seed 起動）');

      if (!cid) {
        console.warn(
          '[IROS] No active conversation for future-seed (after fallback)',
        );
        return null;
      }

      setLoading(true);
      try {
        // ---- ★ Firebase ID トークンを取得して Authorization ヘッダーに付与 ----
        const currentUser = auth.currentUser;
        const idToken = currentUser ? await currentUser.getIdToken() : null;

        if (!idToken) {
          console.warn('[IROS] Future-Seed: no idToken (not logged in?)');
          return null;
        }

        const body = {
          conversationId: cid, // 今はサーバー側では未使用だが将来のために送っておく
        };
        console.log('[IROS] Future-Seed request body', body);

        const res = await fetch('/api/agent/iros/future-seed', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => '(no body)');
          console.error('[IROS] future-seed API error', res.status, detail);
          return null;
        }

        const data: any = await res.json();

        // reply / assistant / message の順で拾う
        const assistant =
          normalizeText(data?.reply ?? data?.assistant ?? data?.message ?? '');

        const meta = data?.meta ?? data?.result?.meta ?? null;

        if (!assistant) {
          console.warn('[IROS] Future-Seed result null');
          return null;
        }

        // Seed メッセージをローカル state に追加（DB保存はしない）
        setMessages((m) => {
          const next = [
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
          ];

          console.log('[IROS] Seed setMessages', {
            before: m.length,
            after: next.length,
            last: {
              id: next[next.length - 1]?.id,
              role: next[next.length - 1]?.role,
              meta: next[next.length - 1]?.meta,
            },
          });

          return next;
        });

        return { assistant, meta: meta ?? undefined };
      } catch (e) {
        console.error('[IROS] future-seed failed', e);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [activeConversationId, conversations],
  );

  /* ========== User Info ========== */

  const reloadUserInfo = useCallback(async () => {
    const u = await irosClient.getUserInfo();
    setUserInfo(u);
  }, []);

  /* ========== 新しいチャット / 会話選択 API ========== */

  // 新しい会話を作って、そのまま開くためのヘルパー
  const newConversation = useCallback(
    async () => {
      const cid = await startConversation();
      // 念のためサーバ側状態も同期（通常は空配列が返る）
      await fetchMessages(cid);
      return cid;
    },
    [startConversation, fetchMessages],
  );

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
        style, // ★ 追加：現在のスタイルも公開

        fetchMessages,
        sendMessage,
        sendNextStepChoice,
        sendFutureSeed,
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
