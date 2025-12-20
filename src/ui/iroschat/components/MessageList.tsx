'use client';

import React from 'react';
import { useIrosChat } from '../IrosChatContext';
import styles from '../index.module.css';
import { useAuth } from '@/context/AuthContext';
import '../IrosChat.css';

import ChatMarkdown from './ChatMarkdown';
import IrosButton, { IrosNextStepGear } from './IrosButton';

// メッセージ型
type IrosMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: unknown;

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

    // ★ WILLエンジンから返ってくる「次の一歩」候補
    nextStep?: {
      gear?: 'safety' | 'soft-rotate' | 'full-rotate' | string;
      options?: {
        key: string; // A / B / C / D など
        label: string; // ボタンに表示する短い文
        description?: string; // （あれば）説明文
      }[];
    };

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
  padding: '12px 0 40vh',
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

// アシスタントは「白いカード」風レイアウト
const assistantBubbleShellStyle: React.CSSProperties = {
  maxWidth: '100%',
  width: '100%',
  flex: '1 1 auto',
  background: '#ffffff',
  borderRadius: 18,
  padding: '14px 18px',
  border: '1px solid rgba(148, 163, 184, 0.35)',
  boxShadow: '0 18px 40px rgba(15, 23, 42, 0.08)',
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

/** Vision / Hint 用のヘッダーバー */
const seedHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '6px 10px 4px',
  marginBottom: 6,
  borderRadius: 10,
  background:
    'linear-gradient(135deg, rgba(56, 189, 248, 0.1), rgba(129, 140, 248, 0.15))',
  border: '1px solid rgba(59, 130, 246, 0.35)',
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
  background: 'rgba(37, 99, 235, 0.08)',
  color: '#1d4ed8',
};

/** [object Object]対策：本文として使える文字列が無い object は「表示しない」 */
function toSafeString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';

  // object の場合：本文候補キーだけ拾う。無ければ空文字（←ここが重要）
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;

    const cand =
      (typeof o.content === 'string' && o.content) ||
      (typeof o.text === 'string' && o.text) ||
      (typeof o.message === 'string' && o.message) ||
      (typeof o.assistant === 'string' && o.assistant) ||
      (typeof (o as any).reply === 'string' && (o as any).reply);

    return cand || '';
  }

  // number / boolean などは文字列化
  try {
    return String(v);
  } catch {
    return '';
  }
}

/**
 * 先頭の【IROS_STATE_META】… を削る（1行目にJSONが連結してる/改行で続く両対応）
 * - 【IROS_STATE_META】{...}
 * - 【IROS_STATE_META】\n{...}\n（以降本文）
 */
function stripIrosMetaHeader(raw: string): string {
  if (!raw) return '';

  // 1) まず「先頭行」にタグがあるケース
  const lines = raw.split('\n');
  const first = lines[0]?.trimStart() ?? '';

  if (!first.startsWith('【IROS_STATE_META】')) return raw;

  // 1-a) 先頭行が「タグだけ」のケース → 次行以降へ
  if (first === '【IROS_STATE_META】') {
    // JSONが数行に渡る可能性があるので、最初の行が「{」から始まるなら
    // その JSON ブロックをざっくり飛ばして、残りを返す
    let i = 1;
    if ((lines[i] ?? '').trimStart().startsWith('{')) {
      // 簡易：括弧の深さで JSON ブロック終端を探す（失敗しても安全に進む）
      let depth = 0;
      for (; i < lines.length; i++) {
        const s = lines[i];
        for (const ch of s) {
          if (ch === '{') depth++;
          else if (ch === '}') depth = Math.max(0, depth - 1);
        }
        if (depth === 0) {
          i++; // JSON終端行の次から本文
          break;
        }
      }
    }
    return lines.slice(i).join('\n').trimStart();
  }

  // 1-b) 先頭行が「タグ + JSON + もしかして本文」になってるケース
  // 例: 【IROS_STATE_META】{"qCode":"Q3"}\n本文...
  return lines.slice(1).join('\n').trimStart();
}

/* ========= I層テンプレ → GPT風Markdown 変換 ========= */

