'use client';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { SOFIA_CONFIG } from '@/lib/sofia/config';

import SidebarMobile from './SidebarMobile';
import Header from './header';
import MessageList from './MessageList';
import ChatInput from './ChatInput';

import { Agent, Message, ConvListItem, MetaData } from './types';
import {
  normalizeAgent,
  listConversations,
  fetchMessages,
  sendText,
  renameConversation,
  deleteConversation,
} from './agentClients';
import { useMtalkSeed } from './hooks/useMtalkSeed';

// ✅ 型追加
type CurrentUser = {
  id: string;
  name: string;
  userType: string;
  credits: number;
  avatarUrl?: string | null;
};

type Props = { agent?: string };

export default function SofiaChatShell({ agent: agentProp = 'mu' }: Props) {
  const sp = useSearchParams();
  const urlAgent = (sp?.get('agent') as Agent | null) ?? null;
  const urlCid = sp?.get('cid') ?? undefined;
  const urlFrom = sp?.get('from') ?? undefined;
  const urlSummary = sp?.get('summary_hint') ?? undefined;

  const agentK = normalizeAgent(urlAgent ?? agentProp);
  const { loading: authLoading, userCode } = useAuth();
  const { inject: injectMtalkSeed } = useMtalkSeed(urlFrom, urlCid, urlSummary);

  const [conversations, setConversations] = useState<ConvListItem[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(
    undefined
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [meta, setMeta] = useState<MetaData | null>(null);

  // ✅ ユーザー情報
  const [uiUser, setUiUser] = useState<CurrentUser | undefined>(undefined);

  const canUse = useMemo(
    () => !!userCode && !authLoading,
    [userCode, authLoading]
  );

  // ✅ ユーザー情報を取得
  useEffect(() => {
    if (!userCode) return;

    (async () => {
      try {
        const res = await fetch('/api/me', { cache: 'no-store' });
        const d = res.ok ? await res.json() : null;

        setUiUser({
          id: d?.id ?? userCode,
          name: d?.name ?? d?.display_name ?? 'user',
          userType: d?.user_type ?? 'member',
          credits: typeof d?.credits === 'number' ? d.credits : 0,
          avatarUrl: d?.avatar_url ?? d?.photoURL ?? null,
        });
      } catch {
        setUiUser({
          id: userCode,
          name: 'user',
          userType: 'member',
          credits: 0,
          avatarUrl: null,
        });
      }
    })();
  }, [userCode]);

  // UI vars
  useEffect(() => {
    const ui = SOFIA_CONFIG.ui;
    const r = document.documentElement;
    const set = (k: string, v?: string | number) => {
      if (v == null) return;
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

  // Compose 高さ → CSS 変数
  const composeRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = composeRef.current;
    if (!el) return;
    const set = () =>
      document.documentElement.style.setProperty(
        '--sof-compose-h',
        `${el.offsetHeight}px`
      );
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 会話一覧
  const doList = useCallback(async () => {
    if (!userCode) return;
    const items = await listConversations(agentK, userCode, urlCid);
    setConversations(items);
    const prefer =
      (urlCid && items.find((i) => i.id === urlCid)?.id) || items[0]?.id;
    if (prefer) setConversationId(prefer);
  }, [agentK, userCode, urlCid]);

  // メッセージ取得
  const doFetchMessages = useCallback(
    async (cid: string) => {
      if (!userCode || !cid) return;
      const rows = await fetchMessages(agentK, userCode, cid);
      setMessages(injectMtalkSeed(rows, cid));
    },
    [agentK, userCode, injectMtalkSeed]
  );

  // 初期ロード
  useEffect(() => {
    if (canUse) doList();
  }, [canUse, doList]);
  useEffect(() => {
    if (canUse && conversationId) doFetchMessages(conversationId);
  }, [canUse, conversationId, doFetchMessages]);

  // 送信
  const handleSend = useCallback(
    async (input: string) => {
      const text = (input ?? '').trim();
      if (!text || !userCode) return;

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID?.() ?? `tmp-${Date.now()}`,
          role: 'user',
          content: text,
          created_at: new Date().toISOString(),
          isPreview: true,
        },
      ]);

      const res = await sendText(agentK, {
        userCode,
        conversationId,
        messagesSoFar: messages,
        text,
      });
      const nextConvId = res.conversationId ?? conversationId;
      if (nextConvId && nextConvId !== conversationId)
        setConversationId(nextConvId);

      if (res.rows && res.rows.length) {
        setMessages(injectMtalkSeed(res.rows, nextConvId));
      } else if (res.replyText) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID?.() ?? `a-${Date.now()}`,
            role: 'assistant',
            content: res.replyText,
            created_at: new Date().toISOString(),
            agent: agentK,
            ...(res.meta ? { meta: res.meta } : {}),
          },
        ]);
      }
      if (typeof res.credit === 'number') {
        try {
          window.dispatchEvent(
            new CustomEvent('sofia_credit', { detail: { credits: res.credit } })
          );
        } catch {}
      }
    },
    [agentK, userCode, conversationId, messages, injectMtalkSeed]
  );

  // 削除/改名
  const handleDelete = useCallback(
    async (id: string) => {
      await deleteConversation(agentK, id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === conversationId) {
        const rest = conversations.filter((c) => c.id !== id);
        setConversationId(rest[0]?.id);
        if (!rest[0]) setMessages([]);
      }
    },
    [agentK, conversationId, conversations]
  );

  const handleRename = useCallback(
    async (id: string, title: string) => {
      await renameConversation(agentK, id, title.trim());
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title: title.trim() } : c))
      );
    },
    [agentK]
  );

  return (
    <div className="sofia-container sof-center">
      <div className="sof-header-fixed">
        <Header
          agent={agentK}
          isMobile
          onShowSideBar={() => setIsMobileMenuOpen(true)}
          onCreateNewChat={() => {
            setConversationId(undefined);
            setMessages([]);
            setMeta(null);
          }}
        />
      </div>

      <div
        className="sof-top-spacer"
        style={{ height: 'calc(var(--sof-header-h, 56px) + 12px)' }}
        aria-hidden
      />

      {authLoading ? (
        <div
          style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}
        >
          読み込み中…
        </div>
      ) : !userCode ? (
        <div
          style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}
        >
          ログインが必要です
        </div>
      ) : (
        <>
          <SidebarMobile
            agent={agentK}
            isOpen={isMobileMenuOpen}
            onClose={() => setIsMobileMenuOpen(false)}
            conversations={conversations}
            onSelect={(id) => {
              setConversationId(id);
              setIsMobileMenuOpen(false);
            }}
            onDelete={handleDelete}
            onRename={handleRename}
            userInfo={null as any}
            meta={meta as any}
            mirraHistory={agentK === 'mirra' ? conversations : (undefined as any)}
          />

          {/* ✅ currentUser を渡す */}
          <MessageList messages={messages} currentUser={uiUser} agent={agentK} />

          <div className="sof-compose-dock" ref={composeRef}>
            <ChatInput onSend={(t) => handleSend(t)} />
          </div>
        </>
      )}

      <div className="sof-underlay" aria-hidden />
      <div className="sof-footer-spacer" />
    </div>
  );
}
