// src/components/SofiaChat/ChatApp.tsx
'use client';

import React from 'react';
import Composer from './Composer';
import MessageList from './MessageList';
import ToastHost from './ToastHost';
import type { Message } from 'types';
import './chat.css';

// 最小の現在ユーザー（必要なら置き換え）
const currentUser = {
  id: 'me',
  name: 'You',
  userType: 'dev',
  credits: 0,
  avatarUrl: null,
};

export default function ChatApp({ agent = 'mu' }: { agent?: 'mu' | 'iros' }) {
  const [messages, setMessages] = React.useState<Message[]>([]);

  // ユーザー送信を受け取る（Composer から発火）
  React.useEffect(() => {
    const onUser = (e: any) => {
      const text = String(e?.detail?.text ?? '');
      if (!text) return;
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'user', content: text } as Message,
      ]);
    };

    const onNewTurn = (e: any) => {
      const res = e.detail || {};
      // assistant 返信をMessageに変換（MessageListは拡張フィールドを読みます）
      const m = {
        id: res.sub_id || crypto.randomUUID(),
        role: 'assistant',
        content: res.reply ?? '',
        // 拡張：バッジやメタ用（Message型に無くてもOK）
        q_code: res.q_code,
        used_credits: res.used_credits,
        status: res.status,
        meta: res.meta,
        conversation_id: res.conversation_id,
        sub_id: res.sub_id,
      } as any;
      setMessages((prev) => [...prev, m]);
    };

    window.addEventListener('mu:user', onUser as any);
    window.addEventListener('mu:new-turn', onNewTurn as any);
    return () => {
      window.removeEventListener('mu:user', onUser as any);
      window.removeEventListener('mu:new-turn', onNewTurn as any);
    };
  }, []);

  return (
    <div
      className="sof-shell"
      style={{
        height: '100%',
        display: 'grid',
        gridTemplateRows: '1fr auto',
        gap: 8,
      }}
    >
      <div className="sof-body" style={{ overflow: 'auto' }}>
        {/* ✅ agent をリレー */}
        <MessageList
          messages={messages}
          currentUser={currentUser}
          agent={agent}
        />
      </div>
      <Composer isMaster={true /* ← マスター判定を実値に差し替え */} />
      <ToastHost />
    </div>
  );
}
