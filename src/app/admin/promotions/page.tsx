'use client';

import { useEffect, useState } from 'react';

type Promo = {
  id: string;
  name: string;
  action: string;
  multiplier: number;
  bonus: number;
  start_at: string;
  end_at: string;
  expires_after_days: number | null;
  applies_to_group_id: string | null;
  applies_to_user_code: string | null;
  priority: number;
  is_active: boolean;
  created_at: string;
};

export default function PromotionPage() {
  const [items, setItems] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: '',
    action: 'daily',
    multiplier: 1,
    bonus: 0,
    start_at: '',
    end_at: '',
    expires_after_days: 30,
    applies_to_group_id: '',
    applies_to_user_code: '',
    priority: 100,
  });
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/promotions/list');
      const json = await res.json();
      if (json.ok) setItems(json.items);
      else setMsg(`❌ ${json.error}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // デフォで今日のJSTで 09:00〜23:59 を入れておく（必要に応じて調整）
    if (!form.start_at || !form.end_at) {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      const start = `${y}-${m}-${d}T09:00`;
      const end = `${y}-${m}-${d}T23:59`;
      setForm((s) => ({ ...s, start_at: start, end_at: end }));
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function set<K extends keyof typeof form>(k: K, v: any) {
    setForm((s) => ({ ...s, [k]: v }));
  }

  async function create() {
    setMsg(null);
    const payload = {
      ...form,
      applies_to_group_id: form.applies_to_group_id || null,
      applies_to_user_code: form.applies_to_user_code || null,
    };
    const res = await fetch('/api/admin/promotions/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (json.ok) {
      setMsg(`✅ 作成: ${json.promo.name}`);
      setForm((f) => ({ ...f, name: '' }));
      load();
    } else setMsg(`❌ ${json.error}`);
  }

  async function toggle(p: Promo) {
    const res = await fetch('/api/admin/promotions/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.id, is_active: !p.is_active }),
    });
    const json = await res.json();
    if (json.ok) {
      setMsg(`🔁 ${json.promo.name} → ${json.promo.is_active ? '有効' : '無効'}`);
      load();
    } else setMsg(`❌ ${json.error}`);
  }

  async function remove(p: Promo) {
    if (!confirm(`削除しますか？\n${p.name}`)) return;
    const res = await fetch('/api/admin/promotions/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.id }),
    });
    const json = await res.json();
    if (json.ok) {
      setMsg('🗑️ 削除しました');
      load();
    } else setMsg(`❌ ${json.error}`);
  }

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontWeight: 700, fontSize: 20, marginBottom: 12 }}>プロモーション設定</h2>

      {/* 作成フォーム */}
      <div style={{ border: '1px solid #e5e5e5', borderRadius: 12, padding: 12, marginBottom: 16 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '180px 1fr',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <label>名前</label>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} />
          <label>アクション</label>
          <select value={form.action} onChange={(e) => set('action', e.target.value)}>
            <option value="daily">daily</option>
            <option value="signup">signup</option>
            <option value="invite">invite</option>
          </select>
          <label>倍率</label>
          <input
            type="number"
            step="0.1"
            value={form.multiplier}
            onChange={(e) => set('multiplier', parseFloat(e.target.value))}
          />
          <label>ボーナス</label>
          <input
            type="number"
            value={form.bonus}
            onChange={(e) => set('bonus', parseInt(e.target.value || '0'))}
          />
          <label>開始</label>
          <input
            type="datetime-local"
            value={form.start_at}
            onChange={(e) => set('start_at', e.target.value)}
          />
          <label>終了</label>
          <input
            type="datetime-local"
            value={form.end_at}
            onChange={(e) => set('end_at', e.target.value)}
          />
          <label>付与の有効期限(日)</label>
          <input
            type="number"
            value={form.expires_after_days ?? 0}
            onChange={(e) => set('expires_after_days', parseInt(e.target.value || '0'))}
          />
          <label>対象グループID(任意)</label>
          <input
            value={form.applies_to_group_id}
            onChange={(e) => set('applies_to_group_id', e.target.value)}
            placeholder="uuid or 空"
          />
          <label>対象ユーザーコード(任意)</label>
          <input
            value={form.applies_to_user_code}
            onChange={(e) => set('applies_to_user_code', e.target.value)}
            placeholder="user_code or 空"
          />
          <label>優先度(小さいほど優先)</label>
          <input
            type="number"
            value={form.priority}
            onChange={(e) => set('priority', parseInt(e.target.value || '100'))}
          />
        </div>
        <div style={{ marginTop: 10 }}>
          <button
            onClick={create}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd' }}
          >
            作成
          </button>
        </div>
      </div>

      {msg && <div style={{ marginBottom: 12 }}>{msg}</div>}

      {/* 一覧 */}
      <h3 style={{ fontWeight: 700, fontSize: 16, margin: '6px 0' }}>登録済み</h3>
      {loading ? (
        <div>読み込み中...</div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {items.map((p) => (
            <div key={p.id} style={{ border: '1px solid #eee', borderRadius: 10, padding: 10 }}>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div>
                  <div style={{ fontWeight: 700 }}>
                    {p.name} {p.is_active ? '🟢' : '⚪️'}
                  </div>
                  <div style={{ color: '#666', fontSize: 12 }}>
                    {p.action} / x{p.multiplier} +{p.bonus} /{' '}
                    {new Date(p.start_at).toLocaleString()} - {new Date(p.end_at).toLocaleString()}
                    {p.expires_after_days ? ` / 期限 ${p.expires_after_days}日` : ''}
                    {p.priority !== 100 ? ` / prio ${p.priority}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => toggle(p)}
                    style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 8 }}
                  >
                    {p.is_active ? '無効化' : '有効化'}
                  </button>
                  <button
                    onClick={() => remove(p)}
                    style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 8 }}
                  >
                    削除
                  </button>
                </div>
              </div>
            </div>
          ))}
          {items.length === 0 && <div style={{ color: '#666' }}>まだありません</div>}
        </div>
      )}
    </div>
  );
}
