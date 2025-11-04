'use client';

import React from 'react';
import { useIrosChat } from '../IrosChatContext';
import styles from '../index.module.css';
import { useAuth } from '@/context/AuthContext'; // 動的アイコン用

type IrosMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  q?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  color?: string;
  ts?: number;
  // 将来、m.avatarUrl を添える場合は (m as any).avatarUrl で拾う
};

const AVATAR_SIZE = 32;
const FALLBACK_USER = '/iavatar_default.png'; // 必ず存在する既定アイコン
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

export default function MessageList() {
  const { messages, loading, error } = useIrosChat() as {
    messages: IrosMessage[];
    loading: boolean;
    error?: string | null;
  };

  // 認証ユーザー（avatarUrl を使う）
  const { user } = (useAuth?.() ?? {}) as { user?: { avatarUrl?: string | null } };

  // ===== 自動スクロール =====
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  const first = React.useRef(true);

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') =>
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });

  React.useEffect(() => {
    scrollToBottom(first.current ? 'auto' : 'smooth');
    first.current = false;
  }, [messages]);

  // 送信時の上スクロール（任意）
  React.useEffect(() => {
    const onUp = () => {
      const el =
        listRef.current ||
        (document.querySelector('.sof-msgs') as HTMLElement) ||
        (document.querySelector('[data-sof-chat-scroll]') as HTMLElement) ||
        document.scrollingElement;
      if (!el) return;
      el.scrollTo({ top: Math.max(0, el.scrollTop - 200), behavior: 'smooth' });
    };
    window.addEventListener('sof:scrollUp', onUp);
    return () => window.removeEventListener('sof:scrollUp', onUp);
  }, []);

  // ユーザーのアバターを解決（m.avatarUrl → user.avatarUrl → 既定）
  const resolveUserAvatar = (msg: IrosMessage): string => {
    const perMessage = ((msg as any)?.avatarUrl as string | undefined)?.trim();
    if (perMessage) return perMessage;
    const byAuth = user?.avatarUrl?.trim();
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

        return (
          <div
            key={m.id}
            className={`sof-msg ${isUser ? 'is-user' : 'is-assistant'}`}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: isUser ? 'flex-end' : 'flex-start',
              gap: 6,
              width: '100%',
            }}
          >
            {/* アバター（ユーザーは右端、AIは左端） */}
            <div className="avatar" style={{ alignSelf: isUser ? 'flex-end' : 'flex-start' }}>
              <img
                src={iconSrc}
                decoding="async"
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  const el = e.currentTarget as HTMLImageElement;
                  // 1段目：既定PNGへ
                  if (!el.dataset.fallback1) {
                    el.dataset.fallback1 = '1';
                    el.src = FALLBACK_USER;
                    return;
                  }
                  // 2段目：必ず成功する埋め込みSVGへ（ネットワーク不要）
                  if (!el.dataset.fallback2) {
                    el.dataset.fallback2 = '1';
                    el.src = FALLBACK_DATA;
                  }
                }}
                alt={isUser ? 'you' : 'Iros'}
                width={AVATAR_SIZE}
                height={AVATAR_SIZE}
                style={{
                  width: AVATAR_SIZE,
                  height: AVATAR_SIZE,
                  borderRadius: '50%',
                  objectFit: 'cover',
                  display: 'block',
                }}
              />
            </div>

            {/* 吹き出し本体 */}
            <div
              className={`bubble sof-bubble-custom ${isUser ? 'is-user' : 'is-assistant'}`}
              style={{
                alignSelf: isUser ? 'flex-end' : 'flex-start',
                maxWidth: 'min(var(--sofia-bubble-max, 780px), 86%)',
                background: isUser
                  ? 'linear-gradient(180deg,#ffffff 0%,#eef5ff 100%)'
                  : 'linear-gradient(180deg,#ffffff 0%,#f7f9fc 100%)',
                border: isUser ? '1px solid #cfe0ff' : '1px solid #e6eaf2',
                color: '#0f172a',
                borderRadius: 16,
                boxShadow: isUser
                  ? '0 1px 3px rgba(16,24,40,.06), 0 8px 24px rgba(30,64,175,.06)'
                  : '0 1px 3px rgba(16,24,40,.06), 0 8px 24px rgba(2,6,23,.05)',
                padding: '10px 12px',
              }}
            >
              {/* （任意）Qバッジ */}
              {m.q && (
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: '#fff',
                    border: '1px solid rgba(15,23,42,.08)',
                    color: '#334155',
                    marginBottom: 6,
                  }}
                >
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

              <p
                className={styles.msgText}
                style={{
                  margin: 0,
                  lineHeight: 1.85,
                  letterSpacing: '0.01em',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                }}
              >
                {m.text}
              </p>
            </div>
          </div>
        );
      })}

      {loading && (
        <div className={styles.loadingRow}>
          <div className={styles.dotAnim} />
          <div className={styles.dotAnim} />
          <div className={styles.dotAnim} />
        </div>
      )}
      {error && <div className={styles.error}>{error}</div>}

      <div ref={bottomRef} />
    </div>
  );
}
