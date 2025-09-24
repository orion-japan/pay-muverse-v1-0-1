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

  // 二重送信ロック
  const sendLockRef = useRef(false);

  // 下書きロード
  useEffect(() => {
    try {
      const saved =
        typeof window !== 'undefined' ? window.localStorage.getItem(draftKey) : '';
      if (saved) setText(saved);
    } catch {}
  }, [draftKey]);

  // 下書き保存
  useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(draftKey, text);
      }
    } catch {}
  }, [text, draftKey]);

  // 自動リサイズ（初期は3行：min 66px、上限は160px）
  const autoSize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    requestAnimationFrame(() => {
      ta.style.height = 'auto';
      const minH = 66; // ← 3行相当
      const maxH = Math.min(180, Math.floor(window.innerHeight * 0.35));
      const next = Math.max(minH, Math.min(ta.scrollHeight, maxH));
      ta.style.height = next + 'px';
    });
  }, []);

  // テキスト変化・初回マウント・添付の出現で高さ調整
  useEffect(() => { autoSize(); }, [text, autoSize]);
  useEffect(() => { autoSize(); }, []);                 // mount
  useEffect(() => { autoSize(); }, [files.length]);     // 添付ありで高さが増えるケース

  const totalSizeMB = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
  const overMaxFiles = files.length > maxFiles;
  const overMaxSize = totalSizeMB > maxTotalSizeMB;

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
    [files, maxFiles],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (disabled || sending) return;
      appendFiles(e.dataTransfer?.files);
    },
    [appendFiles, disabled, sending],
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

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled || sending) return;
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
    },
    [appendFiles, disabled, sending],
  );

  const handleSend = useCallback(async () => {
    const value = text.trim();
    const hasFiles = files.length > 0;

    // 入口ガード
    if (disabled || sending || sendLockRef.current) return;
    if (!value && !hasFiles) return;
    if (overMaxFiles || overMaxSize) return;

    // 占有
    sendLockRef.current = true;
    setSending(true);

    try {
      // UI 先行クリア
      setText('');
      setFiles([]);
      try {
        if (typeof window !== 'undefined') window.localStorage.removeItem(draftKey);
      } catch {}
      taRef.current?.focus();

      if (onSendWithFiles) {
        await onSendWithFiles(value, hasFiles ? files : null);
      } else {
        await onSend(value);
      }
    } finally {
      setSending(false);
      sendLockRef.current = false;
      if (taRef.current) taRef.current.style.height = '42px'; // リセット
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

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
        e.preventDefault();
        if (!sendLockRef.current) {
          void handleSend();
        }
      }
    },
    [isComposing, handleSend],
  );

  // フォーカス管理
  useEffect(() => {
    taRef.current?.focus();
  }, []);
  useEffect(() => {
    if (focusToken !== undefined) taRef.current?.focus();
  }, [focusToken]);

  const removeFileAt = (idx: number) =>
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  const openPicker = () => fileRef.current?.click();

  const canSend =
    !disabled &&
    !sending &&
    (!!text.trim() || files.length > 0) &&
    !overMaxFiles &&
    !overMaxSize;

  // ★ 追加：Q&Aを開く（構造は変えず、内部で遷移）
  const openQA = () => {
    if (typeof window !== 'undefined') {
      window.location.assign('/knowledge'); // モーダル化する場合はここを差し替え
    }
  };

  return (
    /**
     * ここは「中身のみ」。固定や z-index 管理は親 .sof-compose-dock が担当。
     * （SofiaChatShell 側で <div className="sof-compose-dock"><ChatInput/></div> 前提）
     */
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
          rows={1}
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
              <div
                key={i}
                className="sof-fileChip"
                title={`${f.name} (${(f.size / 1024 / 1024).toFixed(2)}MB)`}
              >
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

        {/* アクション（縦並び） */}
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

          {/* ▼▼ 追加：送信ボタンの“上”にQ&Aボタン ▼▼ */}
          <button
            type="button"
            className="sof-actionBtn sof-actionBtn--qa"
            onClick={openQA}
            aria-label="Q&Aを開く"
            title="Q&Aを開く"
          >
            Q＆A
          </button>
          {/* ▲▲ 追加ここまで ▲▲ */}

          <button
            data-sof-send
            type="button"
            className="sof-actionBtn sof-actionBtn--send"
            onClick={() => {
              if (!sendLockRef.current) void handleSend();
            }}
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
