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

import { irosClient } from './lib/irosApi';
import type { IrosStyle } from './lib/irosApi';
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

    /** UI表示用（state） */
    activeConversationId: string | null;

    /** ✅ ロジック用（refを正とする） */
    getActiveConversationId: () => string | null;

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

/**
 * LLMに渡す history を組み立てる（UI側で必要な場合の互換ヘルパー）
 * ✅ role は user/assistant のみに限定する（system を混ぜない）
 */
function buildHistoryForLLM(
  msgs: IrosMessage[],
  limitPairs: number = 10,
): { role: 'user' | 'assistant'; content: string }[] {
  const cleaned = (msgs || [])
    .map((m) => {
      const roleRaw = (m as any)?.role;
      if (roleRaw !== 'user' && roleRaw !== 'assistant') return null;

      const content = normalizeText((m as any)?.content ?? (m as any)?.text).trim();
      if (!content) return null;

      return { role: roleRaw as 'user' | 'assistant', content };
    })
    .filter(
      (x): x is { role: 'user' | 'assistant'; content: string } =>
        !!x && x.content.trim().length > 0,
    );

  const max = Math.max(2, limitPairs * 2);
  return cleaned.slice(-max);
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

  // ✅ history 用：クロージャで古い messages を掴まないための ref
  const messagesRef = useRef<IrosMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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

  const fetchMessages = useCallback(async (cid: string) => {
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

      // フロント専用の Future-Seed メッセージだけを拾う
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

      // rows 側に既にある id は重ねない（React key 重複防止）
      const rowIdSet = new Set((rows || []).map((m) => String((m as any)?.id ?? '')));
      const seedOnly = seedMsgs.filter((m) => {
        const id = String((m as any)?.id ?? '');
        return id && !rowIdSet.has(id);
      });

      return seedOnly.length ? [...rows, ...seedOnly] : rows;
    });

  }, []);

// ✅ IrosChatContext.tsx（IrosChatProvider 内）
// fetchMessages の下あたりに追加（同一ファイル内ならどこでもOK）

function normalizeForSend(raw: string): { text: string; blockedReason: string | null } {
  const s = String(raw ?? '');

  // NB: ZWSP / BOM / ㅤ(ハングルフィラー) を除去
  const stripped = s
    .replace(/\u200B/g, '') // ZWSP
    .replace(/\uFEFF/g, '') // BOM
    .replace(/\u3164/g, '') // ㅤ
    .trim();

  if (!stripped) return { text: '', blockedReason: 'empty' };

  // ✅ 「無言なし」方針：
  // 省略記号だけ / ドットだけ でも “送信は許可” する。
  // （空扱いにするとサーバ側の SILENCE/FORWARD 連鎖や UI 側のブロックが起きやすい）
  // どうしても誤送信が気になるなら、UIで警告表示に留める（blockedにしない）。

  return { text: stripped, blockedReason: null };
}

