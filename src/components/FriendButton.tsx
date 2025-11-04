'use client';
import { useEffect, useState } from 'react';

type Props = { me: string; target: string };

export default function FriendButton({ me, target }: Props) {
  const [state, setState] = useState<'none' | 'pending' | 'friends' | 'self'>('none');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (me === target) {
      setState('self');
      return;
    }
    // 簡易チェック：自分の友達一覧を見て判定（必要に応じて高速化）
    (async () => {
      const res = await fetch('/api/friends/list', { headers: { 'x-user-code': me } });
      const json = await res.json();
      if (json?.ok && Array.isArray(json.friends)) {
        if (json.friends.includes(target)) setState('friends');
      }
    })();
    // pending 表示したい場合は /api/friends/requests で補完（下で用意）
  }, [me, target]);

  const request = async () => {
    setLoading(true);
    const res = await fetch('/api/friends/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-code': me },
      body: JSON.stringify({ to_user_code: target }),
    });
    setLoading(false);
    if (res.ok) setState('pending');
  };

  if (state === 'self') return <span style={chip}>あなた</span>;
  if (state === 'friends') return <span style={chip}>友達</span>;
  if (state === 'pending') return <span style={chip}>申請中</span>;
  return (
    <button disabled={loading} onClick={request} style={btn}>
      友達になる 🤝
    </button>
  );
}
const btn: React.CSSProperties = {
  border: '1px solid #ddd',
  background: '#fff',
  borderRadius: 10,
  padding: '6px 10px',
  cursor: 'pointer',
};
const chip: React.CSSProperties = {
  border: '1px solid #e0e0e0',
  background: '#fafafa',
  borderRadius: 10,
  padding: '4px 8px',
  fontSize: 12,
};
