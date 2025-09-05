// src/components/SofiaChat/ChatInput.tsx
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import './ChatInput.css';

type Props = {
  onSend: (text: string) => Promise<void> | void;
  onSendWithFiles?: (text: string, files?: File[] | null) => Promise<void> | void;
  disabled?: boolean;
  placeholder?: string;
  draftKey?: string;
  accept?: string;
  maxFiles?: number;
  maxTotalSizeMB?: number;
  focusToken?: unknown;
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
  focusToken,
}: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [files, setFiles] = useState<File[]>([]);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      const saved = typeof window !== 'undefined' ? window.localStorage.getItem(draftKey) : '';
      if (saved) setText(saved);
    } catch {}
  }, [draftKey]);

  useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(draftKey, text);
      }
    } catch {}
  }, [text, draftKey]);

  const autoSize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px';
  }, []);
  useEffect(() => { autoSize(); }, [text, autoSize]);

  const totalSizeMB = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
  const overMaxFiles = files.length > maxFiles;
  const overMaxSize = totalSizeMB > maxTotalSizeMB;

  const appendFiles = useCallback((add: FileList | File[] | null | undefined) => {
    if (!add) return;
    const next = [...files];
    for (const f of Array.from(add)) {
      next.push(f);
      if (next.length >= maxFiles) break;
    }
    setFiles(next);
  }, [files, maxFiles]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (disabled || sending) return;
    appendFiles(e.dataTransfer?.files);
  }, [appendFiles, disabled, sending]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

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
      e.preventDefault();
      appendFiles(pasted);
    }
  }, [appendFiles]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
      e.preventDefault();
      handleSend();
    }
  }, [isComposing]); // eslint-disable-line

  const handleSend = useCallback(async () => {
    const value = text.trim();
    const hasFiles = files.length > 0;
    if ((disabled || sending) || (!value && !hasFiles)) return;
    if (overMaxFiles || overMaxSize) return;

    setText('');
    setFiles([]);
    try { if (typeof window !== 'undefined') window.localStorage.removeItem(draftKey); } catch {}
    taRef.current?.focus();

    setSending(true);
    try {
      if (onSendWithFiles) {
        await onSendWithFiles(value, hasFiles ? files : null);
      } else {
        await onSend(value);
      }
    } finally {
      setSending(false);
    }
  }, [text, files, disabled, sending, overMaxFiles, overMaxSize, onSendWithFiles, onSend, draftKey]);

  useEffect(() => { taRef.current?.focus(); }, []);
  useEffect(() => { if (focusToken !== undefined) taRef.current?.focus(); }, [focusToken]);

  const removeFileAt = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));
  const openPicker = () => fileRef.current?.click();

  // ir診断：入力欄にセットするだけ（送信しない）
  const insertIRDiagnosis = useCallback(() => {
    setText('ir診断');
    requestAnimationFrame(() => taRef.current?.focus());
  }, []);

  const canSend =
    !disabled && !sending &&
    (!!text.trim() || files.length > 0) &&
    !overMaxFiles && !overMaxSize;

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

        {(overMaxFiles || overMaxSize) && (
          <div className="sof-attachWarn" role="alert">
            {overMaxFiles && <div>添付は最大 {maxFiles} 個までです。</div>}
            {overMaxSize && <div>合計サイズが {maxTotalSizeMB}MB を超えています。</div>}
          </div>
        )}

        {/* アクション（縦並び、添付ボタンは非表示維持） */}
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
            style={{ display: 'none' }}
          >
            📎
          </button>

          <button
    type="button"
    className="sof-actionBtn sof-actionBtn--ir"   // ← 追加
    onClick={insertIRDiagnosis}
    disabled={disabled || sending}
    aria-label="ir診断を入力欄に挿入"
    title="ir診断を入力に挿入"
  >
    ir診断
  </button>

  {/* 下：送信（←クラスを追加して色付け） */}
  <button
    data-sof-send
    className="sof-actionBtn sof-actionBtn--send"  // ← 追加
    onClick={handleSend}
    disabled={!canSend}
    aria-label="送信"
    title="送信（Enter）"
  >
    送信
  </button>
</div>
      </div>
    </div>
  );
}
