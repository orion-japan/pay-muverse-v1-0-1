// src/app/ops/sofia-logs-normalized/page.tsx
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import '../mu-logs/mu-logs.css';

type Conversation = {
  id: string;
  user_code: string;
  title: string | null;
  origin_app: string | null;
  conversation_code?: string | null;
  last_turn_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type ConversationDetail = Conversation;

type Turn = {
  id: string;
  conv_id: string;
  turn_index?: number | null;
  role: 'user' | 'assistant' | 'system' | string;
  content: string | null;
  used_credits?: number | string | null;
  source?: string | null;
  sub_id?: string | null;
  meta?: any;
  created_at: string | null;
};

type UserItem = {
  user_code: string;
  name: string;
  conversations: number;
  last_turn_at: string | null;
};

async function callApi(url: string) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'x-ops-api-key': process.env.NEXT_PUBLIC_UNUSED || '' },
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // JSONでないレスポンスはそのまま扱う
  }
  if (!res.ok) throw new Error(json?.error || json?.message || text || 'Request failed');
  return json;
}

const num = (v: any, fallback = 0) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export default function SofiaLogsNormalizedPage() {
  useEffect(() => {
    document.body.classList.add('mu-logs-desktop');
    return () => document.body.classList.remove('mu-logs-desktop');
  }, []);

  const [users, setUsers] = useState<UserItem[]>([]);
  const [userCode, setUserCode] = useState('');
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [convId, setConvId] = useState('');
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);

  // ユーザーリスト（Mu と同じ）
  useEffect(() => {
    (async () => {
      try {
        const data = await callApi('/api/sofia-logs/users');
        setUsers(data.users ?? []);
      } catch {
        setUsers([]);
      }
    })();
  }, []);

  // ユーザー選択 → 会話一覧（常に turn_type=normalized を付ける）
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!userCode) {
      setConversations(null);
      setConvId('');
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setListLoading(true);
      try {
        const params = new URLSearchParams({
          user_code: userCode,
          page_size: '200',
          turn_type: 'normalized',
        });
        const data = await callApi(`/api/sofia-logs?${params.toString()}`);
        const list: Conversation[] = data.conversations ?? [];
        setConversations(list);
        if (convId && !list.some((c) => c.id === convId)) setConvId('');
      } catch {
        setConversations([]);
      } finally {
        setListLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userCode]);

  // 会話選択 → 詳細＋ターン（normalized）
  useEffect(() => {
    (async () => {
      if (!convId) {
        setDetail(null);
        setTurns(null);
        return;
      }
      setLoading(true);
      try {
        const params = new URLSearchParams({
          conv_id: convId,
          turn_type: 'normalized',
        });
        const data = await callApi(`/api/sofia-logs?${params.toString()}`);
        setDetail(data.conversation ?? null);
        setTurns(data.turns ?? []);
      } catch (e: any) {
        alert(e?.message || '会話詳細の取得に失敗しました');
        setDetail(null);
        setTurns(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [convId]);

  // クレジット集計
  const creditStats = useMemo(() => {
    if (!turns?.length) {
      return {
        total: 0,
        totalAbs: 0,
        byRole: { assistant: 0, user: 0, system: 0, other: 0 },
        count: { assistant: 0, user: 0, system: 0, other: 0 },
        avgPerAssistant: 0,
      };
    }
    let total = 0;
    let totalAbs = 0;
    const byRole: Record<string, number> = {
      assistant: 0,
      user: 0,
      system: 0,
      other: 0,
    };
    const count: Record<string, number> = {
      assistant: 0,
      user: 0,
      system: 0,
      other: 0,
    };
    for (const t of turns) {
      const v = num(t.used_credits, 0);
      total += v;
      totalAbs += Math.abs(v);
      const r =
        t.role === 'assistant' || t.role === 'user' || t.role === 'system'
          ? t.role
          : 'other';
      byRole[r] += v;
      count[r] += 1;
    }
    const avgPerAssistant = count.assistant ? byRole.assistant / count.assistant : 0;
    return { total, totalAbs, byRole, count, avgPerAssistant };
  }, [turns]);

  // CSV
  const csvForTurns = useMemo(() => {
    if (!detail || !turns?.length) return '';
    const header = [
      'conv_id',
      'turn_id',
      'created_at',
      'role',
      'used_credits',
      'source',
      'sub_id',
      'content',
    ];
    const rows = turns.map((t) => [
      t.conv_id,
      t.id,
      t.created_at ?? '',
      t.role,
      num(t.used_credits, 0),
      t.source || '',
      t.sub_id || '',
      (t.content || '').replaceAll('\n', '\\n').replaceAll('"', '""'),
    ]);
    const lines = [header.join(','), ...rows.map((r) => r.map((x) => `"${String(x)}"`).join(','))];
    return lines.join('\r\n');
  }, [detail, turns]);

  const downloadCSV = () => {
    if (!csvForTurns) return;
    const blob = new Blob([csvForTurns], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = detail?.id ? `sofia_turns_normalized_${detail.id}.csv` : 'sofia_turns_normalized.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mu-logs-bleed">
      <div className="mu-logs-inner">
        <div className="muLogs">
          <h1 className="muLogs__title">Sofia Logs Viewer（normalized）</h1>

          {/* 検索UI：ユーザー → 会話 */}
          <section className="muLogs__search muLogs__search--3col">
            <div className="field">
              <label>User</label>
              <select value={userCode} onChange={(e) => setUserCode(e.target.value)}>
                <option value="">ユーザーを選択…</option>
                {users.map((u) => (
                  <option key={u.user_code} value={u.user_code}>
                    {u.name || u.user_code}｜{u.conversations}件
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>Conversation（normalized）</label>
              <select
                value={convId}
                onChange={(e) => setConvId(e.target.value)}
                disabled={!conversations || conversations.length === 0}
              >
                <option value="">
                  {conversations === null
                    ? '会話ID'
                    : listLoading
                    ? '読み込み中…'
                    : conversations.length === 0
                    ? '会話が見つかりません'
                    : '会話IDを選択…'}
                </option>
                {conversations?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id}
                    {c.title ? `｜${c.title}` : ''}
                    {c.last_turn_at ? `（${c.last_turn_at}）` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="actions">
              <button
                className="ghost"
                onClick={() => {
                  setUserCode('');
                  setConvId('');
                  setConversations(null);
                  setDetail(null);
                  setTurns(null);
                }}
              >
                クリア
              </button>
            </div>
          </section>

          {/* 会話一覧 */}
          {conversations && (
            <section>
              <h2 className="muLogs__h2">会話一覧（normalized / {conversations.length}）</h2>
              <table className="muLogs__table">
                <thead>
                  <tr>
                    <th>conv_id</th>
                    <th>title</th>
                    <th>origin_app</th>
                    <th>last_turn_at</th>
                    <th>created_at</th>
                    <th>open</th>
                  </tr>
                </thead>
                <tbody>
                  {conversations.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.id}</td>
                      <td>{c.title || ''}</td>
                      <td>{c.origin_app || ''}</td>
                      <td className="mono">{c.last_turn_at || ''}</td>
                      <td className="mono">{c.created_at || ''}</td>
                      <td>
                        <button onClick={() => setConvId(c.id)}>開く</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* 会話詳細 */}
          {detail && (
            <section>
              <h2 className="muLogs__h2">会話詳細（normalized）</h2>

              <div className="kv" style={{ marginBottom: 8 }}>
                <div>
                  <b>この会話の消費クレジット合計:</b>{' '}
                  <span className="mono">{fmt(creditStats.totalAbs)}</span>
                  <span style={{ marginLeft: 6, opacity: 0.7 }}>
                    （符号付き合計: {fmt(creditStats.total)}）
                  </span>
                </div>
                <div>
                  <b>内訳:</b> assistant{' '}
                  <span className="mono">{fmt(creditStats.byRole.assistant)}</span> ／ user{' '}
                  <span className="mono">{fmt(creditStats.byRole.user)}</span> ／ system{' '}
                  <span className="mono">{fmt(creditStats.byRole.system)}</span>
                </div>
                <div>
                  <b>件数:</b> assistant {creditStats.count.assistant} ／ user{' '}
                  {creditStats.count.user} ／ system {creditStats.count.system}
                </div>
                <div>
                  <b>assistant平均/turn:</b>{' '}
                  <span className="mono">{fmt(creditStats.avgPerAssistant)}</span>
                </div>
              </div>

              <div className="kv">
                <div>
                  <b>conv_id:</b> <span className="mono">{detail.id}</span>
                </div>
                <div>
                  <b>user_code:</b> <span className="mono">{detail.user_code}</span>
                </div>
                <div>
                  <b>title:</b> {detail.title || ''}
                </div>
                <div>
                  <b>origin_app:</b> {detail.origin_app || ''}
                </div>
                <div>
                  <b>conversation_code:</b>{' '}
                  <span className="mono">{detail.conversation_code || ''}</span>
                </div>
                <div>
                  <b>last_turn_at:</b> <span className="mono">{detail.last_turn_at || ''}</span>
                </div>
                <div>
                  <b>created_at:</b> <span className="mono">{detail.created_at || ''}</span>
                </div>
                <div>
                  <b>updated_at:</b> <span className="mono">{detail.updated_at || ''}</span>
                </div>
              </div>

              <div className="actions right">
                <button onClick={downloadCSV} disabled={!turns?.length}>
                  CSVエクスポート（normalized）
                </button>
              </div>

              <table className="muLogs__table muLogs__turns">
                <thead>
                  <tr>
                    <th>time</th>
                    <th>role</th>
                    <th>used</th>
                    <th>source</th>
                    <th>sub_id</th>
                    <th>content</th>
                  </tr>
                </thead>
                <tbody>
                  {turns?.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{t.created_at || ''}</td>
                      <td className={`role role--${t.role}`}>{t.role}</td>
                      <td className="mono">{fmt(num(t.used_credits, 0))}</td>
                      <td>{t.source || ''}</td>
                      <td className="mono">{t.sub_id || ''}</td>
                      <td className="content">{t.content || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {(loading || listLoading) && <p style={{ marginTop: 8 }}>読み込み中…</p>}
        </div>
      </div>
    </div>
  );
}
