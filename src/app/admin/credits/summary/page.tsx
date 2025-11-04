'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './summary.css';
import { auth } from '@/lib/firebase';

type SummaryRow = {
  group_value: string | null;
  user_count: number;
  total_balance: number;
  consumed_7d: number;
  granted_7d: number;
};

type UserRow = {
  user_code: string;
  click_email: string;
  credit_balance: number;
  plan_status?: string | null;
  plan?: string | null;
  click_type?: string | null;
};

export default function CreditSummaryPage() {
  const [groupBy, setGroupBy] = useState<'plan_status' | 'plan' | 'click_type'>('plan_status');
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTitle, setDrawerTitle] = useState('');
  const [list, setList] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);

  const withAuth = useCallback(async (url: string) => {
    const token = await auth.currentUser?.getIdToken().catch(() => undefined);
    return fetch(url, {
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setMsg('');
    try {
      const res = await withAuth(`/api/admin/credits/summary?group_by=${groupBy}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || json?.detail || 'fetch failed');
      setRows(json.items || []);
    } catch (e: any) {
      setMsg(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [groupBy, withAuth]);

  useEffect(() => {
    load();
  }, [load]);

  const openGroup = useCallback(
    async (value: string | null) => {
      if (value == null) return;
      setDrawerOpen(true);
      setDrawerTitle(`${groupBy} = ${value}`);
      setPage(0);
      const res = await withAuth(
        `/api/admin/credits/summary/users?group_by=${groupBy}&value=${encodeURIComponent(value)}&limit=100&offset=0`,
      );
      const json = await res.json();
      if (res.ok) {
        setList(json.items || []);
        setTotal(json.total || 0);
      } else {
        setList([]);
        setTotal(0);
        setMsg(json?.error || json?.detail || 'fetch failed');
      }
    },
    [groupBy, withAuth],
  );

  const nextPage = useCallback(
    async (dir: 1 | -1) => {
      const newPage = Math.max(page + dir, 0);
      const value = drawerTitle.split(' = ').pop() || '';
      const offset = newPage * 100;
      const res = await withAuth(
        `/api/admin/credits/summary/users?group_by=${groupBy}&value=${encodeURIComponent(value)}&limit=100&offset=${offset}`,
      );
      const json = await res.json();
      if (res.ok) {
        setList(json.items || []);
        setPage(newPage);
      }
    },
    [page, groupBy, drawerTitle, withAuth],
  );

  const colsLabel = useMemo(
    () =>
      ({
        plan_status: 'プラン状態',
        plan: 'プラン',
        click_type: 'タイプ',
      }) as const,
    [],
  );

  return (
    <main className="sum-root">
      <h1 className="sum-title">ユーザークレジット情報一覧（タイプ別）</h1>

      <section className="sum-card">
        <div className="row">
          <label className="label">グルーピング</label>
          <select
            className="input"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as any)}
          >
            <option value="plan_status">plan_status</option>
            <option value="plan">plan</option>
            <option value="click_type">click_type</option>
          </select>
          <button className="btn" onClick={load} disabled={loading}>
            {loading ? '更新中…' : '更新'}
          </button>
        </div>

        {msg && <div className="message">{msg}</div>}

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{colsLabel[groupBy]}</th>
                <th>ユーザー数</th>
                <th>残高合計</th>
                <th>消費（7日）</th>
                <th>付与（7日）</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    なし
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr
                  key={String(r.group_value)}
                  onClick={() => openGroup(r.group_value ?? '')}
                  className="clickable"
                >
                  <td>{r.group_value ?? '(null)'}</td>
                  <td>{r.user_count}</td>
                  <td>{r.total_balance}</td>
                  <td>{r.consumed_7d}</td>
                  <td>{r.granted_7d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {drawerOpen && (
        <section className="sum-card drawer">
          <div className="row space">
            <h2 className="sub">{drawerTitle} — 該当ユーザー</h2>
            <div className="row">
              <button className="btn ghost" onClick={() => nextPage(-1)} disabled={page === 0}>
                ←
              </button>
              <div className="muted">page {page + 1}</div>
              <button
                className="btn ghost"
                onClick={() => nextPage(1)}
                disabled={(page + 1) * 100 >= total}
              >
                →
              </button>
              <button className="btn danger" onClick={() => setDrawerOpen(false)}>
                閉じる
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>user_code</th>
                  <th>email</th>
                  <th>balance</th>
                  <th>plan_status</th>
                  <th>plan</th>
                  <th>click_type</th>
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      なし
                    </td>
                  </tr>
                )}
                {list.map((u) => (
                  <tr key={u.user_code}>
                    <td className="mono">{u.user_code}</td>
                    <td>{u.click_email}</td>
                    <td>{u.credit_balance}</td>
                    <td>{u.plan_status ?? '-'}</td>
                    <td>{u.plan ?? '-'}</td>
                    <td>{u.click_type ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted">合計: {total}</div>
        </section>
      )}
    </main>
  );
}
