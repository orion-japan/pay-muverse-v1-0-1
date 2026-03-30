'use client';

import React from 'react';
import { useIrosChat } from '../IrosChatContext';
import styles from '../index.module.css';
import { useAuth } from '@/context/AuthContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import '../IrosChat.css';

import ChatMarkdown from './ChatMarkdown';
import IrosMetaBadge from './IrosMetaBadge';

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
      gear?: 'safety' | 'soft-rotate' | 'full-rotate' | 'it-demo' | string;
      options?: {
        /** ✅ choiceId（IrosButton側で必須） */
        id: string;
        /** 表示用キー（A/B/C など） */
        key?: string;
        /** ボタンに表示する短い文 */
        label: string;
        /** （あれば）説明文 */
        description?: string;
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

  const lines = raw.split('\n');
  const first = lines[0]?.trimStart() ?? '';

  if (!first.startsWith('【IROS_STATE_META】')) return raw;

  // 先頭行が「タグだけ」のケース → 次行以降へ
  if (first === '【IROS_STATE_META】') {
    let i = 1;
    if ((lines[i] ?? '').trimStart().startsWith('{')) {
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

  // 先頭行が「タグ + JSON」で、本文は次行以降にある想定
  return lines.slice(1).join('\n').trimStart();
}

/** NextStepタグを表示から消す（先頭に複数ついてても全部落とす） */
function stripNextStepTagsForDisplay(raw: string): string {
  if (!raw) return '';
  return raw.replace(/^\s*(\[[a-zA-Z0-9_\-]+\]\s*)+/g, '').trimStart();
}

/* ========= I層テンプレ → GPT風Markdown 変換 ========= */

function transformIrTemplateToMarkdown(input: string): string {
  if (!input.trim()) return input;

  // ① multi7（ENTRY/DUAL/FOCUS_SHIFT/ACCEPT/INTEGRATE/NEXT_MIN）の素テキストを Markdown 見出し化
  // 例: 「入口」単独行 → 「### 入口」
  {
    const STEP_TITLES = new Set([
      '入口',
      '二項',
      '焦点移動',
      '受容',
      '統合',
      '最小の一手',
    ]);

    const lines = input.split(/\r?\n/);
    let hit = 0;

    const out: string[] = [];
    for (const raw of lines) {
      const t = raw.trim();

      if (STEP_TITLES.has(t)) {
        hit++;
        out.push(`### ${t}`, ''); // 見出し + 空行
        continue;
      }

      out.push(raw);
    }

    // 2個以上ヒットしたら「multi7本文」とみなして変換を採用
    if (hit >= 2) return out.join('\n');
  }

  // ② 新 ir診断フォーマットはそのまま表示する
  if (/🧿\s*観測対象[:：]/.test(input) && /I\/T層の刺さる一句/.test(input)) {
    return input;
  }
  // ②.5 通常会話は変換しない
  // - multi7 でも新ir診断でもない本文まで旧I層テンプレ変換に流すと、
  //   改行や段落構造がUI側で崩れる
  // - 旧テンプレの見出し（観測対象 / 深度 / 位相 / 意識状態 / メッセージ）が
  //   実際に含まれているときだけ下の既存変換へ進める
// 新 ir診断フォーマット（まとめあり）はそのまま通す
const looksLikeNewIrFormat =
  /(?:^|\n)\s*観測対象\s*[:：]/m.test(input) &&
  /(?:^|\n)\s*意識状態\s*[:：]/m.test(input) &&
  /(?:^|\n)\s*まとめ\s*[:：]/m.test(input);

if (looksLikeNewIrFormat) {
  return input;
}

// 旧テンプレ判定
const looksLikeLegacyIrTemplate =
  /(?:^|\n)\s*(?:観測対象|深度|位相|意識状態|メッセージ)\s*[:：]?/m.test(input);

if (!looksLikeLegacyIrTemplate) {
  return input;
}
  // ③ 旧 I層テンプレ → Markdown（既存ロジック）
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
    out.push('### 🧿 観測対象', '', data.target, '');
  }

  if (data.depth || data.phase) {
    const meta: string[] = [];
    if (data.depth) meta.push(`深度：${data.depth}`);
    if (data.phase) meta.push(`位相：${data.phase}`);
    if (meta.length) {
      out.push('### 構造メモ', '', meta.join(' / '), '');
    }
  }

  out.push('---', '');

  if (stateText) {
    out.push('### 🌀 意識状態', '', stateText, '');
  }

  if (messageText) {
    out.push('### 🌱 メッセージ', '', messageText, '');
  }

  return out.join('\n');
}

function extractDiagnosisSummary(raw: string): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';

  const lines = text.split(/\r?\n/);

  const normalizeLine = (line: string): string =>
    line
      .replace(/^🌀\s*/, '')
      .replace(/^🧿\s*/, '')
      .replace(/^🌿\s*/, '')
      .replace(/^🌱\s*/, '')
      .replace(/\*\*/g, '')
      .trim();

  const isHeadingLine = (line: string): boolean => {
    const t = normalizeLine(line);
    return /^(観測対象|観測結果|意識状態|メッセージ|まとめ)\s*[:：]/.test(t);
  };

  const startIndex = lines.findIndex((line) => {
    const t = normalizeLine(line);
    return /^まとめ\s*[:：]/.test(t);
  });

  if (startIndex < 0) return '';

  const firstLineNormalized = normalizeLine(lines[startIndex]);
  const firstLine = firstLineNormalized.replace(/^まとめ\s*[:：]\s*/, '').trim();

  const collected: string[] = firstLine ? [firstLine] : [];

  for (let i = startIndex + 1; i < lines.length; i++) {
    const rawLine = lines[i];
    const normalized = normalizeLine(rawLine);

    if (isHeadingLine(rawLine)) break;

    collected.push(normalized.length > 0 ? rawLine.trim() : '');
  }

  return collected.join('\n').trim();
}
export default function MessageList() {
  const chat = useIrosChat() as
    | {
        messages: IrosMessage[];
        loading: boolean;
        error?: string | null;
        setDraftText?: (text: string) => void;
        sendNextStepChoice?: (opt: {
          key: string; // ✅ ここは choiceId を渡す
          label: string;
          gear?: string | null;
        }) => Promise<unknown>;
      }
    | null;

  const messages = chat?.messages ?? [];
  const loading = chat?.loading ?? false;
  const error = chat?.error ?? null;
  const sendNextStepChoice = chat?.sendNextStepChoice;
  const setDraftText = chat?.setDraftText;

  const authVal = (typeof useAuth === 'function' ? useAuth() : {}) as {
    userCode?: string | null;
  };

  const { userCode } = authVal || {};
  const { user } = useCurrentUser({ userCode: userCode ?? undefined });
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  const first = React.useRef(true);

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
    const container = listRef.current;
    if (!container) return;

    container.scrollTo({
      top: container.scrollHeight,
      behavior,
    });
  };

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

    // 送信後も返答後も、常に下端へだけ追尾する
    scrollToBottom('smooth');
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
        const iconSrc = isUser ? resolveUserAvatar(m) : '/iros.png';

