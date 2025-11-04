'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import Link from 'next/link';
/** ===== 型（ゆるめ） ===== */
type QNowRow = {
  user_code: string;
  currentq: string | null;
  depthstage: string | null;
  updated_at: string;
};

type TimelineRow = {
  user_code: string;
  source_type: string; // 'sofia' | 'habit' など
  intent: string | null;
  created_at: string;
  q?: string | null; // ビュー側で文字列化済み（存在しない場合は後段で補完）
  stage?: string | null;
  q_code?: any; // 直接 q_code を取ってくるとき用
};

type ChainRow = {
  user_code: string;
  created_at: string;
  prev_hash: string | null;
  curr_hash: string;
  link_ok: boolean | null;
};

const Q_AXIS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];
const STAGE_AXIS = ['S1', 'S2', 'S3', 'T1', 'T2', 'T3'];
const toKey = (q?: string | null, s?: string | null) => `${q ?? '-'}/${s ?? '-'}`;

// 0～max を 0～1 に正規化→薄い(#f8fafc)～濃い（青系）で塗り
function cellColor(v: number, vmax: number) {
  if (vmax <= 0 || v <= 0) return '#f8fafc';
  const t = Math.min(1, v / vmax);
  const L = 95 - t * 55; // 95%→40%
  const S = 75; // 彩度
  const H = 220; // 色相：青
  return `hsl(${H} ${S}% ${L}%)`;
}

