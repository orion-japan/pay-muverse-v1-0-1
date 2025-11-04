// src/ui/iroschat/components/IrosSidebarMobile.tsx
// ※ 同内容を src/ui/iroschat/IrosSidebarMobile.tsx に置いてもOK
'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { X, Trash, Edit, ChevronDown, ChevronUp } from 'lucide-react';
import './SidebarMobile.css';

type Conversation = { id: string; title: string; updated_at?: string | null };
type UserInfo = { id: string; name: string; userType: string; credits: number };

export default function IrosSidebarMobile({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const log = (...a: any[]) => console.log('[SidebarMobileIROS]', ...a);
  const router = useRouter();

  const [conversations, setConvs] = React.useState<Conversation[]>([]);
  const [userInfo, setUserInfo] = React.useState<UserInfo | null>(null);
  const [metaOpen, setMetaOpen] = React.useState(false);

  // mount/unmount
  React.useEffect(() => {
    log('mount');
    return () => log('unmount');
  }, []);

  // open/close監視
  React.useEffect(() => {
    log('isOpen changed:', isOpen);
  }, [isOpen]);

  // ===== fetch: conversations =====
  React.useEffect(() => {
    if (!isOpen) return;
    let aborted = false;
    (async () => {
      try {
        log('FETCH conversations: start');
        const t0 = performance.now();
        const res = await fetch('/api/agent/iros/conversations', { credentials: 'include' });
        const json = await res.json();
        const dt = Math.round(performance.now() - t0);
        log('FETCH conversations: done', { status: res.status, ms: dt, json });

        if (!aborted && json?.ok) {
          const list = Array.isArray(json.conversations) ? json.conversations : [];
          setConvs(list);
        } else if (!aborted) {
          setConvs([]);
        }
      } catch (e) {
        log('FETCH conversations: error', e);
        if (!aborted) setConvs([]);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [isOpen]);

  // ===== fetch: userinfo =====
  React.useEffect(() => {
    if (!isOpen) return;
    let aborted = false;
    (async () => {
      try {
        log('FETCH userinfo: start');
        const t0 = performance.now();
        const res = await fetch('/api/agent/iros/userinfo', { credentials: 'include' });
        const json = await res.json();
        const dt = Math.round(performance.now() - t0);
        log('FETCH userinfo: done', { status: res.status, ms: dt, json });

        if (!aborted && json?.ok && json?.user) {
          setUserInfo(json.user as UserInfo);
        } else if (!aborted) {
          setUserInfo(null);
        }
      } catch (e) {
        log('FETCH userinfo: error', e);
        if (!aborted) setUserInfo(null);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [isOpen]);

  // ===== body scroll lock =====
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

  if (!isOpen) return null;

  return (
    <div id="sof-sidebar-mobile" role="dialog" aria-modal="true" aria-label="セッション一覧">
      <div
        className="sof-dim show"
        onClick={() => {
          log('click overlay → close');
          onClose();
        }}
      />
      <aside
        className={`sof-drawer ${isOpen ? 'is-open' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sof-drawer__head">
          <div className="sof-drawer__title">🌊 セッション一覧</div>
          <button
            className="sof-iconbtn"
            onClick={() => {
              log('click close');
              onClose();
            }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* user box */}
        <div className="sof-user">
          {userInfo ? (
            <>
              <div className="sof-user__row">
                🌱 <b>Name:</b>&nbsp;<span>{userInfo.name}</span>
              </div>
              <div className="sof-user__row">
                🌱 <b>Type:</b>&nbsp;<span>{userInfo.userType}</span>
              </div>
              <div className="sof-user__row">
                🌱 <b>Credits:</b>&nbsp;<span>{userInfo.credits}</span>
              </div>
            </>
          ) : (
            <div className="sof-user__row" title="userinfo not loaded">
              🌱 <i>user info…</i>
            </div>
          )}
        </div>

        {/* conversation list */}
        <ul className="sof-list">
          {conversations.map((c) => (
            <li key={c.id} className="sof-list__item">
              <button
                className="sof-list__title"
                onClick={() => {
                  log('click conversation', c);
                  const url = `/iros?cid=${encodeURIComponent(c.id)}&agent=iros`;
                  log('router.push', url);
                  router.push(url);
                  onClose();
                }}
                title={c.title || '無題のセッション'}
              >
                {c.title || '無題のセッション'}
              </button>

              <div className="sof-list__ops">
                <button
                  className="sof-iconbtn"
                  onClick={async () => {
                    const t = prompt('新しいタイトルを入力してください', c.title);
                    if (!t?.trim()) return;
                    try {
                      log('PATCH title: start', { id: c.id, title: t.trim() });
                      const res = await fetch(`/api/agent/iros/conversations/${c.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ title: t.trim() }),
                      });
                      log('PATCH title: done', res.status);
                      // refresh
                      const r2 = await fetch('/api/agent/iros/conversations', {
                        credentials: 'include',
                      });
                      const j2 = await r2.json();
                      log('refresh conversations', { status: r2.status, json: j2 });
                      setConvs(Array.isArray(j2?.conversations) ? j2.conversations : []);
                    } catch (e) {
                      log('PATCH title: error', e);
                    }
                  }}
                  title="Rename"
                >
                  <Edit size={16} />
                </button>
                <button
                  className="sof-iconbtn danger"
                  onClick={async () => {
                    if (!confirm('このセッションを削除しますか？')) return;
                    try {
                      log('DELETE conversation: start', c.id);
                      const res = await fetch(`/api/agent/iros/conversations/${c.id}`, {
                        method: 'DELETE',
                      });
                      log('DELETE conversation: done', res.status);
                      setConvs((prev) => prev.filter((x) => x.id !== c.id));
                    } catch (e) {
                      log('DELETE conversation: error', e);
                    }
                  }}
                  title="Delete"
                >
                  <Trash size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>

        {/* Meta fold（任意） */}
        <div className="sof-meta-fold">
          <button
            className="sof-meta-fold__toggle"
            onClick={() => {
              setMetaOpen((v) => !v);
              log('toggle meta', !metaOpen);
            }}
          >
            {metaOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />} Resonance Meta
          </button>
          <div className={`sof-meta-fold__body ${metaOpen ? 'open' : 'closed'}`}>
            {/* MetaPanel を入れるならここに */}
          </div>
        </div>
      </aside>
    </div>
  );
}
