// src/app/ops/sofia-logs/page.tsx
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import '../mu-logs/mu-logs.css'; // PC幅CSSを再利用

/** ===== 型 ===== */
type Conversation = {
  id: string;
  user_code: string;
  title: string | null;
  origin_app: string | null;         // sofia_conversations に追加済み想定（無いなら空で返る）
  conversation_code?: string | null; // ← Sofia 実体キー（APIが返す前提）
  last_turn_at: string | null;       // sofia_conversations に追加済み想定（無いなら空で返る）
  created_at: string | null;
  updated_at: string | null;
};

type ConversationDetail = Conversation;

type Turn = {
  id: string;
  conv_id: string; // sofia_conversations.id を返す（API側で揃えてある）
  role: 'user' | 'assistant' | 'system' | string;
  content: string | null;
  meta?: any;
  used_credits?: number | null;
  source_app?: string | null;
  sub_id?: string | null;
  attachments?: any;
  created_at: string | null;
};

/** ===== API 呼び出し ===== */
async function callApi(url: string) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      'x-ops-api-key': process.env.NEXT_PUBLIC_UNUSED || '',
    },
  });
  // レスポンス本文を読みつつ、エラーならJSONをそのまま throw
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* noop */
  }
  if (!res.ok) {
    const msg = json?.error || json?.message || text || 'Request failed';
    throw new Error(msg);
  }
  return json;
}

export default function SofiaLogsPage() {
  // ★ PC幅にする（ヘッダー/フッターはそのまま）
  useEffect(() => {
    document.body.classList.add('mu-logs-desktop');
    return () => document.body.classList.remove('mu-logs-desktop');
  }, []);

  const [userCode, setUserCode] = useState('');
  const [convId, setConvId] = useState('');
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);

  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [turns, setTurns] = useState<Turn[] | null>(null);

  // user_code 入力から400ms後に一覧取得
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!userCode.trim()) {
      setConversations(null);
      setConvId('');
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setListLoading(true);
      try {
        const params = new URLSearchParams({
          user_code: userCode.trim(),
          page_size: '200',
        });
        const data = await callApi(`/api/sofia-logs?${params.toString()}`);
        const list: Conversation[] = data.conversations ?? [];
        setConversations(list);
        // convId がリストに無ければクリア
        if (convId && !list.some((c) => c.id === convId)) {
          setConvId('');
        }
      } catch (e: any) {
        console.error(e);
        setConversations([]);
      } finally {
        setListLoading(false);
      }
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userCode]);

  // convId 選択で詳細ロード
  useEffect(() => {
    (async () => {
      if (!convId.trim()) {
        setDetail(null);
        setTurns(null);
        return;
      }
      setLoading(true);
      try {
        const params = new URLSearchParams({ conv_id: convId.trim() });
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

  // CSV
  const csvForTurns = useMemo(() => {
    if (!detail || !turns?.length) return '';
    const header = [
      'conv_id',
      'turn_id',
      'created_at',
      'role',
      'used_credits',
      'source_app',
      'sub_id',
      'content',
    ];
    const rows = turns.map((t) => [
      t.conv_id,
      t.id,
      t.created_at ?? '',
      t.role,
      t.used_credits ?? '',
      t.source_app ?? '',
      t.sub_id ?? '',
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
    const name = detail?.id ? `sofia_turns_${detail.id}.csv` : 'sofia_turns.csv';
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mu-logs-bleed">
      <div className="mu-logs-inner">
        <div className="muLogs">
          <h1 className="muLogs__title">Sofia Logs Viewer</h1>

          <section className="muLogs__search muLogs__search--3col">
            <div className="field">
              <label>User Code</label>
              <input
                value={userCode}
                onChange={(e) => setUserCode(e.target.value)}
                placeholder="例: 669933 / U-XXXXXX"
              />
            </div>

            <div className="field">
              <label>Conversation</label>
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
              <h2 className="muLogs__h2">会話一覧（{conversations.length}）</h2>
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
              <h2 className="muLogs__h2">会話詳細</h2>
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
                  <b>last_turn_at:</b>{' '}
                  <span className="mono">{detail.last_turn_at || ''}</span>
                </div>
                <div>
                  <b>created_at:</b>{' '}
                  <span className="mono">{detail.created_at || ''}</span>
                </div>
                <div>
                  <b>updated_at:</b>{' '}
                  <span className="mono">{detail.updated_at || ''}</span>
                </div>
              </div>

              <div className="actions right">
                <button onClick={downloadCSV} disabled={!turns?.length}>
                  CSVエクスポート
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
                      <td className="mono">{t.used_credits ?? ''}</td>
                      <td>{t.source_app || ''}</td>
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
