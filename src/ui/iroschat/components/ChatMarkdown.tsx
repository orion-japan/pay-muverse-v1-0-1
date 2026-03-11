'use client';
import './ChatMarkdown.css';
import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type ChatMarkdownProps = {
  text: string;
  className?: string;
};

const HEADING_ICONS: Record<string, string> = {
  'ステップとして考えられること': '📌',
  '目的を明確にする': '🎯',
  '必要な要素をリストアップ': '🧩',
  '計画を立てる': '🛠️',
  'コミュニケーション': '🫂',
  '二つの見方': '🔍',

  'いまの揺らぎ': '🌀',
  '今選べる一歩': '🌱',
  'その一歩の意味': '📘',

  '🧿 観測対象': '🧿',
  '🌀 意識状態': '🌀',
  '🌱 メッセージ': '🌱',

  '構造メモ': '🧾',
  '結論': '🧭',
  'ポイント': '📌',
  '要点': '🎯',
  '整理': '🧩',
  '補足': '📝',
};

function normalizeHeadingTitle(raw: string): string {
  let t = String(raw ?? '').trim();
  t = t.replace(/^\p{Extended_Pictographic}\s+/u, '');
  t = t.replace(/^[★☆※●■◆◇▶▷・…]+?\s*/u, '');
  t = t.replace(/[：:]\s*$/u, '').trim();
  return t;
}

function pickHeadingIcon(titleRaw: string): string | null {
  const t = normalizeHeadingTitle(titleRaw);
  if (!t) return null;
  if (HEADING_ICONS[t]) return HEADING_ICONS[t];

  const has = (...words: string[]) => words.some((w) => t.includes(w));

  if (has('今ここ', '揃える', '整える', '整列', 'リセット', '仕切り直し', '土台', '軸')) return '🌀';
  if (has('観測', '見る', '見て', '確認', '前提', '状況', 'いま', '現状', '整理', '見方')) return '🔍';
  if (has('焦点', '一点', '絞', '要点', 'ポイント', '核', '中心')) return '🎯';
  if (has('受け止め', '受けとめ', '安心', '安全', '保険', '守る', '落ち着く')) return '🪔';
  if (has('統合', 'つなぐ', '繋ぐ', 'まとめ', '合流', '一つに', '収束')) return '🧩';
  if (has('選ぶ', '決める', '結論', 'ここで一つ', '最終', 'どれ')) return '✅';
  if (has('次', '一歩', '進める', 'やる', '試す', '実行', '今日')) return '👣';
  if (has('補足', '参考', '注記', 'メモ')) return '📝';

  return null;
}

function fixUnmatchedBold(text: string): string {
  const s = String(text ?? '');
  const matches = s.match(/\*\*/g);
  const count = matches?.length ?? 0;
  if (count % 2 === 0) return s;
  const last = s.lastIndexOf('**');
  if (last < 0) return s;
  return s.slice(0, last) + s.slice(last + 2);
}

function normalizeBold(text: string): string {
  const tightened = text.replace(
    /\*\*\s+([^*][^*]*?)\s*\*\*/g,
    (_match, inner: string) => `**${String(inner).trim()}**`,
  );
  return tightened.replace(/^\s*-\s*$/gm, '');
}

function plainTextFromChildren(children: React.ReactNode): string {
  const parts = React.Children.toArray(children).map((ch) => {
    if (typeof ch === 'string') return ch;
    if (typeof ch === 'number') return String(ch);
    if (React.isValidElement(ch)) {
      const el = ch as React.ReactElement<any>;
      return plainTextFromChildren(el.props?.children);
    }
    return '';
  });

  return parts.join('');
}

function countParagraphs(src: string): number {
  const s = String(src ?? '').replace(/\r\n/g, '\n').trim();
  if (!s) return 0;
  return s.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).length;
}

