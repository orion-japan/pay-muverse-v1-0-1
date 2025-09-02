// src/components/SofiaChat/ChatInput.tsx
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

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
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // ====== Auto-resize (min 3 rows, max 10 rows 相当) ======
  const MIN_ROWS = 3;
  const MAX_ROWS = 10;

  const autosize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    // 現在の高さリセット → scrollHeight を測る
    ta.style.height = 'auto';

    // 実際の line-height を取得
    const cs = window.getComputedStyle(ta);
    const line = parseFloat(cs.lineHeight || '22') || 22;

    const minH = MIN_ROWS * line;
    const maxH = MAX_ROWS * line;

    // コンテンツに合わせて拡張（上限は maxH）
    const nextH = Math.min(Math.max(ta.scrollHeight, minH), maxH);
    ta.style.height = `${nextH}px`;

    // これ以上増やせない場合はスクロールで対応
    ta.style.overflowY = nextH >= maxH ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    autosize(); // 初期表示時（空でも最小3行の高さに）
  }, [autosize]);

  useEffect(() => {
    autosize(); // 入力のたびに高さ更新
  }, [text, autosize]);

  // ====== 添付ファイル ======
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = Array.from(e.target.files || []);
    setFiles(f);
    console.log('[SofiaUI] files selected:', f.map((x) => x.name));
  };

  // ====== 送信 ======
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
      // 失敗時にテキストを戻したい場合は以下を有効化：
      // setText(payload);
    } finally {
      setSending(false);
      // 送信後も高さをリセットして最小サイズに戻す
      requestAnimationFrame(() => autosize());
    }
  }, [text, files, sending, onSend, autosize]);

  // ====== キー操作：Enter=送信 / Shift+Enter=改行 ======
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sending) void doSend();
    }
  };

  return (
    <div className="sof-compose">
      <textarea
        ref={taRef}
        className="sof-input"
        placeholder="メッセージを入力…"
        value={text}
        onChange={(e) => setText(e.target.value)} // 改行付きペーストも保持される
        onKeyDown={onKeyDown}
        disabled={sending}
        aria-label="チャット入力"
        // rows は 1 にして高さは JS で制御（最小3行相当まで拡張）
        rows={1}
        style={{
          resize: 'none',    // ユーザー手動リサイズは無効
          overflowY: 'hidden', // 上限到達時に autosize() 側で auto に切り替え
        }}
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
