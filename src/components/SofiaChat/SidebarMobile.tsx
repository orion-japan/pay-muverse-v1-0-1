'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import { X, Trash, Edit } from 'lucide-react';
import './SidebarMobile.css'; // ★ 追加：CSS を読み込み

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
}

const SidebarMobile: React.FC<SidebarMobileProps> = ({
  conversations,
  onSelect,
  onDelete,
  onRename,
  isOpen,
  onClose,
  userInfo,
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // ===== ルート変更で閉じる（残留防止）=====
  const pathname = usePathname();
  React.useEffect(() => {
    if (isOpen) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // ===== 初期フォーカス =====
  React.useEffect(() => {
    if (!isOpen) return;
    const first = document.getElementById('sof-sidebar-mobile');
    (first as HTMLElement | null)?.focus?.();
  }, [isOpen]);

  if (!isOpen || !portalRef.current) return null;

  const content = (
    <div
      id="sof-sidebar-mobile"
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="セッション一覧"
    >
      {/* Backdrop */}
      {/* ★ 変更：open 時は show クラスを付与（古い Safari 対策） */}
      <div className={`sof-dim ${isOpen ? 'show' : ''}`} onClick={onClose} />

      {/* Drawer */}
      <aside
        className={`sof-drawer ${isOpen ? 'is-open' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sof-drawer__head">
          <div className="sof-drawer__title">🌊 セッション一覧</div>
          <button className="sof-iconbtn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {userInfo && (
          <div className="sof-user">
            <div>🌱 <b>Name:</b> {userInfo.name}</div>
            <div>🌱 <b>Type:</b> {userInfo.userType}</div>
            <div>🌱 <b>Credits:</b> {userInfo.credits}</div>
          </div>
        )}

        <ul className="sof-list">
          {conversations.map((conv) => (
            <li key={conv.id} className="sof-list__item">
              <button
                className="sof-list__title"
                onClick={() => {
                  onSelect(conv.id);
                  onClose();
                }}
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
                <button
                  className="sof-iconbtn danger"
                  onClick={() => onDelete(conv.id)}
                  title="Delete"
                >
                  <Trash size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );

  return createPortal(content, portalRef.current);
};

export default SidebarMobile;
