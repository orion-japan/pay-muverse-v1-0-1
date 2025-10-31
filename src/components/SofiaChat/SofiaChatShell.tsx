// src/components/SofiaChat/SofiaChatShell.tsx
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
import UserInfoBadge, { IrosQCode } from '@/ui/iroschat/components/UserInfoBadge';

/* ===== types ===== */
type CurrentUser = {
  id: string;
  name: string;
  userType: string;
  credits: number;
  avatarUrl?: string | null;
};
type IrosUserInfo = {
  id: string;
  name: string;
  q_code: IrosQCode;
  depthStage: string;
  avatarUrl?: string;
};
type Props = { agent?: string; open?: string };

const IROS_Q_CODES = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'] as const;
const isIrosQCode = (value: unknown): value is IrosQCode =>
  typeof value === 'string' && (IROS_Q_CODES as readonly string[]).includes(value as IrosQCode);

let irosUserInfoCache: IrosUserInfo | null = null;
let irosUserInfoPromise: Promise<IrosUserInfo | null> | null = null;

async function loadIrosUserInfo(): Promise<IrosUserInfo | null> {
  if (irosUserInfoCache) return irosUserInfoCache;
  if (!irosUserInfoPromise) {
    irosUserInfoPromise = (async () => {
      const endpoint = '/api/agent/iros/userinfo';
      const maxAttempts = 2;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const res = await fetch(endpoint, { cache: 'no-store' });
          if (res.ok) {
            const json = await res.json().catch(() => null);
            const id = typeof json?.id === 'string' ? json.id : '';
            const name = typeof json?.name === 'string' ? json.name.trim() : '';
            const qRaw = json?.q_code;
            const depthStage = typeof json?.depthStage === 'string' ? json.depthStage : '';
            const avatarUrl = typeof json?.avatarUrl === 'string' ? json.avatarUrl : undefined;
            if (id && name && depthStage && isIrosQCode(qRaw)) {
              const normalized: IrosUserInfo = {
                id,
                name,
                q_code: qRaw,
                depthStage,
                avatarUrl,
              };
              irosUserInfoCache = normalized;
              return normalized;
            }
            return null;
          }
          const shouldRetry = (res.status === 401 || res.status === 500) && attempt < maxAttempts;
          if (!shouldRetry) return null;
        } catch (error) {
          // ネットワーク例外は再試行せず終了
          return null;
        }
      }
      return null;
    })();
  }

  const info = await irosUserInfoPromise;
  if (!irosUserInfoCache && info) {
    irosUserInfoCache = info;
  }
  irosUserInfoPromise = null;
  return irosUserInfoCache ?? info;
}

/* ===== duplicate/over-fetch guards & utils ===== */
const fetchedOnceByConv = new Set<string>(); // 会話IDごとに初回フェッチだけ通す
const norm = (s?: string) => (s || '').replace(/\s+/g, ' ').trim();

// localStorage key（エージェント別に保管）
const lastConvKey = (agent: Agent) => `sofia:lastConv:${agent}`;

/** mTalkの共有テキスト（末尾の「mTalkからの共有…」等）を隠す */
function isMtalkShareHint(m: Message): boolean {
  const c = norm(m.content).toLowerCase();
  if (!c) return false;
  if (c.startsWith('mtalkからの共有')) return true;
  if (c.startsWith('【mtalkからの共有】')) return true;
  const origin = (m as any).origin as string | undefined;
  if (origin && origin.startsWith('mtalk_')) return true;
  const src = (m as any)?.meta?.source as string | undefined;
  const seedReply = !!(m as any)?.meta?.seed_reply;
  if (src === 'mtalk' && seedReply) return true;
  return false;
}
const notShare = (m: Message) => !isMtalkShareHint(m);

