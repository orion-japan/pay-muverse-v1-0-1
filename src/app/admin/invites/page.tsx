// src/app/admin/invites/page.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';

type InviteRow = {
  id: string;
  short_code: string;
  short_url: string;
  destination_url: string;
  ref?: string | null;
  rcode?: string | null;
  mcode?: string | null;
  media_code?: string | null;
  label?: string | null;
  memo?: string | null;
  click_count: number;
  is_active: boolean;
  created_at: string;
};

const mediaOptions = ['AP', 'LINE', 'X', 'Instagram', 'TikTok', 'Seminar', 'QR', 'Other'];

export default function AdminInvitesPage() {
  const [form, setForm] = useState({
    label: 'MuBook無料版',
    ref: '336699',
    rcode: '',
    mcode: '',
    media_code: 'AP',
    short_code: '',
    destination_url: 'https://mu-verse.jp/free-mubook/',
    memo: '',
    created_by: '',
  });
  const [rows, setRows] = useState<InviteRow[]>([]);
  const [created, setCreated] = useState<any>(null);
  const [msg, setMsg] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const qrUrl = useMemo(() => {
    if (!created?.short_url) return '';
    return `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(
      created.short_url,
    )}`;
  }, [created]);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((s) => ({ ...s, [key]: value }));
  }

  async function loadRows() {
    const res = await fetch('/api/admin/invites/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 80 }),
    });
    const json = await res.json();
    if (json.ok) setRows(json.rows || []);
  }

  async function createInvite() {
    setMsg('');
    setCreated(null);
    setLoading(true);
    try {
      const res = await fetch('/api/admin/invites/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!json.ok) {
        setMsg(`❌ ${json.error || '作成に失敗しました'}`);
        return;
      }
      setCreated(json);
      setMsg('✅ 招待リンクを発行しました');
      await loadRows();
    } catch (e: any) {
      setMsg(`❌ ${e?.message || '作成に失敗しました'}`);
    } finally {
      setLoading(false);
    }
  }

  async function copy(text: string) {
    await navigator.clipboard?.writeText(text);
    setMsg('📋 コピーしました');
  }

  useEffect(() => {
    loadRows();
  }, []);

  return (
    <main style={styles.page}>
      <div style={styles.wrap}>
        <div style={styles.header}>
          <div>
            <p style={styles.kicker}>Invite Links</p>
            <h1 style={styles.title}>招待リンク発行</h1>
            <p style={styles.lead}>MuBook無料版を短いURLで配布し、媒体別に追跡します。</p>
          </div>
          <a href="/admin" style={styles.backLink}>
            管理トップへ
          </a>
        </div>

        <section style={styles.panel}>
          <h2 style={styles.sectionTitle}>新規発行</h2>
          <div style={styles.formGrid}>
            <Field label="ラベル">
              <input value={form.label} onChange={(e) => set('label', e.target.value)} style={styles.input} />
            </Field>
            <Field label="ref">
              <input value={form.ref} onChange={(e) => set('ref', e.target.value)} style={styles.input} />
            </Field>
            <Field label="rcode（必須）">
              <input
                value={form.rcode}
                onChange={(e) => set('rcode', e.target.value)}
                style={styles.input}
                placeholder="例: 669933"
              />
            </Field>
            <Field label="mcode">
              <input value={form.mcode} onChange={(e) => set('mcode', e.target.value)} style={styles.input} />
            </Field>
            <Field label="媒体">
              <select
                value={form.media_code}
                onChange={(e) => set('media_code', e.target.value)}
                style={styles.input}
              >
                {mediaOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="短縮コード（空なら自動）">
              <input
                value={form.short_code}
                onChange={(e) => set('short_code', e.target.value)}
                style={styles.input}
                placeholder="例: mubook01"
              />
            </Field>
            <Field label="転送先URL">
              <input
                value={form.destination_url}
                onChange={(e) => set('destination_url', e.target.value)}
                style={styles.input}
              />
            </Field>
            <Field label="メモ">
              <input value={form.memo} onChange={(e) => set('memo', e.target.value)} style={styles.input} />
            </Field>
          </div>

          <div style={styles.actions}>
            <button onClick={createInvite} disabled={loading} style={styles.primaryButton}>
              {loading ? '発行中…' : '短縮URLを発行'}
            </button>
            {msg && <span style={styles.msg}>{msg}</span>}
          </div>
        </section>

        {created && (
          <section style={styles.resultPanel}>
            <div>
              <h2 style={styles.sectionTitle}>発行完了</h2>
              <p style={styles.small}>配布URL</p>
              <code style={styles.code}>{created.short_url}</code>
              <div style={styles.actions}>
                <button onClick={() => copy(created.short_url)} style={styles.secondaryButton}>
                  URLコピー
                </button>
                <button onClick={() => copy(created.destination_url)} style={styles.secondaryButton}>
                  転送先コピー
                </button>
              </div>
              <p style={styles.small}>転送先</p>
              <code style={styles.code}>{created.destination_url}</code>
            </div>
            {qrUrl && <img src={qrUrl} alt="QR" width={180} height={180} style={styles.qr} />}
          </section>
        )}

        <section style={styles.panel}>
          <div style={styles.listHead}>
            <h2 style={styles.sectionTitle}>発行済みリンク</h2>
            <button onClick={loadRows} style={styles.secondaryButton}>
              更新
            </button>
          </div>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>ラベル</th>
                  <th style={styles.th}>短縮URL</th>
                  <th style={styles.th}>媒体</th>
                  <th style={styles.th}>rcode</th>
                  <th style={styles.th}>クリック</th>
                  <th style={styles.th}>作成日</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td style={styles.td}>{row.label || '-'}</td>
                    <td style={styles.td}>
                      <button onClick={() => copy(row.short_url)} style={styles.linkButton}>
                        {row.short_url}
                      </button>
                    </td>
                    <td style={styles.td}>{row.media_code || '-'}</td>
                    <td style={styles.td}>{row.rcode || '-'}</td>
                    <td style={styles.td}>{row.click_count || 0}</td>
                    <td style={styles.td}>{new Date(row.created_at).toLocaleString('ja-JP')}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={6} style={styles.empty}>
                      まだ発行済みリンクがありません。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={styles.field}>
      <span style={styles.label}>{label}</span>
      {children}
    </label>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'linear-gradient(180deg, #f7f3ff 0%, #fff 46%, #f7fbff 100%)',
    padding: '24px 14px 60px',
    color: '#1f2937',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  wrap: { maxWidth: 1080, margin: '0 auto' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  kicker: { margin: 0, color: '#7c3aed', fontWeight: 700, letterSpacing: '.04em' },
  title: { margin: '4px 0 8px', fontSize: 30 },
  lead: { margin: 0, color: '#6b7280', lineHeight: 1.7 },
  backLink: { color: '#7c3aed', textDecoration: 'none', fontWeight: 700 },
  panel: {
    background: 'rgba(255,255,255,0.92)',
    border: '1px solid rgba(17,24,39,0.08)',
    borderRadius: 22,
    padding: 18,
    marginBottom: 14,
    boxShadow: '0 12px 35px rgba(15,23,42,0.05)',
  },
  resultPanel: {
    background: '#fff',
    border: '1px solid rgba(124,58,237,0.18)',
    borderRadius: 22,
    padding: 18,
    marginBottom: 14,
    display: 'flex',
    justifyContent: 'space-between',
    gap: 16,
    flexWrap: 'wrap',
  },
  sectionTitle: { margin: '0 0 14px', fontSize: 19 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12 },
  field: { display: 'grid', gap: 6 },
  label: { fontSize: 13, color: '#6b7280', fontWeight: 700 },
  input: {
    width: '100%',
    minHeight: 42,
    border: '1px solid #e5e7eb',
    borderRadius: 12,
    padding: '0 12px',
    fontSize: 15,
    background: '#fff',
  },
  actions: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 },
  primaryButton: {
    minHeight: 42,
    padding: '0 16px',
    border: 0,
    borderRadius: 999,
    background: '#7c3aed',
    color: '#fff',
    fontWeight: 700,
    cursor: 'pointer',
  },
  secondaryButton: {
    minHeight: 38,
    padding: '0 13px',
    border: '1px solid #e5e7eb',
    borderRadius: 999,
    background: '#fff',
    color: '#374151',
    fontWeight: 700,
    cursor: 'pointer',
  },
  msg: { color: '#374151', fontSize: 14 },
  small: { margin: '8px 0 4px', color: '#6b7280', fontSize: 13, fontWeight: 700 },
  code: {
    display: 'block',
    padding: 10,
    borderRadius: 12,
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    wordBreak: 'break-all',
  },
  qr: { borderRadius: 14, border: '1px solid #eee', background: '#fff' },
  listHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  th: { textAlign: 'left', padding: '10px 8px', borderBottom: '1px solid #e5e7eb', color: '#6b7280' },
  td: { padding: '11px 8px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' },
  linkButton: { border: 0, background: 'transparent', color: '#7c3aed', cursor: 'pointer', padding: 0, textAlign: 'left' },
  empty: { padding: 24, textAlign: 'center', color: '#6b7280' },
};
