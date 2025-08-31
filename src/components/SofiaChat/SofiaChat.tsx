'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useAuth, authedFetch } from '@/context/AuthContext';
import { MetaPanel, type MetaData } from '@/components/SofiaChat/MetaPanel';
import MessageBubble from "@/lib/sofia/MessageBubble";


type MsgRole = 'user' | 'assistant';
export type UiMsg = { role: MsgRole; content: string; _key?: string };

type ConversationItem = {
  conversation_code: string;
  title?: string | null;
  updated_at?: string | null;
  last_text?: string | null;
};

function ensureUiKeys(arr: UiMsg[]): UiMsg[] {
  return arr.map((m, i) => {
    if (!m._key) {
      const uid =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? (crypto as any).randomUUID()
          : `${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
      m._key = uid;
    }
    return m;
  });
}
function stripUiKeys(arr: UiMsg[]) {
  return arr.map(({ role, content }) => ({ role, content }));
}

export function SofiaChat() {
  const { loading: authLoading, userCode } = useAuth();

  const [convCode, setConvCode] = useState<string>('');
  const [convs, setConvs] = useState<ConversationItem[]>([]);
  const [messages, setMessages] = useState<UiMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [initLoaded, setInitLoaded] = useState(false);
  const [mode, setMode] = useState<
    'normal' | 'diagnosis' | 'meaning' | 'intent' | 'dark' | 'remake'
  >('normal');

  // 返信メタ(サーバ側で返すならここに入れる想定。現状はダミー維持可)
  const [meta, setMeta] = useState<MetaData | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(scrollToBottom, [messages, scrollToBottom]);

  // ===== 会話一覧 =====
  const loadConversations = useCallback(
    async (uc: string) => {
      const url = `/api/sofia?user_code=${encodeURIComponent(uc)}`;
      const rs = await authedFetch(url, { method: 'GET', cache: 'no-store' });
      const json = await rs.json();
      const items: ConversationItem[] = Array.isArray(json?.items)
        ? json.items
        : [];
      setConvs(items);
      return items;
    },
    []
  );

  // ===== メッセージ取得 =====
  const loadMessages = useCallback(
    async (uc: string, cc: string) => {
      if (!cc) {
        setMessages([]);
        return;
      }
      const url = `/api/sofia?user_code=${encodeURIComponent(
        uc
      )}&conversation_code=${encodeURIComponent(cc)}`;
      const rs = await authedFetch(url, { method: 'GET', cache: 'no-store' });
      const json = await rs.json();
      const msgs: UiMsg[] = Array.isArray(json?.messages)
        ? json.messages.map((m: any) => ({
            role: m.role,
            content: m.content,
            _key: m._key,
          }))
        : [];
      setMessages(ensureUiKeys(msgs));
      // サーバが meta を返すようにしたらここで setMeta(json.meta)
    },
    []
  );

  // ===== 初期ロード =====
  useEffect(() => {
    if (authLoading) return;
    if (!userCode) return; // 未ログイン

    (async () => {
      const items = await loadConversations(userCode);
      const first = items?.[0]?.conversation_code ?? '';
      setConvCode(first);
      if (first) await loadMessages(userCode, first);
      setInitLoaded(true);
    })();
  }, [authLoading, userCode, loadConversations, loadMessages]);

  // ===== 会話切り替え =====
  useEffect(() => {
    if (!initLoaded || !userCode) return;
    loadMessages(userCode, convCode);
  }, [convCode, initLoaded, loadMessages, userCode]);

  // ===== 新規作成 =====
  const handleNewConversation = useCallback(() => {
    const code = `Q${Date.now()}`;
    setConvCode(code);
    setMessages([]);
  }, []);

  const canSend = useMemo(
    () => input.trim().length > 0 && !sending && !!userCode,
    [input, sending, userCode]
  );

  // ===== 送信 =====
  const handleSend = useCallback(async () => {
    if (!canSend || !userCode) return;
    setSending(true);

    const userMsg: UiMsg = { role: 'user', content: input };
    const next = ensureUiKeys([...messages, userMsg]);
    setMessages(next);
    setInput('');

    try {
      const body = {
        user_code: userCode, // ← 認証から取得
        conversation_code: convCode || `Q${Date.now()}`,
        mode,
        messages: stripUiKeys(next),
      };

      const rs = await authedFetch('/api/sofia', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await rs.json();

      // 返信本文
      const reply = json?.reply ?? '';
      if (reply) {
        setMessages(
          ensureUiKeys([...next, { role: 'assistant', content: reply }])
        );
      }
      // 会話コード（新規時に確定）
      if (json?.conversation_code && json.conversation_code !== convCode) {
        setConvCode(json.conversation_code);
      }
      // メタ（サーバが返す運用にしたらここで格納）
      if (json?.meta) setMeta(json.meta as MetaData);

      // 一覧更新
      loadConversations(userCode).catch(() => void 0);
    } catch (e) {
      setMessages(
        ensureUiKeys([
          ...next,
          {
            role: 'assistant',
            content: '（通信に失敗しました…もう一度お試しください）',
          },
        ])
      );
    } finally {
      setSending(false);
    }
  }, [canSend, convCode, loadConversations, messages, userCode, input, mode]);

  // Enter 送信（Shift+Enter は改行）
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) handleSend();
    }
  };

  // ===== UI =====
  if (authLoading) {
    return <div style={{ padding: 16 }}>読み込み中…</div>;
  }
  if (!userCode) {
    return (
      <div style={{ padding: 16 }}>
        ログインが必要です。サインイン後にチャットを開始できます。
      </div>
    );
  }

  return (
    <div
      style={{
        height: '85vh',
        maxWidth: 640,
        margin: '0 auto',
        padding: '8px 12px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
{/* ヘッダー（固定高さ・1段に収める） */}
<div
  style={{
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    padding: '4px 6px',          // ← 高さを薄くする
    fontSize: 13,                // ← 全体のフォント少し小さめ
  }}
>
  <div style={{ fontWeight: 600 }}>iros Chat</div>

  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'nowrap' }}>
    <div style={{ display: 'flex', flexDirection: 'column', fontSize: 11 }}>
      <span style={{ opacity: 0.6 }}>会話コード</span>
      <select
        value={convCode}
        onChange={(e) => setConvCode(e.target.value)}
        style={{ width: 160, padding: '2px 4px', fontSize: 12 }}
      >
        {convs.map((c) => (
          <option key={c.conversation_code} value={c.conversation_code}>
            {c.conversation_code}
          </option>
        ))}
      </select>
    </div>

    <div style={{ display: 'flex', flexDirection: 'column', fontSize: 11 }}>
      <span style={{ opacity: 0.6 }}>モード</span>
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value as any)}
        style={{ width: 100, padding: '2px 4px', fontSize: 12 }}
      >
        <option value="normal">通常</option>
        <option value="diagnosis">診断</option>
        <option value="meaning">意味付け</option>
        <option value="intent">意図</option>
        <option value="dark">闇の物語</option>
        <option value="remake">リメイク</option>
      </select>
    </div>

    <button
      onClick={handleNewConversation}
      style={{
        padding: '4px 6px',
        fontSize: 12,
        border: '1px solid #ccc',
        borderRadius: 6,
        background: '#f3f4f6',
      }}
    >
      新規
    </button>
  </div>
</div>


      {/* メッセージエリア */}
      <div
        ref={listRef}
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          padding: 12,
          background: 'linear-gradient(#f9fafb, #f3f4f6)',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
        }}
      >
        {messages.map((m, i) => (
          <MessageBubble
            key={m._key || `${i}-${m.role}`}
            role={m.role}
            text={m.content}
          />
        ))}
        {!messages.length && (
          <div
            style={{ opacity: 0.6, fontSize: 13, textAlign: 'center', paddingTop: 24 }}
          >
            ここに会話が表示されます
          </div>
        )}
      </div>

      {/* 入力バー */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          gap: 8,
          alignItems: 'flex-end',
          borderTop: '1px solid #e5e7eb',
          paddingTop: 8,
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="メッセージ入力…"
          style={{
            flex: 1,
            padding: 10,
            borderRadius: 10,
            border: '1px solid #e5e7eb',
            resize: 'none',
            maxHeight: 160,
          }}
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          style={{
            padding: '10px 14px',
            borderRadius: 10,
            border: '1px solid #2563eb',
            background: canSend ? '#3b82f6' : '#93c5fd',
            color: '#fff',
            cursor: canSend ? 'pointer' : 'not-allowed',
            height: 42,
          }}
        >
          送信
        </button>
      </div>

      {/* 共鳴メタの表示（サーバが返す場合に活用） */}
      <MetaPanel meta={meta ?? {}} />
    </div>
  );
}
