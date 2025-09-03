// src/components/SofiaChat/MessageList.tsx
'use client';

import React from 'react';
import type { Message } from 'types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

/** 安全な外部リンクレンダラ */
function LinkRenderer(
  props: React.ComponentPropsWithoutRef<'a'> & { href?: string }
) {
  const { href = '#', children, ...rest } = props;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" {...rest}>
      {children}
    </a>
  );
}

/* ====== 追加: 現在のユーザー情報 ====== */
type CurrentUser = {
  id: string;
  name: string;
  userType: string;
  credits: number;
  avatarUrl?: string | null;
};

/* ====== 追加: Supabase相対パスも解決するアバターURL整形 ====== */
const SUPABASE_BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
function resolveAvatarUrl(src?: string | null): string {
  const u = (src ?? '').trim();
  if (!u) return '/avatar.png';
  if (/^https?:\/\//i.test(u) || /^data:image\//i.test(u)) return u;
  if (u.startsWith('/storage/v1/object/public/')) return `${SUPABASE_BASE}${u}`;
  if (u.startsWith('avatars/')) return `${SUPABASE_BASE}/storage/v1/object/public/${u}`;
  return `${SUPABASE_BASE}/storage/v1/object/public/avatars/${u}`;
}

/** 画像が落ちた時は 1 回だけ /avatar.png にフォールバック */
const Avatar: React.FC<{ src?: string | null; alt: string; size?: number }> = ({
  src,
  alt,
  size = 18,
}) => {
  const finalSrc = resolveAvatarUrl(src);
  const [url, setUrl] = React.useState(finalSrc);
  return (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
      onError={() => {
        if (url !== '/avatar.png') setUrl('/avatar.png');
      }}
    />
  );
};

export default function MessageList({
  messages,
  currentUser,
}: {
  messages: Message[];
  currentUser?: CurrentUser;
}) {
  return (
    <div className="sof-msgs">
      {messages.length === 0 ? (
        <div className="sof-empty">ここに会話が表示されます</div>
      ) : (
        <>
          {messages.map((m) => {
            const isAssistant = m.role !== 'user';

            // アシスタントの吹き出しに env 由来の CSS 変数を直接適用（即効性）
            const bubbleStyle: React.CSSProperties = isAssistant
              ? {
                  fontSize: 'var(--sofia-assist-fs, 15px)',
                  lineHeight: 'var(--sofia-assist-lh, 1.85)' as any,
                  letterSpacing: 'var(--sofia-assist-ls, 0.01em)',
                  maxWidth: 'var(--sofia-bubble-maxw, 78%)',
                  background: 'var(--sofia-a-bg, #f8fafc)',
                  border: 'var(--sofia-a-border, 1px solid #e5e7eb)',
                  borderRadius: 'var(--sofia-a-radius, 16px)',
                  boxShadow: 'var(--sofia-a-shadow, 0 1px 2px rgba(0,0,0,.04))',
                }
              : {};

            // ✅ ラベル: assistant→左寄せのまま / user→右寄せにする（吹き出しの右側）
            const roleStyle: React.CSSProperties = isAssistant
              ? { display: 'flex', alignItems: 'center', gap: 6 }
              : {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  justifyContent: 'flex-end', // ← 右寄せ
                  textAlign: 'right',
                };

            const roleEl = (
              <div className="sof-bubble__role" style={roleStyle}>
                {isAssistant ? (
                  <>
                    <img
                      src="/ir.png"
                      alt="iros"
                      width={18}
                      height={18}
                      style={{ width: 18, height: 18, borderRadius: '50%', objectFit: 'cover' }}
                    />
                    <span>iros</span>
                  </>
                ) : (
                  <>
                    <Avatar src={currentUser?.avatarUrl} alt={currentUser?.name || 'user'} />
                    <span>{currentUser?.name ?? currentUser?.id ?? 'user'}</span>
                  </>
                )}
              </div>
            );

            // Markdown（アシスタントのみ段落余白など適用）
            const mdComponents =
              isAssistant
                ? {
                    a: LinkRenderer,
                    p({ children }: { children: React.ReactNode }) {
                      return (
                        <p
                          style={{
                            margin: 'var(--sofia-p-margin, 6px) 0',
                            fontSize: 'var(--sofia-assist-fs, 15px)',
                            lineHeight: 'var(--sofia-assist-lh, 1.85)' as any,
                            letterSpacing: 'var(--sofia-assist-ls, 0.01em)',
                          }}
                        >
                          {children}
                        </p>
                      );
                    },
                    ul({ children }: { children: React.ReactNode }) {
                      return (
                        <ul
                          style={{
                            paddingInlineStart: 22,
                            margin: 'var(--sofia-p-margin, 6px) 0',
                            fontSize: 'var(--sofia-assist-fs, 15px)',
                            lineHeight: 'var(--sofia-assist-lh, 1.85)' as any,
                            letterSpacing: 'var(--sofia-assist-ls, 0.01em)',
                          }}
                        >
                          {children}
                        </ul>
                      );
                    },
                    ol({ children }: { children: React.ReactNode }) {
                      return (
                        <ol
                          style={{
                            paddingInlineStart: 22,
                            margin: 'var(--sofia-p-margin, 6px) 0',
                            fontSize: 'var(--sofia-assist-fs, 15px)',
                            lineHeight: 'var(--sofia-assist-lh, 1.85)' as any,
                            letterSpacing: 'var(--sofia-assist-ls, 0.01em)',
                          }}
                        >
                          {children}
                        </ol>
                      );
                    },
                    blockquote({ children }: { children: React.ReactNode }) {
                      return (
                        <blockquote
                          style={{
                            borderLeft: '4px solid var(--sofia-bq-border, #cbd5e1)',
                            background: 'var(--sofia-bq-bg, #f1f5f9)',
                            margin: 'var(--sofia-p-margin, 6px) 0',
                            padding: '8px 10px',
                            borderRadius: 6,
                            color: '#475569',
                            fontSize: 'var(--sofia-assist-fs, 15px)',
                            lineHeight: 'var(--sofia-assist-lh, 1.85)' as any,
                            letterSpacing: 'var(--sofia-assist-ls, 0.01em)',
                          }}
                        >
                          {children}
                        </blockquote>
                      );
                    },
                    code(props: any) {
                      const { inline, className, children, ...rest } = props;
                      if (inline) {
                        return (
                          <code
                            style={{
                              background: '#f3f4f6',
                              padding: '2px 6px',
                              borderRadius: 6,
                              fontFamily:
                                'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',
                              fontSize: '0.95em',
                            }}
                            {...rest}
                          >
                            {children}
                          </code>
                        );
                      }
                      return <code className={className} {...rest}>{children}</code>;
                    },
                    pre(props: any) {
                      const { children, ...rest } = props;
                      return (
                        <pre
                          style={{
                            background: '#0b1020',
                            color: 'white',
                            padding: '12px 14px',
                            borderRadius: 10,
                            overflowX: 'auto',
                            border: '1px solid #111827',
                          }}
                          {...rest}
                        >
                          {children}
                        </pre>
                      );
                    },
                    table({ children }: { children: React.ReactNode }) {
                      return (
                        <div style={{ overflowX: 'auto' }}>
                          <table
                            style={{
                              width: '100%',
                              borderCollapse: 'collapse',
                              fontSize: 14,
                            }}
                          >
                            {children}
                          </table>
                        </div>
                      );
                    },
                    th({ children }: { children: React.ReactNode }) {
                      return (
                        <th
                          style={{
                            textAlign: 'left',
                            borderBottom: '1px solid #e5e7eb',
                            padding: '6px 8px',
                            background: '#f9fafb',
                          }}
                        >
                          {children}
                        </th>
                      );
                    },
                    td({ children }: { children: React.ReactNode }) {
                      return (
                        <td style={{ borderBottom: '1px solid #f1f5f9', padding: '6px 8px' }}>
                          {children}
                        </td>
                      );
                    },
                  }
                : { a: LinkRenderer }; // ユーザーは最小限

            const uploaded = (m as any)?.uploaded_image_urls;

            return (
              <div
                key={m.id}
                className={`sof-bubble ${isAssistant ? 'is-assistant' : 'is-user'}`}
                style={bubbleStyle}
              >
                {Array.isArray(uploaded) && uploaded.length ? (
                  <div className="sof-bubble__imgs">
                    {uploaded.map((u: string, i: number) => (
                      <img key={i} src={u} alt="" />
                    ))}
                  </div>
                ) : null}

                {/* ラベル（アシスタントは左、ユーザーは右寄せ） */}
                {roleEl}

                <div className="sof-bubble__text">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={mdComponents as any}
                  >
                    {m.content}
                  </ReactMarkdown>
                </div>
              </div>
            );
          })}

          {/* 入力バー直上フェード */}
          <div className="sof-fader" aria-hidden />
        </>
      )}
    </div>
  );
}
