'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { getAuth } from 'firebase/auth';
import { X, Trash, Edit, ChevronDown, ChevronUp } from 'lucide-react';
import styles from './IrosSidebarMobile.module.css';
import { MetaPanel, type MetaData } from '@/ui/iroschat/components/MetaPanel';

interface UserInfo {
  id: string;
  name: string;
  userType: string;
  credits: number;
}
interface Conversation {
  id: string;
  title: string;
  updated_at?: string | null;
}
type MirraHistoryItem = any;
type LogItem = { role: 'user' | 'assistant'; content: string; at: string };

interface SidebarMobileProps {
  conversations: Conversation[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  isOpen: boolean;
  onClose: () => void;
  userInfo: UserInfo | null;
  meta?: MetaData | null;
  mirraHistory?: MirraHistoryItem[] | null;
  agent?: 'mu' | 'iros' | 'mirra';
  logs?: LogItem[] | null;
}

const TAG = '[IROS/Sidebar]';
const PORTAL_HOST_ID = 'modal-root';
const DRAWER_ROOT_ID = 'sof-sidebar-mobile';

// ✅ タイポ修正（余分な `]` を削除）
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

const cx = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(' ');

const SidebarMobile: React.FC<SidebarMobileProps> = ({
  conversations,
  onSelect,
  onDelete,
  onRename,
  isOpen,
  onClose,
  userInfo,
  meta,
  mirraHistory,
  agent = 'iros',
  logs = null,
}) => {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const [portalElement, setPortalElement] = React.useState<HTMLElement | null>(null);
  const drawerRef = React.useRef<HTMLElement | null>(null);
  const previousActiveElementRef = React.useRef<HTMLElement | null>(null);
  const wasOpenRef = React.useRef<boolean>(isOpen);

  const [metaOpen, setMetaOpen] = React.useState(false);
  const titleId = React.useId();
  const metaPanelId = React.useId();

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const host =
      document.getElementById(PORTAL_HOST_ID) ??
      (() => {
        const el = document.createElement('div');
        el.id = PORTAL_HOST_ID;
        document.body.appendChild(el);
        return el;
      })();
    setPortalElement(host);
  }, []);

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const wasOpen = wasOpenRef.current;
    if (isOpen && !wasOpen) {
      previousActiveElementRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMetaOpen(false);
    }
    if (!isOpen && wasOpen) {
      const trigger = previousActiveElementRef.current;
      if (trigger && typeof trigger.focus === 'function' && typeof window !== 'undefined') {
        window.requestAnimationFrame(() => trigger.focus());
      }
      previousActiveElementRef.current = null;
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  // 初期フォーカス（セレクタ失敗ガード付き）
  React.useEffect(() => {
    if (!isOpen) return;
    if (typeof window === 'undefined') return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    try {
      const focusables = drawer.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      const target = focusables.length > 0 ? focusables[0] : drawer;
      const handle = window.requestAnimationFrame(() => target.focus());
      return () => window.cancelAnimationFrame(handle);
    } catch (err) {
      console.warn(`${TAG} focusable selector failed:`, err);
    }
  }, [isOpen]);

  // スクロールロック + iOS touchmove
  React.useEffect(() => {
    if (!isOpen) return;
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    const prevent = (event: TouchEvent) => {
      if (!drawerRef.current) return;
      const target = event.target as Node | null;
      if (drawerRef.current.contains(target)) return;
      event.preventDefault();
    };
    document.addEventListener('touchmove', prevent, { passive: false });
    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
      document.removeEventListener('touchmove', prevent);
    };
  }, [isOpen]);

  // ESC close
  React.useEffect(() => {
    if (!isOpen) return;
    if (typeof document === 'undefined') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // ルート変更で閉じる
  React.useEffect(() => {
    if (isOpen) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Firebase Bearer
  const getBearer = React.useCallback(async (): Promise<string | null> => {
    try {
      const auth = getAuth();
      const u = auth.currentUser;
      if (!u) {
        console.warn(`${TAG} no currentUser`);
        return null;
      }
      const token = await u.getIdToken(false);
      return token || null;
    } catch (e) {
      console.warn(`${TAG} getIdToken failed:`, e);
      return null;
    }
  }, []);

  // ----- User Info -----
  const [localUser, setLocalUser] = React.useState<UserInfo | null>(null);

  React.useEffect(() => {
    console.log(`${TAG}[userinfo] mount`, { agent, isOpen, hasPropUser: !!userInfo });
    if (!isOpen) return;

    const propLooksValid =
      !!userInfo &&
      (userInfo.name !== 'You' || userInfo.userType !== 'member' || (userInfo.credits ?? 0) !== 0);

    if (propLooksValid) {
      setLocalUser(null); // prop 優先
      return;
    }

    let dead = false;
    (async () => {
      try {
        console.log(`${TAG}[userinfo] fetch start -> /api/agent/iros/userinfo`);
        const bearer = await getBearer();
        const res = await fetch('/api/agent/iros/userinfo', {
          method: 'GET',
          headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
          credentials: 'include',
        });
        console.log(`${TAG}[userinfo] fetch done`, res.status);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (!dead) {
          const u = j?.user ?? null;
          if (u) {
            setLocalUser({
              id: String(u.id ?? 'me'),
              name: String(u.name ?? 'You'),
              userType: String(u.userType ?? 'member'),
              credits: Number(u.credits ?? 0),
            });
          } else {
            setLocalUser({ id: 'me', name: 'You', userType: 'member', credits: 0 });
          }
        }
      } catch (e) {
        console.warn(`${TAG}[userinfo] fetch error:`, e);
        if (!dead) setLocalUser({ id: 'me', name: 'You', userType: 'member', credits: 0 });
      }
    })();

    return () => {
      dead = true;
    };
  }, [isOpen, userInfo, getBearer, agent]);

  const uinfo = (() => {
    const propLooksValid =
      !!userInfo &&
      (userInfo.name !== 'You' || userInfo.userType !== 'member' || (userInfo.credits ?? 0) !== 0);
    return propLooksValid ? userInfo : localUser;
  })();

  // ----- Conversations (fallback fetch) -----
  const [localConvs, setLocalConvs] = React.useState<Conversation[] | null>(null);

  React.useEffect(() => {
    console.log(
      `${TAG}[conversations] mount  -> {agent: '${agent}', isOpen: ${isOpen}, hasPropUserInfo: ${!!userInfo}}`,
    );
    if (agent !== 'iros') return;
    if (!isOpen) return;
    if (Array.isArray(conversations) && conversations.length > 0) {
      setLocalConvs(null);
      return;
    }

    let abort = false;
    (async () => {
      try {
        console.log(`${TAG}[conversations] fetch start -> /api/agent/iros/conversations`);
        const bearer = await getBearer();
        const res = await fetch('/api/agent/iros/conversations', {
          method: 'GET',
          headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
          credentials: 'include',
        });
        if (!res.ok) {
          console.warn(`${TAG}[conversations] fetch error: HTTP ${res.status}`);
          throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        const arr = Array.isArray(json?.conversations) ? json.conversations : [];
        if (!abort) setLocalConvs(arr);
        console.log(`${TAG}[conversations] set  ->`, arr.length);
      } catch (e) {
        if (!abort) setLocalConvs([]);
        console.warn(`${TAG}[conversations] fetch failed:`, e);
      }
    })();

    return () => {
      abort = true;
    };
  }, [agent, isOpen, conversations, userInfo, getBearer]);

  // Mirra history → conversations 変換
  const mirraAsConversations: Conversation[] = React.useMemo(() => {
    if (agent !== 'mirra') return [];
    const src = Array.isArray(mirraHistory) ? mirraHistory : [];
    const norm = src
      .map((h: any, idx: number) => {
        const idRaw =
          h?.id ??
          h?.thread_id ??
          h?.conversation_id ??
          h?.cid ??
          h?.conv_id ??
          h?.report_id ??
          `row-${idx}`;
        const id = String(idRaw ?? '').trim();
        const tRaw = h?.title ?? h?.subject ?? h?.name ?? h?.summary ?? '';
        const titleBase = String(tRaw || '').trim() || '（無題）';
        const whenRaw = h?.updated_at ?? h?.created_at ?? null;
        const when = whenRaw ? new Date(whenRaw).toLocaleString() : '';
        const title = when ? `${titleBase}（${when}）` : titleBase;
        return { id, title, updated_at: whenRaw ?? null };
      })
      .filter((v) => v.id);
    const seen = new Set<string>();
    return norm.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)));
  }, [agent, mirraHistory]);

  const listForUI: Conversation[] = React.useMemo(() => {
    if (agent === 'mirra')
      return mirraAsConversations.length ? mirraAsConversations : (conversations ?? []);
    if (Array.isArray(conversations) && conversations.length) return conversations;
    if (Array.isArray(localConvs) && localConvs.length) return localConvs;
    return [];
  }, [agent, conversations, localConvs, mirraAsConversations]);

  const dispatch = (name: string, detail?: unknown) => {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (error) {
      console.warn(`${TAG} dispatch failed`, error);
    }
  };

  if (!isOpen || !portalElement) return null;

  const fmt = (s?: string | null) => {
    if (!s) return '';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
  };

  const truncate = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

  const content = (
    <div id={DRAWER_ROOT_ID} className={cx(styles.portal, styles.portalActive)}>
      <div className={cx(styles.dim, styles.dimVisible)} aria-hidden="true" onClick={onClose} />
      <aside
        ref={drawerRef}
        className={cx(styles.drawer, styles.drawerOpen)}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={styles.drawerHead}>
          <div id={titleId} className={styles.drawerTitle}>
            🌊 セッション一覧
          </div>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            aria-label="Close sidebar"
          >
            <X size={18} />
          </button>
        </div>

        {uinfo && (
          <div className={styles.user}>
            <button
              type="button"
              className={styles.userRow}
              onClick={() => dispatch('click_username', { id: uinfo.id, name: uinfo.name })}
            >
              🌱 <b>Name:</b>&nbsp;<span>{uinfo.name}</span>
            </button>
            <button
              type="button"
              className={styles.userRow}
              onClick={() => dispatch('click_type', { userType: uinfo.userType })}
            >
              🌱 <b>Type:</b>&nbsp;<span>{uinfo.userType}</span>
            </button>
            <button
              type="button"
              className={styles.userRow}
              onClick={() => dispatch('sofia_credit', { credits: uinfo.credits })}
            >
              🌱 <b>Credits:</b>&nbsp;<span>{uinfo.credits}</span>
            </button>
          </div>
        )}

        {Array.isArray(logs) && logs.length > 0 && (
          <div className={styles.logCard} aria-label="直近ログ">
            <div className={styles.logHead}>🗂️ 直近ログ</div>
            <ul className={styles.logList}>
              {logs.map((row, i) => (
                <li
                  key={`${row.role}-${row.at}-${i}`}
                  className={cx(
                    styles.logItem,
                    row.role === 'user' ? styles.logItemUser : styles.logItemAssistant,
                  )}
                >
                  <div className={styles.logRow}>
                    <span className={styles.logRole}>
                      {row.role === 'user' ? '👤 user' : '🤖 assistant'}
                    </span>
                    <span className={styles.logTime}>{fmt(row.at)}</span>
                  </div>
                  <div className={styles.logContent}>{truncate(row.content, 120)}</div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <ul className={styles.list}>
          {listForUI.length === 0 && (
            <li className={styles.muted} aria-disabled>
              まだ会話履歴がありません。
            </li>
          )}

          {listForUI.map((conv) => (
            <li key={conv.id} className={styles.listItem}>
              <button
                type="button"
                className={styles.listTitle}
                onClick={() => {
                  const params = new URLSearchParams(sp.toString());
                  params.set('cid', conv.id);
                  params.set('agent', agent);
                  router.replace(`${pathname}?${params.toString()}`, { scroll: false });
                  onSelect(conv.id);
                  onClose();
                }}
                title={conv.title || '無題のセッション'}
              >
                {conv.title || '無題のセッション'}
                {conv.updated_at ? (
                  <span className={styles.subTime}>（{fmt(conv.updated_at)}）</span>
                ) : null}
              </button>

              <div className={styles.listOps}>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => {
                    const t = prompt('新しいタイトルを入力してください', conv.title);
                    if (t && t.trim()) onRename(conv.id, t.trim());
                  }}
                  title="Rename"
                >
                  <Edit size={16} />
                </button>
                <button
                  type="button"
                  className={cx(styles.iconButton, styles.iconButtonDanger)}
                  onClick={() => onDelete(conv.id)}
                  title="Delete"
                >
                  <Trash size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>

        <div className={styles.metaFold}>
          <button
            type="button"
            className={styles.metaFoldToggle}
            onClick={() => setMetaOpen((v) => !v)}
            aria-expanded={metaOpen}
            aria-controls={metaPanelId}
          >
            {metaOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />} Resonance Meta
          </button>
          <div
            id={metaPanelId}
            className={cx(styles.metaFoldBody, metaOpen && styles.metaFoldBodyOpen)}
            aria-hidden={!metaOpen}
          >
            <MetaPanel meta={meta ?? null} />
          </div>
        </div>
      </aside>
    </div>
  );

  return createPortal(content, portalElement);
};

export default SidebarMobile;