// ★ メタを本文から隠す：toSafeString → stripIrosMetaHeader → stripNextStepTags → transform
const rawText = stripIrosMetaHeader(toSafeString(m.text));
const displayText = stripNextStepTagsForDisplay(rawText);

// ✅ Markdown は “潰さない” で ChatMarkdown に渡す（整形は ChatMarkdown 側でやる）
let safeText = transformIrTemplateToMarkdown(displayText);

// ▼ ir診断ガイドを装飾分離（HTML使わない版）
// ▼ ir診断ガイドを装飾分離（HTML使わない版）
if (m.meta?.presentationKind === 'diagnosis') {
  const guideMatch = safeText.match(/（詳しく内容を分析するには.*?）。?/);

  if (guideMatch) {
    const guide = guideMatch[0];
    const main = safeText.replace(guide, '').trim();

    safeText = `
${main}

──────────────
🪔 ${guide.replace(/[（）]/g, '')}
`;
  }
}

const diagnosisSummary =
  !isUser && m.meta?.presentationKind === 'diagnosis'
    ? extractDiagnosisSummary(safeText)
    : '';

        // ✅ UIモード（SILENCE判定）: serverの meta.extra.uiMode を最優先で拾う
        const uiMode =
          (m.meta?.extra?.uiMode as string | undefined) ??
          ((m.meta as any)?.uiMode as string | undefined) ??
          null;

        const isSilence = !isUser && uiMode === 'SILENCE';

        console.log('[IROS UI][MessageList]', {
          id: m.id,
          role: m.role,
          textType: typeof m.text,
          textRaw: m.text,
          toSafeString: toSafeString(m.text),
          rawText,
          displayText,
          safeText,
          uiMode,
          isSilence,
          presentationKind_top: (m.meta as any)?.presentationKind ?? null,
          presentationKind_extra: (m.meta as any)?.extra?.presentationKind ?? null,
          mode_top: (m.meta as any)?.mode ?? null,
          mode_extra: (m.meta as any)?.extra?.mode ?? null,
          metaKeys:
            m.meta && typeof m.meta === 'object' ? Object.keys(m.meta as any) : [],
          metaExtraKeys:
            (m.meta as any)?.extra && typeof (m.meta as any).extra === 'object'
              ? Object.keys((m.meta as any).extra)
              : [],
          nextStep: m.meta?.nextStep
            ? {
                gear: m.meta.nextStep.gear,
                optionsLen: m.meta.nextStep.options?.length ?? 0,
              }
            : null,
        });
        // ✅ 表示用Qコードは「現在Q」を優先して拾う（targetQ / goalTargetQ は表示に使わない）
        const qToShowRaw =
          (m.meta?.qCode as any) ??
          (m.meta?.q as any) ??
          (m.meta?.extra?.ctxPack?.qCode as any) ??
          (m.meta?.extra?.ctxPack?.qPrimary as any) ??
          (m.meta?.unified?.q?.current as any) ??
          ((m as any)?.q_code as any) ??
          ((m as any)?.q as any) ??
          null;

        const qToShowSafe =
          typeof qToShowRaw === 'string' && /^Q[1-5]$/.test(qToShowRaw)
            ? (qToShowRaw as 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5')
            : null;

        // ✅ 表示用 e_turn を拾う
        const eTurnToShowRaw =
          (m.meta?.extra?.e_turn as any) ??
          (m.meta?.extra?.mirror?.e_turn as any) ??
          (m.meta?.extra?.mirrorFlowV1?.mirror?.e_turn as any) ??
          (m.meta?.extra?.ctxPack?.e_turn as any) ??
          (m.meta?.extra?.ctxPack?.mirror?.e_turn as any) ??
          ((m.meta as any)?.e_turn as any) ??
          ((m as any)?.e_turn as any) ??
          null;

        const eTurnToShowSafe =
          typeof eTurnToShowRaw === 'string' && /^e[1-5]$/i.test(eTurnToShowRaw.trim())
            ? (eTurnToShowRaw.trim().toLowerCase() as 'e1' | 'e2' | 'e3' | 'e4' | 'e5')
            : null;

            function stripDiagnosisQuoteTags(text?: string) {
              if (!text) return text;

              return text
                .replace(/<<DIAGNOSIS_QUOTE>>/g, '')
                .replace(/<<\/DIAGNOSIS_QUOTE>>/g, '')
                .trim();
            }


        // ✅ 表示用 depth 候補
        // 優先順位:
        // observedStage（今ターン観測）→ depthStage（今ターン主座標）→ ctxPack → 旧depth
        const depthToShowRaw =
          ((m.meta as any)?.observedStage as any) ??
          (m.meta?.extra?.ctxPack?.observedStage as any) ??
          ((m.meta as any)?.depthStage as any) ??
          (m.meta?.extra?.ctxPack?.depthStage as any) ??
          (m.meta?.unified?.depth?.current as any) ??
          (m.meta?.depth as any) ??
          ((m as any)?.depth_stage as any) ??
          ((m as any)?.depth as any) ??
          null;

        const depthToShowSafe =
          typeof depthToShowRaw === 'string' && /^[SFRCIT]\d+$/i.test(depthToShowRaw.trim())
            ? depthToShowRaw.trim().toUpperCase()
            : null;

        // ✅ レーン / 応答タイプ
        const laneKeyToShowRaw =
          (m.meta?.extra?.expr?.laneKey as any) ??
          (m.meta?.extra?.ctxPack?.expr?.laneKey as any) ??
          (m.meta?.extra?.ctxPack?.exprLane as any) ??
          (m.meta?.extra?.exprLane as any) ??
          null;

        const flowDeltaToShowRaw =
          (m.meta?.extra?.flow?.delta as any) ??
          (m.meta?.extra?.ctxPack?.flow?.delta as any) ??
          (m.meta?.extra?.flowMirror?.delta as any) ??
          null;

        const modeToShowRaw =
          (m.meta?.mode as any) ??
          (m.meta?.extra?.mode as any) ??
          (m.meta?.unified?.mode?.current as any) ??
          ((m as any)?.mode as any) ??
          null;

        const laneKeyToShowSafe =
          typeof laneKeyToShowRaw === 'string' && laneKeyToShowRaw.trim().length > 0
            ? laneKeyToShowRaw.trim()
            : null;

        const flowDeltaToShowSafe =
          typeof flowDeltaToShowRaw === 'string' && flowDeltaToShowRaw.trim().length > 0
            ? flowDeltaToShowRaw.trim().toUpperCase()
            : null;

        const modeToShowSafe =
          typeof modeToShowRaw === 'string' && modeToShowRaw.trim().length > 0
            ? modeToShowRaw.trim()
            : null;

        const responseTypeToShow =
          laneKeyToShowSafe ??
          flowDeltaToShowSafe ??
          modeToShowSafe ??
          null;

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
                <img
                  src={iconSrc}
                  alt={isUser ? 'you' : 'iros'}
                  className={isUser ? 'avatar user' : 'avatar assistant'}
                />

                {/* Metaバッジ：Iros（assistant）のときだけ */}
                {!isUser && (
                  <IrosMetaBadge
                    eTurn={eTurnToShowSafe ?? undefined}
                    depth={depthToShowSafe}
                    responseType={responseTypeToShow}
                    mode={modeToShowSafe}
                    laneKey={laneKeyToShowSafe}
                    flowDelta={flowDeltaToShowSafe}
                  />
                )}
              </div>

              {/* 吹き出し */}
              <div
                className={`bubble ${isUser ? 'is-user' : 'is-assistant'}`}
                style={{
                  ...(isUser ? userBubbleStyle : assistantBubbleShellStyle),
                  alignSelf: isUser ? 'flex-end' : 'flex-start',
                  maxWidth:
                    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
                      ? 'min(1100px, 92%)'
                      : 'min(760px, 88%)',
                }}
              >
                {/* 本文 */}
                <div
                  className="msgBody"
                  style={{ fontSize: 14, lineHeight: 1.9, color: '#111827' }}
                >
                  {isSilence ? (
                    <div
                      className="assistant-silence"
                      style={{
                        opacity: 0.75,
                        letterSpacing: 2,
                        padding: '2px 0',
                        userSelect: 'none',
                      }}
                      aria-label="silence"
                    >
                      …
                    </div>
                  ) : (
                    <>
                      <ChatMarkdown text={safeText} />

                      {!isUser &&
                        (((m.meta as any)?.presentationKind === 'diagnosis') ||
                          ((m.meta as any)?.extra?.presentationKind === 'diagnosis')) && (
                        <div className="diagnosisFooter">
                          {diagnosisSummary ? (
                            <div style={{ marginBottom: 8 }}>
<button
  type="button"
  onClick={() => {
    const quoted = `【前回の診断まとめ（引用）】
<<DIAGNOSIS_QUOTE>>
${diagnosisSummary}
<</DIAGNOSIS_QUOTE>>`;

    setDraftText?.(quoted);
  }}
  style={{
    border: '1px solid rgba(147, 116, 255, 0.35)',
    background: 'rgba(255,255,255,0.9)',
    color: '#5b3fd1',
    borderRadius: 999,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
  }}
>
  まとめを引用
</button>
                            </div>
                          ) : null}

                          ※詳しくは、「まとめを引用」ボタンをおして入力してください。<br />
                          ※なお、何度も同じ観測対象で入力すると、結果が不安定になります。
                        </div>
                      )}
                    </>
                  )}

                  {loading && <div className={styles.loadingRow}>...</div>}
                  {error && <div className={styles.error}>{error}</div>}
                  <div ref={bottomRef} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }
