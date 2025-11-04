// src/components/mui/StageOnePanel/index.tsx
'use client';

import React, { useEffect, useState } from 'react';
import './StageOnePanel.css';

import LS7Card, { LS7View } from './LS7Card';
import StepCard from './StepCard';

type Phase1Result = {
  ok: boolean;
  conv_code?: string;
  q_code: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  template_id: string;
  summary: string;
  bullets: string[];
  advice: string[];
  next_actions?: string[];
  ls7?: LS7View | null;
};

function getOrCreateOcrId(): string {
  if (typeof window === 'undefined') return '';
  const k = 'mui:ocr_id';
  const v = sessionStorage.getItem(k);
  if (v) return v;
  const d = new Date();
  const ymd = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('');
  const id = `CASE-${ymd}-${Math.random().toString(36).slice(2, 6)}`;
  sessionStorage.setItem(k, id);
  return id;
}

function getOrCreateConvId(ocrId: string): string {
  if (typeof window === 'undefined') return '';
  const k = 'mui:conv_id';
  const v = sessionStorage.getItem(k);
  if (v) return v;
  const id = `${ocrId}-${Math.random().toString(36).slice(2, 5)}`;
  sessionStorage.setItem(k, id);
  return id;
}

export default function StageOnePanel({
  user_code,
  conv,
}: {
  user_code?: string;
  conv?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [phase1, setPhase1] = useState<Phase1Result | null>(null);
  const [ocrId, setOcrId] = useState('');
  const [convId, setConvId] = useState('');

  useEffect(() => {
    const id = getOrCreateOcrId();
    setOcrId(id);
    if (conv && typeof conv === 'string' && conv.trim()) {
      setConvId(conv.trim());
    } else {
      setConvId(getOrCreateConvId(id));
    }
  }, [conv]);

  // 既存結果があれば拾う
  useEffect(() => {
    if (!convId) return;
    (async () => {
      try {
        const res = await fetch(`/api/agent/mui/stage1/result?conv=${encodeURIComponent(convId)}`);
        const j = await res.json();
        if (j?.ok && j?.result) setPhase1(j.result as Phase1Result);
      } catch {
        /* ignore */
      }
    })();
  }, [convId]);

  async function runAnalyze() {
    if (!convId) {
      setInfo('会話IDが未確定です。ページをリロードしてください。');
      return;
    }
    setBusy(true);
    setInfo(null);
    try {
      const res = await fetch('/api/agent/mui/stage1/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conv_code: convId, user_code: user_code || 'ANON' }),
      });
      const j = await res.json();
      if (!res.ok || !j?.ok) throw new Error(j?.error || 'analyze failed');
      // API は { ok:true, stage:'3α', parsed } 形式なので parsed を採用
      const out = (j.parsed ?? j) as Phase1Result;
      setPhase1(out);
      setInfo('分析を反映しました。');
    } catch (e: any) {
      setInfo(`分析エラー：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mui-stage1">
      <header className="head">
        <div>
          <div className="eyebrow">Mui · OCRケース</div>
          <h1 className="h1">第一段階 — 3ステップ</h1>
          <p className="muted">
            OCR_ID: <code>{ocrId || '...'}</code> ／ 会話ID: <code>{convId || '...'}</code>
          </p>
        </div>
        <div className="head__actions">
          <span className="badge">{phase1 ? '結果あり' : '未分析'}</span>
        </div>
      </header>

      {info && <div className="flash">{info}</div>}

      {/* まだ結果が無いときの開始カード */}
      {!phase1 && (
        <StepCard
          title="第1段階｜現実認識（無料）"
          footer={
            <div className="actions">
              <button className="btn btn--primary" disabled={busy} onClick={runAnalyze}>
                {busy ? '分析中…' : 'フェーズ1を開始（無料）'}
              </button>
            </div>
          }
        >
          <div className="lead">
            <p>いまのやり取りから「Qコード」と「傾向（LS7）」を短く整理します。</p>
            <ul className="lead__list">
              <li>A｜状況と状態：事実と解釈を分けて把握</li>
              <li>B｜パターン解説：愛の七相（LS7）で示唆</li>
              <li>C｜落とし込み：次の一手を1つだけ</li>
            </ul>
          </div>
        </StepCard>
      )}

      {/* LS7カード（あれば） */}
      {phase1?.ls7?.top && <LS7Card view={phase1.ls7} qCode={phase1.q_code} />}

      {/* フェーズ1結果 */}
      {phase1 && (
        <div className="card">
          <div className="card__title">フェーズ1結果（{phase1.q_code}）</div>
          <div className="card__body">
            {phase1.summary && (
              <p>
                <strong>概要:</strong> {phase1.summary}
              </p>
            )}
            {!!phase1.bullets?.length && (
              <>
                <p>
                  <strong>観測ポイント:</strong>
                </p>
                <ul>
                  {phase1.bullets.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </>
            )}
            {!!phase1.advice?.length && (
              <>
                <p>
                  <strong>注意点:</strong>
                </p>
                <ul>
                  {phase1.advice.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </>
            )}
            {!!phase1.next_actions?.length && (
              <>
                <p>
                  <strong>次の一手:</strong>
                </p>
                <ul>
                  {phase1.next_actions.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <div className="card__footer">
            <button className="btn" disabled={busy} onClick={runAnalyze}>
              {busy ? '再分析中…' : '再分析する'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
