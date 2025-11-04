'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import type { PluggableList } from 'unified';
import { SOFIA_CONFIG } from './config';

export type MsgRole = 'user' | 'assistant';

/** 安全な外部リンクレンダラ */
function LinkRenderer(props: React.ComponentPropsWithoutRef<'a'> & { href?: string }) {
  const { href = '#', children, ...rest } = props;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" {...rest}>
      {children}
    </a>
  );
}

type BubbleProps = { role: MsgRole; text: string };

/* =========================
   Dark Story stage parser
   先頭が 「【stage:dark】/【stage:remake】/【stage:integration】」
   の段落を抽出。無ければ空配列。
========================= */
type StageKey = 'dark' | 'remake' | 'integration';
type StageBlock = { stage: StageKey; content: string };

const STAGE_LABEL: Record<StageKey, string> = {
  dark: '闇の物語',
  remake: 'リメイク',
  integration: '再統合',
};

function parseDarkStages(src: string): StageBlock[] {
  if (!src) return [];
  // 改行基準で段落を安全に取る
  const lines = src.split(/\r?\n/);
  const out: StageBlock[] = [];
  let cur: StageBlock | null = null;

  const head = /^【\s*stage\s*:\s*(dark|remake|integration)\s*】\s*$/i;

  for (const raw of lines) {
    const m = raw.match(head);
    if (m) {
      // 新しいステージ開始
      if (cur) out.push({ ...cur, content: cur.content.trim() });
      cur = { stage: m[1].toLowerCase() as StageKey, content: '' };
      continue;
    }
    if (cur) {
      cur.content += (cur.content ? '\n' : '') + raw;
    }
  }
  if (cur) out.push({ ...cur, content: cur.content.trim() });

  // 3段がそろっている、または1–2段でも stage が存在すれば採用
  return out.length > 0 ? out : [];
}

