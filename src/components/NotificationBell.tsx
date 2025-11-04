'use client';
import { useEffect, useState } from 'react';

type Notif = {
  id: string;
  type: string;
  actor_user_code: string;
  post_id?: string | null;
  payload?: any;
  is_read: boolean;
  created_at: string;
};

export default function NotificationBell({ userCode }: { userCode: string }) {
  const [items, setItems] = useState<Notif[]>([]);
  const [open, setOpen] = useState(false);

  const fetchList = async () => {
    const res = await fetch('/api/notifications?limit=30', {
      headers: { 'x-user-code': userCode },
    });
    const json = await res.json();
    if (json?.ok) setItems(json.items || []);
  };

  const markAllRead = async () => {
    const unreadIds = items.filter((i) => !i.is_read).map((i) => i.id);
    if (unreadIds.length === 0) return;
    await fetch('/api/notifications/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-code': userCode },
      body: JSON.stringify({ ids: unreadIds }),
    });
    // 楽観更新
    setItems((prev) => prev.map((i) => ({ ...i, is_read: true })));
  };

  useEffect(() => {
    fetchList();
  }, []);

  const unread = items.filter((i) => !i.is_read).length;

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (!open) fetchList();
        }}
        style={btn}
      >
        🔔
        {unread > 0 && <span style={badge}>{unread}</span>}
      </button>
      {open && (
        <div style={menu}>
          <div style={menuHeader}>
            <strong>通知</strong>
            <button onClick={markAllRead} style={miniBtn}>
              すべて既読
            </button>
          </div>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {items.length === 0 && <div style={empty}>通知はありません</div>}
            {items.map((n) => (
              <div key={n.id} style={{ ...item, background: n.is_read ? '#fff' : '#f7fbff' }}>
                <div style={{ fontSize: 14 }}>
                  <span style={{ marginRight: 6 }}>
                    {n.payload?.icon ?? (n.type === 'resonance' ? '✨' : '•')}
                  </span>
                  <b>{n.actor_user_code}</b> さんが
                  {n.type === 'resonance'
                    ? ` 共鳴(${n.payload?.resonance_type ?? 'unknown'})`
                    : n.type === 'friend_request'
                      ? ' 友達申請'
                      : n.type === 'friend_accepted'
                        ? ' 友達になりました'
                        : ` ${n.type}`}
                  を行いました
                </div>
                <div style={{ fontSize: 12, color: '#888' }}>
                  {new Date(n.created_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  position: 'relative',
  border: '1px solid #ddd',
  borderRadius: 20,
  background: '#fff',
  padding: '6px 10px',
  cursor: 'pointer',
};
const badge: React.CSSProperties = {
  position: 'absolute',
  top: -6,
  right: -6,
  background: 'crimson',
  color: '#fff',
  fontSize: 11,
  borderRadius: 10,
  padding: '1px 5px',
};
const menu: React.CSSProperties = {
  position: 'absolute',
  right: 0,
  top: 36,
  width: 320,
  background: '#fff',
  border: '1px solid #ddd',
  borderRadius: 12,
  boxShadow: '0 8px 24px rgba(0,0,0,.08)',
  padding: 8,
  zIndex: 1000,
};
const menuHeader: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '4px 6px 8px',
};
const miniBtn: React.CSSProperties = {
  border: '1px solid #ddd',
  background: '#fafafa',
  borderRadius: 8,
  padding: '4px 8px',
  cursor: 'pointer',
  fontSize: 12,
};
const item: React.CSSProperties = {
  border: '1px solid #eee',
  borderRadius: 10,
  padding: 8,
  margin: '6px 0',
};
const empty: React.CSSProperties = { padding: 16, textAlign: 'center', color: '#666' };