function fmt(ts?: string) {
  if (!ts) return '-';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

/** === JSONの q_code から currentQ/depthStage を読み出す安全ヘルパ === */
function readQFromJson(qj: any): { q?: string | null; stage?: string | null } {
  if (!qj || typeof qj !== 'object') return {};
  const q = (qj.currentQ ?? qj.currentq ?? qj.Q ?? null) as string | null;
  const stage = (qj.depthStage ?? qj.depthstage ?? qj.stage ?? null) as string | null;
  return { q, stage };
}

export default function AiQDashboard() {
  const [userCode, setUserCode] = useState('669933');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [now, setNow] = useState<QNowRow | null>(null);
  const [timeline, setTimeline] = useState<TimelineRow[]>([]);
  const [chain, setChain] = useState<ChainRow[]>([]);
  const [aiLogs, setAiLogs] = useState<TimelineRow[]>([]); // sofia 限定の生ログ

  /** 初回オートロード */
  useEffect(() => {
    void loadAll(userCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAll(code: string) {
    setLoading(true);
    setErrorMsg(null);
    try {
      // 1) 今
      const { data: nowRows, error: eNow } = await supabase
        .from('user_q_now')
        .select('*')
        .eq('user_code', code)
        .limit(1);

      if (eNow) throw eNow;
      setNow(nowRows?.[0] ?? null);

      // 2) タイムライン（ビュー）。無ければテーブルから抽出
      let tm: TimelineRow[] = [];
      const { data: tData, error: eT } = await supabase
        .from('q_code_timeline')
        .select('*')
        .eq('user_code', code)
        .order('created_at', { ascending: false })
        .limit(100);
      if (!eT && tData) {
        tm = tData as any;
      } else {
        // フォールバック（q_code_logs から抜粋）
        const { data: raw, error: eRaw } = await supabase
          .from('q_code_logs')
          .select('user_code,source_type,intent,created_at,q_code')
          .eq('user_code', code)
          .order('created_at', { ascending: false })
          .limit(100);
        if (eRaw) throw eRaw;
        tm =
          raw?.map((r: any) => {
            const { q, stage } = readQFromJson(r.q_code);
            return {
              user_code: r.user_code,
              source_type: r.source_type,
              intent: r.intent,
              created_at: r.created_at,
              q,
              stage,
            } as TimelineRow;
          }) ?? [];
      }
      setTimeline(tm);

      // 3) 鎖（監査）
      const { data: cRows, error: eC } = await supabase
        .from('q_code_chain_audit')
        .select('user_code,created_at,prev_hash,curr_hash,link_ok')
        .eq('user_code', code)
        .order('created_at', { ascending: false })
        .limit(5);
      if (eC) throw eC;
      setChain((cRows ?? []) as any);

      // 4) AI 由来の生ログ（ヒートマップ用）
      const { data: ai, error: eAI } = await supabase
        .from('q_code_logs')
        .select('created_at,source_type,intent,q_code')
        .eq('user_code', code)
        .eq('source_type', 'sofia')
        .order('created_at', { ascending: false })
        .limit(300);
      if (eAI) throw eAI;
      const aiMapped =
        ai?.map((r: any) => {
          const { q, stage } = readQFromJson(r.q_code);
          return {
            created_at: r.created_at,
            source_type: r.source_type,
            intent: r.intent,
            q,
            stage,
            q_code: r.q_code,
          } as TimelineRow;
        }) ?? [];
      setAiLogs(aiMapped);
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err?.message ?? 'データ取得でエラーが発生しました');
    } finally {
      setLoading(false);
    }
  }

  /** ====== ヒートマップ集計（AIログのみ） ====== */
  const heatmap = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of aiLogs) {
      if (!r.q || !r.stage) continue;
      const k = toKey(r.q, r.stage);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    let vmax = 0;
    counts.forEach((v) => {
      if (v > vmax) vmax = v;
    });

    const grid = Q_AXIS.map((q) =>
      STAGE_AXIS.map((stage) => ({
        q,
        stage,
        count: counts.get(toKey(q, stage)) ?? 0,
      })),
    );
    return { grid, vmax, total: aiLogs.length };
  }, [aiLogs]);

  const aiOnlyTimeline = useMemo(
    () => timeline.filter((r) => r.source_type === 'sofia'),
    [timeline],
  );

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">AI Qコード ダッシュボード</h1>
        <Link
          href="/"
          className="rounded bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700"
        >
          Home
        </Link>
      </header>

      {/* 検索バー */}
      <div className="mb-4 flex gap-2">
        <input
          value={userCode}
          onChange={(e) => setUserCode(e.target.value)}
          className="w-40 rounded border border-gray-300 px-3 py-2 text-sm"
          placeholder="user_code"
        />
        <button
          onClick={() => void loadAll(userCode)}
          disabled={loading}
          className="rounded bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading ? '読み込み中…' : '読み込み'}
        </button>
      </div>

      {errorMsg && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMsg}
        </div>
      )}

      {/* 現在のQ */}
      <section className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-2 text-sm font-semibold">現在のQ（プロフィール）</div>
        {now ? (
          <div className="text-sm leading-6">
            <div>
              <span className="inline-block w-24 text-gray-500">user:</span>
              <span className="font-medium">{now.user_code}</span>
            </div>
            <div>
              <span className="inline-block w-24 text-gray-500">Q:</span>
              <span className="font-semibold">{now.currentq ?? '-'}</span>
            </div>
            <div>
              <span className="inline-block w-24 text-gray-500">stage:</span>
              <span className="font-semibold">{now.depthstage ?? '-'}</span>
            </div>
            <div>
              <span className="inline-block w-24 text-gray-500">updated:</span>
              <span>{fmt(now.updated_at)}</span>
            </div>
          </div>
        ) : (
          <div className="text-sm text-gray-500">データが見つかりません。</div>
        )}
      </section>

      {/* AIログの要約 */}
      <section className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">AIログ件数（直近）</div>
          <div className="mt-1 text-2xl font-semibold">{aiOnlyTimeline.length}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">AI生ログ（解析対象）</div>
          <div className="mt-1 text-2xl font-semibold">{heatmap.total}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">鎖チェック（最新5件）</div>
          <div className="mt-1 text-2xl font-semibold">
            {chain.filter((c) => c.link_ok === true).length}/{chain.length}
          </div>
        </div>
      </section>

      {/* ヒートマップ */}
      <section className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold">ヒートマップ（AI由来：Q × Stage）</div>
          <div className="text-xs text-gray-500">集計対象: {heatmap.total} 件</div>
        </div>

        <div className="overflow-x-auto">
          <div className="inline-block">
            {/* カラムヘッダ */}
            <div
              className="grid"
              style={{
                gridTemplateColumns: `72px repeat(${STAGE_AXIS.length}, 64px)`,
              }}
            >
              <div />
              {STAGE_AXIS.map((s) => (
                <div key={s} className="px-2 py-1 text-center text-xs text-gray-600">
                  {s}
                </div>
              ))}
            </div>

            {/* 本体 */}
            {heatmap.grid.map((row, ri) => (
              <div
                key={Q_AXIS[ri]}
                className="grid"
                style={{
                  gridTemplateColumns: `72px repeat(${STAGE_AXIS.length}, 64px)`,
                }}
              >
                <div className="px-2 py-1 text-xs text-gray-600">{Q_AXIS[ri]}</div>
                {row.map((cell) => (
                  <div
                    key={`${cell.q}-${cell.stage}`}
                    className="flex h-10 w-16 items-center justify-center rounded border border-gray-100"
                    style={{ background: cellColor(cell.count, heatmap.vmax) }}
                    title={`${cell.q} × ${cell.stage}: ${cell.count}`}
                  >
                    <span
                      className="text-xs font-medium"
                      style={{ color: cell.count ? '#0f172a' : '#94a3b8' }}
                    >
                      {cell.count || ''}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* 凡例 */}
        <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
          <span>少</span>
          <div
            className="h-3 w-24 rounded"
            style={{
              background: `linear-gradient(90deg, ${cellColor(0, 10)}, ${cellColor(10, 10)})`,
            }}
          />
          <span>多</span>
        </div>
      </section>

      {/* AI由来ログ（新しい順） */}
      <section className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-2 text-sm font-semibold">AI由来ログ（新しい順）</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-xs text-gray-600">
                <th className="px-3 py-2">created_at</th>
                <th className="px-3 py-2">intent</th>
                <th className="px-3 py-2">Q</th>
                <th className="px-3 py-2">stage</th>
              </tr>
            </thead>
            <tbody>
              {aiOnlyTimeline.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-gray-400" colSpan={4}>
                    まだ AI 由来のログがありません。
                  </td>
                </tr>
              )}
              {aiOnlyTimeline.map((r, i) => (
                <tr key={i} className="border-b">
                  <td className="px-3 py-2">{fmt(r.created_at)}</td>
                  <td className="px-3 py-2">{r.intent ?? '-'}</td>
                  <td className="px-3 py-2">{r.q ?? '-'}</td>
                  <td className="px-3 py-2">{r.stage ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 鎖の状態（最新5件） */}
      <section className="mb-10 rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-2 text-sm font-semibold">鎖の状態（最新5件）</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-xs text-gray-600">
                <th className="px-3 py-2">created_at</th>
                <th className="px-3 py-2">prev_hash</th>
                <th className="px-3 py-2">curr_hash</th>
                <th className="px-3 py-2">link_ok</th>
              </tr>
            </thead>
            <tbody>
              {chain.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-gray-400" colSpan={4}>
                    監査データがまだありません。
                  </td>
                </tr>
              )}
              {chain.map((c, i) => (
                <tr key={i} className="border-b">
                  <td className="px-3 py-2">{fmt(c.created_at)}</td>
                  <td className="px-3 py-2">
                    <code className="rounded bg-gray-50 px-1 py-0.5">{c.prev_hash ?? 'null'}</code>
                  </td>
                  <td className="px-3 py-2">
                    <code className="rounded bg-gray-50 px-1 py-0.5">{c.curr_hash}</code>
                  </td>
                  <td className="px-3 py-2">
                    {c.link_ok ? (
                      <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                        OK
                      </span>
                    ) : (
                      <span className="rounded bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">
                        NG
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
