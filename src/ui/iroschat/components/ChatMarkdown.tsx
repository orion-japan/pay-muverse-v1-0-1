// src/ui/iroschat/components/ChatMarkdown.tsx
'use client';

import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type ChatMarkdownProps = {
  text: string;
  className?: string;
};

// 見出しごとのアイコン対応表（必要ならあとで増やす）
const HEADING_ICONS: Record<string, string> = {
  'ステップとして考えられること': '📌',
  '目的を明確にする': '🎯',
  '必要な要素をリストアップ': '🧩',
  '計画を立てる': '🛠️',
  'コミュニケーション': '🫂',
  // 既存分も残す
  'いまの揺らぎ': '🌀',
  '今選べる一手': '🌱',
  'その一手の意味': '📘',
};

// ** ～ ** の内側の余白をトリム & 空の「-」行を削除
function normalizeBold(text: string): string {
  // 例: "** 今日、選べる一歩**" → "**今日、選べる一歩**"
  const tightened = text.replace(
    /\*\*\s+([^*][^*]*?)\s*\*\*/g,
    (_match, inner: string) => `**${String(inner).trim()}**`,
  );

  // 中身のない「-」だけの行（"-" / "- "）を削除
  // → 「✨」「ステップとして考えられること：」「-」の「-」が消える
  return tightened.replace(/^\s*-\s*$/gm, '');
}

// li の children からテキストだけ取り出して、中身が空かどうか判定する
function extractPlainText(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') {
        return String(child);
      }

      // ReactMarkdown の場合、さらにネストしていることもあるので軽く見る
      if (React.isValidElement(child)) {
        const el = child as React.ReactElement<{ children?: React.ReactNode }>;

        if (el.props && el.props.children) {
          return extractPlainText(el.props.children);
        }
      }

      return '';
    })
    .join('')
    .trim();
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
          p: ({ node, ...props }) => (
            <p
              {...props}
              style={{
                margin: '0 0 0.8em',
                lineHeight: 1.9,
                whiteSpace: 'pre-wrap',
              }}
            />
          ),

          // 強調（＝小見出し＋アイコン）
          strong: ({ children, ...props }) => {
            const raw = String(children ?? '').trim();
            const icon = HEADING_ICONS[raw] ?? '✨'; // 対応がなければ ✨

            return (
              <strong
                {...props}
                style={{
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4em',
                  margin: '1em 0 0.3em',
                  fontSize: '1.04rem',
                  letterSpacing: '0.02em',
                  whiteSpace: 'pre-wrap',
                }}
              >
                <span style={{ fontSize: '1.1rem' }}>{icon}</span>
                <span>{raw}</span>
              </strong>
            );
          },

          // 共鳴ハイライト（ *こういうところ* ）
          em: ({ children, ...props }) => (
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
          ),

          // 箇条書き
          ul: ({ children, ...props }) => (
            <ul
              {...props}
              style={{
                paddingLeft: '1.2em',
                margin: '0.25em 0 0.6em',
              }}
            >
              {children}
            </ul>
          ),

          li: ({ children, ...props }) => (
            <li
              {...props}
              style={{
                margin: '0.1em 0',
              }}
            >
              {children}
            </li>
          ),

          // 区切り線
          hr: () => (
            <hr
              style={{
                border: 'none',
                borderTop: '1px dashed rgba(148,163,184,0.7)',
                margin: '0.6em 0 0.8em',
              }}
            />
          ),
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