function countMarkdownHeadings(src: string): number {
  const s = String(src ?? '').replace(/\r\n/g, '\n');
  const m = s.match(/^\#{1,6}\s+/gm);
  return m?.length ?? 0;
}

function hasLeadingEmoji(s: string): boolean {
  const t = String(s ?? '').trimStart();
  return /^\p{Extended_Pictographic}/u.test(t);
}

function pickParagraphIcon(index: number): string {
  if (index === 0) return '🧿';
  if (index === 1) return '🌀';
  if (index === 2) return '🌱';
  return '•';
}

function HeadingLine({ title, level }: { title: string; level: 1 | 2 | 3 | 4 }) {
  const Tag = (`h${level}` as any) as React.ElementType;

  const raw = String(title ?? '').trim();
  const m = raw.match(/^([\p{Extended_Pictographic}\uFE0F]+)\s*(.*)$/u);
  const leadingEmoji = m?.[1] ?? null;
  const restTitle = (m?.[2] ?? raw).trim();
  const normTitle = normalizeHeadingTitle(restTitle);

  const icon =
    leadingEmoji ??
    HEADING_ICONS[normTitle] ??
    pickHeadingIcon(normTitle) ??
    '🧿';

  const isSub = normTitle === '二つの見方';

  return (
    <Tag className={`iros-heading-line${isSub ? ' iros-heading-sub' : ''}`}>
      <span className="iros-heading-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{normTitle}</span>
    </Tag>
  );
}

export default function ChatMarkdown({ text, className }: ChatMarkdownProps) {
  const normalized = useMemo(() => {
    const t1 = normalizeBold(text);
    const t2 = fixUnmatchedBold(t1);
    return t2;
  }, [text]);

  const paraCount = useMemo(() => countParagraphs(normalized), [normalized]);
  const headingCount = useMemo(() => countMarkdownHeadings(normalized), [normalized]);
  const enableParaDecor = paraCount >= 2 && headingCount <= 1;

  let pIndex = 0;

  return (
    <div className={`iros-markdown ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children, ...props }) => {
            const raw = plainTextFromChildren(children);
            const idx = pIndex++;
            const shouldDecorate = enableParaDecor && raw.trim() && !hasLeadingEmoji(raw) && idx <= 2;
            const icon = pickParagraphIcon(idx);

            return (
              <p {...props} className="iros-p">
                {shouldDecorate && (
                  <span className="iros-picon" aria-hidden="true">
                    {icon}
                  </span>
                )}
                <span className="iros-ptext">{children}</span>
              </p>
            );
          },

          h1: ({ children }) => <HeadingLine title={plainTextFromChildren(children)} level={1} />,
          h2: ({ children }) => <HeadingLine title={plainTextFromChildren(children)} level={2} />,
          h3: ({ children }) => <HeadingLine title={plainTextFromChildren(children)} level={3} />,
          h4: ({ children }) => <HeadingLine title={plainTextFromChildren(children)} level={4} />,

          strong: ({ children, ...props }) => (
            <strong {...props} className="iros-emphasis">
              {children}
            </strong>
          ),

          em: ({ children, ...props }) => (
            <em {...props} className="iros-emphasis-normal">
              {children}
            </em>
          ),

          blockquote: ({ children, ...props }) => (
            <blockquote {...props} className="iros-quote">
              {children}
            </blockquote>
          ),

          hr: (props) => <hr {...props} className="iros-hr" />,

          ul: ({ children, ...props }) => (
            <ul {...props} className="iros-list iros-ul">
              {children}
            </ul>
          ),

          ol: ({ children, ...props }) => (
            <ol {...props} className="iros-list iros-ol">
              {children}
            </ol>
          ),

          li: ({ children, ...props }) => (
            <li {...props} className="iros-li">
              {children}
            </li>
          ),

          a: ({ children, href, ...props }) => (
            <a
              {...props}
              href={href}
              className="iros-link"
              target="_blank"
              rel="noreferrer noopener"
            >
              {children}
            </a>
          ),

          code: ({ children, className: codeClassName, ...props }) => {
            const isBlock = typeof codeClassName === 'string' && codeClassName.includes('language-');

            if (isBlock) {
              return (
                <code {...props} className={`iros-codeblock ${codeClassName ?? ''}`}>
                  {children}
                </code>
              );
            }

            return (
              <code {...props} className="iros-codeinline">
                {children}
              </code>
            );
          },

          pre: ({ children, ...props }) => (
            <pre {...props} className="iros-pre">
              {children}
            </pre>
          ),

          table: ({ children, ...props }) => (
            <div className="iros-table-wrap">
              <table {...props} className="iros-table">
                {children}
              </table>
            </div>
          ),

          thead: ({ children, ...props }) => <thead {...props}>{children}</thead>,
          tbody: ({ children, ...props }) => <tbody {...props}>{children}</tbody>,
          tr: ({ children, ...props }) => <tr {...props}>{children}</tr>,
          th: ({ children, ...props }) => (
            <th {...props} className="iros-th">
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td {...props} className="iros-td">
              {children}
            </td>
          ),
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
