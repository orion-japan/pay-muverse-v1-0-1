'use client';

import { useState } from 'react';

export default function LeaderPanel() {
  const [leaderUserCode, setLeaderUserCode] = useState('');
  const [originUserCode, setOriginUserCode] = useState('');
  const [groupCode, setGroupCode] = useState('');
  const [result, setResult] = useState<string | null>(null);

  async function handleSetLeader() {
    const res = await fetch('/api/set-leader', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leader_user_code: leaderUserCode,
        origin_user_code: originUserCode,
        group_code: groupCode,
        created_by: 'admin-ui',
      }),
    });
    const data = await res.json();
    if (data.success) {
      setResult(`✅ ${leaderUserCode} をリーダーに設定 (Tier ${data.tier_level})`);
    } else {
      setResult(`❌ Error: ${data.error}`);
    }
  }

  return (
    <div style={{ padding: 20, border: '1px solid #ccc', borderRadius: 8 }}>
      <h3>リーダー設定</h3>
      <div style={{ marginBottom: '8px' }}>
        <input
          placeholder="リーダーにする user_code"
          value={leaderUserCode}
          onChange={(e) => setLeaderUserCode(e.target.value)}
        />
      </div>
      <div style={{ marginBottom: '8px' }}>
        <input
          placeholder="派生元の user_code"
          value={originUserCode}
          onChange={(e) => setOriginUserCode(e.target.value)}
        />
      </div>
      <div style={{ marginBottom: '8px' }}>
        <input
          placeholder="グループコード"
          value={groupCode}
          onChange={(e) => setGroupCode(e.target.value)}
        />
      </div>
      <button onClick={handleSetLeader}>リーダーに設定</button>
      {result && <p>{result}</p>}
    </div>
  );
}
