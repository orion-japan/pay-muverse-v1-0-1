// src/components/SofiaChat/ChatInput.tsx
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import './ChatInput.css';

type Props = {
  /** 既存互換: テキストのみ送信 */
  onSend: (text: string) => Promise<void> | void;

  /** 新規: テキスト + ファイル送信（これを渡すとこちらが優先） */
  onSendWithFiles?: (text: string, files?: File[] | null) => Promise<void> | void;

  disabled?: boolean;
  placeholder?: string;

  /** 複数チャットがある場合にドラフト保存キーを分けたいとき */
  draftKey?: string;

  /** <input type="file" accept="..."> の accept（既定: 画像/動画/音声/一般ファイル） */
  accept?: string;

  /** 同時添付の最大枚数（既定: 5） */
  maxFiles?: number;

  /** 添付の総容量上限（MB, 既定: 25MB） */
  maxTotalSizeMB?: number;
};

const DEFAULT_DRAFT_KEY = 'sofia_chat_draft';

export default function ChatInput({
  onSend,
  onSendWithFiles,
  disabled = false,
  placeholder = 'メッセージを入力（Shift+Enterで改行）',
  draftKey = DEFAULT_DRAFT_KEY,
  accept = 'image/*,video/*,audio/*,.pdf,.txt,.md,.doc,.docx,.ppt,.pptx,.xls,.xlsx',
  maxFiles = 5,
  maxTotalSizeMB = 25,
}: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [isComposing, setIsComposing] = useState(false); // IME中フラグ
  const [dragOver, setDragOver] = useState(false);

  const [files, setFiles] = useState<File[]>([]);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // ---- draft 復元（文字が消える対策）----
  useEffect(() => {
    try {
      const saved = typeof window !== 'undefined' ? window.localStorage.getItem(draftKey) : '';
      if (saved) setText(saved);
    } catch {
      /* no-op */
    }
  }, [draftKey]);

  // 保存（テキストのみ保存。添付ファイルは保存しない）
  useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(draftKey, text);
      }
    } catch {
      /* no-op */
    }
  }, [text, draftKey]);

  // 自動リサイズ（最小4行）
  const autoSize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px';
  }, []);
  useEffect(() => {
    autoSize();
  }, [text, autoSize]);

  // ファイル合計サイズ（MB）
  const totalSizeMB = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
  const overMaxFiles = files.length > maxFiles;
  const overMaxSize = totalSizeMB > maxTotalSizeMB;

  // 添付を追加
  const appendFiles = useCallback(
    (add: FileList | File[] | null | undefined) => {
      if (!add) return;
      const next = [...files];
      for (const f of Array.from(add)) {
        next.push(f);
        if (next.length >= maxFiles) break;
      }
      setFiles(next);
    },
    [files, maxFiles]
  );

  // ドラッグ&ドロップ
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (disabled || sending) return;
      appendFiles(e.dataTransfer?.files);
    },
    [appendFiles, disabled, sending]
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  // 画像のペースト（クリップボード）
  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pasted: File[] = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const file = it.getAsFile();
        if (file) pasted.push(file);
      }
    }
    if (pasted.length) {
      e.preventDefault(); // テキスト化の挿入を防ぐ（必要に応じて外してください）
      appendFiles(pasted);
    }
  }, [appendFiles]);

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

  // 送信
  const handleSend = useCallback(async () => {
    const value = text.trim();
    const hasFiles = files.length > 0;

    if ((disabled || sending) || (!value && !hasFiles)) return;
    if (overMaxFiles || overMaxSize) return;

    setSending(true);
    try {
      if (onSendWithFiles) {
        await onSendWithFiles(value, hasFiles ? files : null);
      } else {
        // 既存互換: onSend(text) のみ
        await onSend(value);
      }

      // 成功時はクリア
      setText('');
      setFiles([]);
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.removeItem(draftKey);
        }
      } catch {
        /* no-op */
      }
      taRef.current?.focus();
    } finally {
      setSending(false);
    }
  }, [
    text,
    files,
    disabled,
    sending,
    overMaxFiles,
    overMaxSize,
    onSendWithFiles,
    onSend,
    draftKey,
  ]);

  // 初回フォーカス
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  const removeFileAt = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const openPicker = () => fileRef.current?.click();

  const canSend = !disabled && !sending && (!!text.trim() || files.length > 0) && !overMaxFiles && !overMaxSize;

  return (
    <div
      className="sof-compose"
      aria-label="メッセージ入力エリア"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      data-dragover={dragOver ? 'true' : 'false'}
    >
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
          onPaste={onPaste}
          disabled={disabled || sending}
          aria-label="メッセージ本文"
        />

        {/* 添付ファイル表示（簡易チップ） */}
        {files.length > 0 && (
          <div className="sof-fileChips" aria-live="polite">
            {files.map((f, i) => (
              <div key={i} className="sof-fileChip" title={`${f.name} (${(f.size/1024/1024).toFixed(2)}MB)`}>
                <span className="sof-fileName">{f.name}</span>
                <button
                  type="button"
                  className="sof-fileRemove"
                  onClick={() => removeFileAt(i)}
                  aria-label={`${f.name} を削除`}
                  title="削除"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 制限超過メッセージ */}
        {(overMaxFiles || overMaxSize) && (
          <div className="sof-attachWarn" role="alert">
            {overMaxFiles && <div>添付は最大 {maxFiles} 個までです。</div>}
            {overMaxSize && <div>合計サイズが {maxTotalSizeMB}MB を超えています。</div>}
          </div>
        )}

        {/* 添付ボタン + 送信ボタン */}
        <div className="sof-actions">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={accept}
            style={{ display: 'none' }}
            onChange={(e) => appendFiles(e.target.files || undefined)}
          />
          <button
            type="button"
            className="sof-attachBtn"
            onClick={openPicker}
            disabled={disabled || sending || files.length >= maxFiles}
            aria-label="ファイルを添付"
            title="ファイルを添付"
          >
            📎
          </button>

          <button
            data-sof-send
            className="sof-sendBtn"
            onClick={handleSend}
            disabled={!canSend}
            aria-label="送信"
            title="送信（Enter）"
          >
            <span className="sof-sendIcon" aria-hidden>✈</span>
          </button>
        </div>
      </div>
    </div>
  );
}
