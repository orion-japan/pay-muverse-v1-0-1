// src/ui/iroschat/components/ChatMarkdown.tsx
'use client';

import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type ChatMarkdownProps = {
  text: string;
  className?: string;
};

// 見出しごとのアイコン対応表（ここは好きに増やしてOK）
const HEADING_ICONS: Record<string, string> = {
  'いまの揺らぎ': '🌀',
  '今選べる一手': '🌱',
  'その一手の意味': '📘',
  '新たな年への願い': '🎍',
  '時間の流れと一年の終わり': '⌛️',
};

// ** ～ ** の内側の余白をトリムするヘルパー
// 例: "** 今日、選べる一歩**" → "**今日、選べる一歩**"
function normalizeBold(text: string): string {
  return text.replace(
    /\*\*\s+([^*][^*]*?)\s*\*\*/g,
    (_match, inner: string) => `**${String(inner).trim()}**`,
  );
}

export default function ChatMarkdown({ text, className }: ChatMarkdownProps) {
  // ここで一度 normalize してから ReactMarkdown に渡す
  const normalized = useMemo(() => normalizeBold(text), [text]);

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 段落
          p({ node, ...props }) {
            return (
              <p
                {...props}
                style={{
                  margin: '0 0 0.8em',
                  lineHeight: 1.9,
                  whiteSpace: 'pre-wrap',
                }}
              />
            );
          },

          // 強調（＝小見出し）
          strong({ children, ...props }) {
            const raw = String(children ?? '').trim();
            const icon = HEADING_ICONS[raw] ?? '';

            return (
              <strong
                {...props}
                className="iros-section-heading"
                style={{
                  display: 'block',
                  margin: '0.8em 0 0.35em',
                  padding: '0.35em 0.6em',
                  borderTop: '1px solid rgba(148,163,184,0.4)',
                  borderLeft: '4px solid rgba(129,140,248,0.9)',
                  borderRadius: '6px',
                  background:
                    'linear-gradient(90deg, rgba(239,246,255,0.85), rgba(249,250,251,0.9))',
                  fontWeight: 700,
                  fontSize: '1.02rem',
                  letterSpacing: '0.02em',
                }}
              >
                {icon && <span style={{ marginRight: '0.45em' }}>{icon}</span>}
                <span>{raw}</span>
              </strong>
            );
          },

          // 共鳴ハイライト（ *こういうところ* ）
          em({ children, ...props }) {
            return (
              <span
                {...props}
                style={{
                  color: '#7c3aed',
                  fontWeight: 500,
                  fontStyle: 'normal',
                }}
              >
                {children}
              </span>
            );
          },

          // 箇条書き
          ul({ children, ...props }) {
            return (
              <ul
                {...props}
                style={{
                  paddingLeft: '1.2em',
                  margin: '0.25em 0 0.6em',
                }}
              >
                {children}
              </ul>
            );
          },
          li({ children, ...props }) {
            return (
              <li
                {...props}
                style={{
                  margin: '0.1em 0',
                }}
              >
                {children}
              </li>
            );
          },

          // 区切り線
          hr() {
            return (
              <hr
                style={{
                  border: 'none',
                  borderTop: '1px dashed rgba(148,163,184,0.7)',
                  margin: '0.6em 0 0.8em',
                }}
              />
            );
          },
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
