// src/components/SofiaChat/SofiaChat.tsx
'use client';

import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
  useCallback,
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
import type { MetaData } from '@/components/SofiaChat/MetaPanel';

/* ========= types ========= */
type Role = 'user' | 'assistant';
export type Message = {
  id: string;
  role: Role;
  content: string;
  created_at?: string;
  isPreview?: boolean;
  // uploaded_image_urls は既存実装で使われることがあるので any セーフティで受ける
  // uploaded_image_urls?: string[];
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

  return { qcodes, layers, used_knowledge, stochastic: indicator };
};

export default function SofiaChat() {
  const { loading: authLoading, userCode, planStatus } = useAuth();

  /* ========= states ========= */
  const [conversations, setConversations] = useState<ConvListItem[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [meta, setMeta] = useState<MetaData | null>(null);

  // ✅ Sidebar/MessageList 表示用：ユーザーの実値
  const [uiUser, setUiUser] = useState<{
    id: string;
    name: string;
    userType: string;
    credits: number;
    avatarUrl?: string | null;
  } | null>(null);

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
  const handleSend = async (input: string, _files: File[] | null = null): Promise<void> => {
    const text = (input ?? '').trim();
    if (!text || !userCode) return;

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

  /* ===== サイドバー：リネーム / 削除 (API接続) ===== */
  const handleRename = useCallback(async (id: string, newTitle: string) => {
    try {
      const r = await fetchWithIdToken(`/api/conv/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j?.error ?? 'リネームに失敗しました');
        return;
      }
      setConversations((xs) => xs.map((x) => (x.id === id ? { ...x, title: newTitle } : x)));
    } catch (e) {
      console.error('[SofiaChat] rename error:', e);
      alert('リネームに失敗しました');
    }
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm('この会話を削除します。よろしいですか？')) return;
      try {
        const r = await fetchWithIdToken(`/api/conv/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          alert(j?.error ?? '削除に失敗しました');
          return;
        }
        setConversations((xs) => xs.filter((x) => x.id !== id));
        if (conversationId === id) handleNewChat();
      } catch (e) {
        console.error('[SofiaChat] delete error:', e);
        alert('削除に失敗しました');
      }
    },
    [conversationId]
  );

  /* ===== Name/Type/Credits クリック（受け取り→トースト） ===== */
  useEffect(() => {
    const showToast = (msg: string) => {
      const id = 'sof-toast';
      document.getElementById(id)?.remove();
      const el = document.createElement('div');
      el.id = id;
      el.style.cssText =
        'position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom));transform:translateX(-50%);' +
        'background:rgba(0,0,0,.78);color:#fff;padding:8px 12px;border-radius:10px;font-size:13px;' +
        'z-index:2147483647;box-shadow:0 6px 16px rgba(0,0,0,.18)';
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 1800);
    };

    const onName = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      showToast(`Username: ${d.name ?? d.id ?? ''}`);
    };
    const onType = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      showToast(`Type: ${d.userType ?? ''}`);
    };
    const onCredit = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      showToast(`Credits: ${d.credits ?? 0}`);
    };

    window.addEventListener('click_username', onName as EventListener);
    window.addEventListener('click_type', onType as EventListener);
    window.addEventListener('sofia_credit', onCredit as EventListener);

    return () => {
      window.removeEventListener('click_username', onName as EventListener);
      window.removeEventListener('click_type', onType as EventListener);
      window.removeEventListener('sofia_credit', onCredit as EventListener);
    };
  }, []);

  /* ===== 実ユーザー情報の取得（get-user-info） ===== */
  useEffect(() => {
    if (!userCode) return;
    (async () => {
      try {
        const r = await fetchWithIdToken('/api/get-user-info', { cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          setUiUser({
            id: j.user_code ?? userCode,
            name: j.click_username ?? j.user_code ?? userCode,
            userType: String(j.click_type ?? 'free'),
            credits: Number(j.sofia_credit ?? 0) || 0,
            avatarUrl: j.avatar_url ?? '/avatar.png', // ← フォールバック統一
          });
        } else {
          setUiUser({
            id: userCode,
            name: userCode,
            userType: 'free',
            credits: 0,
            avatarUrl: '/avatar.png',
          });
        }
      } catch {
        setUiUser({
          id: userCode,
          name: userCode,
          userType: 'free',
          credits: 0,
          avatarUrl: '/avatar.png',
        });
      }
    })();
  }, [userCode]);

  /* ========= guard ========= */
  if (authLoading) return <div style={styles.center}>読み込み中…</div>;
  if (!userCode) return <div style={styles.center}>ログインが必要です</div>;

  /* ========= render ========= */
  return (
    <div className="sofia-container sof-center">
      <div className="sof-header-fixed">
        <Header
          title="iros_AI"
          isMobile
          onShowSideBar={() => setIsMobileMenuOpen(true)}
          onCreateNewChat={handleNewChat}
        />
      </div>

      <div className="sof-top-spacer" style={{ height: 'calc(var(--sof-header-h, 56px) + 12px)' }} aria-hidden />

      <SidebarMobile
        isOpen={isMobileMenuOpen}
        onClose={() => setIsMobileMenuOpen(false)}
        conversations={conversations}
        onSelect={handleSelectConversation}
        onDelete={handleDelete}
        onRename={handleRename}
        userInfo={
          uiUser ?? {
            id: userCode,
            name: userCode,
            userType: 'free',
            credits: 0,
          }
        }
        meta={meta}
      />

      {/* ✅ ユーザー表示用に currentUser を渡す */}
      <MessageList messages={messages} currentUser={uiUser ?? undefined} />

      <div ref={endRef} />

      <div className="sof-compose-dock" ref={composeRef}>
        <ChatInput onSend={(text) => handleSend(text, null)} />
      </div>

      <div className="sof-underlay" aria-hidden />
      <div className="sof-footer-spacer" />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  center: { display: 'grid', placeItems: 'center', minHeight: '60vh' },
};
