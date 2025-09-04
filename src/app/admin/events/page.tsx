'use client';
import { useEffect, useState } from 'react';

export default function EventToolsPage() {
  const [form, setForm] = useState({
    group_code: '',
    leader_user_code: '',
    group_name: '',
    invite_max_uses: 1000,
    invite_expires_at: '',
    invite_notes: 'event',
    // ★ 追加
    campaign_type: 'bonus-credit', // 例: 'bonus-credit' | 'none' など
    bonus_credit: 45,              // 今回は 45 加算 → 合計 90
  });

  const [msg, setMsg] = useState<string | null>(null);
  const [created, setCreated] = useState<any>(null);

  function set<K extends keyof typeof form>(k: K, v: any) {
    setForm(s => ({ ...s, [k]: v }));
  }

  async function create() {
    setMsg(null);
    setCreated(null);
    const res = await fetch('/api/admin/events/create-group-and-invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    const json = await res.json();
    if (json.ok) {
      setCreated(json);
      setMsg(`✅ 作成 success (group:${json.group.group_code}, eve:${json.invite.code})`);
    } else {
      setMsg(`❌ ${json.error}`);
    }
  }

  const sampleLink =
    created
      ? `https://join.muverse.jp/register?ref=<app_code>&rcode=${created.rcode}&mcode=${created.mcode}&eve=${created.invite.code}`
      : '';

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontWeight: 700, fontSize: 20, marginBottom: 12 }}>イベント用グループ作成 & 招待コード発行</h2>

      <div style={{ display:'grid', gridTemplateColumns:'180px 1fr', gap:8, alignItems:'center', border:'1px solid #eee', borderRadius:12, padding:12 }}>
        <label>グループコード</label>
        <input value={form.group_code} onChange={e=>set('group_code', e.target.value)} />
        <label>リーダー user_code</label>
        <input value={form.leader_user_code} onChange={e=>set('leader_user_code', e.target.value)} />
        <label>グループ名</label>
        <input value={form.group_name} onChange={e=>set('group_name', e.target.value)} />
        <label>最大使用回数</label>
        <input type="number" value={form.invite_max_uses} onChange={e=>set('invite_max_uses', parseInt(e.target.value || '0'))} />
        <label>有効期限(任意)</label>
        <input value={form.invite_expires_at} onChange={e=>set('invite_expires_at', e.target.value)} placeholder="2025-09-13T23:59:59+09:00" />
        <label>メモ</label>
        <input value={form.invite_notes} onChange={e=>set('invite_notes', e.target.value)} />

        {/* ★ 追加: イベント種別 */}
        <label>イベント種別</label>
        <select value={form.campaign_type} onChange={e=>set('campaign_type', e.target.value)}>
          <option value="bonus-credit">クレジット増量キャンペーン</option>
          <option value="none">なし</option>
        </select>

        {/* ★ 追加: 増量クレジット */}
        <label>増量クレジット</label>
        <input type="number" min={0} value={form.bonus_credit}
               onChange={e=>set('bonus_credit', parseInt(e.target.value || '0'))} />
      </div>

      <div style={{ marginTop: 10 }}>
        <button onClick={create} style={{ padding:'8px 12px', borderRadius:8, border:'1px solid #ddd' }}>作成</button>
      </div>
      {msg && <div style={{ marginTop: 10 }}>{msg}</div>}

      {created && (
        <div style={{ marginTop:12, border:'1px solid #eee', borderRadius:12, padding:12 }}>
          <div>Group: <b>{created.group.group_code}</b> / {created.group.name}</div>
          <div>Leader user_code (rcode): <b>{created.rcode}</b></div>
          <div>Event Invite Code (eve): <b>{created.invite.code}</b></div>
          <div>キャンペーン種別: <b>{created.invite.campaign_type || '-'}</b></div>
          <div>増量クレジット: <b>{created.invite.bonus_credit ?? 0}</b></div>
          <div>配布URL例:</div>
          <code style={{ display:'block', marginTop:6, wordBreak:'break-all' }}>{sampleLink}</code>
          <div style={{ marginTop:8, fontSize:12, color:'#6b7280' }}>
            ※ <b>ref</b> は参加者の <b>app_code</b> です。
          </div>
        </div>
      )}
    </div>
  );
}
