// src/app/lecture/q-analysis/QAnalysisPage.tsx
'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import styles from './QAnalysisPage.module.css';
import QCodeCalendar from '@/components/qcode/QCodeCalendar';
import QPie, { type QPieAppearance } from '@/components/qcode/QPie';
import QDayTimeline from '@/components/qcode/QDayTimeline';
import TimelineField from '@/components/qcode/QTimelineField';
import { useRouter } from 'next/navigation';

type Q = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
type Pol = 'ease' | 'now' | 'yin' | 'yang' | undefined;

type QLog = {
  for_date: string;
  created_at?: string;
  q_code: {
    currentQ: Q;
    depthStage?: string;
    polarity?: Pol;
    layer?: 'inner' | 'outer';
  };
  intent?: string;
  extra?: any;
};

const Q_LABEL: Record<Q, string> = {
  Q1: '自由さ ↔ 我慢',
  Q2: '目的 ↔ イライラ',
  Q3: '安心 ↔ 不安',
  Q4: '挑戦 ↔ プレッシャー',
  Q5: '情熱 ↔ 虚しさ',
};

const BASE: Record<Q, string> = {
  Q1: '#7b8da4',
  Q2: '#5aa06a',
  Q3: '#c2a05a',
  Q4: '#5a88c2',
  Q5: '#c25a5a',
};

/* ====== 色ユーティリティ ====== */
const hexToHsl = (hex: string) => {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0,
    s = 0,
    l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
};
const hslToHex = (h: number, s: number, l: number) => {
  h /= 360;
  s /= 100;
  l /= 100;
  const h2 = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = h2(p, q, h + 1 / 3);
    g = h2(p, q, h);
    b = h2(p, q, h - 1 / 3);
  }
  const toHex = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};
const easeColor = (hex: string) => {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, Math.min(100, s + 22), Math.min(100, l + 20));
};
const nowColor = (hex: string) => {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, Math.max(0, s - 18), Math.max(0, l - 16));
};

/* ====== 集計型 ====== */
type Counts = { Q1: number; Q2: number; Q3: number; Q4: number; Q5: number };
type PolarityCounts = Record<Q, { ease: number; now: number }>;

/* ====== 日付ユーティリティ（UTC） ====== */
const fmtUTC = (d: Date) => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const utcToday = () =>
  new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
  );
const addUTCDays = (base: Date, delta: number) => {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + delta);
  return d;
};

/* ====== Bearer 取得（Firebase優先 / Supabase fallback） ====== */
async function getBearerToken(): Promise<string | null> {
  try {
    const { getAuth } = await import('firebase/auth');
    const auth = getAuth();
    if (auth?.currentUser) {
      const t = await auth.currentUser.getIdToken(false);
      if (t) return t;
    }
  } catch {}
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    if (url && key) {
      const sb = createClient(url, key);
      const { data } = await sb.auth.getSession();
      const t = data?.session?.access_token;
      if (t) return t;
    }
  } catch {}
  return null;
}

/* ====== 総評テキスト生成 ====== */
function buildSummaryText(opts: {
  start: string;
  end: string;
  counts: Counts;
  polarity: PolarityCounts;
}) {
  const { start, end, counts, polarity } = opts;
  const total = counts.Q1 + counts.Q2 + counts.Q3 + counts.Q4 + counts.Q5;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);

  const entries = Object.entries(counts) as [keyof Counts, number][];
  const top = entries.sort((a, b) => b[1] - a[1])[0];

  const lines: string[] = [];
  lines.push(`【Qコード総評】${start} 〜 ${end}`);
  lines.push(`合計 ${total} 件`);
  lines.push(`最多: ${top?.[0] ?? '-'}（${top?.[1] ?? 0} 件・${pct(top?.[1] ?? 0)}%）`);
  lines.push('内訳: ' + entries.map(([q, n]) => `${q}:${n}件(${pct(n)}%)`).join(' / '));
  lines.push(
    'Ease/Now 内訳: ' +
      (Object.keys(polarity) as (keyof PolarityCounts)[])
        .map((q) => `${q} E:${polarity[q].ease} N:${polarity[q].now}`)
        .join(' / '),
  );
  lines.push('');
  lines.push('上記を踏まえて、今の状態の解釈と次の一歩の提案をお願いします。');
  return lines.join('\n');
}

