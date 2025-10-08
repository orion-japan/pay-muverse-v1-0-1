'use client';
import React, { useEffect, useMemo, useState } from 'react';

/**
 * Mui — 第三段階 UI（①相手のパターンを深掘り → ②事例から実践 → ③共鳴パターンを知る）
 * - sub_id:
 *   stage3-1 = ① 相手のパターンを深掘り
 *   stage3-2 = ② 事例から実践
 *   stage3-3 = ③ 共鳴パターンを知る
 *
 * - Hydration対策：IDはSSRでは生成しない。マウント後に sessionStorage から作成/取得。
 * - 保存：/api/agent/mui/stage/save に POST（Stage1/2 と同じ）
 */

// ========= 共通ユーティリティ =========
function getOrCreateOcrId(): string {
  if (typeof window === 'undefined') return '';
  const k = 'mui:ocr_id';
  const v = sessionStorage.getItem(k);
  if (v) return v;
  const d = new Date();
  const ymd = [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('');
  const id = `CASE-${ymd}-${Math.random().toString(36).slice(2,6)}`;
  sessionStorage.setItem(k, id);
  return id;
}
function getOrCreateConvId(ocrId: string): string {
  if (typeof window === 'undefined') return '';
  const k = 'mui:conv_id';
  const v = sessionStorage.getItem(k);
  if (v) return v;
  const id = `${ocrId}-${Math.random().toString(36).slice(2,5)}`;
  sessionStorage.setItem(k, id);
  return id;
}
async function saveStage(payload: any) {
  const res = await fetch('/api/agent/mui/stage/save', {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) throw new Error(data?.error || 'saveStage failed');
  return data;
}

// ========= 固定プロンプト（第三段階） =========
const GUARDRAILS = ['断定禁止','選択肢は2つ','行動は1つ'] as const;

const PROMPTS_STAGE3 = {
  step1: {
    title: '① 相手のパターンを深掘り',
    body: `【Irosガード】断定禁止 / 選択肢は2つ / 行動は1つ

第二段階で仮置きしたパターンについて、境界（どこまでOK/NG）・トリガー（何が起点）・二次感情（見えてる感情の下）を1つずつ言語化します。

次の一歩：境界/トリガー/二次感情をそれぞれ1語ずつ書く。`,
    nextStep: '境界・トリガー・二次感情を1語ずつ',
  },
  step2: {
    title: '② 事例から実践',
    body: `似たケース（友人・ネットの事例・過去の自分）を1つ取り上げ、成功した最小の一手を真似できる形で具体化します（20〜60字）。

次の一歩：成功事例の「最小の一手」を1つだけ書く。`,
    nextStep: '最小の一手を1つだけ言語化',
  },
  step3: {
    title: '③ 共鳴パターンを知る',
    body: `自分と相手の「響きやすいフレーズ」を見つけます。合意の言い回し・感謝の置き方・問いかけの型から、2者の共鳴点を1つだけ選びます。

次の一歩：共鳴フレーズ（短文）を1つだけ決める。`,
    nextStep: '共鳴フレーズを1つだけ決定',
  },
};

// ========= 共通UI =========
function StepCard({ title, children, footer }:{
  title:string; children:React.ReactNode; footer?:React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="card__title">{title}</div>
      <div className="card__body">{children}</div>
      {footer && <div className="card__footer">{footer}</div>}
    </div>
  );
}

function MiniChatBox({ onSend }:{ onSend:(t:string)=>void }) {
  const [text,setText] = useState('');
  return (
    <div className="chatbox">
      <textarea
        className="chatbox__ta"
        placeholder="チャットで補助。疑問や要約メモなど自由にどうぞ"
        value={text}
        onChange={(e)=>setText(e.target.value)}
      />
      <button
        className="btn btn--primary"
        onClick={()=>{
          const t = text.trim(); if(!t) return;
          onSend(t); setText('');
        }}
      >送信</button>
    </div>
  );
}

// ========= メイン =========
export default function StageThreePanel({ user_code }: { user_code?: string }) {
  const [step, setStep] = useState<1|2|3>(1);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string|null>(null);

  // Hydration対策：IDはマウント後に
  const [ocrId, setOcrId] = useState('');
  const [convId, setConvId] = useState('');
  useEffect(()=>{ setOcrId(getOrCreateOcrId()); },[]);
  useEffect(()=>{ if(ocrId) setConvId(getOrCreateConvId(ocrId)); },[ocrId]);

  const toneBase = useMemo(()=>({
    phase:'Inner',         // 第三段階は内面的作業が多いので Inner を既定
    layer18:'T1',          // 深掘りトーン
    q_current:'Q4',        // 仮置き：深めの問い
    guardrails: GUARDRAILS
  }),[]);

  async function persist(sub_id:'stage3-1'|'stage3-2'|'stage3-3', next_step:string) {
    if (!user_code) { setInfo('user_code が未設定です。'); return; }
    setBusy(true);
    try{
      await saveStage({
        user_code,
        seed_id: ocrId,
        sub_id,
        phase: toneBase.phase,
        depth_stage: toneBase.layer18,
        q_current: toneBase.q_current,
        next_step,
        tone: toneBase,
      });
      setInfo('保存しました。');
    } catch(e:any) {
      setInfo(`保存に失敗：${e?.message||e}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="mui-stage3">
      <header className="head">
        <div>
          <div className="eyebrow">Mui · OCRケース</div>
          <h1 className="h1">第三段階 — 3ステップ</h1>
          <p className="muted">OCR_ID: <code>{ocrId || '...'}</code> ／ 会話ID: <code>{convId || '...'}</code></p>
        </div>
        <div className="head__actions"><span className="badge">Step {step}/3</span></div>
      </header>

      {info && <div className="flash">{info}</div>}

      {step===1 && (
        <StepCard
          title={PROMPTS_STAGE3.step1.title}
          footer={(
            <div className="actions">
              <button className="btn" disabled={busy}
                onClick={async()=>{ await persist('stage3-1', PROMPTS_STAGE3.step1.nextStep); }}>
                この内容を記録</button>
              <div className="spacer"/>
              <button className="btn btn--primary" disabled={busy}
                onClick={async()=>{ await persist('stage3-1', PROMPTS_STAGE3.step1.nextStep); setStep(2); }}>
                次の「事例から実践」に進みますか？</button>
            </div>
          )}
        >
          <pre className="prompt">{PROMPTS_STAGE3.step1.body}</pre>
          <MiniChatBox onSend={()=>{/* 任意: 会話APIへ */}}/>
        </StepCard>
      )}

      {step===2 && (
        <StepCard
          title={PROMPTS_STAGE3.step2.title}
          footer={(
            <div className="actions">
              <button className="btn" disabled={busy}
                onClick={async()=>{ await persist('stage3-2', PROMPTS_STAGE3.step2.nextStep); }}>
                この内容を記録</button>
              <div className="spacer"/>
              <button className="btn btn--primary" disabled={busy}
                onClick={async()=>{ await persist('stage3-2', PROMPTS_STAGE3.step2.nextStep); setStep(3); }}>
                次の「共鳴パターンを知る」に進みますか？</button>
            </div>
          )}
        >
          <pre className="prompt">{PROMPTS_STAGE3.step2.body}</pre>
          <MiniChatBox onSend={()=>{/* 任意 */}}/>
        </StepCard>
      )}

      {step===3 && (
        <StepCard
          title={PROMPTS_STAGE3.step3.title}
          footer={(
            <div className="actions">
              <button className="btn" disabled={busy}
                onClick={async()=>{ await persist('stage3-3', PROMPTS_STAGE3.step3.nextStep); }}>
                この内容を記録</button>
              <div className="spacer"/>
              <button className="btn btn--primary" disabled={busy}
                onClick={async()=>{ await persist('stage3-3', PROMPTS_STAGE3.step3.nextStep); alert('第四段階に進みます。'); }}>
                次の「第四段階」に進みますか？</button>
            </div>
          )}
        >
          <pre className="prompt">{PROMPTS_STAGE3.step3.body}</pre>
          <MiniChatBox onSend={()=>{/* 任意 */}}/>
        </StepCard>
      )}

      {/* 🎨 ライトパステル（Stage1/2と統一） */}
      <style jsx global>{`
        :root{
          --bg:#f7f7fb;
          --panel:#ffffff;
          --panel-grad:linear-gradient(180deg,#ffffffaa,#ffffff80);
          --text:#2a2a35;
          --sub:#6b6f86;
          --accent:#8167ff;
          --accent-2:#ff7bd4;
          --line:rgba(73, 86, 121, .14);
          --glow:radial-gradient(1200px 700px at 20% -10%, #ffd6f5 0%, #e6e7ff 35%, #f7f7fb 65%);
        }
        .mui-stage3{ min-height:100vh; background: var(--glow), var(--bg); color:var(--text); padding:16px; }
        .head{ display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:12px; }
        .eyebrow{ font-size:12px; color:var(--sub); letter-spacing:.08em; }
        .h1{ margin:4px 0; font-size:22px; font-weight:800; }
        .muted{ color:var(--sub); margin:0; }
        .badge{ background:#fff; border:1px solid var(--line); padding:6px 10px; border-radius:999px; font-size:12px; box-shadow:0 2px 8px rgba(129,103,255,.15); }
        .flash{ background:linear-gradient(180deg,#f0e9ff,#ffe6f6); border:1px solid rgba(129,103,255,.25); padding:10px 12px; border-radius:12px; margin:10px 0 16px; color:#3b3366; }
        .card{ background:var(--panel-grad); border:1px solid var(--line); border-radius:16px; padding:14px; margin-bottom:14px;
               box-shadow:0 6px 24px rgba(129,103,255,.12), 0 2px 8px rgba(255,123,212,.10); }
        .card__title{ font-weight:800; letter-spacing:.02em; margin-bottom:6px; }
        .card__body{ white-space:pre-wrap; line-height:1.75; }
        .card__footer{ border-top:1px dashed var(--line); margin-top:10px; padding-top:10px; display:flex; gap:10px; align-items:center; }
        .prompt{ font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
                 background: linear-gradient(180deg,#fff6ff,#f8f9ff);
                 border: 1px dashed rgba(129,103,255,.35); border-radius: 12px; padding: 10px; }
        .actions{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .spacer{ flex:1; }
        .btn{ appearance:none; cursor:pointer; background:#fff; border:1px solid var(--line);
              padding:9px 14px; border-radius:12px; color:var(--text);
              transition: transform .04s ease, box-shadow .2s ease, background .2s; box-shadow:0 2px 10px rgba(0,0,0,.04); }
        .btn:hover{ background:#fafaff; box-shadow:0 6px 18px rgba(129,103,255,.18); transform: translateY(-1px); }
        .btn:active{ transform: translateY(0); } .btn:disabled{ opacity:.6; cursor:default; }
        .btn--primary{ background: radial-gradient(200% 180% at 0% 0%, #ffe1f2 0%, #e4e2ff 45%, #ffffff 100%);
                       border-color: rgba(129,103,255,.35); color:#2a234d; font-weight:800; }
        .chatbox{ display:grid; grid-template-columns:1fr auto; gap:8px; align-items:start; margin-top:10px; }
        .chatbox__ta{ min-height:72px; background: linear-gradient(180deg,#fff,#fafaff); color:var(--text); border:1px solid var(--line); border-radius:12px; padding:10px; resize:vertical; }
      `}</style>
    </div>
  );
}
