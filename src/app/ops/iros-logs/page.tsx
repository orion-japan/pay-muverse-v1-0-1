// src/app/ops/iros-logs/page.tsx
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import '../mu-logs/mu-logs.css';

type Conversation = {
  id: string;
  user_code: string | null;
  last_turn_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  turns_count: number;
};

type ConversationDetail = Conversation;

type Turn = {
  id: string;
  conv_id: string;
  role: 'user' | 'assistant' | string;
  content: string | null;
  q_code: string | null;
  depth_stage: string | null;
  self_acceptance: number | null;
  meta?: any;
  used_credits: number | null;
  created_at: string | null;
};

// 共通 API 呼び出しヘルパ
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
    // JSON でないレスポンスはそのまま扱う
  }
  if (!res.ok) {
    throw new Error(json?.error || json?.message || text || 'Request failed');
  }
  return json;
}

const num = (v: any, fallback = 0) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * 旧Irosの「[お金・収入]: {...}」や
 * 先頭の【IROS_STATE_META】... 行を削るヘルパ
 */
function stripLegacyMetaHeader(raw: string | null | undefined): string {
  if (!raw) return '';
  const lines = raw.split('\n');
  if (lines.length === 0) return '';

  const first = lines[0].trimStart();

  // ① 新Iros用: 先頭が 【IROS_STATE_META】 で始まる行なら削る
  if (first.startsWith('【IROS_STATE_META】')) {
    const rest = lines.slice(1).join('\n').trimStart();
    return rest;
  }

  // ② 旧Iros用: 1行目に { と } が両方あれば「旧meta行」とみなして削除
  if (first.includes('{') && first.includes('}')) {
    const rest = lines.slice(1).join('\n').trimStart();
    return rest;
  }

  // どちらでもなければそのまま返す
  return raw;
}


/**
 * Y/H をアイコン付きで表示するヘルパ
 * （ログ CSV には生の数値をそのまま出す）
 */
function formatYDisplay(yLevel: any): string {
  if (yLevel === null || yLevel === undefined || yLevel === '') return '';
  const value = num(yLevel, 0);
  let icon = '🧊'; // 揺れ小さい・凍りつき
  if (value >= 3) {
    icon = '🔥'; // 揺れが大きい
  } else if (value >= 1) {
    icon = '🌱'; // 建設的な揺れ
  }
  return `${icon} ${fmt(value)}`;
}

function formatHDisplay(hLevel: any): string {
  if (hLevel === null || hLevel === undefined || hLevel === '') return '';
  const value = num(hLevel, 0);
  let icon = '⚠️'; // 余白少ない
  if (value >= 3) {
    icon = '🌈'; // 余白たっぷり
  } else if (value >= 1) {
    icon = '🙂'; // そこそこ余裕
  }
  return `${icon} ${fmt(value)}`;
}

