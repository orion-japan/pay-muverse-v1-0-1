// src/ui/iroschat/components/MessageList.tsx
'use client';

import React from 'react';
import { useIrosChat } from '../IrosChatContext';
import styles from '../index.module.css';
import { useAuth } from '@/context/AuthContext'; // 動的アイコン用
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import ReactMarkdown from 'react-markdown';
import '../IrosChat.css'; // 行間・余白の調整

type IrosMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: unknown; // 混在対策（確実に文字列化して描画）

  // 旧Qバッジ用（当面は残す）
  q?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  color?: string;

  // 追加: サーバーから渡ってくる meta 一式
  meta?: {
    qCode?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
    depth?: string | null;
    mode?:
      | 'light'
      | 'consult'
      | 'mirror'
      | 'resonate'
      | 'counsel'
      | 'structured'
      | 'diagnosis'
      | 'auto'
      | string
      | null;
    tLayerModeActive?: boolean;
    tLayerHint?: string | null;
    [key: string]: any;
  };

  ts?: number;
};

const AVATAR_SIZE = 32;
const FALLBACK_USER = '/iavatar_default.png';
const FALLBACK_DATA =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" viewBox="0 0 40 40">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#eceff7"/><stop offset="1" stop-color="#dde6ff"/>
      </linearGradient></defs>
      <rect width="40" height="40" rx="20" fill="url(#g)"/>
      <circle cx="20" cy="16" r="8" fill="#b7c3d7"/>
      <rect x="7" y="26" width="26" height="10" rx="5" fill="#c8d2e3"/>
    </svg>`,
  );

/* ========= muverse トーン用スタイル ========= */

// タイムライン全体：ごく薄い muverse グラデ背景
const chatAreaStyle: React.CSSProperties = {
  padding: '12px 0 18px',
  background:
    'linear-gradient(180deg, #f5f7ff 0%, #eef5ff 35%, #faf6ff 70%, #ffffff 100%)',
};

// ユーザー吹き出し（薄い muverse グラデ）
const userBubbleStyle: React.CSSProperties = {
  background: 'linear-gradient(135deg, #f8f3ff 0%, #e8ddff 40%, #f7f0ff 100%)',
  border: '1px solid rgba(147, 116, 255, 0.35)',
  boxShadow: '0 10px 26px rgba(113, 88, 255, 0.22)',
  color: '#2b2140',
  borderRadius: 16,
  padding: '10px 13px',
};

// アシスタントは GPT 風フラット：枠・影は CSS 側で消してあるのでここでは幅だけ
const assistantBubbleShellStyle: React.CSSProperties = {
  maxWidth: '100%',
  width: '100%',
  flex: '1 1 auto',
};

// Qバッジ（muverse 色味）
const qBadgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 11,
  marginBottom: 6,
  background:
    'linear-gradient(135deg, rgba(129, 140, 248, 0.06), rgba(192, 132, 252, 0.16))',
  border: '1px solid rgba(129, 140, 248, 0.45)',
  color: '#4338ca',
};

/** Vision / Hint 用のヘッダーバー（旧 Seed スタイルを流用） */
const seedHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '6px 10px 4px',
  marginBottom: 6,
  borderRadius: 10,
  background:
    'linear-gradient(135deg, rgba(56,189,248,0.1), rgba(129,140,248,0.15))',
  border: '1px solid rgba(59,130,246,0.35)',
};

const seedLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  fontWeight: 600,
  color: '#0f172a',
};

const seedTLHintStyle: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 10,
  background: 'rgba(37,99,235,0.08)',
  color: '#1d4ed8',
};

/** [object Object]対策：最終的に必ず文字列へ正規化 */
function toSafeString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const cand =
      (typeof o.content === 'string' && o.content) ||
      (typeof o.text === 'string' && o.text) ||
      (typeof o.message === 'string' && o.message) ||
      (typeof o.assistant === 'string' && o.assistant);
    if (cand) return cand;
    try {
      return JSON.stringify(o, null, 2); // 可読性重視
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/* ========= I層テンプレ → GPT風Markdown 変換 ========= */

/**
 * ir診断用テンプレ
 *  観測対象：{{...}}
 *  深度：{{R2}}
 *  位相：{{Outer}}
 *  🌀意識状態：{{...}}
 *  🪔メッセージ：{{...}}
 * を GPT っぽい Markdown に変換する。
 * 対応しないテキストの場合は input をそのまま返す。
 */
function transformIrTemplateToMarkdown(input: string): string {
  if (!input.trim()) return input;

  // 🔹新ir診断フォーマットはそのまま表示する
  // 例：
  // 🧿 観測対象：◯◯
  // 🪔 irosからの一句：〜
  // 構造スキャン
  // フェーズ：〜
  // 位相：〜
  // 深度：〜
  // 🌀 その瞬間の揺れ：〜
  // 🌱 次の一手：〜
  if (
    /🧿\s*観測対象[:：]/.test(input) &&
    /I\/T層の刺さる一句/.test(input)
  ) {
    return input;
  }

  const rawLines = input.split(/\r?\n/);

  type Section = 'none' | 'state' | 'message';

  const data = {
    target: '',
    depth: '',
    phase: '',
    stateLines: [] as string[],
    messageLines: [] as string[],
  };

  const extractValue = (raw: string): string => {
    let t = raw.trim();
    const m = t.match(/^\{\{(.*)\}\}$/);
    if (m) t = m[1].trim();
    return t;
  };

  const getAfterMark = (s: string): string => {
    const idxJa = s.indexOf('：');
    const idxEn = s.indexOf(':');
    const pos = idxJa !== -1 ? idxJa : idxEn !== -1 ? idxEn : -1;
    return pos >= 0 ? s.slice(pos + 1) : '';
  };

  // 絵文字を前処理で削る（🌀 / 🌱 / 🪔）
  const normalizeHead = (line: string): string =>
    line
      .replace(/^🌀\s*/, '')
      .replace(/^🌱\s*/, '')
      .replace(/^🪔\s*/, '')
      .trim();

  let section: Section = 'none';

  for (const raw of rawLines) {
    const line = normalizeHead(raw);
    if (!line) {
      if (section === 'state') data.stateLines.push('');
      if (section === 'message') data.messageLines.push('');
      continue;
    }

    if (line.startsWith('観測対象')) {
      data.target = extractValue(getAfterMark(line));
      section = 'none';
      continue;
    }
    if (line.startsWith('深度')) {
      data.depth = extractValue(getAfterMark(line));
      section = 'none';
      continue;
    }
    if (line.startsWith('位相')) {
      data.phase = extractValue(getAfterMark(line));
      section = 'none';
      continue;
    }

    if (line.startsWith('意識状態')) {
      section = 'state';
      continue;
    }
    if (line.startsWith('メッセージ')) {
      section = 'message';
      continue;
    }

    if (section === 'state') {
      data.stateLines.push(raw.trim());
      continue;
    }
    if (section === 'message') {
      data.messageLines.push(raw.trim());
      continue;
    }
  }

  const stateText = data.stateLines.join('\n').trim();
  const messageText = data.messageLines.join('\n').trim();

  const hasAny =
    !!data.target ||
    !!data.depth ||
    !!data.phase ||
    !!stateText ||
    !!messageText;

  if (!hasAny) return input;

  const out: string[] = [];

  if (data.target) {
    out.push('**🧿 観測対象**', '', data.target, '');
  }

  if (data.depth || data.phase) {
    const meta: string[] = [];
    if (data.depth) meta.push(`深度：${data.depth}`);
    if (data.phase) meta.push(`位相：${data.phase}`);
    if (meta.length) {
      out.push('**構造メモ**', '', meta.join(' / '), '');
    }
  }

  out.push('---', '');

  if (stateText) {
    out.push('', '**🌀 意識状態**', '', stateText, '');
  }

  if (messageText) {
    out.push('', '**🌱 メッセージ**', '', messageText, '');
  }

  return out.join('\n');
}

/**
 * カギカッコごと太字になっているパターンを
 * 「**カギカッコの中身だけ太字」に変換する。
 * 例：**「小さな一歩」** → 「**小さな一歩**」
 */
function normalizeBoldInsideQuotes(input: string): string {
  if (!input) return input;

  // 「〜」パターン
  let out = input.replace(/\*\*「([^」]+)」\*\*/g, '「**$1**」');

  // 『〜』パターンも一応サポート
  out = out.replace(/\*\*『([^』]+)』\*\*/g, '『**$1**』');

  return out;
}

/* ========= ReactMarkdown 用カスタムコンポーネント ========= */

const markdownComponents: any = {
  // 段落：行間を少し広めに
  p: ({ children }: { children: React.ReactNode }) => (
    <p
      style={{
        margin: '0 0 0.8em', // ちょっとだけ余白を増やす
        whiteSpace: 'pre-wrap',
      }}
    >
      {children}
    </p>
  ),

  // 太字：sofiaカードの「小見出し」っぽく強調
  strong: ({ children }: { children: React.ReactNode }) => (
    <strong
      style={{
        fontWeight: 700,
        color: '#111827',
        fontSize: '1.02rem', // ベース文字より少し大きく
        letterSpacing: '0.01em',
        display: 'inline-block',
        margin: '0.45em 0 0.25em', // 上に少し余白 → 段が分かれて見える
      }}
    >
      {children}
    </strong>
  ),

  // 箇条書き
  ul: ({ children }: { children: React.ReactNode }) => (
    <ul
      style={{
        paddingLeft: '1.2em',
        margin: '0.25em 0 0.6em',
      }}
    >
      {children}
    </ul>
  ),
  li: ({ children }: { children: React.ReactNode }) => (
    <li
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
        borderTop: '1px dashed rgba(148, 163, 184, 0.7)',
        margin: '0.6em 0 0.8em',
      }}
    />
  ),
};

export default function MessageList() {
  const { messages, loading, error } = useIrosChat() as {
    messages: IrosMessage[];
    loading: boolean;
    error?: string | null;
  };

  const authVal = (typeof useAuth === 'function' ? useAuth() : {}) as {
    user?: { avatarUrl?: string | null };
  };
  const { user } = authVal || {};

  const listRef = React.useRef<HTMLDivElement | null>(null);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  const first = React.useRef(true);

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') =>
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });

  React.useEffect(() => {
    console.log('[IROS UI] messages updated', {
      len: messages.length,
      last: messages[messages.length - 1]
        ? {
            id: messages[messages.length - 1].id,
            role: messages[messages.length - 1].role,
            meta: messages[messages.length - 1].meta,
          }
        : null,
    });

    scrollToBottom(first.current ? 'auto' : 'smooth');
    first.current = false;
  }, [messages]);

  const resolveUserAvatar = (msg: IrosMessage): string => {
    const perMessage = ((msg as any)?.avatarUrl as string | undefined)?.trim?.();
    if (perMessage) return perMessage;
    const byAuth = user?.avatarUrl?.trim?.() || '';
    if (byAuth) return byAuth;
    return FALLBACK_USER;
  };

  return (
    <div
      ref={listRef}
      className={`${styles.timeline} sof-msgs`}
      style={chatAreaStyle}
    >
      {!messages.length && !loading && !error && (
        <div className={styles.emptyHint}>ここに会話が表示されます</div>
      )}

      {messages.map((m) => {
        const isUser = m.role === 'user';
        const iconSrc = isUser ? resolveUserAvatar(m) : '/ir.png';

        const rawText = toSafeString(m.text);
        const safeText = normalizeBoldInsideQuotes(
          transformIrTemplateToMarkdown(rawText),
        );

        const qFromMeta = m.meta?.qCode;
        const qToShow = qFromMeta ?? m.q;

        // 🔹 Vision モード判定
        const isVisionMode = !isUser && m.meta?.mode === 'vision';

        // 🔹 Vision Hint（T層フラグのみ）の判定
        const isVisionHint =
          !isUser &&
          m.meta?.mode !== 'vision' &&
          !!m.meta?.tLayerModeActive === true;

        const tHint = m.meta?.tLayerHint || 'T2';

        return (
          <div
            key={m.id}
            className={`message ${isUser ? 'is-user' : 'is-assistant'}`}
          >
            {/* ▼ アイコン＋Qバッジを横一列に並べるヘッダー行 ▼ */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: isUser ? 'flex-end' : 'flex-start',
                gap: 6,
                marginBottom: 4,
              }}
            >
              {/* アバター */}
              <div className="avatar" style={{ alignSelf: 'center' }}>
                <img
                  src={iconSrc}
                  alt={isUser ? 'you' : 'Iros'}
                  width={AVATAR_SIZE}
                  height={AVATAR_SIZE}
                  onError={(e) => {
                    const el = e.currentTarget as HTMLImageElement & {
                      dataset: Record<string, string | undefined>;
                    };
                    if (!el.dataset.fallback1) {
                      el.dataset.fallback1 = '1';
                      el.src = FALLBACK_USER;
                      return;
                    }
                    if (!el.dataset.fallback2) {
                      el.dataset.fallback2 = '1';
                      el.src = FALLBACK_DATA;
                    }
                  }}
                  style={{
                    borderRadius: '50%',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              </div>

              {/* Qバッジ：Iros（assistant）のときだけアイコンの右に表示 */}
              {!isUser && qToShow && (
                <div className="q-badge" style={qBadgeStyle}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      background: m.color || 'rgba(129,140,248,0.85)',
                      display: 'inline-block',
                    }}
                  />
                  {qToShow}
                </div>
              )}
            </div>

            {/* 吹き出し（構図はこれまで通り） */}
            <div
              className={`bubble ${isUser ? 'is-user' : 'is-assistant'}`}
              style={{
                ...(isUser ? userBubbleStyle : assistantBubbleShellStyle),
                alignSelf: isUser ? 'flex-end' : 'flex-start',
                maxWidth: 'min(760px, 88%)',
              }}
            >
              {/* ▼ Vision系ヘッダー（Mode / Hint） */}
              {(isVisionMode || isVisionHint) && (
  <div style={seedHeaderStyle}>
    <div style={seedLabelStyle}>
      {isVisionMode ? (
        <>
          <span>🌌 Vision Mode</span>
          <span style={seedTLHintStyle}>{tHint}</span>
          {/* ← ここを追加：Vision 中も T 層アクティブなら ✨ を添える */}
          {m.meta?.tLayerModeActive && (
            <span style={{ marginLeft: 6, fontSize: 14 }}>✨</span>
          )}
        </>
      ) : (
        <span style={{ fontSize: 14, opacity: 0.9 }}>✨</span>
      )}
    </div>
  </div>
)}


              <div className="msgBody">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks]}
                  components={markdownComponents}
                >
                  {safeText}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        );
      })}

      {loading && <div className={styles.loadingRow}>...</div>}
      {error && <div className={styles.error}>{error}</div>}
      <div ref={bottomRef} />
    </div>
  );
}