export function MessageBubble({ role, text }: BubbleProps) {
  const isUser = role === 'user';

  // env → 数値・長さに整形
  const fsPx = Number(SOFIA_CONFIG.ui.assistantFontSize ?? 16); // px
  const lhNum = Number(SOFIA_CONFIG.ui.assistantLineHeight ?? 2.1); // line-height
  const lsEm = Number(SOFIA_CONFIG.ui.assistantLetterSpacing ?? 0); // em
  const paraMgPx = Number(SOFIA_CONFIG.ui.paragraphMargin ?? 12); // px
  const softBreakHeightPx = 14; // 単一改行の余白

  /** 吹き出しの枠スタイル */
  const bubbleStyle: React.CSSProperties = {
    maxWidth: `${SOFIA_CONFIG.ui.bubbleMaxWidthPct ?? 78}%`,
    borderRadius: (isUser
      ? (SOFIA_CONFIG.ui.userRadius ?? 14)
      : (SOFIA_CONFIG.ui.assistantRadius ?? 16)) as number,
    padding: '10px 12px',
    background: isUser
      ? SOFIA_CONFIG.ui.userBg || '#e6f3ff'
      : SOFIA_CONFIG.ui.assistantBg || '#ffffff',
    color: isUser ? SOFIA_CONFIG.ui.userFg || '#111827' : undefined,
    border: isUser
      ? `1px solid ${SOFIA_CONFIG.ui.userBorder || '#e5e7eb'}`
      : SOFIA_CONFIG.ui.assistantBorder || '1px solid #e5e7eb',
    boxShadow: isUser ? undefined : SOFIA_CONFIG.ui.assistantShadow || '0 1px 2px rgba(0,0,0,.06)',
    overflow: 'hidden', // マージン潰れ防止
    wordBreak: 'break-word',
  };

  /** 吹き出し内のラッパ（両者共通で“勝たせる”） */
  const contentStyle: React.CSSProperties = {
    display: 'flow-root', // マージン潰れ対策
    fontSize: fsPx,
    lineHeight: lhNum,
    letterSpacing: `${lsEm}em`,
    whiteSpace: 'pre-wrap', // 改行を生かす
    wordBreak: 'break-word',
    overflowWrap: 'anywhere',
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", "Noto Sans JP", "Hiragino Kaku Gothic ProN", "Meiryo", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
  };

  /** 段落・本文要素の共通スタイル */
  const blockTextStyle: React.CSSProperties = {
    fontSize: fsPx,
    lineHeight: lhNum,
    letterSpacing: `${lsEm}em`,
    margin: `${paraMgPx}px 0`,
  };

  // plugins（型安全）
  const remarkList: PluggableList = [remarkGfm, remarkBreaks];
  const rehypeList: PluggableList = [rehypeHighlight];

  // ここで stage を検出（なければ通常 Markdown）
  const stages = parseDarkStages(text);

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
          {/* stage あり → 三層カード表示、なし → Markdown */}
          {stages.length > 0 ? (
            <div>
              {stages.map((s, idx) => (
                <div
                  key={`${s.stage}-${idx}`}
                  style={{
                    border: '1px solid #e5e7eb',
                    borderRadius: 10,
                    padding: '10px 12px',
                    margin: idx === 0 ? `0 0 ${paraMgPx}px` : `${paraMgPx}px 0 0`,
                    background:
                      s.stage === 'dark' ? '#f8fafc' : s.stage === 'remake' ? '#f9fef8' : '#fffef7',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.7, marginBottom: 6 }}>
                    {`【${STAGE_LABEL[s.stage]}】`}
                  </div>
                  <ReactMarkdown
                    remarkPlugins={remarkList}
                    rehypePlugins={rehypeList}
                    components={{
                      a: LinkRenderer,
                      br() {
                        return <span style={{ display: 'block', height: softBreakHeightPx }} />;
                      },
                      p({ children }) {
                        return <p style={blockTextStyle}>{children}</p>;
                      },
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
                              margin: `${paraMgPx}px 0`,
                            }}
                            {...rest}
                          >
                            {children}
                          </pre>
                        );
                      },
                    }}
                  >
                    {s.content}
                  </ReactMarkdown>
                </div>
              ))}
            </div>
          ) : (
            // 既存：通常の Markdown レンダリング
            <div className="markdown">
              <ReactMarkdown
                remarkPlugins={remarkList} // 単一改行 → <br/>
                rehypePlugins={rehypeList}
                components={{
                  a: LinkRenderer,

                  // インラインコード
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
                          margin: `${paraMgPx}px 0`,
                        }}
                        {...rest}
                      >
                        {children}
                      </pre>
                    );
                  },

                  // 単一改行 <br/> を“高さを持つ”要素にして余白を作る
                  br() {
                    return <span style={{ display: 'block', height: softBreakHeightPx }} />;
                  },

                  table({ children }) {
                    return (
                      <div style={{ overflowX: 'auto', margin: `${paraMgPx}px 0` }}>
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
                          margin: `${paraMgPx}px 0`,
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
                          margin: `${paraMgPx}px 0`,
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
                          margin: `${paraMgPx}px 0`,
                          ...blockTextStyle,
                        }}
                      >
                        {children}
                      </ol>
                    );
                  },

                  li({ children }) {
                    return <li style={{ margin: '4px 0' }}>{children}</li>;
                  },

                  p({ children }) {
                    return <p style={blockTextStyle}>{children}</p>;
                  },

                  h1({ children }) {
                    return (
                      <h1 style={{ fontSize: 20, fontWeight: 700, margin: `${paraMgPx}px 0` }}>
                        {children}
                      </h1>
                    );
                  },
                  h2({ children }) {
                    return (
                      <h2 style={{ fontSize: 18, fontWeight: 700, margin: `${paraMgPx}px 0` }}>
                        {children}
                      </h2>
                    );
                  },
                  h3({ children }) {
                    return (
                      <h3 style={{ fontSize: 16, fontWeight: 700, margin: `${paraMgPx}px 0` }}>
                        {children}
                      </h3>
                    );
                  },
                }}
              >
                {text}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default MessageBubble;
