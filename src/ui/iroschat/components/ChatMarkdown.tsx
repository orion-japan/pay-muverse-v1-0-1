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

  '構造メモ': '🧾',
};

// ✅ 見出し文字列を正規化（先頭絵文字/空白/末尾の「:」「：」などを除去）
function normalizeHeadingTitle(raw: string): string {
  let t = String(raw ?? '').trim();

  // 先頭の絵文字＋空白を落とす（例: "✨ タイトル" → "タイトル"）
  t = t.replace(/^\p{Extended_Pictographic}\s+/u, '');

  // 先頭に残りがちな記号も軽く落とす
  t = t.replace(/^[★☆※●■◆◇▶▷・…]+?\s*/u, '');

  // 末尾のコロン（見出しっぽい装飾）を落とす
  t = t.replace(/[：:]\s*$/u, '').trim();

  return t;
}

// ✅ タイトルからアイコンを推定（辞書 → キーワード推定 → 何も出さない）
function pickHeadingIcon(titleRaw: string): string | null {
  const title = normalizeHeadingTitle(titleRaw);

  // 1) 完全一致（辞書が最優先）
  if (HEADING_ICONS[title]) return HEADING_ICONS[title];

  // 2) IRっぽいプレフィクス
  if (titleRaw.trim().startsWith('🧿')) return '🧿';
  if (titleRaw.trim().startsWith('🌀')) return '🌀';
  if (titleRaw.trim().startsWith('🌱')) return '🌱';

  // 3) キーワード推定（ここが「可変」に効く）
  const t = title;

  if (/(合図|サイン|シグナル|今の合図|いまの合図)/.test(t)) return '📌';
  if (/(置き方|置く場所|場所|配置|置く)/.test(t)) return '📍';
  if (/(扱い方|使い方|運用|ルール)/.test(t)) return '🧭';
  if (/(管理|整理|構造|枠|ブロック)/.test(t)) return '🗂️';
  if (/(役|役割|担う|機能)/.test(t)) return '🧩';
  if (/(意味|意義|理由)/.test(t)) return '📘';
  if (/(魅力|ポイント|効く|効いてる)/.test(t)) return '✨'; // ← ここは「魅力」のときだけ許可
  if (/(最小|残る|残す|ミニマム)/.test(t)) return '🪶';

  // 4) どうしても決まらない → “アイコン無し”
  return null;
}

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

  const tNorm = normalizeHeadingTitle(t);

  // 典型：IR/テンプレの見出し候補は短い
  if (tNorm.length >= 2 && tNorm.length <= 18 && HEADING_ICONS[tNorm]) return true;

  // 「〜：」で終わる短い行は見出しになりがち
  if (tNorm.length <= 24 && /[：:]$/.test(t)) return true;

  // 先頭が絵文字＋空白なら見出しっぽい
  if (/^\p{Extended_Pictographic}\s+/u.test(t) && tNorm.length <= 24) return true;

  return false;
}

function HeadingLine({ title, level }: { title: string; level: 1 | 2 | 3 | 4 }) {
  const Tag = (`h${level}` as any) as React.ElementType;

  // ✅ 先頭の絵文字（例: 📌/🗂️/📍/🧭 など）を「見出しアイコン」として回収
  const raw = String(title ?? '').trim();

  // 先頭の絵文字(1個) + 空白 を拾う
  const m = raw.match(/^([\p{Extended_Pictographic}\uFE0F]+)\s*(.*)$/u);
  const leadingEmoji = m?.[1] ?? null;
  const restTitle = (m?.[2] ?? raw).trim();

  const normTitle = normalizeHeadingTitle(restTitle);

  // ✅ アイコン決定：先頭絵文字があればそれを優先。無ければ既存ロジック。最後は必ずデフォルト。
  const icon = leadingEmoji ?? pickHeadingIcon(normTitle) ?? '🧿';

  return (
    <Tag className="iros-heading-line">
      <span style={{ marginRight: '0.4em', fontSize: '1.1rem' }}>{icon}</span>
      <span>{normTitle}</span>
    </Tag>
  );
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

// ✅ 段落数（空行区切り）をざっくり数える：装飾の“発火条件”に使う
function countParagraphs(src: string): number {
  const s = String(src ?? '').replace(/\r\n/g, '\n').trim();
  if (!s) return 0;
  // 2個以上の改行で区切られる塊を段落とみなす
  return s.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).length;
}

