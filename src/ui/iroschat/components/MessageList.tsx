// src/ui/iroschat/components/MessageList.tsx
'use client';

import React from 'react';
import { useIrosChat } from '../IrosChatContext';
import styles from '../index.module.css';
import { useAuth } from '@/context/AuthContext'; // 動的アイコン用
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import ReactMarkdown from 'react-markdown';
import '../IrosChat.css'; // 行間・余白の調整

type IrosMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: unknown; // 混在対策（確実に文字列化して描画）
  q?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  color?: string;
  ts?: number;
};

const AVATAR_SIZE = 32;
const FALLBACK_USER = '/iavatar_default.png';
const FALLBACK_DATA =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" viewBox="0 0 40 40">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#eceff7"/><stop offset="1" stop-color="#dde6ff"/>
      </linearGradient></defs>
      <rect width="40" height="40" rx="20" fill="url(#g)"/>
      <circle cx="20" cy="16" r="8" fill="#b7c3d7"/>
      <rect x="7" y="26" width="26" height="10" rx="5" fill="#c8d2e3"/>
    </svg>`
  );

/** [object Object]対策：最終的に必ず文字列へ正規化 */
function toSafeString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const cand =
      (typeof o.content === 'string' && o.content) ||
      (typeof o.text === 'string' && o.text) ||
      (typeof o.message === 'string' && o.message) ||
      (typeof o.assistant === 'string' && o.assistant);
    if (cand) return cand;
    try {
      return JSON.stringify(o, null, 2); // 可読性重視
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export default function MessageList() {
  const { messages, loading, error } = useIrosChat() as {
    messages: IrosMessage[];
    loading: boolean;
    error?: string | null;
  };

  const authVal = (typeof useAuth === 'function' ? useAuth() : {}) as {
    user?: { avatarUrl?: string | null };
  };
  const { user } = authVal || {};

  const listRef = React.useRef<HTMLDivElement | null>(null);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  const first = React.useRef(true);

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') =>
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });

  React.useEffect(() => {
    scrollToBottom(first.current ? 'auto' : 'smooth');
    first.current = false;
  }, [messages]);

  const resolveUserAvatar = (msg: IrosMessage): string => {
    const perMessage = ((msg as any)?.avatarUrl as string | undefined)?.trim?.();
    if (perMessage) return perMessage;
    const byAuth = user?.avatarUrl?.trim?.() || '';
    if (byAuth) return byAuth;
    return FALLBACK_USER;
  };

  return (
    <div ref={listRef} className={`${styles.timeline} sof-msgs`}>
      {!messages.length && !loading && !error && (
        <div className={styles.emptyHint}>ここに会話が表示されます</div>
      )}

      {messages.map((m) => {
        const isUser = m.role === 'user';
        const iconSrc = isUser ? resolveUserAvatar(m) : '/ir.png';

        // ここで必ず文字列化
        const safeText = toSafeString(m.text);

        return (
          <div key={m.id} className={`message ${isUser ? 'is-user' : 'is-assistant'}`}>
            {/* アバター */}
            <div
              className="avatar"
              style={{ alignSelf: isUser ? 'flex-end' : 'flex-start' }}
            >
              <img
                src={iconSrc}
                alt={isUser ? 'you' : 'Iros'}
                width={AVATAR_SIZE}
                height={AVATAR_SIZE}
                onError={(e) => {
                  const el = e.currentTarget as HTMLImageElement & {
                    dataset: Record<string, string | undefined>;
                  };
                  if (!el.dataset.fallback1) {
                    el.dataset.fallback1 = '1';
                    el.src = FALLBACK_USER;
                    return;
                  }
                  if (!el.dataset.fallback2) {
                    el.dataset.fallback2 = '1';
                    el.src = FALLBACK_DATA;
                  }
                }}
                style={{
                  borderRadius: '50%',
                  objectFit: 'cover',
                  display: 'block',
                }}
              />
            </div>

            {/* 吹き出し */}
            <div
              className={`bubble ${isUser ? 'is-user' : 'is-assistant'}`}
              style={{
                alignSelf: isUser ? 'flex-end' : 'flex-start',
                maxWidth: 'min(var(--sofia-bubble-max, 780px), 86%)',
              }}
            >
              {m.q && (
                <div className="q-badge">
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      background: m.color || '#94a3b8',
                      display: 'inline-block',
                    }}
                  />
                  {m.q}
                </div>
              )}

              {/* 本文（行間・段落間を制御） */}
              <div className="msgBody">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                  {safeText}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        );
      })}

      {loading && <div className={styles.loadingRow}>...</div>}
      {error && <div className={styles.error}>{error}</div>}
      <div ref={bottomRef} />
    </div>
  );
}
