// src/app/admin/register-logs/page.tsx
'use client';

import { useEffect, useState, useCallback } from 'react';
import AdminGate from '@/components/AdminGate';

type Row = {
  id: number;
  ip_address: string | null;
  phone_number: string | null;
  referral_code: string | null;
  created_at: string;
};

export default function RegisterLogsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [ip, setIp] = useState('');
  const [phone, setPhone] = useState('');
  const [limit, setLimit] = useState(200);
  const [loading, setLoading] = useState(false);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    const r = await fetch('/api/admin/register-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, phone, limit }),
    });
    const j = await r.json();
    setRows(j.rows || []);
    setLoading(false);
  }, [ip, phone, limit]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const exportCSV = () => {
    const headers = ['IP Address','Phone','Code','Created'];
    const lines = rows.map(r => [
      r.ip_address ?? '',
      r.phone_number ?? '',
      r.referral_code ?? '',
      r.created_at,
    ].map(x => `"${String(x).replaceAll('"','""')}"`).join(','));
    const blob = new Blob([[headers.join(','), ...lines].join('\n')], { type:'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'register_logs.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AdminGate>
      <main className="p-4">
        <h1 className="text-2xl font-bold mb-3">🧾 ユーザー登録ログ</h1>

        <div className="flex gap-2 flex-wrap mb-3">
          <input className="border p-2" placeholder="IPで検索" value={ip} onChange={e=>setIp(e.target.value)} />
          <input className="border p-2" placeholder="電話番号で検索" value={phone} onChange={e=>setPhone(e.target.value)} />
          <input className="border p-2 w-28" type="number" min={50} max={2000} step={50} value={limit} onChange={e=>setLimit(+e.target.value)} />
          <button className="bg-blue-600 text-white px-4 py-2" onClick={fetchLogs} disabled={loading}>
            {loading ? '読み込み中…' : '検索'}
          </button>
          <button className="bg-green-600 text-white px-4 py-2" onClick={exportCSV} disabled={rows.length===0}>
            CSVエクスポート
          </button>
        </div>

        <div className="border rounded overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-gray-100">
              <tr>
                <th className="border px-2 py-1">IP Address</th>
                <th className="border px-2 py-1">Phone</th>
                <th className="border px-2 py-1">Code</th>
                <th className="border px-2 py-1">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-500">データがありません</td></tr>
              )}
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="border px-2 py-1">{r.ip_address}</td>
                  <td className="border px-2 py-1">{r.phone_number}</td>
                  <td className="border px-2 py-1">{r.referral_code}</td>
                  <td className="border px-2 py-1">{new Date(r.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </AdminGate>
  );
}
