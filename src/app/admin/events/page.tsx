'use client';

import { useState } from 'react';

export default function EventToolsPage() {
  const [form, setForm] = useState({
    group_code: '',
    leader_user_code: '',
    group_name: '',
    invite_max_uses: 1000,
    invite_expires_at: '', // "2025-09-13T23:59:59+09:00" のように入れる
    invite_notes: 'event',
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [created, setCreated] = useState<any>(null);

  function set<K extends keyof typeof form>(k: K, v: any) { setForm(s => ({ ...s, [k]: v })); }

  async function create() {
    setMsg(null);
    const res = await fetch('/api/admin/events/create-group-and-invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    const json = await res.json();
    if (json.ok) {
      setCreated(json);
      setMsg(`✅ 作成 success (group:${json.group.group_code}, invite:${json.invite.code})`);
    } else {
      setMsg(`❌ ${json.error}`);
    }
  }

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontWeight: 700, fontSize: 20, marginBottom: 12 }}>イベント用グループ作成 & 招待発行</h2>
      <div style={{ display:'grid', gridTemplateColumns:'180px 1fr', gap:8, alignItems:'center', border:'1px solid #eee', borderRadius:12, padding:12 }}>
        <label>グループコード</label><input value={form.group_code} onChange={e=>set('group_code', e.target.value)} placeholder="例: 913EVENT" />
        <label>リーダーuser_code</label><input value={form.leader_user_code} onChange={e=>set('leader_user_code', e.target.value)} placeholder="例: 336699" />
        <label>グループ名</label><input value={form.group_name} onChange={e=>set('group_name', e.target.value)} placeholder="例: 9/13 Meetup" />
        <label>招待 最大使用回数</label><input type="number" value={form.invite_max_uses} onChange={e=>set('invite_max_uses', parseInt(e.target.value || '0'))} />
        <label>招待 有効期限(任意)</label><input value={form.invite_expires_at} onChange={e=>set('invite_expires_at', e.target.value)} placeholder="2025-09-13T23:59:59+09:00" />
        <label>招待メモ</label><input value={form.invite_notes} onChange={e=>set('invite_notes', e.target.value)} />
      </div>
      <div style={{ marginTop: 10 }}>
        <button onClick={create} style={{ padding:'8px 12px', borderRadius:8, border:'1px solid #ddd' }}>作成</button>
      </div>
      {msg && <div style={{ marginTop: 10 }}>{msg}</div>}

      {created && (
        <div style={{ marginTop:12, border:'1px solid #eee', borderRadius:12, padding:12 }}>
          <div>Group: <b>{created.group.group_code}</b> / {created.group.name}</div>
          <div>Invite Code: <b>{created.invite.code}</b></div>
          <div>例の登録URL: <code>{created.example_link}</code></div>
        </div>
      )}
    </div>
  );
}
