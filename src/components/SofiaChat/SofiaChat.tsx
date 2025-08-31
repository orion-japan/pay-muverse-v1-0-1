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
import '@/components/SofiaChat/SofiaChat.css';
import './ChatInput.css';

import SidebarMobile from './SidebarMobile';
import Header from './header';
import MessageList from './MessageList';
import ChatInput from './ChatInput';

import { MetaPanel, type MetaData } from '@/components/SofiaChat/MetaPanel';

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
  return {
    qcodes: asArray(m.qcodes).map((q: any) =>
      typeof q === 'string'
        ? { code: q }
        : { code: String(q?.code ?? q), score: typeof q?.score === 'number' ? q.score : undefined }
    ),
    layers: asArray(m.layers).map((l: any) =>
      typeof l === 'string'
        ? { layer: l }
        : { layer: String(l?.layer ?? l), score: typeof l?.score === 'number' ? l.score : undefined }
    ),
    used_knowledge: asArray(m.used_knowledge).map((k: any) => ({
      id: String(k?.id ?? `${k?.key ?? 'K'}-${Math.random().toString(36).slice(2, 7)}`),
      key: String(k?.key ?? 'K'),
      title: (k?.title ?? null) as string | null,
    })),
    stochastic: m.stochastic ?? null,
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

  /* ===== 高さを CSS 変数(:root)へ反映 ===== */
  const composeRef = useRef<HTMLDivElement>(null);
  const metaDockRef = useRef<HTMLDivElement>(null);

  // 入力バーの高さ -> --compose-height（:root）
  useLayoutEffect(() => {
    const el = composeRef.current;
    if (!el) return;
    const set = () => {
      document.documentElement.style.setProperty('--compose-height', `${el.offsetHeight}px`);
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Metaドックの高さ -> --meta-height（:root）
  useLayoutEffect(() => {
    const m = metaDockRef.current;
    if (!m) return;
    const apply = () => {
      document.documentElement.style.setProperty('--meta-height', `${m.offsetHeight || 0}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(m);
    return () => ro.disconnect();
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
        title:
          row.title ??
          (row.updated_at ? `会話 (${new Date(row.updated_at).toLocaleString()})` : '新しい会話'),
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
        `/api/sofia?user_code=${encodeURIComponent(userCode)}&conversation_code=${encodeURIComponent(
          convId
        )}`
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
      id: globalThis.crypto?.randomUUID?.() ?? `tmp-${Date.now()}`,
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
            id: globalThis.crypto?.randomUUID?.() ?? `a-${Date.now()}`,
            role: 'assistant',
            content: js.reply as string,
            created_at: new Date().toISOString(),
          },
        ]);
      }
      if (js.meta) setMeta(normalizeMeta(js.meta));

      fetchConversations();
    } catch (e) {
      console.error('[SofiaChat] send error:', e);
      setMessages((prev) => [
        ...prev,
        {
          id: globalThis.crypto?.randomUUID?.() ?? `e-${Date.now()}`,
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
    <>
      <div className="sof-header-fixed">
        <Header
          title="会話履歴"
          isMobile
          onShowSideBar={() => setIsMobileMenuOpen(true)}
          onCreateNewChat={handleNewChat}
        />
      </div>

      <SidebarMobile
        isOpen={isMobileMenuOpen}
        onClose={() => setIsMobileMenuOpen(false)}
        conversations={conversations}
        onSelect={handleSelectConversation}
        onDelete={() => {}}
        onRename={() => {}}
        userInfo={{ id: userCode, name: userCode, userType: 'member', credits: 0 }}
      />

      <MessageList messages={messages} />
      <div ref={endRef} />

      <div className="sof-meta-dock" ref={metaDockRef}>
        <MetaPanel meta={meta} />
      </div>

      <div className="sof-compose-dock" ref={composeRef}>
        <ChatInput onSend={handleSend} onPreview={() => {}} onCancelPreview={() => {}} />
      </div>

      {/* 入力BOX〜画面下を白で覆う“下敷き”（入力欄の上でメッセージを確実に隠す） */}
      <div className="sof-underlay" aria-hidden />

      <div className="sof-footer-spacer" />
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  center: { display: 'grid', placeItems: 'center', minHeight: '60vh' },
};
