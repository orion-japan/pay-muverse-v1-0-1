'use client';
import { useEffect, useState } from 'react';

type Req = {
  request_id: string;
  from_user_code: string;
  to_user_code: string;
  status: string;
  created_at: string;
};

export default function FriendRequestsPanel({ me }: { me: string }) {
  const [incoming, setIncoming] = useState<Req[]>([]);
  const [outgoing, setOutgoing] = useState<Req[]>([]);

  const load = async () => {
    const res = await fetch('/api/friends/requests', { headers: { 'x-user-code': me } });
    const json = await res.json();
    if (json?.ok) {
      setIncoming(json.incoming || []);
      setOutgoing(json.outgoing || []);
    }
  };

  const respond = async (request_id: string, action: 'accepted' | 'declined' | 'blocked') => {
    await fetch('/api/friends/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-code': me },
      body: JSON.stringify({ request_id, action }),
    });
    await load();
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div style={{ border: '1px solid #eaeaea', borderRadius: 12, padding: 12 }}>
      <h4>友達申請</h4>
      <div style={{ display: 'grid', gap: 10 }}>
        <div>
          <div style={{ fontWeight: 600 }}>受信（あなた宛）</div>
          {incoming.length === 0 ? (
            <div style={{ color: '#777' }}>なし</div>
          ) : (
            incoming.map((r) => (
              <div key={r.request_id} style={row}>
                <span>
                  <b>{r.from_user_code}</b> さんからの申請
                </span>
                <span>
                  <button style={okBtn} onClick={() => respond(r.request_id, 'accepted')}>
                    承認
                  </button>
                  <button style={ngBtn} onClick={() => respond(r.request_id, 'declined')}>
                    却下
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
        <div>
          <div style={{ fontWeight: 600 }}>送信（保留中）</div>
          {outgoing.length === 0 ? (
            <div style={{ color: '#777' }}>なし</div>
          ) : (
            outgoing.map((r) => (
              <div key={r.request_id} style={row}>
                <span>
                  <b>{r.to_user_code}</b> さんへ申請中
                </span>
                <span style={{ color: '#999' }}>{new Date(r.created_at).toLocaleString()}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
const row: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  border: '1px solid #eee',
  borderRadius: 10,
  padding: '6px 8px',
};
const okBtn: React.CSSProperties = {
  marginRight: 8,
  border: '1px solid #ddd',
  background: '#f6fff6',
  borderRadius: 8,
  padding: '4px 8px',
  cursor: 'pointer',
};
const ngBtn: React.CSSProperties = {
  border: '1px solid #ddd',
  background: '#fff6f6',
  borderRadius: 8,
  padding: '4px 8px',
  cursor: 'pointer',
};
