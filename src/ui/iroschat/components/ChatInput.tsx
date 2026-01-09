'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import './ChatInput.css';
import { useIrosChat } from '../IrosChatContext';

const DRAFT_KEY = 'iros_chat_draft';

type ChatInputProps = {
  /** /reply から返ってきた meta を上位（Shell）に渡すためのフック */
  onMeta?: (meta: any) => void;
};

//
// =========================================================
// ghost / ellipsis normalize（UI側）
// =========================================================
function normalizeGhostWhitespace(input: string): string {
  const s = String(input ?? '');
  const removed = s.replace(/[\u3164\u200B-\u200D\u2060\uFEFF\u2800]/g, '');
  return removed.replace(/\r\n/g, '\n').trim();
}

function isEllipsisOnly(input: string): boolean {
  const s = String(input ?? '').replace(/\s+/g, '').trim();
  if (!s) return true;
  if (/^…+$/.test(s)) return true;
  if (/^\.+$/.test(s)) return true;
  if (/^[.…]+$/.test(s)) return true;
  return false;
}

function normalizeSendText(input: string): string {
  const norm = normalizeGhostWhitespace(input);
  if (isEllipsisOnly(norm)) return '';
  return norm;
}

export default function ChatInput({ onMeta }: ChatInputProps) {
  const chat = useIrosChat();
  const sendMessage: any = (chat as any)?.sendMessage;
  const loading: boolean = Boolean((chat as any)?.loading);

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [isComposing, setIsComposing] = useState(false);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const sendLockRef = useRef(false);

  // ▼ 送信可否（本番定義）
  const disabled = loading || sending;
  const normalizedForSend = useMemo(
    () => normalizeSendText(text),
    [text],
  );
  const canSend = !disabled && normalizedForSend.length > 0;

  // ▼ 下書きロード／保存
  useEffect(() => {
    try {
      const saved =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(DRAFT_KEY)
          : '';
      if (saved) setText(saved);
    } catch {}
  }, []);

  useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(DRAFT_KEY, text);
      }
    } catch {}
  }, [text]);

  // ▼ 自動リサイズ
  const autoSize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    requestAnimationFrame(() => {
      ta.style.height = 'auto';
      const minH = 66;
      const maxH = Math.min(180, Math.floor(window.innerHeight * 0.35));
      const next = Math.max(minH, Math.min(ta.scrollHeight, maxH));
      ta.style.height = `${next}px`;
    });
  }, []);

  useEffect(() => {
    autoSize();
  }, [text, autoSize]);

  // ▼ 送信処理
  const handleSend = useCallback(async () => {
    const value = normalizeSendText(text);

    if (!value) {
      console.warn('[IrosChatInput] blocked: empty after normalize');
      return;
    }
    if (disabled || sendLockRef.current) return;
    if (typeof sendMessage !== 'function') {
      console.error('[IrosChatInput] sendMessage missing');
      return;
    }

    sendLockRef.current = true;
    setSending(true);

    try {
      taRef.current?.blur();

      setText('');
      try {
        window.localStorage.removeItem(DRAFT_KEY);
      } catch {}

      const res: any = await sendMessage(value);

      if (onMeta && res?.meta) {
        onMeta(res.meta);
      }
    } catch (e) {
      console.error('[IrosChatInput] send error', e);
    } finally {
      setSending(false);
      sendLockRef.current = false;
      autoSize();
    }
  }, [text, disabled, sendMessage, onMeta, autoSize]);

  // ▼ キー操作
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
        e.preventDefault();
        if (canSend) {
          void handleSend();
        }
      }
    },
    [isComposing, canSend, handleSend],
  );

  // 初期フォーカス
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  return (
    <div className="sof-compose" aria-label="メッセージ入力エリア">
      <div className="sof-inputWrap">
        <textarea
          ref={taRef}
          className="sof-textarea"
          rows={1}
          placeholder="こちらに入力してください…（Shift+Enterで改行）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onInput={autoSize}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          disabled={disabled}
          aria-label="Irosへメッセージ"
        />

        <div className="sof-actions sof-actions--single">
          <button
            data-sof-send
            type="button"
            className="sof-actionBtn sof-actionBtn--send sof-actionBtn--lg"
            onClick={() => {
              if (canSend) {
                void handleSend();
              }
            }}
            disabled={!canSend}
            aria-label="送信"
            title="送信（Enter）"
          >
            {sending ? '送信中…' : '送信'}
          </button>
        </div>
      </div>
    </div>
  );
}
