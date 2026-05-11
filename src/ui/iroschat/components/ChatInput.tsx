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

function setKeyboardOpenUI(open: boolean) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  root.classList.toggle('keyboard-open', open);
  root.style.setProperty('--footer-safe-pad', open ? '0px' : 'var(--footer-h, 56px)');
}

function detectKeyboardOpen(): boolean {
  if (typeof window === 'undefined') return false;

  const vv = window.visualViewport;
  if (!vv) return false;

  const heightGap = window.innerHeight - vv.height;
  return heightGap > 120;
}

export default function ChatInput({ onMeta }: ChatInputProps) {
  const chat = useIrosChat();
  const sendMessage: any = (chat as any)?.sendMessage;
  const loading: boolean = Boolean((chat as any)?.loading);
  const draftText: string = String((chat as any)?.draftText ?? '');
  const setDraftText: ((text: string) => void) | undefined = (chat as any)?.setDraftText;

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [isComposing, setIsComposing] = useState(false);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const sendLockRef = useRef(false);

  const disabled = loading || sending;
  const normalizedForSend = useMemo(() => normalizeSendText(text), [text]);
  const hasActiveConversation = Boolean((chat as any)?.activeConversationId);
  const canSend =
  !disabled &&
  normalizedForSend.length > 0;

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

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const vv = window.visualViewport;
    if (!vv) return;

    let raf = 0;

    const syncKeyboardState = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const open = detectKeyboardOpen();
        setKeyboardOpenUI(open);
      });
    };

    vv.addEventListener('resize', syncKeyboardState);
    vv.addEventListener('scroll', syncKeyboardState);
    window.addEventListener('resize', syncKeyboardState);

    syncKeyboardState();

    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener('resize', syncKeyboardState);
      vv.removeEventListener('scroll', syncKeyboardState);
      window.removeEventListener('resize', syncKeyboardState);
      setKeyboardOpenUI(false);
    };
  }, []);

  const handleSend = useCallback(async () => {
    // ✅ 二重送信防止:
    // React state の disabled/sending 反映より先に、クリック/Enter が連続で入ることがある。
    // ここで即時ロックを見て、postMessage だけ複数走る状態を防ぐ。
    if (sendLockRef.current || loading || sending) {
      console.warn('[IrosChatInput] blocked: already sending', {
        sendLock: sendLockRef.current,
        loading,
        sending,
      });
      return;
    }

    const value = normalizeSendText(text);

    if (!value) {
      console.warn('[IrosChatInput] blocked: empty after normalize');
      return;
    }
    if (typeof sendMessage !== 'function') {
      return;
    }

    sendLockRef.current = true;
    setSending(true);

    // ✅ 先に退避
    const prevText = text;

    // ✅ 送信と同時に見た目を消す
    setText('');
    setDraftText?.('');
    try {
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {}

    try {
      taRef.current?.blur();

      const res: any = await sendMessage(value);

      if (onMeta && res?.meta) {
        onMeta(res.meta);
      }
    } catch (e) {
      console.error('[IrosChatInput] send error', e);

      // ✅ 失敗したら戻す
      setText(prevText);
      setDraftText?.(prevText);
      try {
        window.localStorage.setItem(DRAFT_KEY, prevText);
      } catch {}
    } finally {
      setSending(false);
      sendLockRef.current = false;
      autoSize();
    }
  }, [text, sendMessage, onMeta, autoSize, setDraftText, loading, sending]);

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

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  useEffect(() => {
    const next = String(draftText ?? '').trim();
    if (!next) return;

    setText((prev) => {
      const prevTrim = String(prev ?? '').trim();

      // すでに同じ内容なら何もしない
      if (prevTrim === next) return prev;

      // ユーザーが入力中なら上書きしない
      if (prevTrim.length > 0) return prev;

      // 空のときだけ draft を反映
      return next;
    });

    setDraftText?.('');

    requestAnimationFrame(() => {
      taRef.current?.focus();
      autoSize();
    });
  }, [draftText, setDraftText, autoSize]);

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
          onFocus={() => {
            setKeyboardOpenUI(true);
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                setKeyboardOpenUI(detectKeyboardOpen());
              });
            });
          }}
          onBlur={() => {
            setTimeout(() => {
              setKeyboardOpenUI(false);
            }, 180);
          }}
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
    console.log('[IROS][ChatInput] send button click', {
      canSend,
      disabled,
      sending,
      text,
      draftText,
      normalizedForSend,
      activeConversationId: (chat as any)?.activeConversationId ?? null,
    });

    if (canSend) {
      void handleSend();
    } else {
      console.log('[IROS][ChatInput] blocked at button', {
        canSend,
        disabled,
        sending,
        text,
        draftText,
        normalizedForSend,
        activeConversationId: (chat as any)?.activeConversationId ?? null,
      });
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
