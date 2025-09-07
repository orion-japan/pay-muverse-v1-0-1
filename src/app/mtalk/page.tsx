'use client';

import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { fetchWithIdToken } from '@/lib/fetchWithIdToken';
import './mtalk.css';

type Agent = 'mu' | 'iros';

type Report = {
  id: string;
  q_emotion: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  phase: 'Inner' | 'Outer';
  depth_stage: string;
  reply_text: string;
  created_at: string;
};

export default function MTalkPage() {
  const router = useRouter();
  const { userCode } = useAuth();

  const [agent, setAgent] = useState<Agent>('mu');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [latestReport, setLatestReport] = useState<Report | null>(null);

  const canSubmit = useMemo(() => {
    return !loading && input.trim().length > 0;
  }, [loading, input]);

  async function analyze() {
    if (!canSubmit) return;
    setLoading(true);
    setErrorMsg(null);

    try {
      const lines = input
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);

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
        // 残高不足など
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
        report: Report;
        balance_after: number;
      };

      if (j?.ok) {
        setSessionId(j.session_id);
        setLatestReport(j.report);
      } else {
        setErrorMsg('解析に失敗しました。');
      }
    } catch (e: any) {
      setErrorMsg('通信エラーが発生しました。ネットワークをご確認ください。');
    } finally {
      setLoading(false);
    }
  }

  async function consult(reportId: string) {
    try {
      const res = await fetchWithIdToken('/api/agent/mtalk/consult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report_id: reportId }),
      });
      const j = await res.json();
  
      if (j?.ok && j.redirect) {
        // 1) mTalk要約を sessionStorage に保存（SofiaChat が拾う）
        if (j.summary_hint && j.conversation_id) {
          try {
            sessionStorage.setItem(
              `mtalk:seed:${j.conversation_id}`,
              j.summary_hint
            );
          } catch {}
        }
  
        // 2) URLにも summary_hint を短縮して付与
        const short = encodeURIComponent(String(j.summary_hint || '').slice(0, 220));
        const redirectUrl = j.redirect.includes('summary_hint=')
          ? j.redirect
          : `${j.redirect}&summary_hint=${short}`;
  
        // 3) 遷移
        router.push(redirectUrl);
      } else {
        setErrorMsg(j?.error || '相談の起動に失敗しました。');
      }
    } catch (e) {
      setErrorMsg('通信エラーが発生しました。');
    }
  }
  

  return (
    <main className="mtalk-root">
      <header className="mtalk-intro">
        <h1>mTalk — マインドトーク</h1>
        <p className="lead">
          多くの人は、無意識のセルフトークに導かれて、できない理由を賢く語る罠に入ります。
          <br />
          <b>mTalk は、その声を見える化し、意図へ戻す入口。</b>
          ここで整えれば、マインドトークは静かになります。
        </p>

        <div className="mtalk-agent">
          <span className="label">鑑定エージェント：</span>
          <label className="radio">
            <input
              type="radio"
              name="agent"
              value="mu"
              checked={agent === 'mu'}
              onChange={() => setAgent('mu')}
            />
            <span>Mu（2クレジット）</span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name="agent"
              value="iros"
              checked={agent === 'iros'}
              onChange={() => setAgent('iros')}
            />
            <span>iros（5クレジット）</span>
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

            <div className="report-actions">
              <button className="secondary" onClick={() => consult(latestReport.id)}>
                この問題に取り組みますか？（相談する）
              </button>
            </div>
          </article>
        ) : (
          <div className="placeholder">解析結果はここに表示され、保存されます。</div>
        )}
      </section>
    </main>
  );
}
