// src/components/SofiaChat/SofiaChatShell.tsx
'use client';

import React, { useEffect, useMemo, useRef, useState, useLayoutEffect, useCallback } from 'react';
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
import type { MetaData } from '@/components/SofiaChat/MetaPanel';

type Role = 'user' | 'assistant';
export type Message = { id: string; role: Role; content: string; created_at?: string; isPreview?: boolean };

type ConvListItem = { id: string; title: string; updated_at?: string | null };
type SofiaGetList = { items?: { conversation_code: string; title?: string | null; updated_at?: string | null }[] };
type SofiaGetMessages = { messages?: { role: Role; content: string }[] };
type SofiaPostRes = { conversation_code?: string; reply?: string; meta?: any };

type Props = {
  agent: 'mu' | 'iros';
  title?: string; // Header表示
};

const normalizeMeta = (m: any): MetaData | null => {
  if (!m) return null;
  const asArray = (v: any) => (Array.isArray(v) ? v : v ? [v] : []);
  const qcodes = asArray(m.qcodes).map((q: any) =>
    typeof q === 'string' ? { code: q } : { code: String(q?.code ?? q), score: typeof q?.score === 'number' ? q.score : undefined }
  );
  const layers = asArray(m.layers).map((l: any) =>
    typeof l === 'string' ? { layer: l } : { layer: String(l?.layer ?? l), score: typeof l?.score === 'number' ? l.score : undefined }
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
  return { qcodes, layers, used_knowledge, stochastic: indicator };
};

export default function SofiaChatShell({ agent, title }: Props) {
  const { loading: authLoading, userCode } = useAuth();

  const [conversations, setConversations] = useState<ConvListItem[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [meta, setMeta] = useState<MetaData | null>(null);
  const [uiUser, setUiUser] = useState<{ id: string; name: string; userType: string; credits: number; avatarUrl?: string | null } | null>(null);

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const canUse = useMemo(() => !!userCode && !authLoading, [userCode, authLoading]);

  // ===== UI変数（元のIros UIそのまま） =====
  useEffect(() => {
    const ui = SOFIA_CONFIG.ui;
    const r = document.documentElement;
    const set = (k: string, v?: string | number) => { if (v != null) r.style.setProperty(k, String(v)); };
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

  // ===== 見た目Hotfix（元のIros UIそのまま） =====
  useEffect(() => {
    const css = `
    :where(.sofia-container) .sof-msgs .sof-bubble{
      border: none !important;
      background:
        radial-gradient(130% 160% at 0% -40%, rgba(203,213,225,.28), transparent 60%),
        linear-gradient(180deg, #ffffff 0%, #f6f9ff 100%) !important;
      box-shadow: 0 1px 0 rgba(255,255,255,.65) inset, 0 8px 24px rgba(2,6,23,.10) !important;
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
      background: linear-gradient(180deg, #8aa0ff 0%, #6b8cff 60%, #5979ee 100%) !important;
      box-shadow: 0 1px 0 rgba(255,255,255,.25) inset, 0 10px 24px rgba(107,140,255,.22) !important;
      border-bottom-right-radius: 6px !important;
    }
    .sof-underlay{ background: transparent !important; box-shadow:none !important; }
    `;
    let el = document.getElementById('sofia-hotfix') as HTMLStyleElement | null;
    if (!el) { el = document.createElement('style'); el.id = 'sofia-hotfix'; document.head.appendChild(el); }
    el.textContent = css;
  }, []);

  // ===== Composeの高さ反映 =====
  const composeRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = composeRef.current; if (!el) return;
    const set = () => document.documentElement.style.setProperty('--sof-compose-h', `${el.offsetHeight}px`);
    set(); const ro = new ResizeObserver(set); ro.observe(el); return () => ro.disconnect();
  }, []);

  useEffect(() => { document.body.style.setProperty('--meta-height', `0px`); }, []);

  // ===== 会話一覧（必要なら既存sofia API流用） =====
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
    } catch (e) { console.error('[SofiaChat] fetchConversations error:', e); }
  };

  const fetchMessages = async (convId: string) => {
    if (!userCode || !convId) return;
    try {
      const r = await fetchWithIdToken(`/api/sofia?user_code=${encodeURIComponent(userCode)}&conversation_code=${encodeURIComponent(convId)}`);
      if (!r.ok) throw new Error(`messages ${r.status}`);
      const js: SofiaGetMessages = await r.json().catch(() => ({}));
      const rows = (js.messages ?? []).map((m, i) => ({ id: `${i}-${m.role}-${m.content.slice(0, 8)}`, role: m.role, content: m.content })) as Message[];
      setMessages(rows);
    } catch (e) { console.error('[SofiaChat] fetchMessages error:', e); }
  };

  useEffect(() => { if (canUse) fetchConversations(); }, [canUse, userCode]);
  useEffect(() => { if (canUse && conversationId) fetchMessages(conversationId); }, [canUse, conversationId]);

  // ===== 送信：agentに応じて mu/iros を切替 =====
  const handleSend = async (input: string): Promise<void> => {
    const text = (input ?? '').trim();
    if (!text || !userCode) return;

    const optimistic: Message = { id: (crypto?.randomUUID?.() ?? `tmp-${Date.now()}`), role: 'user', content: text, created_at: new Date().toISOString() };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const body = { message: text, mode: agent === 'iros' ? 'iros' : 'mu', conversation_id: conversationId ?? undefined };
      const r = await fetchWithIdToken('/api/agent/muai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const js: any = await r.json().catch(() => ({}));

      if (js?.conversation_id && js.conversation_id !== conversationId) {
        setConversationId(js.conversation_id);
        setConversations((prev) =>
          prev.some((x) => x.id === js.conversation_id) ? prev : [{ id: js.conversation_id, title: agent === 'iros' ? 'Iros 会話' : 'Mu 会話', updated_at: new Date().toISOString() }, ...prev]
        );
      }

      if (typeof js?.reply === 'string') {
        const agentLabel = agent === 'iros' ? 'Iros' : 'MuAI';
        setMessages((prev) => [
          ...prev,
          {
            id: js?.sub_id ?? (crypto?.randomUUID?.() ?? `a-${Date.now()}`),
            role: 'assistant',
            content: js.reply,
            created_at: new Date().toISOString(),
            ...(js?.used_credits != null ? { used_credits: js.used_credits } : {}),
            ...(js?.status ? { status: js.status } : {}),
            ...(js?.meta ? { meta: { ...js.meta, mode: agent } } : { meta: { mode: agent } }),
            ...(js?.conversation_id ? { conversation_id: js.conversation_id } : {}),
            ...(js?.sub_id ? { sub_id: js.sub_id } : {}),
            agent: agentLabel,
          } as any,
        ]);
      }

      if (js?.meta) {
        const m = normalizeMeta(js.meta);
        if (m) setMeta(m);
      }

      if (js?.warning) {
        const warn = js.warning === 'NO_BALANCE' ? '残高が不足しています。返信は返しましたが、チャージをご確認ください。' : '残りクレジットが少なくなっています。';
        try { window.dispatchEvent(new CustomEvent('toast', { detail: { kind: 'warn', msg: warn } })); } catch {}
      }
    } catch (e) {
      console.error('[SofiaChat] send error:', e);
      setMessages((prev) => [...prev, { id: (crypto?.randomUUID?.() ?? `e-${Date.now()}`), role: 'assistant', content: '（通信に失敗しました。時間をおいて再度お試しください）' }]);
    }
  };

  // ===== その他 =====
  const handleNewChat = () => { setConversationId(undefined); setMessages([]); setMeta(null); };
  const handleSelectConversation = (id: string) => { setConversationId(id); setIsMobileMenuOpen(false); };

  const handleRename = useCallback(async (id: string, newTitle: string) => {
    try {
      const r = await fetchWithIdToken(`/api/conv/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newTitle }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j?.error ?? 'リネームに失敗しました'); return; }
      setConversations((xs) => xs.map((x) => (x.id === id ? { ...x, title: newTitle } : x)));
    } catch { console.error('[SofiaChat] rename error'); alert('リネームに失敗しました'); }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('この会話を削除します。よろしいですか？')) return;
    try {
      const r = await fetchWithIdToken(`/api/conv/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j?.error ?? '削除に失敗しました'); return; }
      setConversations((xs) => xs.filter((x) => x.id !== id)); if (conversationId === id) handleNewChat();
    } catch { console.error('[SofiaChat] delete error'); alert('削除に失敗しました'); }
  }, [conversationId]);

  // ===== ユーザー情報（表示用） =====
  useEffect(() => {
    if (!userCode) return;
    (async () => {
      try {
        const r = await fetchWithIdToken('/api/get-user-info', { cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        if (r.ok) setUiUser({ id: j.user_code ?? userCode, name: j.click_username ?? j.user_code ?? userCode, userType: String(j.click_type ?? 'free'), credits: Number(j.sofia_credit ?? 0) || 0, avatarUrl: j.avatar_url ?? '/avatar.png' });
        else setUiUser({ id: userCode, name: userCode, userType: 'free', credits: 0, avatarUrl: '/avatar.png' });
      } catch { setUiUser({ id: userCode, name: userCode, userType: 'free', credits: 0, avatarUrl: '/avatar.png' }); }
    })();
  }, [userCode]);

// ★ ここから置き換え
return (
    <div className="sofia-container sof-center">
      {/* ヘッダーは常に先に描画（チラつき防止） */}
      <div className="sof-header-fixed">
        <Header
          agent={agent}
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
  
      {/* 本文だけを状態で出し分け */}
      {authLoading ? (
        <div style={styles.center}>読み込み中…</div>
      ) : !userCode ? (
        <div style={styles.center}>ログインが必要です</div>
      ) : (
        <>
          <SidebarMobile
            isOpen={isMobileMenuOpen}
            onClose={() => setIsMobileMenuOpen(false)}
            conversations={conversations}
            onSelect={handleSelectConversation}
            onDelete={handleDelete}
            onRename={handleRename}
            userInfo={uiUser ?? { id: userCode, name: userCode, userType: 'free', credits: 0 }}
            meta={meta}
          />
  
          <MessageList messages={messages} currentUser={uiUser ?? undefined} />
          <div ref={endRef} />
  
          <div className="sof-compose-dock" ref={composeRef}>
            <ChatInput onSend={(text) => handleSend(text)} />
          </div>
        </>
      )}
  
      <div className="sof-underlay" aria-hidden />
      <div className="sof-footer-spacer" />
    </div>
  );
  // ★ ここまで
  
}

const styles: Record<string, React.CSSProperties> = {
  center: { display: 'grid', placeItems: 'center', minHeight: '60vh' },
};
