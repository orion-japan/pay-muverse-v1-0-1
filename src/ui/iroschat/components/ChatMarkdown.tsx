// src/ui/iroschat/components/ChatMarkdown.tsx
'use client';
import './ChatMarkdown.css';
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
  '二つの見方': '🔍',

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

// ChatMarkdown.tsx
// ✅ 見出しタイトルから “意味アイコン” を推定（日本語優先）
// - 先頭絵文字が残っていればそれが最優先（leadingEmoji）
// - 先頭絵文字が剥がれても、タイトル語彙でアイコンが変わるようにする
function pickHeadingIcon(titleRaw: string): string | null {
  const t = normalizeHeadingTitle(titleRaw);
  if (!t) return null;

  // ✅ 1) 辞書が最優先（確実に出したい見出しはここで固定）
  if (HEADING_ICONS[t]) return HEADING_ICONS[t];

  // helper: どれか含む
  const has = (...words: string[]) => words.some((w) => t.includes(w));

  // ✅ 2) “意味ベース” の分岐（辞書に無いときだけ）
  // 揃える/整える/今ここ
  if (has('今ここ', '揃える', '整える', '整列', 'リセット', '仕切り直し', '土台', '軸')) return '🌀';

  // 観測/見る/確認/前提（※「見方」も拾う）
  if (has('観測', '見る', '見て', '確認', '前提', '状況', 'いま', '現状', '整理', '見方')) return '🔍';

  // 焦点/一点/絞る/要点
  if (has('焦点', '一点', '絞', '要点', 'ポイント', '核', '中心')) return '🎯';

  // 受け止め/安心/安全/保険
  if (has('受け止め', '受けとめ', '安心', '安全', '保険', '守る', '落ち着く')) return '🪔';

  // 統合/つなぐ/まとめ
  if (has('統合', 'つなぐ', '繋ぐ', 'まとめ', '合流', '一つに', '収束')) return '🧩';

  // 選ぶ/決める/結論/ここで一つ
  if (has('選ぶ', '決める', '結論', 'ここで一つ', '最終', 'どれ')) return '✅';

  // 次の一歩/進める/行動
  if (has('次', '一歩', '進める', 'やる', '試す', '実行', '今日')) return '👣';

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


function HeadingLine({ title, level }: { title: string; level: 1 | 2 | 3 | 4 }) {
  const Tag = (`h${level}` as any) as React.ElementType;

  const raw = String(title ?? '').trim();

  // 先頭の絵文字(1個) + 空白 を拾う
  const m = raw.match(/^([\p{Extended_Pictographic}\uFE0F]+)\s*(.*)$/u);
  const leadingEmoji = m?.[1] ?? null;
  const restTitle = (m?.[2] ?? raw).trim();

  const normTitle = normalizeHeadingTitle(restTitle);

  // ✅ ここがポイント：
  // 1) 先頭絵文字
  // 2) HEADING_ICONS（タイトル完全一致）
  // 3) 意味ベース推定
  // 4) デフォルト
  const icon =
    leadingEmoji ??
    HEADING_ICONS[normTitle] ??
    pickHeadingIcon(normTitle) ??
    '🧿';

  // ✅ 「二つの見方」だけ “サブ見出し扱い” のクラスを付ける
  const isSub = normTitle === '二つの見方';

  return (
    <Tag className={`iros-heading-line${isSub ? ' iros-heading-sub' : ''}`}>
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
    <div className={`iros-markdown ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children, ...props }) => {
            const raw = plainTextFromChildren(children);
            const idx = pIndex++;
            const shouldDecorate = enableParaDecor && idx <= 2 && raw.trim() && !hasLeadingEmoji(raw);

            const icon = idx === 0 ? '🧿' : idx === 1 ? '🌀' : '🌱';

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

          strong: ({ children, ...props }) => {
            return (
              <strong {...props} className="iros-emphasis">
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
  );}