const sendMessage = useCallback(
  async (text: string, mode: string = 'auto'): Promise<SendResult> => {
    const cid = activeConversationIdRef.current;
    if (!cid) return null;

    console.log('[UI/sendMessage] outbound(raw)', {
      cid,
      mode,
      textLen: text?.length ?? 0,
      head: String(text ?? '').slice(0, 120),
    });

    const norm = normalizeForSend(text);

    if (norm.blockedReason) {
      console.warn('[UI/sendMessage] blocked', {
        cid,
        mode,
        reason: norm.blockedReason,
        rawHead: String(text ?? '').slice(0, 120),
      });
      return { assistant: '', meta: { blocked: true, reason: norm.blockedReason } };
    }

    console.log('[UI/sendMessage] outbound(norm)', {
      cid,
      mode,
      textLen: norm.text.length,
      head: norm.text.slice(0, 120),
    });

    setLoading(true);

    // ① UIに user を即反映（ここが無いと「送ったのに増えない」になる）
    const userMsg: IrosMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: norm.text,
      content: norm.text,
      created_at: new Date().toISOString(),
      ts: Date.now(),
    } as IrosMessage;

    try {
      setMessages((m) => [...m, userMsg]);

      // ② DBへ保存
      console.log('[UI/sendMessage] BEFORE postMessage', { cid });
      await irosClient.postMessage({
        conversationId: cid,
        text: norm.text,
        role: 'user',
      });
      console.log('[UI/sendMessage] AFTER postMessage', { cid });

      // ③ LLM用 history を作る（既存の関数を使う）
      const history = buildHistoryForLLM([...(messagesRef.current || []), userMsg], 10);

      // ④ reply を生成＋保存（ここが無いと「iros返答が出ない」）
      console.log('[UI/sendMessage] BEFORE replyAndStore', { cid, mode });
      const r: any = await irosClient.replyAndStore({
        conversationId: cid,
        user_text: norm.text,
        mode,
        style,
        history,
      });
      console.log('[UI/sendMessage] AFTER replyAndStore', { cid });

      const assistant = normalizeText(r?.assistant ?? '');
      const meta = r?.meta ?? null;

      // ⑤ UIに assistant を反映
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

      await reloadConversations();

      return { assistant, meta: meta ?? undefined };
    } catch (e) {
      console.error('[UI/sendMessage] failed', e);
      return null;
    } finally {
      setLoading(false);
    }
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

      // ✅ 押された選択肢（タグ無し）
      const choiceText = String(opt.label ?? '').trim();

      // ✅ 直前の assistant を探して「引用」に使う（UI表示だけ）
      const lastAssistantText = (() => {
        const arr = messagesRef.current || [];
        for (let i = arr.length - 1; i >= 0; i--) {
          const m: any = arr[i];
          if (!m) continue;
          if (m.role !== 'assistant') continue;

          const t = normalizeText(m.content ?? m.text).trim();
          if (t) return t;
        }
        return '';
      })();

      // ✅ UIに見せる本文：引用 + 選択肢
      // ※ 引用が無いときは選択肢のみ
      const displayText = lastAssistantText
        ? `> ${lastAssistantText.replace(/\n/g, '\n> ')}\n\n${choiceText}`
        : choiceText;

      // ✅ サーバへはタグ付き raw を送る（DB保存は既存どおりstripされる）
      const rawText = `[${opt.key}] ${opt.label}`;

      const userMsg: IrosMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        text: displayText, // ✅ UI表示は「引用＋選択肢」
        content: displayText, // ✅ UI表示は「引用＋選択肢」
        created_at: new Date().toISOString(),
        ts: Date.now(),
        meta: {
          nextStepChoice: {
            key: opt.key,
            label: opt.label,
            gear: opt.gear ?? null,
          },
          quotedFromAssistant: Boolean(lastAssistantText),
        },
      } as IrosMessage;

      try {
        // ① user メッセージをローカルに即反映（引用つき）
        setMessages((m) => [...m, userMsg]);

        // ② DB 保存は rawText（タグ付き）で送る
        await irosClient.postMessage({
          conversationId: cid,
          text: rawText,
          role: 'user',
        });

        // ✅ LLM に渡す history（引用はUI演出なので、LLMには“選択肢だけ”を積む）
        const llmUserMsg: IrosMessage = {
          ...userMsg,
          text: choiceText,
          content: choiceText,
        } as IrosMessage;

        const history = buildHistoryForLLM(
          [...(messagesRef.current || []), llmUserMsg],
          10,
        );

        // ③ reply はタグ無しテキスト + nextStepChoice
        // NOTE: irosApiClient の型定義に extra/nextStepChoice が無い場合があるので、payload を any に落として渡す
        const payload: any = {
          conversationId: cid,
          user_text: choiceText, // ✅ LLMには「選択肢だけ」
          mode: 'nextStep',
          style,

          // ✅ route.ts が extra.choiceId を拾う
          extra: {
            choiceId: opt.key,
          },

          // （残してOK）UIのための付加情報。サーバ側が無視しても害はない
          nextStepChoice: {
            key: opt.key,
            label: opt.label,
            gear: opt.gear ?? null,
          },

          history,
        };

        const r: any = await irosClient.replyAndStore(payload);

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

        await reloadConversations();
        return { assistant, meta: meta ?? undefined };
      } catch (e) {
        console.error('[IROS] sendNextStepChoice failed', e);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [reloadConversations, style],
  );

  /* ========== Future-Seed（T層デモ） ========== */

  const sendFutureSeed = useCallback(async (): Promise<SendResult> => {
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
        console.log('[IROS] Future-Seed: activeConversationId を補完しました', cid);
        activeConversationIdRef.current = cid;
        setActiveConversationId(cid);
      }
    }

    console.log('[IROS] Seed ボタンが押されました（Future-Seed 起動）');

    if (!cid) {
      console.warn('[IROS] No active conversation for future-seed (after fallback)');
      return null;
    }

    setLoading(true);
    try {
      const currentUser = auth.currentUser;
      const idToken = currentUser ? await currentUser.getIdToken() : null;

      if (!idToken) {
        console.warn('[IROS] Future-Seed: no idToken (not logged in?)');
        return null;
      }

      const body = { conversationId: cid };
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

      const assistant = normalizeText(
        data?.reply ?? data?.assistant ?? data?.message ?? '',
      );
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
            meta: (next[next.length - 1] as any)?.meta,
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
  }, [activeConversationId, conversations]);

  /* ========== User Info ========== */

  const reloadUserInfo = useCallback(async () => {
    const u = await irosClient.getUserInfo();
    setUserInfo(u);
  }, []);

  /* ========== 新しいチャット / 会話選択 API ========== */

  const newConversation = useCallback(async () => {
    const cid = await startConversation();
    await fetchMessages(cid);
    return cid;
  }, [startConversation, fetchMessages]);

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
        getActiveConversationId: () => activeConversationIdRef.current,
        style,

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
