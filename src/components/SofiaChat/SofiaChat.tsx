// src/components/SofiaChat/SofiaChat.tsx
'use client';

import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
} from 'react';
import { useAuth } from '@/context/AuthContext';
import { fetchWithIdToken } from '@/lib/fetchWithIdToken';
import { SOFIA_CONFIG } from '@/lib/sofia/config';

import '@/components/SofiaChat/SofiaChat.css';
import './ChatInput.css';
import './SofiaResonance.css';

import SidebarMobile from './SidebarMobile';
import Header from './header';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import type { MetaData } from '@/components/SofiaChat/MetaPanel';  // ← 型だけ残す

/* ========= types ========= */
type Role = 'user' | 'assistant';
export type Message = {
  id: string;
  role: Role;
  content: string;
  created_at?: string;
  isPreview?: boolean;
};

type ConvListItem = {
  id: string;
  title: string;
  updated_at?: string | null;
};

type SofiaGetList = {
  items?: {
    conversation_code: string;
    title?: string | null;
    updated_at?: string | null;
    messages?: { role: Role; content: string }[];
  }[];
};
type SofiaGetMessages = { messages?: { role: Role; content: string }[] };

type SofiaPostRes = {
  conversation_code?: string;
  reply?: string;
  meta?: any;
};

/* ========= utils ========= */
const normalizeMeta = (m: any): MetaData | null => {
  if (!m) return null;
  const asArray = (v: any) => (Array.isArray(v) ? v : v ? [v] : []);

  const qcodes = asArray(m.qcodes).map((q: any) =>
    typeof q === 'string'
      ? { code: q }
      : { code: String(q?.code ?? q), score: typeof q?.score === 'number' ? q.score : undefined }
  );
  const layers = asArray(m.layers).map((l: any) =>
    typeof l === 'string'
      ? { layer: l }
      : { layer: String(l?.layer ?? l), score: typeof l?.score === 'number' ? l.score : undefined }
  );
  const used_knowledge = asArray(m.used_knowledge).map((k: any) => ({
    id: String(k?.id ?? `${k?.key ?? 'K'}-${Math.random().toString(36).slice(2, 7)}`),
    key: String(k?.key ?? 'K'),
    title: (k?.title ?? null) as string | null,
  }));

  const indicator = {
    on: typeof m.stochastic === 'boolean' ? m.stochastic : Boolean(m?.stochastic?.on),
    g: typeof m.g === 'number' ? m.g : m?.stochastic?.g ?? null,
    seed: typeof m.seed === 'number' ? m.seed : m?.stochastic?.seed ?? null,
    noiseAmp: typeof m.noiseAmp === 'number' ? m.noiseAmp : m?.stochastic?.noiseAmp ?? null,
    epsilon: m?.stochastic_params?.epsilon ?? null,
    retrNoise: m?.stochastic_params?.retrNoise ?? null,
    retrSeed: m?.stochastic_params?.retrSeed ?? null,
  };

  const resonance = {
    phase: m.phase ?? null,
    selfAcceptance: m.selfAcceptance ?? null,
    relation: m.relation ?? null,
    nextQ: m.nextQ ?? null,
    currentQ: m.currentQ ?? null,
  };

  const dialogue_trace = Array.isArray(m.dialogue_trace) ? m.dialogue_trace : null;

  return {
    qcodes,
    layers,
    used_knowledge,
    stochastic: indicator, // ← ここにまとめて渡せばOK
  };
  
};

