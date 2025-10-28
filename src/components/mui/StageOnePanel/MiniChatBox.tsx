'use client';
import React, { useState } from 'react';
import './StageOnePanel.css';

export default function MiniChatBox({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState('');

  return (
    <div className="chatbox">
      <textarea
        className="chatbox__ta"
        placeholder="チャットで色々聞く・話す…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        className="btn btn--primary"
        onClick={() => {
          const t = text.trim();
          if (!t) return;
          onSend(t);
          setText('');
        }}
      >
        送信
      </button>
    </div>
  );
}
