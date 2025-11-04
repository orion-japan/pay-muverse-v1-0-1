'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import './ChatInput.css';
import { useIrosChat } from '../IrosChatContext';

const DRAFT_KEY = 'iros_chat_draft';
const QA_URL = '/api/iros/summary'; // ルートが異なる場合はここだけ変更

export default function ChatInput() {
  const { send, loading } = useIrosChat();

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [isComposing, setIsComposing] = useState(false);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const sendLockRef = useRef(false);

  // ▼ チャット末尾へスクロール（Sofiaと同等の候補セレクタ）
  const scrollChatToBottom = useCallback(() => {
    const el =
      (document.querySelector('[data-sof-chat-scroll]') as HTMLElement) ||
      (document.querySelector('.sof-chatScroll') as HTMLElement) ||
      (document.querySelector('.sof-chatBody') as HTMLElement) ||
      (document.scrollingElement as HTMLElement);

    if (!el) return;
    const doScroll = () => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    requestAnimationFrame(doScroll);
    setTimeout(doScroll, 0);
    setTimeout(doScroll, 120);
  }, []);

  // ▼ 下書きロード／保存
  useEffect(() => {
    try {
      const saved = typeof window !== 'undefined' ? window.localStorage.getItem(DRAFT_KEY) : '';
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

  // ▼ 自動リサイズ（初期3行、上限は画面高の35%・最大180px）
  const autoSize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    requestAnimationFrame(() => {
      ta.style.height = 'auto';
      const minH = 66; // 3行相当
      const maxH = Math.min(180, Math.floor(window.innerHeight * 0.35));
      const next = Math.max(minH, Math.min(ta.scrollHeight, maxH));
      ta.style.height = next + 'px';
    });
  }, []);
  useEffect(() => {
    autoSize();
  }, [text, autoSize]);
  useEffect(() => {
    autoSize();
  }, []); // mount

  // ▼ 送信処理（Enter・ボタン共通）
  const handleSend = useCallback(
    async (overrideText?: string) => {
      const value = (overrideText ?? text).trim();
      if (!value) return;
      if (loading || sending || sendLockRef.current) return;

      sendLockRef.current = true;
      setSending(true);

      try {
        // 入力直後に上方向スクロール（GPT風演出）
        taRef.current?.blur();
        window.dispatchEvent(new Event('sof:scrollUp'));

        // 入力欄クリア＆draft消去
        setText('');
        try {
          if (typeof window !== 'undefined') {
            window.localStorage.removeItem(DRAFT_KEY);
          }
        } catch {}

        taRef.current?.focus();
        await send(value);
      } catch (e) {
        console.error('[IrosChatInput] send error:', e);
      } finally {
        setSending(false);
        sendLockRef.current = false;

        // 高さリセット
        if (taRef.current) {
          taRef.current.style.height = '66px';
          autoSize();
        }
        // レイテンシ吸収して再スクロール
        setTimeout(() => window.dispatchEvent(new Event('sof:scrollUp')), 80);
      }
    },
    [text, loading, sending, send, autoSize],
  );

  // ▼ キー操作：Enter送信 / Shift+Enter改行 / IME中は無効
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
        e.preventDefault();
        if (!sendLockRef.current) {
          taRef.current?.blur();
          scrollChatToBottom();
          void handleSend();
        }
      }
    },
    [isComposing, handleSend, scrollChatToBottom],
  );

  // 初期フォーカス
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  // Q&A（30日分のQコード要約ページへ）
  const openQA = () => {
    // 入力欄と下書きをクリア
    setText('');
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(DRAFT_KEY);
      }
    } catch {}

    const params = new URLSearchParams();
    params.set('scope', 'qcode');
    params.set('days', '30');
    if (typeof window !== 'undefined') {
      window.location.assign(`${QA_URL}?${params.toString()}`);
    }
  };

  const disabled = loading || sending;
  const canSend = !disabled && !!text.trim();

  return (
    <div className="sof-compose" aria-label="メッセージ入力エリア">
      <div className="sof-inputWrap">
        <textarea
          ref={taRef}
          className="sof-textarea"
          rows={1}
          placeholder="短く、その時の呼吸に合わせて入力してください…（Shift+Enterで改行）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onInput={autoSize}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          disabled={disabled}
          aria-label="Irosへメッセージ"
        />

        {/* アクション列（Q&A / 送信） */}
        <div className="sof-actions">
          <button
            type="button"
            className="sof-actionBtn sof-actionBtn--qa"
            onClick={openQA}
            aria-label="Q&Aを開く"
            title="Q&Aを開く"
          >
            Q＆A
          </button>

          <button
            data-sof-send
            type="button"
            className="sof-actionBtn sof-actionBtn--send"
            onClick={() => {
              if (!sendLockRef.current) {
                taRef.current?.blur();
                scrollChatToBottom();
                void handleSend();
              }
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