/* =================================================================== */
export default function QAnalysisPage() {
  const router = useRouter();

  const [items, setItems] = useState<QLog[]>([]);
  const [loading, setLoading] = useState(false);

  // 相対期間
  const [days, setDays] = useState<'30' | '60' | '90'>('30');
  const [intent, setIntent] = useState<'all' | 'self_post' | 'event_attend' | 'vision_check'>(
    'all',
  );
  const [appearance, setAppearance] = useState<QPieAppearance>('none');

  // 絶対期間
  const [fromDate, setFromDate] = useState<string | null>(null);
  const [toDate, setToDate] = useState<string | null>(null);

  // 見出し用（UTC）
  const startDate = useMemo(() => {
    if (fromDate) return fromDate;
    const endUTC = toDate ? new Date(`${toDate}T00:00:00Z`) : utcToday();
    const startUTC = addUTCDays(endUTC, -(parseInt(days as string, 10) || 30) + 1);
    return fmtUTC(startUTC);
  }, [fromDate, toDate, days]);

  const endDateForTitle = useMemo(() => {
    const endUTC = toDate ? new Date(`${toDate}T00:00:00Z`) : utcToday();
    return fmtUTC(endUTC);
  }, [toDate]);

  // 選択日
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const [pickedLogs, setPickedLogs] = useState<QLog[]>([]);

  /* ===== Mu総評（会話作成→ユーザー文保存→LLM→画面遷移） ===== */
  const onClickSummary = useCallback(async () => {
    const DEV = process.env.NODE_ENV !== 'production';
    try {
      const bearer = await getBearerToken();
      const authz = bearer ? { Authorization: `Bearer ${bearer}` } : {};

      const start = startDate;
      const end = endDateForTitle;

      // キー（同期間なら再利用）
      const key = `me:${end}:qcode:${fromDate || toDate ? `abs:${start}-${end}` : days}`;

      // 集計
      const counts: Counts = items.reduce<Counts>(
        (acc, it) => {
          const q = it?.q_code?.currentQ as Q | undefined;
          if (q) acc[q] += 1;
          return acc;
        },
        { Q1: 0, Q2: 0, Q3: 0, Q4: 0, Q5: 0 },
      );

      const init = { ease: 0, now: 0 };
      const polarity: PolarityCounts = {
        Q1: { ...init },
        Q2: { ...init },
        Q3: { ...init },
        Q4: { ...init },
        Q5: { ...init },
      };
      for (const it of items) {
        const q = it?.q_code?.currentQ as Q | undefined;
        if (!q) continue;
        const pol = it?.q_code?.polarity;
        if (pol === 'ease') polarity[q].ease++;
        else polarity[q].now++;
      }

      const topQ =
        (Object.entries(counts) as [Q, number][]).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-';
      const title = `Q総評 / ${end} / ${topQ}`;
      const summaryText = buildSummaryText({ start, end, counts, polarity });

      // 1) 会話 find_or_create
      if (DEV) console.info('[q-analysis] conv find_or_create', { key, title });
      const resConv = await fetch('/api/agent/muai/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authz },
        body: JSON.stringify({
          op: 'find_or_create',
          key,
          title,
          meta: { source: 'q-analysis', start, end, days: fromDate || toDate ? undefined : days },
        }),
      });
      const jConv = await resConv.json();
      if (!resConv.ok || !jConv?.threadId) {
        console.error('conv create failed', jConv);
        alert('会話の作成に失敗しました');
        return;
      }
      const threadId: string = jConv.threadId;

      // 2) 初回 user 発話（表示させるので silent は付けない）
      if (DEV) console.info('[q-analysis] post user turn', { threadId, len: summaryText.length });
      await fetch('/api/mu/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authz },
        body: JSON.stringify({
          conv_id: threadId,
          role: 'user',
          content: summaryText,
          meta: { source: 'q-analysis' },
        }),
      });

      // 3) LLM 呼び出し（text を必ず渡す）。assistant 保存はサーバ側が行う
      if (DEV) console.info('[q-analysis] LLM call', { threadId });
      await fetch('/api/agent/muai/reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authz },
        body: JSON.stringify({
          agent: 'mu',
          conversationId: threadId,
          text: summaryText, // ← これが無いと "text required"
          meta: { source: 'q-analysis' },
        }),
      });

      // 4) 画面遷移
      router.push(`/chat?open=${threadId}`);
    } catch (e) {
      console.error(e);
      alert('総評の送信に失敗しました');
    }
  }, [items, days, fromDate, toDate, startDate, endDateForTitle, router]);

  /* ===== データ取得 ===== */
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const q = new URLSearchParams({ limit: '500' });
        if (fromDate) q.set('from', fromDate);
        if (toDate) q.set('to', toDate);
        if (!fromDate && !toDate) q.set('days', days);
        if (intent !== 'all') q.set('intent', intent);

        const res = await fetch(`/api/qcode/log?${q}`, {
          cache: 'no-store',
          credentials: 'include',
        });
        const json = await res.json();
        setItems(json.items ?? []);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [days, intent, fromDate, toDate]);

  // Q合計
  const counts = useMemo<Counts>(() => {
    const c: Counts = { Q1: 0, Q2: 0, Q3: 0, Q4: 0, Q5: 0 };
    for (const it of items) {
      const q = it?.q_code?.currentQ;
      if (q) c[q]++;
    }
    return c;
  }, [items]);

  // Ease/Now 集計
  const polarityCounts = useMemo<PolarityCounts>(() => {
    const init = { ease: 0, now: 0 };
    const c: PolarityCounts = {
      Q1: { ...init },
      Q2: { ...init },
      Q3: { ...init },
      Q4: { ...init },
      Q5: { ...init },
    };
    for (const it of items) {
      const q = it?.q_code?.currentQ as Q | undefined;
      if (!q) continue;
      const pol = it?.q_code?.polarity;
      if (pol === 'ease') c[q].ease++;
      else c[q].now++; // 未指定は now 扱い
    }
    return c;
  }, [items]);

  const totalCount = counts.Q1 + counts.Q2 + counts.Q3 + counts.Q4 + counts.Q5;
  const pctOfTotal = (n: number) => (totalCount ? Math.round((n / totalCount) * 100) : 0);

  // ラベル
  const rangeLabel = fromDate || toDate ? `${startDate} 〜 ${endDateForTitle}` : `${days}日`;

  return (
    <main className={styles.wrap}>
      <div className="lessons__wrap">
        {/* 戻るボタン */}
        <button className="backBtn" onClick={() => router.back()} aria-label="戻る">
          ← 戻る
        </button>
      </div>

      <h1 className={styles.title}>🔍 Q解析</h1>
      <p className={styles.intro}>ここでは Qコードの記録や解析を行います。</p>

      {/* フィルタ + Mu総評ボタン */}
      <div className={styles.filters}>
        {/* 相対日数 */}
        <div className={styles.segment} title="相対期間">
          <button
            className={!fromDate && !toDate && days === '30' ? styles.on : ''}
            onClick={() => setDays('30')}
          >
            30日
          </button>
          <button
            className={!fromDate && !toDate && days === '60' ? styles.on : ''}
            onClick={() => setDays('60')}
          >
            60日
          </button>
          <button
            className={!fromDate && !toDate && days === '90' ? styles.on : ''}
            onClick={() => setDays('90')}
          >
            90日
          </button>
        </div>

        {/* 絶対期間 */}
        <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <input
            type="date"
            value={fromDate ?? ''}
            onChange={(e) => setFromDate(e.target.value || null)}
          />
          <span>〜</span>
          <input
            type="date"
            value={toDate ?? ''}
            onChange={(e) => setToDate(e.target.value || null)}
          />
          {(fromDate || toDate) && (
            <button
              onClick={() => {
                setFromDate(null);
                setToDate(null);
              }}
              style={{ marginLeft: 4 }}
            >
              クリア
            </button>
          )}
        </div>

        {/* intent */}
        <select value={intent} onChange={(e) => setIntent(e.target.value as any)}>
          <option value="all">すべて</option>
          <option value="self_post">Self</option>
          <option value="event_attend">Event</option>
          <option value="vision_check">Vision</option>
        </select>

        {/* QPie 外観 */}
        <select
          value={appearance}
          onChange={(e) => setAppearance(e.target.value as QPieAppearance)}
        >
          <option value="none">ドーナツ：標準</option>
          <option value="segment">ドーナツ：各セグメントをグラデ</option>
          <option value="ring">ドーナツ：リング全体グラデ</option>
        </select>

        {/* 🪔 Mu総評 */}
        <button
          onClick={onClickSummary}
          className={styles.segment}
          title="直近のQから総評を作成してMu会話を開始"
          style={{ marginLeft: 8 }}
        >
          🪔 Mu AI 総評（{fromDate || toDate ? `${startDate}〜${endDateForTitle}` : `${days}日`}）
        </button>
      </div>

      {/* ヒートマップ */}
      <section className={styles.section}>
        <h2>
          Qヒートマップ
          <br />（{rangeLabel}）
        </h2>
        <QCodeCalendar
          days={days}
          intent={intent}
          onSelectDay={(date, logs) => {
            setPickedDate(date);
            setPickedLogs(logs as QLog[]);
          }}
        />
      </section>

      {/* 選択日の表示 */}
      {pickedDate && (
        <section className={styles.section}>
          <h2>選択日のログ：{pickedDate}</h2>
          <div className={styles.dayRow}>
            <div className={styles.dayCol}>
              {pickedLogs.length === 0 ? (
                <div className={styles.empty}>この日は記録がありません。</div>
              ) : (
                <ul className={styles.logList}>
                  {pickedLogs.map((it, i) => (
                    <li key={i} className={styles.logItem}>
                      <span className={styles.logDate}>{it.for_date}</span>
                      <span className={styles.logQ}>{it.q_code?.currentQ}</span>
                      <span className={styles.logStage}>{it.q_code?.depthStage}</span>
                      {it.q_code?.polarity && (
                        <span className={styles.logIntent}>[{it.q_code.polarity}]</span>
                      )}
                      {it.q_code?.layer && (
                        <span className={styles.logIntent}>[{it.q_code.layer}]</span>
                      )}
                      {it.intent && <span className={styles.logIntent}>({it.intent})</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className={styles.dayCol}>
              <QDayTimeline logs={pickedLogs} />
            </div>
          </div>
        </section>
      )}

      {/* 分布（ドーナツ） */}
      <section className={styles.section}>
        <h2>
          Qコード分布
          <br />（{rangeLabel}）
        </h2>
        <div className={styles.pieRow}>
          <div className={styles.pieCol}>
            <QPie counts={counts} appearance={appearance} />
          </div>
          <div className={styles.pieColRight}>
            <ul className={styles.qList}>
              {(Object.keys(BASE) as Q[]).map((q) => (
                <li key={q} className={styles.qItem}>
                  <span className={styles.qLabel}>
                    <i className={styles.swatch} style={{ background: BASE[q] }} />
                    {q}：{Q_LABEL[q]}
                  </span>
                  <span className={styles.qCount}>
                    {counts[q]} 件（{pctOfTotal(counts[q])}%）
                  </span>
                </li>
              ))}
              <li className={styles.total}>合計：{totalCount} 件</li>
            </ul>
          </div>
        </div>
      </section>

      {/* 流れ（タイムライン）＋ 内訳 */}
      <section className={styles.section}>
        <h2>
          Qの流れ
          <br />（{startDate} ～ {endDateForTitle}）
        </h2>

        <div className={styles.pieCol} style={{ maxWidth: 'unset' }}>
          <TimelineField
            items={items}
            days={!fromDate && !toDate ? days : undefined}
            startDate={fromDate ?? startDate}
            endDate={toDate ?? endDateForTitle}
          />
        </div>

        <div className={styles.pieColRight} style={{ maxWidth: 'unset', marginTop: 12 }}>
          <ul className={styles.qList}>
            {(Object.keys(BASE) as Q[]).map((q) => {
              const ease = polarityCounts[q].ease;
              const now = polarityCounts[q].now;
              return (
                <li key={q} className={styles.qItem} style={{ alignItems: 'flex-start' }}>
                  <div className={styles.qLabel} style={{ whiteSpace: 'normal' }}>
                    <i className={styles.swatch} style={{ background: BASE[q] }} />
                    <span>
                      {q}：{Q_LABEL[q]}
                    </span>
                  </div>
                  <div className={styles.qCount} style={{ display: 'grid', gap: 4 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <i className={styles.swatch} style={{ background: easeColor(BASE[q]) }} />
                      <span>Ease：</span>
                      <b>{ease}</b>
                      <span>件（{pctOfTotal(ease)}%）</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <i className={styles.swatch} style={{ background: nowColor(BASE[q]) }} />
                      <span>Now：</span>
                      <b>{now}</b>
                      <span>件（{pctOfTotal(now)}%）</span>
                    </div>
                  </div>
                </li>
              );
            })}
            <li className={styles.total} style={{ display: 'grid', gap: 6 }}>
              合計：{totalCount} 件
              <span style={{ fontWeight: 400, color: '#445' }}>
                （Ease {pctOfTotal(Object.values(polarityCounts).reduce((a, c) => a + c.ease, 0))}%
                / Now {pctOfTotal(Object.values(polarityCounts).reduce((a, c) => a + c.now, 0))}%）
              </span>
            </li>
          </ul>
        </div>
      </section>

      {/* 最近のログ */}
      <section className={styles.section}>
        <details className={styles.logPanel}>
          <summary className={styles.logSummary}>
            <span>📜 最近のログ</span>
            {!loading && <span className={styles.logCount}>{items.length}</span>}
          </summary>

          {loading && <p>読み込み中…</p>}

          {!loading && items.length === 0 && (
            <div className={styles.empty}>
              まだQログがありません。Self投稿やVisionチェック、イベント参加で記録されます。
            </div>
          )}

          {!loading && items.length > 0 && (
            <ul className={styles.logList}>
              {items.slice(0, 50).map((it, i) => (
                <li key={i} className={styles.logItem}>
                  <span className={styles.logDate}>{it.for_date}</span>
                  <span className={styles.logQ}>{it.q_code?.currentQ}</span>
                  <span className={styles.logStage}>{it.q_code?.depthStage}</span>
                  {it.q_code?.polarity && (
                    <span className={styles.logIntent}>[{it.q_code.polarity}]</span>
                  )}
                  {it.q_code?.layer && (
                    <span className={styles.logIntent}>[{it.q_code.layer}]</span>
                  )}
                  {it.intent && <span className={styles.logIntent}>({it.intent})</span>}
                </li>
              ))}
            </ul>
          )}
        </details>
      </section>
    </main>
  );
}
