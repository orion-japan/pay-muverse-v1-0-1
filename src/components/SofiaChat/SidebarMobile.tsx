'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import { X, Trash, Edit, ChevronDown, ChevronUp } from 'lucide-react';
import './SidebarMobile.css';

import { MetaPanel, type MetaData } from '@/components/SofiaChat/MetaPanel';

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
}

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
  agent,
}) => {
  const router = useRouter();

  // ===== Portal host =====
  const portalRef = React.useRef<Element | null>(null);
  if (typeof window !== 'undefined' && !portalRef.current) {
    const host =
      document.getElementById('modal-root') ??
      (() => {
        const el = document.createElement('div');
        el.id = 'modal-root';
        document.body.appendChild(el);
        return el;
      })();
    portalRef.current = host;
  }

  // ===== Lock body scroll =====
  React.useEffect(() => {
    const prev = document.body.style.overflow;
    const prevent = (e: TouchEvent) => e.preventDefault();
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      document.addEventListener('touchmove', prevent, { passive: false });
    }
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('touchmove', prevent);
    };
  }, [isOpen]);

  // ===== Esc close =====
  React.useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // ===== Close on route change =====
  const pathname = usePathname();
  React.useEffect(() => { if (isOpen) onClose(); /* eslint-disable-next-line */ }, [pathname]);

  // ===== initial focus =====
  React.useEffect(() => {
    if (!isOpen) return;
    const first = document.getElementById('sof-sidebar-mobile');
    (first as HTMLElement | null)?.focus?.();
  }, [isOpen]);

  const [metaOpen, setMetaOpen] = React.useState<boolean>(false);

  // toast dispatch
  const dispatch = (name: string, detail?: any) => {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch {}
  };

  // mirra history → conversation list normalize
  const mirraAsConversations: Conversation[] = React.useMemo(() => {
    if (agent !== 'mirra') return [];
    const src = Array.isArray(mirraHistory) ? mirraHistory : [];
    const norm = src.map((h: any, idx: number) => {
      const idRaw =
        h?.id ?? h?.thread_id ?? h?.conversation_id ?? h?.cid ?? h?.conv_id ?? h?.report_id ?? `row-${idx}`;
      const id = typeof idRaw === 'string' ? idRaw.trim() : String(idRaw).trim();

      const tRaw = h?.title ?? h?.subject ?? h?.name ?? h?.summary ?? '';
      const titleBase = String(tRaw || '').trim() || '（無題）';
      const whenRaw = h?.updated_at ?? h?.created_at ?? null;
      const when = whenRaw ? new Date(whenRaw).toLocaleString() : '';
      const title = when ? `${titleBase}（${when}）` : titleBase;

      return { id, title, updated_at: whenRaw ?? null };
    }).filter((x) => x.id);

    const seen = new Set<string>();
    return norm.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  }, [agent, mirraHistory]);

  const listForUI: Conversation[] = agent === 'mirra' ? mirraAsConversations.length ? mirraAsConversations : conversations : conversations;

  if (!isOpen || !portalRef.current) return null;

  const content = (
    <div
      id="sof-sidebar-mobile"
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="セッション一覧"
    >
      <div className="sof-dim show" onClick={onClose} />

      <aside className={`sof-drawer ${isOpen ? 'is-open' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="sof-drawer__head">
          <div className="sof-drawer__title">🌊 セッション一覧</div>
          <button className="sof-iconbtn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* user box */}
        {userInfo && (
          <div className="sof-user">
            <button className="sof-user__row" onClick={() => dispatch('click_username', { id: userInfo.id, name: userInfo.name })}>
              🌱 <b>Name:</b>&nbsp;<span>{userInfo.name}</span>
            </button>
            <button className="sof-user__row" onClick={() => dispatch('click_type', { userType: userInfo.userType })}>
              🌱 <b>Type:</b>&nbsp;<span>{userInfo.userType}</span>
            </button>
            <button className="sof-user__row" onClick={() => dispatch('sofia_credit', { credits: userInfo.credits })}>
              🌱 <b>Credits:</b>&nbsp;<span>{userInfo.credits}</span>
            </button>
          </div>
        )}

        {/* list */}
        <ul className="sof-list">
          {listForUI.map((conv) => (
            <li key={conv.id} className="sof-list__item">
              <button
                className="sof-list__title"
                onClick={() => {
                  if (agent === 'mirra') {
                    router.push(`/mtalk/${conv.id}?agent=mirra&from=sidebar&cid=${conv.id}`);
                  } else {
                    onSelect(conv.id);
                  }
                  onClose();
                }}
                title={conv.title || '無題のセッション'}
              >
                {conv.title || '無題のセッション'}
              </button>

              {/* ← ここを「常に」表示（mirra も可） */}
              <div className="sof-list__ops">
                <button
                  className="sof-iconbtn"
                  onClick={() => {
                    const t = prompt('新しいタイトルを入力してください', conv.title);
                    if (t && t.trim()) onRename(conv.id, t.trim());
                  }}
                  title="Rename"
                >
                  <Edit size={16} />
                </button>
                <button className="sof-iconbtn danger" onClick={() => onDelete(conv.id)} title="Delete">
                  <Trash size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>

        {/* Meta fold */}
        <div className="sof-meta-fold">
          <button className="sof-meta-fold__toggle" onClick={() => setMetaOpen((v) => !v)}>
            {metaOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />} Resonance Meta
          </button>
          <div className={`sof-meta-fold__body ${metaOpen ? 'open' : 'closed'}`}>
            <MetaPanel meta={meta ?? null} />
          </div>
        </div>
      </aside>
    </div>
  );

  return createPortal(content, portalRef.current);
};

export default SidebarMobile;