export default function IrosLogsPage() {
  useEffect(() => {
    document.body.classList.add('mu-logs-desktop');
    return () => document.body.classList.remove('mu-logs-desktop');
  }, []);

  const [userCode, setUserCode] = useState('');
  const [userOptions, setUserOptions] = useState<string[] | null>(null);
  const [userListLoading, setUserListLoading] = useState(false);

  const [conversations, setConversations] = useState<Conversation[] | null>(
    null,
  );
  const [convId, setConvId] = useState('');
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);

  // --- ユーザー一覧取得（初回のみ） ---
  useEffect(() => {
    (async () => {
      setUserListLoading(true);
      try {
        const data = await callApi('/api/iros-logs?user_list=1');
        const users: string[] = data.users ?? [];
        setUserOptions(users);
      } catch {
        setUserOptions([]);
      } finally {
        setUserListLoading(false);
      }
    })();
  }, []);

  // user_code 選択 → 会話一覧取得
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
        });
        const data = await callApi(`/api/iros-logs?${params.toString()}`);
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

  // conv_id 選択 → 詳細・ターン取得
  useEffect(() => {
    (async () => {
      if (!convId) {
        setDetail(null);
        setTurns(null);
        return;
      }
      setLoading(true);
      try {
        const params = new URLSearchParams({ conv_id: convId });
        const data = await callApi(`/api/iros-logs?${params.toString()}`);
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

  // CSV（Iros 用：q_code / depth_stage / self_acceptance を含める）
  const csvForTurns = useMemo(() => {
    if (!detail || !turns?.length) return '';

    const header = [
      'conv_id',
      'turn_id',
      'created_at',
      'role',
      'q_code',
      'depth_stage',
      'self_acceptance',
      'y_level',
      'h_level',
      'polarity_score',
      'polarity_band',
      'stability_band',
      'mirror_mode',
      'intent_layer',
      'intent_line',
      'situation_topic',
      'unified_summary',
      'content',
    ];
    const lines = [header.join(',')];

    for (const t of turns) {
      const meta = (t.meta ?? {}) as any;
      const yLevel = meta?.yLevel ?? meta?.y_level ?? '';
      const hLevel = meta?.hLevel ?? meta?.h_level ?? '';
      const mirrorMode = meta?.mirrorMode ?? meta?.mirror_mode ?? '';
      const intentLayer = meta?.intentLayer ?? meta?.intent_layer ?? '';
      const intentLine =
        typeof meta?.intentLine === 'string' ? meta.intentLine : '';

      const polarityScore =
        meta?.polarityScore ?? meta?.polarity_score ?? '';
      const polarityBand =
        meta?.polarityBand ?? meta?.polarity_band ?? '';
      const stabilityBand =
        meta?.stabilityBand ?? meta?.stability_band ?? '';

      const unified = meta?.unified ?? null;
      const situation = unified?.situation ?? null;
      const situationTopic =
        typeof situation?.topic === 'string' ? situation.topic : '';
      const unifiedSummary =
        typeof unified?.intentSummary === 'string'
          ? unified.intentSummary
          : '';

      const row = [
        t.conv_id,
        t.id,
        t.created_at ?? '',
        t.role,
        t.q_code || '',
        t.depth_stage || '',
        t.self_acceptance ?? '',
        yLevel,
        hLevel,
        polarityScore,
        polarityBand,
        stabilityBand,
        mirrorMode,
        intentLayer,
        intentLine.replaceAll('\n', '\\n').replaceAll('"', '""'),
        situationTopic.replaceAll('\n', '\\n').replaceAll('"', '""'),
        unifiedSummary.replaceAll('\n', '\\n').replaceAll('"', '""'),
        (t.content || '').replaceAll('\n', '\\n').replaceAll('"', '""'),
      ];
      lines.push(row.map((x) => `"${String(x)}"`).join(','));
    }

    return lines.join('\r\n');
  }, [detail, turns]);

  const downloadCSV = () => {
    if (!csvForTurns) return;
    const blob = new Blob([csvForTurns], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = detail?.id ? `iros_logs_${detail.id}.csv` : 'iros_logs.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClear = () => {
    setUserCode('');
    setConvId('');
    setConversations(null);
    setDetail(null);
    setTurns(null);
  };

  return (
    <div className="mu-logs-bleed">
      <div className="mu-logs-inner">
        <div className="muLogs">
          <h1 className="muLogs__title">Iros Logs Viewer</h1>

          {/* 検索UI：User Code（ドロップダウン） → Conversation */}
          <section className="muLogs__search muLogs__search--3col">
            <div className="field">
              <label>User Code</label>
              <select
                value={userCode}
                onChange={(e) => setUserCode(e.target.value)}
              >
                <option value="">
                  {userListLoading
                    ? 'ユーザー一覧を読み込み中…'
                    : 'ユーザーを選択…'}
                </option>
                {userOptions?.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
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
                    {c.last_turn_at ? `（${c.last_turn_at}）` : ''}
                    {typeof c.turns_count === 'number'
                      ? `｜${c.turns_count} turns`
                      : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="actions">
              <button className="ghost" onClick={handleClear}>
                クリア
              </button>
            </div>
          </section>

          {/* 会話一覧 */}
          {conversations && (
            <section>
              <h2 className="muLogs__h2">
                会話一覧（Iros / {conversations.length}）
              </h2>
              <table className="muLogs__table">
                <thead>
                  <tr>
                    <th>conv_id</th>
                    <th>user_code</th>
                    <th>turns</th>
                    <th>last_turn_at</th>
                    <th>created_at</th>
                    <th>open</th>
                  </tr>
                </thead>
                <tbody>
                  {conversations.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.id}</td>
                      <td className="mono">{c.user_code || ''}</td>
                      <td className="mono">
                        {typeof c.turns_count === 'number'
                          ? c.turns_count
                          : ''}
                      </td>
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
              <h2 className="muLogs__h2">会話詳細（Iros）</h2>

              <div className="kv">
                <div>
                  <b>conv_id:</b> <span className="mono">{detail.id}</span>
                </div>
                <div>
                  <b>user_code:</b>{' '}
                  <span className="mono">{detail.user_code || ''}</span>
                </div>
                <div>
                  <b>turns_count:</b>{' '}
                  <span className="mono">
                    {typeof detail.turns_count === 'number'
                      ? detail.turns_count
                      : ''}
                  </span>
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
                  CSVエクスポート（Iros）
                </button>
              </div>

              <table className="muLogs__table muLogs__turns">
                <thead>
                  <tr>
                    <th>time</th>
                    <th>role</th>
                    <th>q</th>
                    <th>depth</th>
                    <th>SA</th>
                    <th
                      title="揺らぎ（Y）：感情や思考の揺れの大きさ。高いほど迷いや葛藤が強い状態です。"
                    >
                      Y
                    </th>
                    <th
                      title="余白（H）：心の余裕・選択の余白。高いほど自由度が高く、低いほど追い込まれた状態です。"
                    >
                      H
                    </th>
                    <th title="心の向き（ネガ〜ニュートラル〜ポジ）">
                      Pol
                    </th>
                    <th title="安定度（揺れの安定／不安定）">Stab</th>
                    <th
                      title="mirror：Iros がどの立ち位置で応答したか（相談寄り / 構造整理 / 意図寄り など）"
                    >
                      mirror
                    </th>
                    <th title="I-layer：意図レイヤー（S/R/C/I/T のどこで動いているか）">
                      I-layer
                    </th>
                    <th title="intent：いまの章タイトルや奥で守ろうとしている願い（短いラベル）">
                      intent
                    </th>
                    <th title="topic：相談内容のテーマ（仕事・恋愛などの分類）">
                      topic
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {turns?.map((t) => {
                    const meta = (t.meta ?? {}) as any;

                    const yLevel = meta?.yLevel ?? meta?.y_level ?? null;
                    const hLevel = meta?.hLevel ?? meta?.h_level ?? null;

                    const unified = meta?.unified ?? null;

                    // Pol/Stab は unified に入ってる場合がある
                    const polarityBand =
                      meta?.polarityBand ??
                      meta?.polarity_band ??
                      unified?.polarityBand ??
                      unified?.polarity_band ??
                      '';

                    const stabilityBand =
                      meta?.stabilityBand ??
                      meta?.stability_band ??
                      unified?.stabilityBand ??
                      unified?.stability_band ??
                      '';

                    // mirror は mirrorMode が無いなら mode を使う
                    const mirrorMode =
                      meta?.mirrorMode ??
                      meta?.mirror_mode ??
                      meta?.mode ??
                      '';

                    // I-layer は intentLayer が無いなら intentLine.intentBand を使う
                    const intentLayer =
                      meta?.intentLayer ??
                      meta?.intent_layer ??
                      meta?.intentLine?.intentBand ??
                      '';

                    // intent（表示用の短いラベル）
                    // string が無ければ intentLine object を1行に圧縮して出す
                    const intentLineObj = meta?.intentLine;
                    const intentLine =
                      typeof meta?.intentLine === 'string'
                        ? meta.intentLine
                        : intentLineObj && typeof intentLineObj === 'object'
                        ? [
                            intentLineObj.nowLabel,
                            intentLineObj.coreNeed,
                            intentLineObj.direction
                              ? `dir:${intentLineObj.direction}`
                              : null,
                            intentLineObj.focusLayer
                              ? `focus:${intentLineObj.focusLayer}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' / ')
                        : '';

                    const situation = unified?.situation ?? null;
                    const topic =
                      typeof situation?.topic === 'string'
                        ? situation.topic
                        : '';

                    const unifiedSummary =
                      typeof unified?.intentSummary === 'string'
                        ? unified.intentSummary
                        : '';

                    const intentLinePreview =
                      intentLine.length > 40
                        ? intentLine.slice(0, 40) + '…'
                        : intentLine;

                    const yDisplay = formatYDisplay(yLevel);
                    const hDisplay = formatHDisplay(hLevel);
                    const cleanedContent = stripLegacyMetaHeader(t.content);

                    return (
                      <React.Fragment key={t.id}>
                        {/* メタ情報行 */}
                        <tr>
                          <td className="mono">{t.created_at || ''}</td>
                          <td className={`role role--${t.role}`}>{t.role}</td>
                          <td className="mono">{t.q_code || ''}</td>
                          <td className="mono">{t.depth_stage || ''}</td>
                          <td className="mono">
                            {t.self_acceptance !== null &&
                            t.self_acceptance !== undefined
                              ? fmt(num(t.self_acceptance, 0))
                              : ''}
                          </td>
                          <td className="mono">{yDisplay}</td>
                          <td className="mono">{hDisplay}</td>
                          <td className="mono">
                            {polarityBand ? String(polarityBand) : ''}
                          </td>
                          <td className="mono">
                            {stabilityBand ? String(stabilityBand) : ''}
                          </td>
                          <td className="mono">
                            {mirrorMode ? String(mirrorMode) : ''}
                          </td>
                          <td className="mono">
                            {intentLayer ? String(intentLayer) : ''}
                          </td>
                          <td className="content" title={intentLine}>
                            {intentLinePreview}
                          </td>
                          <td className="content">{topic}</td>
                        </tr>

                        {/* content 行（横幅いっぱいを1セルで／中でスクロール） */}
                        <tr className="muLogs__turnContentRow">
                          <td className="content" colSpan={13}>
                            <div
                              style={{
                                maxHeight: '8em', // ここが「縦に伸びすぎたらスクロール」の高さ
                                overflowY: 'auto',
                                padding: '4px 2px',
                                whiteSpace: 'pre-wrap',
                              }}
                            >
                              {topic || unifiedSummary ? (
                                <div
                                  style={{
                                    fontSize: '0.85em',
                                    marginBottom: 4,
                                    opacity: 0.8,
                                  }}
                                >
                                  {topic && <strong>[{topic}]</strong>}
                                  {topic && unifiedSummary && '：'}
                                  {unifiedSummary}
                                </div>
                              ) : null}
                              {cleanedContent || ''}
                            </div>
                          </td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>

              {/* Toyota 向けの凡例 */}
              <p style={{ marginTop: 8, fontSize: 12, color: '#555' }}>
                🧊/🌱/🔥：揺らぎ（Y）の大きさ ／ ⚠️/🙂/🌈：心の余白（H）の広さを示します。
              </p>
            </section>
          )}

          {(loading || listLoading) && (
            <p style={{ marginTop: 8 }}>読み込み中…</p>
          )}
        </div>
      </div>
    </div>
  );
}
