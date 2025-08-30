'use client';
// src/components/SofiaChat.tsx

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type MsgRole = 'user' | 'assistant';
export type UiMsg = { role: MsgRole; content: string; _key?: string };

type ConversationItem = {
  conversation_code: string;
  title?: string | null;
  updated_at?: string | null;
  last_text?: string | null;
};

/* ---- key 付与 / 剥がし ---- */
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

/* ---- 吹き出し ---- */
function MessageBubble({ role, text }: { role: MsgRole; text: string }) {
  const isUser = role === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', margin: '6px 0' }}>
      <div
        style={{
          maxWidth: '78%',
          whiteSpace: 'pre-wrap',
          borderRadius: 12,
          padding: '8px 12px',
          background: isUser ? '#e6f3ff' : '#fff',
          border: '1px solid #e5e7eb',
          boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
          lineHeight: 1.6,
        }}
      >
        {text}
      </div>
    </div>
  );
}

export function SofiaChat() {
  // state
  const [userCode, setUserCode] = useState('U0000');
  const [convCode, setConvCode] = useState<string>('');
  const [convs, setConvs] = useState<ConversationItem[]>([]);
  const [messages, setMessages] = useState<UiMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [initLoaded, setInitLoaded] = useState(false);
  const [mode, setMode] = useState<'normal' | 'diagnosis' | 'meaning' | 'intent' | 'dark' | 'remake'>('normal');

  const listRef = useRef<HTMLDivElement>(null);

  // スクロール最下部へ
  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(scrollToBottom, [messages, scrollToBottom]);

  // 会話一覧
  const loadConversations = useCallback(async (uc: string) => {
    const url = `/api/sofia?user_code=${encodeURIComponent(uc)}`;
    const rs = await fetch(url, { cache: 'no-store' });
    const json = await rs.json();
    const items: ConversationItem[] = Array.isArray(json?.items) ? json.items : [];
    setConvs(items);
    return items;
  }, []);

  // メッセージ
  const loadMessages = useCallback(async (uc: string, cc: string) => {
    if (!cc) {
      setMessages([]);
      return;
    }
    const url = `/api/sofia?user_code=${encodeURIComponent(uc)}&conversation_code=${encodeURIComponent(cc)}`;
    const rs = await fetch(url, { cache: 'no-store' });
    const json = await rs.json();
    const msgs: UiMsg[] = Array.isArray(json?.messages)
      ? json.messages.map((m: any) => ({ role: m.role, content: m.content, _key: m._key }))
      : [];
    setMessages(ensureUiKeys(msgs));
  }, []);

  // 初期ロード
  useEffect(() => {
    (async () => {
      const items = await loadConversations(userCode);
      const first = items?.[0]?.conversation_code ?? '';
      setConvCode(first);
      if (first) await loadMessages(userCode, first);
      setInitLoaded(true);
    })();
  }, [loadConversations, loadMessages, userCode]);

  // 会話切り替え
  useEffect(() => {
    if (!initLoaded) return;
    loadMessages(userCode, convCode);
  }, [convCode, initLoaded, loadMessages, userCode]);

  // 新規
  const handleNewConversation = useCallback(() => {
    const code = `Q${Date.now()}`;
    setConvCode(code);
    setMessages([]);
  }, []);

  const canSend = useMemo(() => input.trim().length > 0 && !loading, [input, loading]);

  // 送信
  const handleSend = useCallback(async () => {
    if (!canSend) return;
    setLoading(true);

    const userMsg: UiMsg = { role: 'user', content: input };
    const next = ensureUiKeys([...messages, userMsg]);
    setMessages(next);
    setInput('');

    try {
      const body = {
        user_code: userCode,
        conversation_code: convCode || `Q${Date.now()}`,
        mode,
        messages: stripUiKeys(next),
      };
      const rs = await fetch('/api/sofia', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await rs.json();

      const reply = json?.reply ?? '';
      if (reply) setMessages(ensureUiKeys([...next, { role: 'assistant', content: reply }]));

      if (json?.conversation_code && json.conversation_code !== convCode) {
        setConvCode(json.conversation_code);
      }
      loadConversations(userCode).catch(() => void 0);
    } catch {
      setMessages(ensureUiKeys([...next, { role: 'assistant', content: '（通信に失敗しました…もう一度お試しください）' }]));
    } finally {
      setLoading(false);
    }
  }, [canSend, convCode, loadConversations, messages, userCode, input, mode]);

  // Enterで送信（Shift+Enterは改行）
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) handleSend();
    }
  };

  return (
    // 画面全高にフィット：ヘッダー/メッセージ/入力バーの3分割
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
      {/* ヘッダー（固定高さ） */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ fontWeight: 700 }}>Sofia Chat</div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.6 }}>会話コード</div>
            <select value={convCode} onChange={(e) => setConvCode(e.target.value)} style={{ width: 220, padding: '6px 8px' }}>
              {convs.map((c) => (
                <option key={c.conversation_code} value={c.conversation_code}>
                  {c.conversation_code}
                </option>
              ))}
              {convCode && !convs.some((c) => c.conversation_code === convCode) ? (
                <option key={convCode} value={convCode}>
                  {convCode}
                </option>
              ) : null}
            </select>
          </div>

          <div>
            <div style={{ fontSize: 12, opacity: 0.6 }}>モード</div>
            <select value={mode} onChange={(e) => setMode(e.target.value as any)} style={{ width: 120, padding: '6px 8px' }}>
              <option value="normal">通常</option>
              <option value="diagnosis">診断</option>
              <option value="meaning">意味付け</option>
              <option value="intent">意図</option>
              <option value="dark">闇の物語</option>
              <option value="remake">リメイク</option>
            </select>
          </div>

          <button onClick={handleNewConversation} style={{ padding: '6px 10px' }}>
            新規生成
          </button>
        </div>
      </div>

      {/* メッセージエリア（伸縮・スクロール） */}
      <div
        ref={listRef}
        style={{
          flex: '1 1 auto',
          minHeight: 0,                 // flex 子の overflow を有効化
          overflowY: 'auto',
          padding: 12,
          background: 'linear-gradient(#f9fafb, #f3f4f6)',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
        }}
      >
        {messages.map((m, i) => (
          <MessageBubble key={m._key || `${i}-${m.role}`} role={m.role} text={m.content} />
        ))}
        {!messages.length && (
          <div style={{ opacity: 0.6, fontSize: 13, textAlign: 'center', paddingTop: 24 }}>
            ここに会話が表示されます
          </div>
        )}
      </div>

      {/* 入力バー（下固定） */}
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
          placeholder="メッセージを入力…（Enterで送信 / Shift+Enterで改行）"
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

      {loading && <div style={{ fontSize: 12, opacity: 0.7 }}>送信中…</div>}
    </div>
  );
}
