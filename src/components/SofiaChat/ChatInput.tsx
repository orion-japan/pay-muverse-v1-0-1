'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import './ChatInput.css';

type Props = {
  onSend: (text: string) => Promise<void> | void;
  disabled?: boolean;
  placeholder?: string;
  /** 複数チャットがある場合にドラフト保存キーを分けたいとき */
  draftKey?: string;
};

const DEFAULT_DRAFT_KEY = 'sofia_chat_draft';

export default function ChatInput({
  onSend,
  disabled = false,
  placeholder = 'メッセージを入力（Shift+Enterで改行）',
  draftKey = DEFAULT_DRAFT_KEY,
}: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [isComposing, setIsComposing] = useState(false); // ← IME中フラグ
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // ---- draft 復元（文字が消える対策）----
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem(draftKey) : '';
    if (saved) setText(saved);
  }, [draftKey]);

  // 保存
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(draftKey, text);
    }
  }, [text, draftKey]);

  // 自動リサイズ（最小4行）
  const autoSize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px';
  }, []);
  useEffect(() => { autoSize(); }, [text, autoSize]);

  // Enter送信 / Shift+Enter改行 / IME中は送信しない
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
        e.preventDefault();
        handleSend();
      }
    },
    [isComposing] // eslint-disable-line
  );

  const handleSend = useCallback(async () => {
    const value = text.trim();
    if (!value || sending || disabled) return;
    setSending(true);
    try {
      await onSend(value);
      setText('');
      // 送信成功後はドラフトもクリア
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(draftKey);
      }
      taRef.current?.focus();
    } finally {
      setSending(false);
    }
  }, [text, onSend, sending, disabled, draftKey]);

  // 初回フォーカス
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  return (
    <div className="sof-compose" aria-label="メッセージ入力エリア">
      <div className="sof-inputWrap">
        <textarea
          ref={taRef}
          className="sof-textarea"
          rows={4}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onInput={autoSize}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          disabled={disabled || sending}
          aria-label="メッセージ本文"
        />
<button
  data-sof-send                         // ★ ユニーク属性
  className="sof-sendBtn"
  onClick={handleSend}
  disabled={!text.trim() || sending || disabled}
  aria-label="送信" title="送信（Enter）"
>
  <span className="sof-sendIcon" aria-hidden>✈</span>
</button>

      </div>
    </div>
  );
}