function transformIrTemplateToMarkdown(input: string): string {
  if (!input.trim()) return input;

  // 新 ir診断フォーマットはそのまま表示する
  if (/🧿\s*観測対象[:：]/.test(input) && /I\/T層の刺さる一句/.test(input)) {
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
 * 太字まわりのゆらぎを正規化する
 * - "** 〜 **" → "**〜**"（先頭/末尾の空白を削る）
 * - **「〜」** / **『〜』** → 「**〜**」 / 『**〜**』
 */
function normalizeBoldMarks(input: string): string {
  if (!input) return input;

  // "** テキスト **" → "**テキスト**"
  let out = input.replace(/\*\*\s+([^*][^*]*?)\s*\*\*/g, '**$1**');

  // カギカッコごと太字 → 中身だけ太字
  out = out.replace(/\*\*「([^」]+)」\*\*/g, '「**$1**」');
  out = out.replace(/\*\*『([^』]+)』\*\*/g, '『**$1**』');

  return out;
}

export default function MessageList() {
  const { messages, loading, error, sendNextStepChoice } =
    useIrosChat() as unknown as {
      messages: IrosMessage[];
      loading: boolean;
      error?: string | null;
      sendNextStepChoice?: (opt: {
        key: string;
        label: string;
        gear?: string | null;
      }) => Promise<unknown>;
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
    if (!messages.length) return;

    const last = messages[messages.length - 1];

    console.log('[IROS UI] messages updated', {
      len: messages.length,
      last: last ? { id: last.id, role: last.role, meta: last.meta } : null,
    });

    // 初回ロード時：一番下へ
    if (first.current) {
      scrollToBottom('auto');
      first.current = false;
      return;
    }

    const container = listRef.current;
    const bottomEl = bottomRef.current;
    if (!container || !bottomEl) return;

    if (last.role === 'user') {
      // ユーザーメッセージ送信時：画面中央付近に持ち上げる
      const bottomOffset = bottomEl.offsetTop;
      const viewHeight = container.clientHeight;
      const desiredRatio = 0.5;

      const targetTopRaw = bottomOffset - viewHeight * desiredRatio;
      const maxScroll = container.scrollHeight - viewHeight;
      const targetTop = Math.max(0, Math.min(targetTopRaw, maxScroll));

      container.scrollTo({ top: targetTop, behavior: 'smooth' });
    } else {
      // Iros の返答時：一番下まで追尾
      scrollToBottom('smooth');
    }
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

        // ★ メタを本文から隠す：toSafeString → stripIrosMetaHeader → transform → normalize
        const rawText = stripIrosMetaHeader(toSafeString(m.text));
        const displayText = stripNextStepTagsForDisplay(rawText);
        const safeText = normalizeBoldMarks(transformIrTemplateToMarkdown(displayText));
        /** NextStepタグを表示から消す（先頭に複数ついてても全部落とす） */
function stripNextStepTagsForDisplay(raw: string): string {
  if (!raw) return '';
  return raw.replace(/^\s*(\[[a-zA-Z0-9_\-]+\]\s*)+/g, '').trimStart();
}

// ✅ 表示用Qコードは「現在Q」を優先して拾う（targetQ / goalTargetQ は表示に使わない）
const qToShowRaw =
  (m.meta?.qCode as any) ??
  (m.meta?.q as any) ??
  (m.meta?.unified?.q?.current as any) ??
  ((m as any)?.q_code as any) ??
  ((m as any)?.q as any) ??
  null;

// 安全弁：Q1〜Q5 以外は出さない
const qToShowSafe =
  typeof qToShowRaw === 'string' && /^Q[1-5]$/.test(qToShowRaw)
    ? (qToShowRaw as 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5')
    : null;


        const isVisionMode = !isUser && m.meta?.mode === 'vision';
        const isVisionHint =
          !isUser && m.meta?.mode !== 'vision' && !!m.meta?.tLayerModeActive === true;
        const tHint = m.meta?.tLayerHint || 'T2';

        const nextStep = m.meta?.nextStep;

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

              {/* Qバッジ：Iros（assistant）のときだけ */}
              {!isUser && qToShowSafe && (
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
                  {qToShowSafe}
                </div>
              )}
            </div>

            {/* 吹き出し */}
            <div
              className={`bubble ${isUser ? 'is-user' : 'is-assistant'}`}
              style={{
                ...(isUser ? userBubbleStyle : assistantBubbleShellStyle),
                alignSelf: isUser ? 'flex-end' : 'flex-start',
                maxWidth: 'min(760px, 88%)',
              }}
            >
              {/* Vision系ヘッダー（Mode / Hint） */}
              {(isVisionMode || isVisionHint) && (
                <div style={seedHeaderStyle}>
                  <div style={seedLabelStyle}>
                    {isVisionMode ? (
                      <>
                        <span>🌌 Vision Mode</span>
                        <span style={seedTLHintStyle}>{tHint}</span>
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

              {/* 本文＋「次の一歩」ボタン */}
              <div
                className={`msgBody ${isVisionMode ? 'vision-theme' : ''} ${
                  isVisionHint ? 'vision-hint-theme' : ''
                }`}
                style={{ fontSize: 14, lineHeight: 1.9, color: '#111827' }}
              >
                {/* 本文 */}
                <ChatMarkdown text={safeText} />

                {/* ★ WILLエンジンの「次の一歩」オプション（必要なときだけ表示） */}
                {!isUser && nextStep?.options && nextStep.options.length > 0 && (
                  <div
                    style={{
                      marginTop: 16,
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                    }}
                  >
{nextStep.options.map((opt) => {
  // ✅ 受け取り options が旧型でも新型でも動くように正規化
  const normalized = {
    id: (opt as any).id ?? opt.key,      // ← choiceId 本体
    key: opt.key,                        // ← A/B/C など表示用（無くてもOK）
    label: opt.label,
    description: opt.description,
  };

  return (
    <IrosButton
      key={normalized.id}
      option={normalized as any}
      gear={nextStep.gear as IrosNextStepGear}
      pending={loading}
      onClick={async (option) => {
        const id = (option as any).id ?? option.key ?? '';
        const displayLabel = option.label;

        // ✅ 送信本文だけ「タグ付き」にする（UI表示は server の strip が担当）
        const alreadyTagged =
        typeof displayLabel === 'string' && displayLabel.startsWith(`[${id}]`);

      const rawText = alreadyTagged ? displayLabel : `[${id}] ${displayLabel}`;


        console.log('[IROS UI] nextStep option clicked', {
          id,
          displayLabel,
          rawText,
          gear: nextStep.gear ?? null,
        });

        if (sendNextStepChoice) {
          await sendNextStepChoice({
            key: id,
            label: rawText, // ★ここが重要：/reply に choiceId を届ける
            gear: (nextStep.gear ?? null) as string | null,
          });
        }
      }}
    />
  );
})}

                  </div>
                )}
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
