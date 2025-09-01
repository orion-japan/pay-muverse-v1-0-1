'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { SOFIA_CONFIG } from './config';

export type MsgRole = 'user' | 'assistant';

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

type BubbleProps = { role: MsgRole; text: string };

export function MessageBubble({ role, text }: BubbleProps) {
  const isUser = role === 'user';

  // デバッグ：現在の UI 設定（必ず出す）
  // eslint-disable-next-line no-console
  console.debug('[SofiaUI] config(ui)=', SOFIA_CONFIG.ui);

  // env → 数値・長さに整形
  const fsPx = `${SOFIA_CONFIG.ui.assistantFontSize}px`;
  const lhNum = Number(SOFIA_CONFIG.ui.assistantLineHeight || 1.85);
  const lsEm = `${SOFIA_CONFIG.ui.assistantLetterSpacing}em`;
  const paraMg = `${SOFIA_CONFIG.ui.paragraphMargin ?? 6}px`;

  /** 吹き出しの枠スタイル */
  const bubbleStyle: React.CSSProperties = {
    maxWidth: `${SOFIA_CONFIG.ui.bubbleMaxWidthPct ?? 78}%`,
    borderRadius: isUser
      ? (SOFIA_CONFIG.ui.userRadius ?? 14)
      : (SOFIA_CONFIG.ui.assistantRadius ?? 16),
    padding: '10px 12px',
    background: isUser
      ? (SOFIA_CONFIG.ui.userBg || '#e6f3ff')
      : (SOFIA_CONFIG.ui.assistantBg || '#fff'),
    color: isUser ? (SOFIA_CONFIG.ui.userFg || '#111827') : undefined,
    border: isUser
      ? `1px solid ${SOFIA_CONFIG.ui.userBorder || '#e5e7eb'}`
      : (SOFIA_CONFIG.ui.assistantBorder || '1px solid #e5e7eb'),
    boxShadow: isUser ? undefined : (SOFIA_CONFIG.ui.assistantShadow || '0 1px 2px rgba(0,0,0,0.05)'),
    overflow: 'hidden',
    wordBreak: 'break-word',
  };

  /** 吹き出し内のコンテンツ全体に直指定（←これで負けにくい） */
  const contentStyle: React.CSSProperties = !isUser
    ? {
        fontSize: fsPx,
        lineHeight: lhNum as any,
        letterSpacing: lsEm,
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", "Noto Sans JP", "Hiragino Kaku Gothic ProN", "Meiryo", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflowWrap: 'anywhere',
      }
    : {};

  /** パラグラフ用（アシスタントのみ） */
  const assistantTextStyle: React.CSSProperties = !isUser
    ? {
        fontSize: fsPx,
        lineHeight: lhNum as any,
        letterSpacing: lsEm,
        margin: `${paraMg} 0`,
      }
    : {};

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        margin: '6px 0',
      }}
    >
      <div style={bubbleStyle}>
        <div style={contentStyle}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              a: LinkRenderer,

              code(props) {
                const { inline, className, children, ...rest } = props as any;
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

              pre(props) {
                const { children, ...rest } = props as any;
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

              table({ children }) {
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
              th({ children }) {
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
              td({ children }) {
                return (
                  <td style={{ borderBottom: '1px solid #f1f5f9', padding: '6px 8px' }}>
                    {children}
                  </td>
                );
              },

              blockquote({ children }) {
                return (
                  <blockquote
                    style={{
                      borderLeft: `4px solid ${SOFIA_CONFIG.ui.blockquoteTintBorder || '#cbd5e1'}`,
                      background: SOFIA_CONFIG.ui.blockquoteTintBg || '#f1f5f9',
                      margin: `${paraMg} 0`,
                      padding: '8px 10px',
                      borderRadius: 6,
                      color: '#475569',
                      fontStyle: 'italic',
                      fontSize: fsPx,
                      lineHeight: lhNum as any,
                      letterSpacing: lsEm,
                    }}
                  >
                    {children}
                  </blockquote>
                );
              },

              ul({ children }) {
                return (
                  <ul
                    style={{
                      paddingInlineStart: 22,
                      margin: `${paraMg} 0`,
                      fontSize: fsPx,
                      lineHeight: lhNum as any,
                      letterSpacing: lsEm,
                    }}
                  >
                    {children}
                  </ul>
                );
              },

              ol({ children }) {
                return (
                  <ol
                    style={{
                      paddingInlineStart: 22,
                      margin: `${paraMg} 0`,
                      fontSize: fsPx,
                      lineHeight: lhNum as any,
                      letterSpacing: lsEm,
                    }}
                  >
                    {children}
                  </ol>
                );
              },

              p({ children }) {
                return <p style={assistantTextStyle}>{children}</p>;
              },

              h1({ children }) {
                return (
                  <h1 style={{ fontSize: 20, fontWeight: 700, margin: '8px 0' }}>
                    {children}
                  </h1>
                );
              },
              h2({ children }) {
                return (
                  <h2 style={{ fontSize: 18, fontWeight: 700, margin: '8px 0' }}>
                    {children}
                  </h2>
                );
              },
              h3({ children }) {
                return (
                  <h3 style={{ fontSize: 16, fontWeight: 700, margin: '8px 0' }}>
                    {children}
                  </h3>
                );
              },
            }}
          >
            {text}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

export default MessageBubble;