/** ほぼ同一の user/assistant 発話をマージ（seed 付き優先） */
function dedupeMessages(arr: Message[]): Message[] {
  type Key = string;
  const byKey = new Map<Key, Message>();

  for (const m of arr) {
    const kBase = `${m.role}|${norm(m.content)}`;
    const prev = byKey.get(kBase);
    if (!prev) {
      byKey.set(kBase, m);
      continue;
    }
    const t1 = new Date(prev.created_at || 0).getTime();
    const t2 = new Date(m.created_at || 0).getTime();
    const close = Math.abs(t2 - t1) <= 10_000;

    const isSeedPrev = !!(prev as any)?.meta?.seed || !!(prev as any)?.meta?.seed_reply;
    const isSeedCurr = !!(m as any)?.meta?.seed || !!(m as any)?.meta?.seed_reply;

    if (isSeedCurr && !isSeedPrev) {
      byKey.set(kBase, m);
      continue;
    }
    if (isSeedPrev && !isSeedCurr) continue;

    if (close) {
      byKey.set(kBase, t2 >= t1 ? m : prev);
    } else {
      byKey.set(`${kBase}|${t2}`, m);
    }
  }

  return Array.from(byKey.values()).sort(
    (a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime()
  );
}
/* ============================================== */

export default function SofiaChatShell({ agent: agentProp = 'mu', open }: Props) {
  const sp = useSearchParams();
  const urlAgent = (sp?.get('agent') as Agent | null) ?? null;
  const urlCid = sp?.get('cid') ?? undefined;
  const urlFrom = sp?.get('from') ?? undefined;
  const urlSummary = sp?.get('summary_hint') ?? undefined;

  const agentK = normalizeAgent(urlAgent ?? agentProp);
  const { loading: authLoading, userCode } = useAuth();
  const { inject: injectMtalkSeed } = useMtalkSeed(urlFrom, urlCid, urlSummary);

  const [conversations, setConversations] = useState<ConvListItem[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [meta, setMeta] = useState<MetaData | null>(null);

  const [uiUser, setUiUser] = useState<CurrentUser | undefined>(undefined);
  const [irosUserInfo, setIrosUserInfo] = useState<IrosUserInfo | null>(
    agentK === 'iros' ? irosUserInfoCache : null
  );

  const canUse = useMemo(() => !!userCode && !authLoading, [userCode, authLoading]);

  // === open パラメータの解釈（menu/new/cid:xxx/UUID） ===
  const openTarget = useMemo(() => {
    if (!open) return { type: null as null, cid: undefined as string | undefined };

    if (open === 'menu') return { type: 'menu' as const, cid: undefined };
    if (open === 'new') return { type: 'new' as const, cid: undefined };
    if (open.startsWith('cid:')) {
      const cid = open.slice(4);
      return { type: 'cid' as const, cid: cid || undefined };
    }
    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(open);
    if (isUUID) return { type: 'cid' as const, cid: open };

    return { type: null as null, cid: undefined };
  }, [open]);

  // === サイドバー表示用に user を整形（null なら非表示） ===
  const menuUser = useMemo(() => {
    if (!uiUser) return null;
    return {
      id: uiUser.id,
      name: uiUser.name || 'user',
      userType: uiUser.userType ?? 'member',
      credits: typeof uiUser.credits === 'number' ? uiUser.credits : 0,
    };
  }, [uiUser]);

  useEffect(() => {
    if (agentK !== 'iros') return;
    let cancelled = false;
    if (irosUserInfoCache) {
      setIrosUserInfo(irosUserInfoCache);
      return;
    }
    (async () => {
      const info = await loadIrosUserInfo();
      if (!cancelled && info) {
        setIrosUserInfo(info);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentK]);

  // ユーザー情報
  useEffect(() => {
    if (!userCode) return;

    const fallback = () =>
      setUiUser({
        id: userCode,
        name: 'user',
        userType: 'member',
        credits: 0,
        avatarUrl: null,
      });

    let cancelled = false;

    (async () => {
      try {
        const r1 = await fetch(
          `/api/userinfo?user_code=${encodeURIComponent(userCode)}`,
          { cache: 'no-store' }
        );
        if (r1.ok) {
          const d = await r1.json();
          if (cancelled) return;
          setUiUser({
            id: d?.id ?? userCode,
            name: d?.name ?? 'user',
            userType: d?.user_type ?? 'member',
            credits: Number(d?.sofia_credit ?? d?.credits ?? 0),
            avatarUrl: d?.avatar_url ?? d?.photoURL ?? null,
          });
          return;
        }
        const r2 = await fetch('/api/me', { cache: 'no-store' });
        if (r2.ok) {
          const d = await r2.json();
          if (cancelled) return;
          setUiUser({
            id: d?.id ?? userCode,
            name: d?.name ?? d?.display_name ?? 'user',
            userType: d?.user_type ?? 'member',
            credits: Number(d?.sofia_credit ?? d?.credits ?? 0),
            avatarUrl: d?.avatar_url ?? d?.photoURL ?? null,
          });
          return;
        }
        if (!cancelled) fallback();
      } catch {
        if (!cancelled) fallback();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userCode]);

  // クレジットのライブ反映
  useEffect(() => {
    const onCredit = (e: Event) => {
      const { credits } = (e as CustomEvent).detail ?? {};
      if (typeof credits === 'number') {
        setUiUser((u) => (u ? { ...u, credits } : u));
      }
    };
    window.addEventListener('sofia_credit', onCredit as EventListener);
    return () => window.removeEventListener('sofia_credit', onCredit as EventListener);
  }, []);

  // UI スタイル設定
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

  // Compose 高さを CSS 変数に反映
  const composeRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = composeRef.current;
    if (!el) return;
    const set = () =>
      document.documentElement.style.setProperty('--sof-compose-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 会話一覧
  const doList = useCallback(async () => {
    if (!userCode) return;
    const items = await listConversations(agentK, userCode, urlCid);

    // updated_at の降順に（万一サーバ未ソートでも直近が先頭）
    const sorted = [...items].sort((a, b) => {
      const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      return tb - ta;
    });
    setConversations(sorted);

    // 優先順位：openTarget.cid > urlCid > localStorage last > 先頭
    const stored = (typeof window !== 'undefined'
      ? window.localStorage.getItem(lastConvKey(agentK)) || undefined
      : undefined) as string | undefined;

    const prefer =
      (openTarget.type === 'cid' && openTarget.cid && sorted.find(i => i.id === openTarget.cid)?.id) ||
      (urlCid && sorted.find(i => i.id === urlCid)?.id) ||
      (stored && sorted.find(i => i.id === stored)?.id) ||
      sorted[0]?.id;

    if (prefer) {
      setConversationId(prefer);
      try { window.localStorage.setItem(lastConvKey(agentK), prefer); } catch {}
    }
  }, [agentK, userCode, urlCid, openTarget]);

  // メッセージ取得（force でガード無視も可能）
  const doFetchMessages = useCallback(
    async (cid: string, opts?: { force?: boolean }) => {
      if (!userCode || !cid) return;
      if (opts?.force) fetchedOnceByConv.delete(cid);
      if (!opts?.force && fetchedOnceByConv.has(cid)) return;
      fetchedOnceByConv.add(cid);

      const rows = await fetchMessages(agentK, userCode, cid);
      const seeded = injectMtalkSeed(rows, cid).filter(notShare);
      setMessages(dedupeMessages(seeded));
    },
    [agentK, userCode, injectMtalkSeed]
  );

  // 初期ロード
  useEffect(() => {
    if (!canUse) return;
    doList();
  }, [canUse, doList]);

  useEffect(() => {
    if (canUse && conversationId) {
      // 直近会話を保存
      try {
        window.localStorage.setItem(lastConvKey(agentK), conversationId);
      } catch {}
      doFetchMessages(conversationId);
    }
  }, [canUse, conversationId, doFetchMessages, agentK]);

  // open の即時反映
  useEffect(() => {
    if (!canUse) return;

    if (openTarget.type === 'menu') {
      setIsMobileMenuOpen(true);
      return;
    }
    if (openTarget.type === 'new') {
      setConversationId(undefined);
      setMessages([]);
      setMeta(null);
      try { window.localStorage.removeItem(lastConvKey(agentK)); } catch {}
      return;
    }
    if (openTarget.type === 'cid' && openTarget.cid) {
      setConversationId(openTarget.cid);
      doFetchMessages(openTarget.cid, { force: true });
    }
  }, [canUse, openTarget, doFetchMessages, agentK]);

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

      try { console.info('[handleSend] sendText result:', res); } catch {}

      const nextConvId = res.conversationId ?? conversationId;
      if (nextConvId && nextConvId !== conversationId) {
        setConversationId(nextConvId);
        try { window.localStorage.setItem(lastConvKey(agentK), nextConvId); } catch {}
      }

      // 1) rows 優先（空配列なら何もしない）
      if (Array.isArray(res.rows) && res.rows.length > 0) {
        setMessages((prev) => {
          const merged: Message[] = [
            ...prev.filter((m) => !res.rows!.some((r) => r.id && r.id === m.id)),
            ...res.rows!,
          ].filter(notShare);

          const hasSeed = res.rows!.some((r) => r.meta?.seed || r.meta?.seed_reply);
          const maybeSeeded =
            agentK === 'mirra' && !hasSeed ? injectMtalkSeed(merged, nextConvId!) : merged;

          return dedupeMessages(maybeSeeded);
        });
      } else {
        // 2) replyText があれば追加
        const replyTextSafe =
          typeof res.replyText === 'number'
            ? String(res.replyText)
            : typeof res.replyText === 'string'
            ? res.replyText
            : '';

        if (replyTextSafe && replyTextSafe.trim() !== '') {
          setMessages((prev) => {
            const reply: Message = {
              id: crypto.randomUUID?.() ?? `a-${Date.now()}`,
              role: 'assistant',
              content: replyTextSafe,
              created_at: new Date().toISOString(),
              agent: agentK,
              ...(res.meta ? { meta: res.meta as any } : {}),
            };
            const arr: Message[] = [...prev, reply];
            const cleaned: Message[] = arr.filter(notShare as (m: Message) => boolean);
            return dedupeMessages(cleaned);
          });
        } else if (nextConvId) {
          // 3) rows も replyText も無い → 保存済み想定で強制再取得
          await doFetchMessages(nextConvId, { force: true });
        }
      }

      // 4) クレジット更新イベント
      if (typeof res.credit === 'number') {
        try {
          window.dispatchEvent(
            new CustomEvent('sofia_credit', { detail: { credits: res.credit } })
          );
        } catch {}
      }
      // 🟢 ここを追加：送信後に上方向スクロール（GPT風の動き）
      window.dispatchEvent(new CustomEvent('sof:scrollUp'));
    },
    [agentK, userCode, conversationId, messages, injectMtalkSeed, doFetchMessages]
  );

  // 削除 / 改名
  const handleDelete = useCallback(
    async (id: string) => {
      const key = lastConvKey(agentK);
  
      // 1) 正攻法の削除（agentClients が master/uuid を判定）
      try {
        await deleteConversation(agentK, id);
      } catch (e) {
        console.warn('[delete] failed:', e);
        // 失敗してもUIをサーバー真実と再同期する
      }
  
      // 2) サーバーの最新一覧で同期
      let rows: ConvListItem[] = [];
      try {
        rows = await listConversations(agentK, String(userCode || ''));
      } catch (e) {
        console.warn('[delete] list after delete failed:', e);
      }
      rows.sort((a, b) => {
        const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return tb - ta;
      });
      setConversations(rows);
  
      // 3) 選択と localStorage を調整
      const stillExists = rows.some((c) => c.id === conversationId);
      const next = stillExists ? conversationId : rows.find((c) => c.id !== id)?.id;
      setConversationId(next);
      if (next) {
        try { window.localStorage.setItem(key, next); } catch {}
        await doFetchMessages(next, { force: true });
      } else {
        setMessages([]);
        try { window.localStorage.removeItem(key); } catch {}
      }
    },
    [agentK, conversationId, userCode, doFetchMessages]
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
            try { window.localStorage.removeItem(lastConvKey(agentK)); } catch {}
          }}
          userInfoBadge={
            agentK === 'iros' && irosUserInfo ? (
              <UserInfoBadge name={irosUserInfo.name} q={irosUserInfo.q_code} />
            ) : undefined
          }
        />
      </div>

      <div
        className="sof-top-spacer"
        style={{ height: 'calc(var(--sof-header-h, 56px) + 12px)' }}
        aria-hidden
      />

      {authLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
          読み込み中…
        </div>
      ) : !userCode ? (
        <div style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
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
              try { window.localStorage.setItem(lastConvKey(agentK), id); } catch {}
            }}
            onDelete={handleDelete}
            onRename={handleRename}
            userInfo={menuUser}
            meta={meta as any}
            mirraHistory={agentK === 'mirra' ? conversations : (undefined as any)}
          />

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
