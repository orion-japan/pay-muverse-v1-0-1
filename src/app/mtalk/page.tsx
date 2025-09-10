// src/app/mtalk/page.tsx
'use client';

import React, { useMemo, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { fetchWithIdToken } from '@/lib/fetchWithIdToken';
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

type ThreadItem = { id: string; title: string; updated_at?: string | null };

export default function MTalkPage() {
  const router = useRouter();
  const { userCode } = useAuth();

  const [agent, setAgent] = useState<Agent>('mirra');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [latestReport, setLatestReport] = useState<Report | null>(null);

  // ★ mirra の会話履歴（上部に表示）
  const [history, setHistory] = useState<ThreadItem[]>([]);
  const hasHistory = history.length > 0;

  const canSubmit = useMemo(() => !loading && input.trim().length > 0, [loading, input]);

  // 履歴取得（mirra 限定）
  useEffect(() => {
    if (!userCode) return;
    (async () => {
      try {
        // 固定の mirra 用エンドポイント
        const r = await fetchWithIdToken('/api/talk/mirra/history', { cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        setHistory(Array.isArray(j?.items) ? (j.items as ThreadItem[]) : []);
      } catch {
        setHistory([]);
      }
    })();
  }, [userCode]);

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
          agent,           // mirra / iros
          texts: lines,
          session_id: sessionId,
        }),
      });

      // （以降は既存の処理のままでOK）
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

  // チャットへは「過去相談者のみ」入場可：履歴から入る方式に限定
  async function consult(reportId: string) {
    if (!hasHistory) {
      setErrorMsg('mirra の相談チャットは、過去に相談したことがある方のみご利用いただけます。上の履歴からお入りください。');
      return;
    }

    try {
      const res = await fetchWithIdToken('/api/agent/mtalk/consult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report_id: reportId }),
      });
      const j = await res.json();

      if (j?.ok && j.redirect) {
        if (j.summary_hint && j.conversation_id) {
          try {
            sessionStorage.setItem(`mtalk:seed:${j.conversation_id}`, j.summary_hint);
          } catch {}
        }
        const short = encodeURIComponent(String(j.summary_hint || '').slice(0, 220));
        const redirectUrl = j.redirect.includes('summary_hint=')
          ? j.redirect
          : `${j.redirect}&summary_hint=${short}`;

        router.push(redirectUrl);
      } else {
        setErrorMsg(j?.error || '相談の起動に失敗しました。');
      }
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
          <div className="mh-list">
            {history.map((h) => (
              <button
                key={h.id || `${h.title}-${h.updated_at ?? ''}`} // 安定した key
                className="mh-item"
                onClick={() =>
                  router.push(`/mtalk/${h.id}?agent=mirra&from=history&cid=${h.id}`)
                }
                title={h.title}
              >
                <div className="mh-title-line">{h.title}</div>
                <div className="mh-date">
                  {h.updated_at ? new Date(h.updated_at).toLocaleString() : ''}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ====== 既存の説明 & 入力 ====== */}
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
            <input
              type="radio"
              name="agent"
              value="mirra"
              checked={agent === 'mirra'}
              onChange={() => setAgent('mirra')}
            />
            <span>mirra（初回 2 クレジット）</span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name="agent"
              value="iros"
              checked={agent === 'iros'}
              onChange={() => setAgent('iros')}
            />
            <span>iros（初回 5 クレジット）</span>
          </label>
        </div>
      </header>

      <section className="mtalk-input">
        <textarea
          rows={8}
          placeholder="日頃のマインドトークを、いくつか改行で入力してください（例：どうせ間に合わない／また失敗する気がする など）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
        />
        <div className="mtalk-actions">
          <button className="primary" disabled={!canSubmit} onClick={analyze}>
            {loading ? '解析中…' : `解析する（${agent === 'iros' ? 5 : 2}クレジット）`}
          </button>

          {/* ★ チャット入場は履歴からのみ。ここでは「相談する」ボタンを履歴がある人にだけ出す */}
          {latestReport && hasHistory && (
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
              <span className={`q-badge ${latestReport.q_emotion.toLowerCase()}`}>
                {latestReport.q_emotion}
              </span>
              <span className="pill">位相：{latestReport.phase}</span>
              <span className="pill">深度：{latestReport.depth_stage}</span>
              <time>{new Date(latestReport.created_at).toLocaleString()}</time>
            </div>
            <pre className="reply">{latestReport.reply_text}</pre>

            {/* 二重導線だが、上の仕様にあわせ履歴がある人だけ表示 */}
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
