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
  '今選べる一歩': '🌱',
  'その一歩の意味': '📘',
  // IR系（例）
  '🧿 観測対象': '🧿',
  '🌀 意識状態': '🌀',
  '🌱 メッセージ': '🌱',
  '構造メモ': '✨',
};

// ✅ 未閉じの ** が残って "** だけ表示される" を防ぐ（最後の1個だけ無効化）
function fixUnmatchedBold(text: string): string {
  const s = String(text ?? '');
  const matches = s.match(/\*\*/g);
  const count = matches?.length ?? 0;

  // ** が偶数ならOK
  if (count % 2 === 0) return s;

  // ** が奇数 → 最後の ** だけ消す（閉じ忘れを無効化）
  const last = s.lastIndexOf('**');
  if (last < 0) return s;

  return s.slice(0, last) + s.slice(last + 2);
}


// ** ～ ** の内側の余白をトリム & 空の「-」行を削除
function normalizeBold(text: string): string {
  const tightened = text.replace(
    /\*\*\s+([^*][^*]*?)\s*\*\*/g,
    (_match, inner: string) => `**${String(inner).trim()}**`,
  );

  return tightened.replace(/^\s*-\s*$/gm, '');
}

/**
 * strong を「見出し扱い」にするか判定
 * - 旧テンプレで "**見出し**" を使っている互換のためのルール
 * - 本文の強調は strong のまま（見出しにしない）
 */
function isStrongHeading(raw: string): boolean {
  const t = String(raw ?? '').trim();
  if (!t) return false;

  // 典型：IR/テンプレの見出し候補は短い
  if (t.length >= 2 && t.length <= 18 && HEADING_ICONS[t]) return true;

  // 「〜：」で終わる短い行は見出しになりがち（例: ステップとして考えられること：）
  if (t.length <= 24 && /[：:]$/.test(t)) return true;

  // 先頭が絵文字＋空白なら見出しっぽい（例: 🧿 観測対象）
  if (/^\p{Extended_Pictographic}\s+/u.test(t) && t.length <= 24) return true;

  return false;
}

function HeadingLine({
  title,
  level,
}: {
  title: string;
  level: 1 | 2 | 3 | 4;
}) {
  const raw = String(title ?? '').trim();
  const icon =
    HEADING_ICONS[raw] ??
    (raw.startsWith('🧿') ? '🧿' : raw.startsWith('🌀') ? '🌀' : raw.startsWith('🌱') ? '🌱' : '✨');

  // CSS を活かしたいなら className も付けておく
  const Tag = (['h1', 'h2', 'h3', 'h4'] as const)[level - 1];

  return (
    <Tag
      className="iros-section-heading"
      style={{
        fontWeight: 700,
        margin: '1.0em 0 0.35em',
        fontSize: level <= 2 ? '1.08rem' : '1.03rem',
        letterSpacing: '0.02em',
        display: 'flex',
        alignItems: 'center',
        gap: '0.45em',
      }}
    >
      <span className="iros-section-heading-icon" style={{ fontSize: '1.05em' }}>
        {icon}
      </span>
      <span>{raw}</span>
    </Tag>
  );
}

// ✅ ここを置き換え（useMemo 部分）
export default function ChatMarkdown({ text, className }: ChatMarkdownProps) {
  const normalized = useMemo(() => {
    // 1) **内側の余白整理
    const t1 = normalizeBold(text);
    // 2) 未閉じの ** を「最後の1個だけ」無効化（全部消さない）
    const t2 = fixUnmatchedBold(t1);
    return t2;
  }, [text]);

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ ...props }) => (
            <p
              {...props}
              style={{
                margin: '0 0 0.8em',
                lineHeight: 1.9,
                whiteSpace: 'pre-wrap',
              }}
            />
          ),

          h1: ({ children }) => <HeadingLine title={String(children ?? '')} level={1} />,
          h2: ({ children }) => <HeadingLine title={String(children ?? '')} level={2} />,
          h3: ({ children }) => <HeadingLine title={String(children ?? '')} level={3} />,
          h4: ({ children }) => <HeadingLine title={String(children ?? '')} level={4} />,

          // ✅ strong を「見た目だけ見出し」にする（p の子でも安全）
          strong: ({ children, ...props }) => {
            const raw = String(children ?? '').trim();

            if (isStrongHeading(raw)) {
              const icon =
                HEADING_ICONS[raw] ??
                (raw.startsWith('🧿') ? '🧿' : raw.startsWith('🌀') ? '🌀' : raw.startsWith('🌱') ? '🌱' : '✨');

              return (
                <span
                  {...props}
                  className="iros-section-heading"
                  style={{
                    display: 'block',
                    margin: '1em 0 0.3em',
                    fontWeight: 700,
                    fontSize: '1.04rem',
                    letterSpacing: '0.02em',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  <span style={{ marginRight: '0.4em', fontSize: '1.1rem' }}>{icon}</span>
                  {raw}
                </span>
              );
            }

            return (
              <strong
                {...props}
                className="iros-emphasis iros-emphasis-normal"
                style={{ fontWeight: 700 }}
              >
                {children}
              </strong>
            );
          },

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

// ✅ sanitizeMarkdown はもう使わないので「削除」してOK（呼び元も消したため）


function sanitizeMarkdown(text: string): string {
  // ✅ 未閉じの ** が残って "** だけ表示される" を防ぐ（最後の1個だけ無効化）
  // ※ fixUnmatchedBold() を使う（全部消すのは破壊的なのでやらない）
  return fixUnmatchedBold(String(text ?? ''));
}
