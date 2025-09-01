// src/components/SofiaChat/SidebarMobile.tsx
'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import { X, Trash, Edit, ChevronDown, ChevronUp } from 'lucide-react';
import './SidebarMobile.css';

// ★ 追加：MetaPanel
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
}
interface SidebarMobileProps {
  conversations: Conversation[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  isOpen: boolean;
  onClose: () => void;
  userInfo: UserInfo | null;
  // ★ 追加：メタを受け取って表示
  meta?: MetaData | null;
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
}) => {
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

  // ===== Lock body scroll (+ iOS touchmove) =====
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

  // ===== Esc で閉じる =====
  React.useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // ===== ルート変更で閉じる =====
  const pathname = usePathname();
  React.useEffect(() => { if (isOpen) onClose(); /* eslint-disable-next-line */ }, [pathname]);

  // ===== 初期フォーカス =====
  React.useEffect(() => {
    if (!isOpen) return;
    const first = document.getElementById('sof-sidebar-mobile');
    (first as HTMLElement | null)?.focus?.();
  }, [isOpen]);

  // ★ 追加：Meta 折りたたみ
  const [metaOpen, setMetaOpen] = React.useState<boolean>(false);

  // ★ 追加：クリックイベント dispatch
  const dispatch = (name: string, detail?: any) => {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch {}
  };

  if (!isOpen || !portalRef.current) return null;

  const content = (
    <div
      id="sof-sidebar-mobile"
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="セッション一覧"
    >
      <div className={`sof-dim ${isOpen ? 'show' : ''}`} onClick={onClose} />

      <aside className={`sof-drawer ${isOpen ? 'is-open' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="sof-drawer__head">
          <div className="sof-drawer__title">🌊 セッション一覧</div>
          <button className="sof-iconbtn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* ユーザー情報ボックス */}
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

        {/* セッション一覧 */}
        <ul className="sof-list">
          {conversations.map((conv) => (
            <li key={conv.id} className="sof-list__item">
              <button
                className="sof-list__title"
                onClick={() => { onSelect(conv.id); onClose(); }}
                title={conv.title || '無題のセッション'}
              >
                {conv.title || '無題のセッション'}
              </button>
              <div className="sof-list__ops">
                <button
                  className="sof-iconbtn"
                  onClick={() => {
                    const t = prompt('新しいタイトルを入力してください', conv.title);
                    if (t) onRename(conv.id, t);
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

        {/* ====== 下部：Resonance Meta（折りたたみ） ====== */}
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
