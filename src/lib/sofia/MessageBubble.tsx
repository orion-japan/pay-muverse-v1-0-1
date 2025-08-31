'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

export type MsgRole = 'user' | 'assistant';

function LinkRenderer(
  props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string }
) {
  const { href = '#', children, ...rest } = props;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" {...rest}>
      {children}
    </a>
  );
}

export function MessageBubble({ role, text }: { role: MsgRole; text: string }) {
  const isUser = role === 'user';

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        margin: '6px 0',
      }}
    >
      <div
        style={{
          maxWidth: '78%',
          borderRadius: 12,
          padding: '10px 12px',
          background: isUser ? '#e6f3ff' : '#fff',
          border: '1px solid #e5e7eb',
          boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
          lineHeight: 1.65,
          overflow: 'hidden',
        }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            a: LinkRenderer,
            code(props) {
              // 型の差異を吸収
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
                    borderLeft: '4px solid #a7f3d0',
                    background: '#ecfdf5',
                    margin: '8px 0',
                    padding: '8px 10px',
                    borderRadius: 6,
                  }}
                >
                  {children}
                </blockquote>
              );
            },
            ul({ children }) {
              return (
                <ul style={{ paddingInlineStart: 22, margin: '6px 0' }}>{children}</ul>
              );
            },
            ol({ children }) {
              return (
                <ol style={{ paddingInlineStart: 22, margin: '6px 0' }}>{children}</ol>
              );
            },
            p({ children }) {
              return <p style={{ margin: '6px 0' }}>{children}</p>;
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
  );
}