// ✅ Markdown見出しの本数（#）を数える：見出しがあるなら段落装飾は控えめに
function countMarkdownHeadings(src: string): number {
  const s = String(src ?? '').replace(/\r\n/g, '\n');
  const m = s.match(/^\#{1,6}\s+/gm);
  return m?.length ?? 0;
}

// ✅ 先頭に絵文字があるか（段落装飾の二重付与防止）
function hasLeadingEmoji(s: string): boolean {
  const t = String(s ?? '').trimStart();
  return /^\p{Extended_Pictographic}/u.test(t);
}

export default function ChatMarkdown({ text, className }: ChatMarkdownProps) {
  const normalized = useMemo(() => {
    // ⚠️ これは「ブラウザの console」に出ます（dev.live.log には基本出ません）
    // console.log('[DEBUG/ChatMarkdown][RAW]', JSON.stringify(text).slice(0, 800));

    const t1 = normalizeBold(text);
    const t2 = fixUnmatchedBold(t1);

    // console.log('[DEBUG/ChatMarkdown][NORMALIZED]', JSON.stringify(t2).slice(0, 800));
    return t2;
  }, [text]);

  // ✅ “3段以上”のときだけ、段落にも軽い装飾を乗せる（見出しが無い文章向け）
  const paraCount = useMemo(() => countParagraphs(normalized), [normalized]);
  const headingCount = useMemo(() => countMarkdownHeadings(normalized), [normalized]);

  // ルール：
  // - 段落>=3 かつ 見出しが少ない（<=1）ときだけ、最初の1〜3段落に薄いアイコンを付ける
  const enableParaDecor = paraCount >= 3 && headingCount <= 1;

  // 段落インデックス（render中だけ使う）
  let pIndex = 0;

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children, ...props }) => {
            const raw = plainTextFromChildren(children);
            const idx = pIndex++;
            const shouldDecorate = enableParaDecor && idx <= 2 && raw.trim() && !hasLeadingEmoji(raw);

            // 先頭3段落だけ：🧿 → 🌀 → 🌱（強すぎない）
            const icon = idx === 0 ? '🧿' : idx === 1 ? '🌀' : '🌱';

            return (
              <p
                {...props}
                style={{
                  margin: '0 0 0.8em',
                  lineHeight: 1.9,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {shouldDecorate && (
                  <span style={{ marginRight: '0.45em', fontSize: '1.05rem' }}>{icon}</span>
                )}
                {children}
              </p>
            );
          },

          // ✅ 見出し：children を plainText で
          h1: ({ children }) => <HeadingLine title={plainTextFromChildren(children)} level={1} />,
          h2: ({ children }) => <HeadingLine title={plainTextFromChildren(children)} level={2} />,
          h3: ({ children }) => <HeadingLine title={plainTextFromChildren(children)} level={3} />,
          h4: ({ children }) => <HeadingLine title={plainTextFromChildren(children)} level={4} />,

          strong: ({ children, ...props }) => {
            const raw0 = plainTextFromChildren(children).trim();

            // ✅ 先頭の絵文字を拾う（あれば見出しアイコンとして優先）
            const m = raw0.match(/^([\p{Extended_Pictographic}\uFE0F]+)\s*/u);
            const leadingEmoji = m?.[1] ?? null;

            // ✅ 見出し判定/正規化は「絵文字を除いた本文」でやる
            const raw = leadingEmoji ? raw0.replace(m?.[0] ?? '', '').trim() : raw0;
            const norm = normalizeHeadingTitle(raw);

            if (isStrongHeading(raw)) {
              const icon = leadingEmoji ?? pickHeadingIcon(raw) ?? '🧿';

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
                  {norm}
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
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
