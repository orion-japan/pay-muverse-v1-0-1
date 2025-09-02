'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
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

  // 現在の UI 設定（デバッグ出力）
  // eslint-disable-next-line no-console
  console.debug('[SofiaUI] config(ui)=', SOFIA_CONFIG.ui);

  // env → 数値・長さに整形
  const fsPx = `${SOFIA_CONFIG.ui.assistantFontSize}px`;               // 例: 16
  const lhNum = Number(SOFIA_CONFIG.ui.assistantLineHeight || 2.2);     // 例: 2.5
  const lsEm = `${SOFIA_CONFIG.ui.assistantLetterSpacing}em`;           // 例: 0.03em
  const paraMgPx = Number(SOFIA_CONFIG.ui.paragraphMargin ?? 12);       // 例: 12(px)
  const paraMg = `${paraMgPx}px`;
  // 単一改行(<br/>)に入れる“ちょい余白”（必要なら env に出してOK）
  const softBreakHeightPx = 15;

  /** 吹き出しの枠スタイル */
  const bubbleStyle: React.CSSProperties = {
    maxWidth: `${SOFIA_CONFIG.ui.bubbleMaxWidthPct ?? 78}%`,
    borderRadius: isUser
      ? (SOFIA_CONFIG.ui.userRadius ?? 14)
      : (SOFIA_CONFIG.ui.assistantRadius ?? 16),
    padding: '10px 12px',
    background: isUser
      ? (SOFIA_CONFIG.ui.userBg || '#e6f3ff')
      : (SOFIA_CONFIG.ui.assistantBg || '#ffffff'),
    color: isUser ? (SOFIA_CONFIG.ui.userFg || '#111827') : undefined,
    border: isUser
      ? `1px solid ${SOFIA_CONFIG.ui.userBorder || '#e5e7eb'}`
      : (SOFIA_CONFIG.ui.assistantBorder || '1px solid #e5e7eb'),
    boxShadow: isUser ? undefined : (SOFIA_CONFIG.ui.assistantShadow || '0 1px 2px rgba(0,0,0,.06)'),
    overflow: 'hidden',                 // ← マージン潰れ防止
    wordBreak: 'break-word',
  };

  /** 吹き出し内のラッパ（ここに直指定して“勝たせる”） */
  const contentStyle: React.CSSProperties = !isUser
    ? {
        display: 'flow-root',           // ← マージン潰れ対策
        fontSize: fsPx,
        lineHeight: lhNum as any,
        letterSpacing: lsEm,
        whiteSpace: 'pre-wrap',         // ← 改行を生かす
        wordBreak: 'break-word',
        overflowWrap: 'anywhere',
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", "Noto Sans JP", "Hiragino Kaku Gothic ProN", "Meiryo", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
      }
    : {};

  /** 段落・本文要素の共通スタイル（アシスタントのみ） */
  const blockTextStyle: React.CSSProperties = !isUser
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
            // 単一改行を <br/> にする
            remarkPlugins={[remarkGfm, remarkBreaks]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              a: LinkRenderer,

              // 1行コード
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
                // フェンスコード
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
                      margin: `${paraMg} 0`,
                    }}
                    {...rest}
                  >
                    {children}
                  </pre>
                );
              },

              // ← ここが効く：単一改行 <br/> を“高さを持つ”要素にして余白を作る
              br() {
                return <span style={{ display: 'block', height: softBreakHeightPx }} />;
              },

              table({ children }) {
                return (
                  <div style={{ overflowX: 'auto', margin: `${paraMg} 0` }}>
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
                      ...blockTextStyle,
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
                      ...blockTextStyle,
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
                      ...blockTextStyle,
                    }}
                  >
                    {children}
                  </ol>
                );
              },

              li({ children }) {
                return (
                  <li style={{ margin: '4px 0' }}>
                    {children}
                  </li>
                );
              },

              p({ children }) {
                return <p style={blockTextStyle}>{children}</p>;
              },

              h1({ children }) {
                return (
                  <h1 style={{ fontSize: 20, fontWeight: 700, margin: `${paraMg} 0` }}>
                    {children}
                  </h1>
                );
              },
              h2({ children }) {
                return (
                  <h2 style={{ fontSize: 18, fontWeight: 700, margin: `${paraMg} 0` }}>
                    {children}
                  </h2>
                );
              },
              h3({ children }) {
                return (
                  <h3 style={{ fontSize: 16, fontWeight: 700, margin: `${paraMg} 0` }}>
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
