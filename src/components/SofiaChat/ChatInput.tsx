// src/components/SofiaChat/ChatInput.tsx
'use client';

import React, { useCallback, useRef, useState } from 'react';

type Props = {
  onSend: (text: string, files?: File[] | null) => Promise<any> | any;
  onPreview: () => void;
  onCancelPreview: () => void;
};

export default function ChatInput({ onSend }: Props) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = Array.from(e.target.files || []);
    setFiles(f);
    console.log('[SofiaUI] files selected:', f.map((x) => x.name));
  };

  const doSend = useCallback(async () => {
    const payload = text.trim();
    if (!payload || sending) return;
    console.log('[SofiaUI] send click:', { len: payload.length, files: files.length });

    // 1) 先に即クリア（UI体験優先）
    setText('');
    setSending(true);

    try {
      await onSend(payload, files.length ? files : null);
      // 成功時：添付もクリア
      setFiles([]);
      if (fileRef.current) fileRef.current.value = '';
    } catch (e) {
      console.error('[SofiaUI] onSend error:', e);
      // 失敗時：テキストは戻さない方が誤連投を防げる。戻したい場合は setText(payload)
    } finally {
      setSending(false);
    }
  }, [text, files, sending, onSend]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sending) void doSend();
    }
  };

  return (
    <div className="sof-compose">
      <input
        className="sof-input"
        type="text"
        placeholder="メッセージを入力…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={sending}
        aria-label="チャット入力"
      />

      <input
        ref={fileRef}
        className="sof-file"
        type="file"
        multiple
        onChange={handleFileChange}
        disabled={sending}
        aria-label="ファイルを選択"
      />

      <button
        className={`sof-btn${sending ? '' : ' primary'}`}
        onClick={() => void doSend()}
        disabled={sending || !text.trim()}
        aria-busy={sending}
        aria-label="送信"
        style={{ minWidth: 64 }}
      >
        {sending ? '送信中…' : '送信'}
      </button>
    </div>
  );
}
