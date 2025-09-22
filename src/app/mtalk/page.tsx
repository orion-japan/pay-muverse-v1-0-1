'use client';

import React, { useMemo, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { fetchWithIdToken } from '@/lib/fetchWithIdToken';
import { useUnread } from '@/store/useUnread';
import './mtalk.css';

type Agent = 'mirra' | 'iros';

type Report = {
  id: string;
  q_emotion: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  phase: 'Inner' | 'Outer';
  depth_stage: string;
  reply_text: string;
  created_at: string;
};

type ThreadItem = {
  id?: string;
  thread_id?: string;
  conversation_id?: string;
  cid?: string;
  conv_id?: string;
  report_id?: string;
  title?: string;
  subject?: string;
  name?: string;
  summary?: string;
  updated_at?: string | null;
  created_at?: string | null;
  unread_count?: number | null;
};

export default function MTalkPage() {
  const router = useRouter();
  const { userCode } = useAuth();
  const setTalkUnread = useUnread((s) => s.setTalkUnread);

  const [agent, setAgent] = useState<Agent>('mirra');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [latestReport, setLatestReport] = useState<Report | null>(null);

  const [history, setHistory] = useState<ThreadItem[]>([]);

  const historySafe = useMemo(() => {
    const src = Array.isArray(history) ? history : [];
    const norm = src.map((h, idx) => {
      const idRaw =
        h?.id ??
        h?.thread_id ??
        h?.conversation_id ??
        h?.cid ??
        h?.conv_id ??
        h?.report_id ??
        `row-${idx}`;
      const id = typeof idRaw === 'string' ? idRaw.trim() : String(idRaw).trim();
      const titleRaw = h?.title ?? h?.subject ?? h?.name ?? h?.summary ?? '';
      const title = String(titleRaw || '').trim() || '（無題）';
      const dateRaw = h?.updated_at ?? h?.created_at ?? null;
      const when = dateRaw ? new Date(dateRaw).toLocaleString() : '';
      return { id, label: when ? `${title}（${when}）` : title };
    });
    const cleaned = norm.filter((x) => x.id && x.id.length > 0);
    const seen = new Set<string>();
    const uniq = cleaned.filter((x) => {
      if (seen.has(x.id)) return false;
      seen.add(x.id);
      return true;
    });
    return uniq;
  }, [history]);

  const hasHistory = historySafe.length > 0;

  const canSubmit = useMemo(() => !loading && input.trim().length > 0, [loading, input]);

  // 履歴取得（mirra 限定）
  useEffect(() => {
    if (!userCode) return;
    (async () => {
      try {
        const r = await fetchWithIdToken('/api/agent/mtalk/conversations', { cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        const items = Array.isArray(j?.items) ? (j.items as ThreadItem[]) : [];
        setHistory(items);
        const totalUnread = items.reduce((acc, it) => acc + (it.unread_count ?? 0), 0);
        setTalkUnread(totalUnread);
      } catch {
        setHistory([]);
        setTalkUnread(0);
      }
    })();
  }, [userCode, setTalkUnread]);

  async function analyze() {
    if (!canSubmit) return;
    setLoading(true);
    setErrorMsg(null);

    try {
      const lines = input.split('\n').map(s => s.trim()).filter(Boolean);
      const res = await fetchWithIdToken('/api/agent/mtalk/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent,
          texts: lines,
          session_id: sessionId,
        }),
      });

      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (res.status === 402 || j?.error === 'insufficient_balance') {
          setErrorMsg('クレジット残高が不足しています。Plan からチャージしてください。');
          return;
        }
        setErrorMsg(j?.error || '解析に失敗しました。しばらくして再度お試しください。');
        return;
      }

      const j = (await res.json()) as {
        ok: boolean;
        session_id: string;
        conversation_id?: string;
        report: Report;
        balance_after: number;
      };

      if (j?.ok) {
        setSessionId(j.session_id);
        setConversationId(j.conversation_id || null);
        setLatestReport(j.report);
      } else {
        setErrorMsg('解析に失敗しました。');
      }
    } catch {
      setErrorMsg('通信エラーが発生しました。ネットワークをご確認ください。');
    } finally {
      setLoading(false);
    }
  }

  // ★ 相談開始：問題/回答をAPIに渡し、チャットへ遷移
  async function consult(reportId: string) {
    try {
      const res = await fetchWithIdToken('/api/agent/mtalk/consult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_id: reportId,
          problem_text: input?.trim() || '（mTalk）この相談の“問題”テキスト',
          answer_text: latestReport?.reply_text || '（mTalk）この相談の“回答”テキスト',
          title: 'mTalkからの相談',
        }),
      });
      const j = await res.json();

      if (!(j?.ok)) {
        setErrorMsg(j?.error || '相談の起動に失敗しました。');
        return;
      }

      // 保険：サーバで挿入できなかった場合でも描画できるよう seed を保存
      try {
        const cid = String(j.conversation_id || '').trim();
        if (Array.isArray(j.seed_messages) && j.seed_messages.length) {
          sessionStorage.setItem(`mtalk:seed:${cid}`, JSON.stringify(j.seed_messages));
        }
        if (j.summary_hint) {
          sessionStorage.setItem(`mtalk:seed_hint:${cid}`, String(j.summary_hint).slice(0, 220));
        }
      } catch {}

      const hintedCid = String(j.conversation_id || '').trim();
      const url = new URL(`/mtalk/${encodeURIComponent(hintedCid)}`, location.origin);
      url.searchParams.set('agent', 'mirra');
      url.searchParams.set('from', 'mtalk');
      url.searchParams.set('cid', hintedCid);
      if (j.summary_hint) url.searchParams.set('summary_hint', String(j.summary_hint).slice(0, 220));
      router.push(url.pathname + url.search);
    } catch {
      setErrorMsg('通信エラーが発生しました。');
    }
  }

  return (
    <main className="mtalk-root">
      {/* ====== 履歴バー（上部） ====== */}
      <section className="mtalk-history">
        <div className="mh-title">
          <span>過去の mirra 相談</span>
          {!hasHistory && <em className="mh-empty">（まだ相談履歴がありません）</em>}
        </div>
        {hasHistory && (
          <select
            className="mh-dropdown"
            defaultValue=""
            onChange={(e) => {
              const val = e.target.value;
              if (val) {
                router.push(`/mtalk/${val}?agent=mirra&from=history&cid=${val}`);
              }
            }}
          >
            <option value="" disabled>履歴を選択してください</option>
            {historySafe.map((h) => (
              <option key={h.id} value={h.id}>{h.label}</option>
            ))}
          </select>
        )}
      </section>

      {/* ====== 説明 & 入力 ====== */}
      <header className="mtalk-intro">
        <h1>mTalk — マインドトーク</h1>
        <p className="lead">
          多くの人は、無意識のセルフトークに導かれて、できない理由を賢く語る罠に入ります。
          <br />
          <b>mTalk は、その声を見える化し、意図へ戻す入口。</b> ここで整えれば、マインドトークは静かになります。
        </p>

        <div className="mtalk-agent">
          <span className="label">鑑定エージェント：</span>
          <label className="radio">
            <input type="radio" name="agent" value="mirra" checked={agent === 'mirra'} onChange={() => setAgent('mirra')} />
            <span>mirra（初回 2 クレジット）</span>
          </label>
          <label className="radio">
            <input type="radio" name="agent" value="iros" checked={agent === 'iros'} onChange={() => setAgent('iros')} />
            <span>iros（初回 5 クレジット）</span>
          </label>
        </div>
      </header>

      <section className="mtalk-input">
        <textarea
          rows={8}
          placeholder="日頃のマインドトークを入力してください"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
        />
        <div className="mtalk-actions">
          <button className="primary" disabled={!canSubmit} onClick={analyze}>
            {loading ? '解析中…' : `解析する（${agent === 'iros' ? 5 : 2}クレジット）`}
          </button>

          {/* 初回でも常に表示（latestReport がある時） */}
          {latestReport && (
            <button className="secondary" onClick={() => consult(latestReport.id)}>
              この問題に取り組みますか？（相談する）
            </button>
          )}

          {!userCode && <span className="warn">※ ログインが必要です</span>}
        </div>

        {errorMsg && <div className="error">{errorMsg}</div>}
      </section>

      <section className="mtalk-result">
        {latestReport ? (
          <article className="report-card">
            <div className="meta">
              <span className={`q-badge ${latestReport.q_emotion.toLowerCase()}`}>{latestReport.q_emotion}</span>
              <span className="pill">位相：{latestReport.phase}</span>
              <span className="pill">深度：{latestReport.depth_stage}</span>
              <time>{new Date(latestReport.created_at).toLocaleString()}</time>
            </div>
            <pre className="reply">{latestReport.reply_text}</pre>

            {hasHistory && (
              <div className="report-actions">
                <button className="secondary" onClick={() => consult(latestReport.id)}>
                  この問題に取り組みますか？（相談する）
                </button>
              </div>
            )}
          </article>
        ) : (
          <div className="placeholder">解析結果はここに表示され、保存されます。</div>
        )}
      </section>
    </main>
  );
}
