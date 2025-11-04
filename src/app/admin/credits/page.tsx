'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './page.css';
import { auth } from '@/lib/firebase';

// レジャー方式のトランザクション型
type Tx = {
  id: string;
  user_code: string | null;
  user_id: string | null;
  delta: number; // +付与 / -消費
  reason: string | null;
  idempotency_key: string | null;
  created_at: string;
};

// 検索結果（ユーザー要約）
type UserBrief = {
  user_code: string;
  click_email: string;
  credit_balance: number;
};

export default function CreditAdjustPage() {
  const [query, setQuery] = useState(''); // user_code or email
  const [selected, setSelected] = useState<UserBrief | null>(null);
  const [amount, setAmount] = useState<number>(45);
  const [reason, setReason] = useState('manual_grant');
  const [tx, setTx] = useState<Tx[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [message, setMessage] = useState<string>('');
  const [voidKey, setVoidKey] = useState('');

  const canSubmit = useMemo(() => selected && amount > 0 && !loading, [selected, amount, loading]);
  const canVoid = useMemo(() => selected && !!voidKey && !loading, [selected, voidKey, loading]);

  const withAuth = useCallback(async (url: string, init?: RequestInit) => {
    const token = await auth.currentUser?.getIdToken().catch(() => undefined);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(init?.headers as Record<string, string>),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    return fetch(url, { ...init, headers });
  }, []);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setFetching(true);
    setMessage('');
    try {
      const res = await withAuth(`/api/admin/users/search?q=${encodeURIComponent(query.trim())}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || json?.detail || 'search failed');
      const u: UserBrief | undefined = (json.items || [])[0];
      if (!u) {
        setSelected(null);
        setTx([]);
        setBalance(null);
        setMessage('ユーザーが見つかりませんでした');
        return;
      }
      setSelected(u);
      setBalance(u.credit_balance);
      await loadTx(u.user_code);
    } catch (e: any) {
      setMessage(`検索エラー：${String(e?.message || e)}`);
    } finally {
      setFetching(false);
    }
  }, [query, withAuth]);

  const loadTx = useCallback(
    async (user_code?: string) => {
      const code = user_code || selected?.user_code;
      if (!code) return;
      try {
        const r1 = await withAuth(
          `/api/admin/credit-tx?user_code=${encodeURIComponent(code)}&limit=50`,
        );
        const j1 = await r1.json();
        if (!r1.ok) throw new Error(j1?.error || j1?.detail || 'fetch failed');
        setTx(j1.items || []);
        // 最新残高
        const r2 = await withAuth(`/api/admin/users/search?q=${encodeURIComponent(code)}&exact=1`);
        const j2 = await r2.json();
        if (r2.ok && j2.items?.[0]) setBalance(j2.items[0].credit_balance);
      } catch (e) {
        // noop
      }
    },
    [selected?.user_code, withAuth],
  );

  const grant = useCallback(async () => {
    if (!canSubmit || !selected) return;
    setLoading(true);
    setMessage('');
    try {
      const res = await withAuth('/api/admin/grant-credit', {
        method: 'POST',
        body: JSON.stringify({
          user_code: selected.user_code,
          amount,
          reason: reason.trim() || 'manual_grant',
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || json?.detail || 'grant failed');
      setMessage(`付与完了：op_id=${json.op_id}`);
      setBalance(json?.credit_balance ?? balance);
      await loadTx(selected.user_code);
    } catch (e: any) {
      setMessage(`エラー：${String(e?.message || e)}`);
    } finally {
      setLoading(false);
    }
  }, [amount, balance, canSubmit, loadTx, reason, selected, withAuth]);

  const doVoid = useCallback(async () => {
    if (!canVoid || !selected) return;
    setLoading(true);
    setMessage('');
    try {
      const res = await withAuth('/api/admin/void-credit', {
        method: 'POST',
        body: JSON.stringify({ idempotency_key: voidKey }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || json?.detail || 'void failed');
      setMessage(`取消/相殺 完了：tx_id=${json.tx_id}`);
      setVoidKey('');
      await loadTx(selected.user_code);
    } catch (e: any) {
      setMessage(`取消エラー：${String(e?.message || e)}`);
    } finally {
      setLoading(false);
    }
  }, [canVoid, loadTx, selected, voidKey, withAuth]);

  // Enter で検索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') search();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [search]);

  return (
    <main className="credit-root">
      <h1 className="credit-title">クレジット調整（管理）</h1>

      <section className="credit-card">
        <div className="row">
          <input
            className="input grow"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="user_code または email を入力して検索"
          />
          <button className="btn" onClick={search} disabled={fetching}>
            {fetching ? '検索中…' : '検索'}
          </button>
        </div>

        {selected && (
          <div className="row info">
            <div>
              <div className="muted">user_code</div>
              <div className="mono">{selected.user_code}</div>
            </div>
            <div>
              <div className="muted">email</div>
              <div>{selected.click_email}</div>
            </div>
            <div>
              <div className="muted">残高</div>
              <div className="balance">{balance ?? '-'}</div>
            </div>
          </div>
        )}

        <div className="row two">
          <div className="col">
            <label className="label">付与量（正数）</label>
            <input
              type="number"
              className="input"
              min={1}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </div>
          <div className="col">
            <label className="label">理由</label>
            <input
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="promo / incident_refund / admin_postcomp など"
            />
          </div>
        </div>

        <div className="row gap">
          <span className="muted">プリセット:</span>
          <button
            className="chip"
            onClick={() => {
              setAmount(1);
              setReason('manual_grant');
            }}
          >
            +1
          </button>
          <button
            className="chip"
            onClick={() => {
              setAmount(10);
              setReason('promo10');
            }}
          >
            +10
          </button>
          <button
            className="chip"
            onClick={() => {
              setAmount(45);
              setReason('promo45');
            }}
          >
            +45
          </button>
          <button
            className="chip"
            onClick={() => {
              setAmount(90);
              setReason('promo90');
            }}
          >
            +90
          </button>
        </div>

        <div className="row actions">
          <button className="btn" disabled={!canSubmit} onClick={grant}>
            {loading ? '実行中…' : '付与/返金を実行'}
          </button>
          {message && <div className="message">{message}</div>}
        </div>
      </section>

      <section className="credit-card">
        <div className="row space">
          <h2 className="sub">直近トランザクション</h2>
          <button className="btn ghost" onClick={() => loadTx()} disabled={fetching}>
            {fetching ? '更新中…' : '再読み込み'}
          </button>
        </div>

        <div className="row">
          <input
            className="input grow"
            value={voidKey}
            onChange={(e) => setVoidKey(e.target.value)}
            placeholder="取消したい idempotency_key を入力（例: op-xxx）"
          />
          <button className="btn danger" onClick={doVoid} disabled={!canVoid}>
            取消/相殺
          </button>
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>日時</th>
                <th>delta</th>
                <th>reason</th>
                <th>idempotency_key</th>
              </tr>
            </thead>
            <tbody>
              {tx.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    なし
                  </td>
                </tr>
              )}
              {tx.map((t) => (
                <tr key={t.id}>
                  <td>{new Date(t.created_at).toLocaleString()}</td>
                  <td className={t.delta < 0 ? 'neg' : 'pos'}>{t.delta}</td>
                  <td>{t.reason || '-'}</td>
                  <td className="mono small">{t.idempotency_key}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
