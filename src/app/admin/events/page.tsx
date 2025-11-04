// src/app/admin/events/page.tsx
'use client';
import { useEffect, useMemo, useState } from 'react';

/* ===== ユーティリティ ===== */
function toJSTDate(d: Date) {
  // 表示用に「JSTで1か月後の 23:59:59」を作る
  // JSのDateは内部UTC、toLocaleStringは環境依存なので手で+09:00表記を作る
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}T23:59:59+09:00`;
}
function oneMonthLaterJSTString() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return toJSTDate(d);
}
// 簡易バリデーション（英数とハイフンのみ/4〜32文字）
function isValidEventCode(s: string) {
  if (!s) return true;
  return /^[A-Za-z0-9-]{4,32}$/.test(s);
}

export default function EventToolsPage() {
  const [form, setForm] = useState({
    group_code: '',
    leader_user_code: '',
    group_name: '',
    invite_max_uses: 1000,
    invite_expires_at: '', // ← 初期表示時に1か月後(JST)を自動セット
    invite_notes: 'event',
    campaign_type: 'bonus-credit',
    bonus_credit: 45,

    // ★ 追加：イベントコード（= URLの eve）
    event_code: '',

    // ★ 追加：URLの ref として埋め込む app_code
    app_code: '336699', // 既定値。必要に応じて編集
  });

  const [msg, setMsg] = useState<string | null>(null);
  const [created, setCreated] = useState<any>(null);

  function set<K extends keyof typeof form>(k: K, v: any) {
    setForm((s) => ({ ...s, [k]: v }));
  }

  // 初期マウント時に有効期限へデフォルト（1か月後JST）を入れる
  useEffect(() => {
    if (!form.invite_expires_at) {
      setForm((s) => ({ ...s, invite_expires_at: oneMonthLaterJSTString() }));
    }
  }, []); // eslint-disable-line

  async function create() {
    setMsg(null);
    setCreated(null);

    if (!isValidEventCode(form.event_code)) {
      setMsg('❌ イベントコードは英数とハイフンのみ、4〜32文字にしてください（空も可）。');
      return;
    }

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
      setMsg(`❌ ${json.error || '作成に失敗しました'}`);
    }
  }

  // 表示用URL
  const sampleLink = useMemo(() => {
    if (!created) return '';
    const eve = form.event_code || created.invite?.code || '';
    const ref = (form.app_code || '').trim() || '<app_code>';
    return `https://join.muverse.jp/register?ref=${encodeURIComponent(ref)}&rcode=${encodeURIComponent(created.rcode)}&mcode=${encodeURIComponent(created.mcode)}&eve=${encodeURIComponent(eve)}`;
  }, [created, form.event_code, form.app_code]);

  function copy(text: string) {
    if (!text) return;
    navigator.clipboard?.writeText(text);
    setMsg('📋 コピーしました');
  }

  // QR画像URL（外部のQR生成APIを使用）
  const qrUrl = useMemo(() => {
    if (!sampleLink) return '';
    const size = 320;
    return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(sampleLink)}`;
  }, [sampleLink]);

  // QRダウンロード
  const downloadQR = async () => {
    if (!qrUrl) return;
    // そのまま a[download] でOK（同一生成URL）
    const a = document.createElement('a');
    a.href = qrUrl;
    a.download = 'invite_qr.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontWeight: 700, fontSize: 20, marginBottom: 12 }}>
        イベント用グループ作成 & 招待コード発行
      </h2>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '180px 1fr',
          gap: 8,
          alignItems: 'center',
          border: '1px solid #eee',
          borderRadius: 12,
          padding: 12,
        }}
      >
        <label>グループコード</label>
        <input value={form.group_code} onChange={(e) => set('group_code', e.target.value)} />

        <label>リーダー user_code（= rcode）</label>
        <input
          value={form.leader_user_code}
          onChange={(e) => set('leader_user_code', e.target.value)}
        />

        <label>グループ名</label>
        <input value={form.group_name} onChange={(e) => set('group_name', e.target.value)} />

        <label>最大使用回数</label>
        <input
          type="number"
          value={form.invite_max_uses}
          onChange={(e) => set('invite_max_uses', parseInt(e.target.value || '0'))}
        />

        <label>有効期限(任意)</label>
        <input
          value={form.invite_expires_at}
          onChange={(e) => set('invite_expires_at', e.target.value)}
          placeholder="2025-09-13T23:59:59+09:00"
        />

        <label>メモ</label>
        <input value={form.invite_notes} onChange={(e) => set('invite_notes', e.target.value)} />

        <label>イベント種別</label>
        <select value={form.campaign_type} onChange={(e) => set('campaign_type', e.target.value)}>
          <option value="bonus-credit">クレジット増量キャンペーン</option>
          <option value="none">なし</option>
        </select>

        <label>増量クレジット</label>
        <input
          type="number"
          min={0}
          value={form.bonus_credit}
          onChange={(e) => set('bonus_credit', parseInt(e.target.value || '0'))}
        />

        {/* ★ 追加：イベントコード（= eve） */}
        <label>
          イベントコード（eve）
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            例: <code>QME-20250913</code>（英数・ハイフン、4〜32文字。空なら自動作成）
          </div>
        </label>
        <input
          value={form.event_code}
          onChange={(e) => set('event_code', e.target.value.trim())}
          placeholder="QME-20250913"
          style={{
            borderColor: isValidEventCode(form.event_code) ? '#ddd' : '#f43f5e',
            outline: 'none',
          }}
        />

        {/* ★ 追加：app_code */}
        <label>
          app_code（ref）
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            参加者の所属コード。URLの <b>ref</b> に入ります。
          </div>
        </label>
        <input
          value={form.app_code}
          onChange={(e) => set('app_code', e.target.value)}
          placeholder="336699"
        />
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        <button
          onClick={create}
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd' }}
        >
          作成
        </button>
        {sampleLink && (
          <>
            <button
              onClick={() => copy(sampleLink)}
              style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd' }}
            >
              URLをコピー
            </button>
            <button
              onClick={downloadQR}
              style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd' }}
            >
              QRダウンロード
            </button>
          </>
        )}
      </div>

      {msg && <div style={{ marginTop: 10 }}>{msg}</div>}

      {created && (
        <div style={{ marginTop: 12, border: '1px solid #eee', borderRadius: 12, padding: 12 }}>
          <div>
            Group: <b>{created.group.group_code}</b> / {created.group.name}
          </div>
          <div>
            Leader user_code (rcode): <b>{created.rcode}</b>
          </div>
          <div>
            Event Invite Code (eve): <b>{form.event_code || created.invite.code}</b>
          </div>
          <div>
            キャンペーン種別: <b>{created.invite.campaign_type || '-'}</b>
          </div>
          <div>
            増量クレジット: <b>{created.invite.bonus_credit ?? 0}</b>
          </div>

          <div style={{ marginTop: 6 }}>配布URL例:</div>
          <code style={{ display: 'block', marginTop: 6, wordBreak: 'break-all' }}>
            {sampleLink}
          </code>
          <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>
            ※ <b>ref</b> は参加者の <b>app_code</b> です。
          </div>

          {/* QR プレビュー */}
          {qrUrl && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>QRコード</div>
              <img
                src={qrUrl}
                alt="Invite QR"
                width={240}
                height={240}
                style={{ border: '1px solid #eee', borderRadius: 8, background: '#fff' }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