export default function SofiaChat() {
  const { loading: authLoading, userCode } = useAuth();

  /* ========= states ========= */
  const [conversations, setConversations] = useState<ConvListItem[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [meta, setMeta] = useState<MetaData | null>(null);

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const canUse = useMemo(() => !!userCode && !authLoading, [userCode, authLoading]);

  /* ==== UI用CSS変数（env → CSS） ==== */
  useEffect(() => {
    const ui = SOFIA_CONFIG.ui;
    const r = document.documentElement;
    const set = (k: string, v?: string | number) => {
      if (v === undefined || v === null) return;
      r.style.setProperty(k, String(v));
    };
    set('--sofia-assist-fs', `${ui.assistantFontSize}px`);
    set('--sofia-assist-lh', ui.assistantLineHeight);
    set('--sofia-assist-ls', `${ui.assistantLetterSpacing}em`);
    set('--sofia-p-margin', `${ui.paragraphMargin}px`);

    set('--sofia-bubble-maxw', `${ui.bubbleMaxWidthPct}%`);
    set('--sofia-a-border', ui.assistantBorder);
    set('--sofia-a-radius', `${ui.assistantRadius}px`);
    set('--sofia-a-shadow', ui.assistantShadow);
    set('--sofia-a-bg', ui.assistantBg);
    set('--sofia-bq-border', ui.blockquoteTintBorder);
    set('--sofia-bq-bg', ui.blockquoteTintBg);

    set('--sofia-user-bg', ui.userBg);
    set('--sofia-user-fg', ui.userFg);
    set('--sofia-user-border', ui.userBorder);
    set('--sofia-user-radius', `${ui.userRadius}px`);
  }, []);

  /* ==== プレゼン用 Hotfix ==== */
  useEffect(() => {
    const css = `
    :where(.sofia-container) .sof-msgs .sof-bubble{
      border: none !important;
      background:
        radial-gradient(130% 160% at 0% -40%, rgba(203,213,225,.28), transparent 60%),
        linear-gradient(180deg, #ffffff 0%, #f6f9ff 100%) !important;
      box-shadow:
        0 1px 0 rgba(255,255,255,.65) inset,
        0 8px 24px rgba(2,6,23,.10) !important;
      border-radius: var(--sofia-a-radius, 16px) !important;
    }
    :where(.sofia-container) .sof-msgs .sof-bubble.is-assistant{
      border-bottom-left-radius: 6px !important;
      color: #0f172a !important;
    }
    :where(.sofia-container) .sof-msgs .sof-bubble.is-user{
      color: #fff !important;
      text-shadow: 0 1px 0 rgba(0,0,0,.08);
      border: none !important;
      background:
        linear-gradient(180deg, #8aa0ff 0%, #6b8cff 60%, #5979ee 100%) !important;
      box-shadow:
        0 1px 0 rgba(255,255,255,.25) inset,
        0 10px 24px rgba(107,140,255,.22) !important;
      border-bottom-right-radius: 6px !important;
    }
    .sof-underlay{ background: transparent !important; box-shadow:none !important; }
    `;
    let el = document.getElementById('sofia-hotfix') as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = 'sofia-hotfix';
      document.head.appendChild(el);
    }
    el.textContent = css;
  }, []);

  /* ==== 「送信中」オーバーレイを強制オフ ==== */
  useEffect(() => {
    let el = document.getElementById('sofia-hide-overlay') as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = 'sofia-hide-overlay';
      document.head.appendChild(el);
    }
    el.textContent = `.sof-overlay{ display:none !important; }`;
  }, []);

  /* ===== 高さ反映（Composeのみ残す） ===== */
  const composeRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = composeRef.current;
    if (!el) return;
    const set = () => {
      document.documentElement.style.setProperty('--sof-compose-h', `${el.offsetHeight}px`);
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // MetaPanelを撤去したので高さは常に0に固定
    document.body.style.setProperty('--meta-height', `0px`);
  }, []);

  /* ===== 会話一覧 ===== */
  const fetchConversations = async () => {
    if (!userCode) return;
    try {
      const r = await fetchWithIdToken(`/api/sofia?user_code=${encodeURIComponent(userCode)}`);
      if (!r.ok) throw new Error(`list ${r.status}`);
      const js: SofiaGetList = await r.json().catch(() => ({}));

      const items = (js.items ?? []).map((row) => ({
        id: row.conversation_code,
        title: row.title ?? (row.updated_at ? `会話 (${new Date(row.updated_at).toLocaleString()})` : '新しい会話'),
        updated_at: row.updated_at ?? null,
      })) as ConvListItem[];

      setConversations(items);
      if (!conversationId && items[0]?.id) setConversationId(items[0].id);
    } catch (e) {
      console.error('[SofiaChat] fetchConversations error:', e);
    }
  };

  /* ===== メッセージ ===== */
  const fetchMessages = async (convId: string) => {
    if (!userCode || !convId) return;
    try {
      const r = await fetchWithIdToken(
        `/api/sofia?user_code=${encodeURIComponent(userCode)}&conversation_code=${encodeURIComponent(convId)}`
      );
      if (!r.ok) throw new Error(`messages ${r.status}`);
      const js: SofiaGetMessages = await r.json().catch(() => ({}));
      const rows = (js.messages ?? []).map((m, i) => ({
        id: `${i}-${m.role}-${m.content.slice(0, 8)}`,
        role: m.role,
        content: m.content,
      })) as Message[];
      setMessages(rows);
    } catch (e) {
      console.error('[SofiaChat] fetchMessages error:', e);
    }
  };

  useEffect(() => {
    if (!canUse) return;
    fetchConversations();
  }, [canUse, userCode]);

  useEffect(() => {
    if (!canUse || !conversationId) return;
    fetchMessages(conversationId);
  }, [canUse, conversationId]);

  /* ===== 送信 ===== */
  const handleSend = async (input: string, _files?: File[] | null) => {
    const text = (input ?? '').trim();
    if (!text || !userCode) return {};

    const optimistic: Message = {
      id: (globalThis.crypto?.randomUUID?.() ?? `tmp-${Date.now()}`),
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const msgsForApi = [...messages, optimistic].map((m) => ({ role: m.role, content: m.content }));
      const body = {
        user_code: userCode,
        conversation_code: conversationId ?? '',
        mode: 'normal',
        vars: { debug: true, client: 'web' },
        messages: msgsForApi,
      };

      const r = await fetchWithIdToken('/api/sofia', { method: 'POST', body: JSON.stringify(body) });
      const js: SofiaPostRes = await r.json().catch(() => ({}));

      if (js.conversation_code && js.conversation_code !== conversationId) {
        setConversationId(js.conversation_code);
      }
      if (js.reply) {
        setMessages((prev) => [
          ...prev,
          {
            id: (globalThis.crypto?.randomUUID?.() ?? `a-${Date.now()}`),
            role: 'assistant',
            content: js.reply as string,
            created_at: new Date().toISOString(),
          },
        ]);
      }

      if (js.meta) {
        const m = normalizeMeta(js.meta);
        setMeta(m);
      }

      fetchConversations();
    } catch (e) {
      console.error('[SofiaChat] send error:', e);
      setMessages((prev) => [
        ...prev,
        {
          id: (globalThis.crypto?.randomUUID?.() ?? `e-${Date.now()}`),
          role: 'assistant',
          content: '（通信に失敗しました。時間をおいて再度お試しください）',
        },
      ]);
    }
    return {};
  };

  /* ===== その他 ===== */
  const handleNewChat = () => {
    setConversationId(undefined);
    setMessages([]);
    setMeta(null);
  };

  const handleSelectConversation = (id: string) => {
    setConversationId(id);
    setIsMobileMenuOpen(false);
  };

  /* ========= guard ========= */
  if (authLoading) return <div style={styles.center}>読み込み中…</div>;
  if (!userCode) return <div style={styles.center}>ログインが必要です</div>;

  /* ========= render ========= */
  return (
    <div className="sofia-container sof-center">
      <div className="sof-header-fixed">
        <Header
          title="会話履歴"
          isMobile
          onShowSideBar={() => setIsMobileMenuOpen(true)}
          onCreateNewChat={handleNewChat}
        />
      </div>

      <div
        className="sof-top-spacer"
        style={{ height: 'calc(var(--sof-header-h, 56px) + 12px)' }}
        aria-hidden
      />

      <SidebarMobile
        isOpen={isMobileMenuOpen}
        onClose={() => setIsMobileMenuOpen(false)}
        conversations={conversations}
        onSelect={handleSelectConversation}
        onDelete={() => {}}
        onRename={() => {}}
        userInfo={{ id: userCode, name: userCode, userType: 'member', credits: 0 }}
        meta={meta}
      />

      <MessageList messages={messages} />
      <div ref={endRef} />

      {/* MetaPanel は削除済み */}

      <div className="sof-compose-dock" ref={composeRef}>
        <ChatInput onSend={handleSend} onPreview={() => {}} onCancelPreview={() => {}} />
      </div>

      <div className="sof-underlay" aria-hidden />

      <div className="sof-footer-spacer" />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  center: { display: 'grid', placeItems: 'center', minHeight: '60vh' },
};
