// src/components/SofiaChat/MessageList.tsx
'use client';

import React from 'react';
import type { Message } from './types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import AvatarImg from '@/components/AvatarImg';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

/** 外部リンクを安全に開く */
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

type CurrentUser = {
  id: string;                 // ← user_code を想定（UUIDでも可）
  name: string;
  userType: string;
  credits: number;
  avatarUrl?: string | null;  // ← 空でもOK（フォールバックで埋める）
};

/* ===== バッジ判定（Iros と同等の振る舞い） ===== */
function getAgentBadge(
  m: any,
  isAssistant: boolean,
  agent?: 'mu' | 'iros' | 'mirra'
): 'MuAI' | 'Iros' | 'Mirra' | 'mTalk' | 'sShot' | null {
  if (!isAssistant) return null;

  // ページ側指定を優先
  if (agent === 'iros') return 'Iros';
  if (agent === 'mu') return 'MuAI';
  if (agent === 'mirra') return 'Mirra';

  // メッセージ内メタのフォールバック
  const a = m.agent || m?.meta?.agent;
  if (a === 'Iros' || a === 'MuAI' || a === 'Mirra' || a === 'mTalk' || a === 'sShot') return a;

  const mode = m?.meta?.mode;
  if (mode === 'iros') return 'Iros';
  if (mode === 'mirra') return 'Mirra';
  if (mode === 'mtalk') return 'mTalk';
  if (mode === 'sshot') return 'sShot';

  return 'MuAI';
}

export default function MessageList({
  messages,
  currentUser,
  agent,
}: {
  messages: Message[];
  currentUser?: CurrentUser;
  agent?: 'mu' | 'iros' | 'mirra';
}) {
  // ▼ currentUser.avatarUrl が空でも profiles から補完
  const supabase = React.useMemo(() => createClientComponentClient(), []);
  const [resolvedAvatar, setResolvedAvatar] = React.useState<string | null | undefined>(
    currentUser?.avatarUrl
  );
  const [resolvedName, setResolvedName] = React.useState<string | undefined>(currentUser?.name);

  React.useEffect(() => {
    let alive = true;

    async function fillFromProfiles() {
      // すでに渡されていれば何もしない
      if (currentUser?.avatarUrl) return;

      // user_code 等を currentUser.id で受け取っている想定
      if (!currentUser?.id) return;

      // profiles に user_code がある前提。UUIDで紐づけなら eq('user_id', …) に変更。
      const { data, error } = await supabase
        .from('profiles')
        .select('name, avatar_url')
        .eq('user_code', currentUser.id)
        .single();

      if (!alive) return;

      if (!error && data) {
        setResolvedAvatar(data.avatar_url ?? null);
        if (data.name && !resolvedName) setResolvedName(data.name);
      }
    }

    setResolvedAvatar(currentUser?.avatarUrl ?? null);
    setResolvedName(currentUser?.name);

    fillFromProfiles();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, currentUser?.id, currentUser?.avatarUrl]);

  return (
    <div className="sof-msgs">
      {messages.length === 0 ? (
        <div className="sof-empty">ここに会話が表示されます</div>
      ) : (
        <>
          {messages.map((m) => {
            const isAssistant = m.role !== 'user';
            const badge = getAgentBadge(m, isAssistant, agent);

            // 色など差分用のクラス（mu→is-muai）
            const agentClass =
              isAssistant && agent ? `is-${agent === 'mu' ? 'muai' : agent}` : '';

            // アシスタントの吹き出し装飾（Iros と同じ変数適用）
            const bubbleStyle: React.CSSProperties = isAssistant
              ? {
                  fontSize: 'var(--sofia-assist-fs, 15px)',
                  lineHeight: 'var(--sofia-assist-lh, 1.85)' as any,
                  letterSpacing: 'var(--sofia-assist-ls, 0.01em)',
                  background: 'var(--sofia-a-bg, #f8fafc)',
                  border: 'var(--sofia-a-border, 1px solid #e5e7eb)',
                  borderRadius: 'var(--sofia-a-radius, 16px)',
                  boxShadow: 'var(--sofia-a-shadow, 0 1px 2px rgba(0,0,0,.04))',
                }
              : {};

            const iconSrc =
              (badge === 'Iros'
                ? '/ir.png'
                : badge === 'Mirra'
                ? '/mirra.png'
                : badge === 'mTalk'
                ? '/mtalk.png'
                : badge === 'sShot'
                ? '/sshot.png'
                : '/mu_ai.png') + '?v=3';

            // Markdown レンダラ（Iros と同じトーン）
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
                      return (
                        <code className={className} {...rest}>
                          {children}
                        </code>
                      );
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
                : { a: LinkRenderer };

            const uploaded = (m as any)?.uploaded_image_urls;
            const usedCredits = (m as any)?.used_credits;
            const qCode = (m as any)?.q_code;
            const status = (m as any)?.status as
              | 'ok'
              | 'error'
              | 'timeout'
              | 'unauthorized'
              | 'ratelimited'
              | undefined;

            /* ========= 縦並びレイアウト（avatar 上 / bubble 下） ========= */
            return (
              <div
                key={m.id}
                className={`sof-msg ${isAssistant ? 'is-assistant' : 'is-user'} ${agentClass}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: isAssistant ? 'flex-start' : 'flex-end',
                  gap: 6,
                  width: '100%',
                }}
              >
                {/* アバター（上段） */}
                <div className="avatar" style={{ alignSelf: isAssistant ? 'flex-start' : 'flex-end' }}>
                  {isAssistant ? (
                    <img
                      src={iconSrc}
                      alt={badge ?? 'assistant'}
                      width={32}
                      height={32}
                      style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
                    />
                  ) : (
                    <AvatarImg
                      src={resolvedAvatar /* ← 補完後のURL/キー */}
                      alt={resolvedName || currentUser?.name || 'user'}
                      size={32}
                      versionKey={currentUser?.id}
                    />
                  )}
                </div>

                {/* 吹き出し（下段・横幅をCSSで拡げられるクラス） */}
                <div
                  className={`bubble sof-bubble-custom ${isAssistant ? 'is-assistant' : 'is-user'}`}
                  style={{
                    ...bubbleStyle,
                    alignSelf: isAssistant ? 'flex-start' : 'flex-end',
                  }}
                >
                  {/* 画像プレビュー */}
                  {Array.isArray(uploaded) && uploaded.length ? (
                    <div className="sof-bubble__imgs">
                      {uploaded.map((u: string, i: number) => (
                        <img key={i} src={u} alt="" />
                      ))}
                    </div>
                  ) : null}

                  {/* ラベル（名前） */}
                  <div
                    className="sof-bubble__role"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      ...(isAssistant ? {} : { justifyContent: 'flex-end', textAlign: 'right' }),
                    }}
                  >
                    {isAssistant ? (
                      <>
                        <img
                          src={iconSrc}
                          alt={badge ?? 'assistant'}
                          width={32}
                          height={32}
                          style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }}
                        />
                        <span>{badge ?? 'assistant'}</span>
                      </>
                    ) : (
                      <>
                        <AvatarImg
                          src={resolvedAvatar}
                          alt={resolvedName || currentUser?.name || 'user'}
                          size={32}
                          versionKey={currentUser?.id}
                        />
                        <span>{resolvedName ?? currentUser?.name ?? currentUser?.id ?? 'user'}</span>
                      </>
                    )}
                  </div>

                  {/* バッジ（AIのみ） */}
                  {isAssistant && badge && (
                    <div
                      className="sof-badge"
                      style={{
                        display: 'inline-block',
                        fontSize: 12,
                        padding: '2px 6px',
                        border: '1px solid #cbd5e1',
                        borderRadius: 8,
                        marginBottom: 6,
                        background: '#fff',
                        color: '#334155',
                      }}
                    >
                      {badge}
                    </div>
                  )}

                  {/* 本文 */}
                  <div className="msgBody">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight]}
                      components={mdComponents as any}
                    >
                      {m.content}
                    </ReactMarkdown>
                  </div>

                  {/* メタ情報 */}
                  {(usedCredits || qCode || status) && (
                    <div
                      className="sof-meta"
                      style={{
                        marginTop: 6,
                        fontSize: 12,
                        opacity: 0.8,
                        display: 'flex',
                        gap: 10,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        ...(isAssistant ? {} : { justifyContent: 'flex-end' }),
                      }}
                    >
                      {typeof usedCredits === 'number' && <span>used {usedCredits}C</span>}
                      {qCode && <span>Q: {qCode}</span>}
                      {status && status !== 'ok' && (
                        <span style={{ color: '#d43b3b' }}>
                          {status === 'timeout'
                            ? 'timeout'
                            : status === 'unauthorized'
                            ? 'auth error'
                            : status === 'ratelimited'
                            ? 'rate limited'
                            : 'error'}
                        </span>
                      )}
                    </div>
                  )}
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
