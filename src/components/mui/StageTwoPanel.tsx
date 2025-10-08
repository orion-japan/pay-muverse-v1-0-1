'use client';
import React, { useEffect, useMemo, useState } from 'react';

/**
 * Mui — 第二段階 UI（①相手の状態 → ②返信の方法 → ③対処法）
 * - 課金ゲート：step1 解放前に /api/billing/status を確認
 * - sub_id:
 *   stage2-1 = ①パターンから相手の状態
 *   stage2-2 = ②返信の方法
 *   stage2-3 = ③パターンの対処法
 *
 * 依存：Next.js/React（app router）。CSSは下の <style jsx global> に同梱。
 */

// ========= 共通ユーティリティ =========
function getOrCreateOcrId(): string {
  const k = 'mui:ocr_id';
  const v = typeof window !== 'undefined' ? sessionStorage.getItem(k) : null;
  if (v) return v;
  const d = new Date();
  const id = `CASE-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${Math.random().toString(36).slice(2,6)}`;
  if (typeof window !== 'undefined') sessionStorage.setItem(k, id);
  return id;
}
function getOrCreateConvId(ocrId: string): string {
  const k = 'mui:conv_id';
  const v = typeof window !== 'undefined' ? sessionStorage.getItem(k) : null;
  if (v) return v;
  const id = `${ocrId}-${Math.random().toString(36).slice(2,5)}`;
  if (typeof window !== 'undefined') sessionStorage.setItem(k, id);
  return id;
}
async function saveStage(payload: any) {
  const res = await fetch('/api/agent/mui/stage/save', {
    method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) throw new Error(data?.error || 'saveStage failed');
  return data;
}

// ========= 固定プロンプト（第二段階） =========
const GUARDRAILS = ["断定禁止","選択肢は2つ","行動は1つ"];
const PROMPTS_STAGE2 = {
  step1: {
    title: '① パターンから相手の状態',
    body: `【Irosガード】断定禁止 / 選択肢は2つ / 行動は1つ\n\n選ばれたパターンを手掛かりに、相手の内的ニーズを仮説として言語化します（評価語なし／200字前後）。\n\n次の一歩：ニーズを尊重する前置きの1文を書く。`,
    nextStep: 'ニーズ尊重の前置きを1文だけ作る'
  },
  step2: {
    title: '② 返信の方法',
    body: `Irosトーンで使える返信テンプレを2択まで提示します。\n\n次の一歩：どちらか1つを選んで下書きへ反映する。`,
    nextStep: 'テンプレを1つだけ選ぶ'
  },
  step3: {
    title: '③ パターンの対処法',
    body: `関係の温度を下げずに進める最小の対処行動を1つだけ指示します。\n\n次の一歩：実行タイミング（いつ・どの場面）を決める。`,
    nextStep: '実行タイミングを1つ決める'
  }
};

// ========= ミニチャット（追加） =========
function MiniChatBox({ onSend }:{ onSend:(text:string)=>void }) {
  const [text, setText] = useState('');
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

// ========= ステップカード =========
function StepCard({ title, children, footer }:{title:string; children:React.ReactNode; footer?:React.ReactNode}){
  return (
    <div className="card">
      <div className="card__title">{title}</div>
      <div className="card__body">{children}</div>
      {footer && <div className="card__footer">{footer}</div>}
    </div>
  );
}

// ========= 第二段階メイン =========
export default function StageTwoPanel({ user_code }: { user_code?: string }){
  const [step, setStep] = useState<1|2|3>(1);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string|null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [paid, setPaid] = useState<boolean>(false);

  const ocrId = useMemo(()=>getOrCreateOcrId(),[]);
  const convId = useMemo(()=>getOrCreateConvId(ocrId),[ocrId]);
  const toneBase = useMemo(()=>({ phase:'Mixed', layer18:'R4', q_current:'Q3', guardrails:GUARDRAILS }),[]);

  // 初回：課金ステータス取得
  useEffect(()=>{
    (async()=>{
      try{
        const r = await fetch('/api/billing/status');
        if(r.ok){ const j = await r.json(); setPaid(Boolean(j?.active)); }
      }catch{ /* noop */ }
    })();
  },[]);

  async function persist(sub_id:'stage2-1'|'stage2-2'|'stage2-3', next_step:string){
    if(!user_code){ setInfo('user_code が未設定です。'); return; }
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
        tone: toneBase
      });
      setInfo('保存しました。');
    }catch(e:any){ setInfo(`保存に失敗：${e?.message||e}`); }
    finally{ setBusy(false); }
  }

  function requirePaid(action:()=>void){
    if(paid){ action(); } else { setPayOpen(true); }
  }

  return (
    <div className="mui-stage2">
      <header className="head">
        <div>
          <div className="eyebrow">Mui · OCRケース</div>
          <h1 className="h1">第二段階 — 3ステップ</h1>
          <p className="muted">OCR_ID: <code>{ocrId}</code> ／ 会話ID: <code>{convId}</code> ／ プラン: <strong>{paid?'有効':'未購入'}</strong></p>
        </div>
        <div className="head__actions">
          <span className="badge">Step {step}/3</span>
        </div>
      </header>

      {info && <div className="flash">{info}</div>}

      {step===1 && (
        <StepCard title={PROMPTS_STAGE2.step1.title}
          footer={(
            <div className="actions">
              <button className="btn" disabled={busy}
                onClick={()=>requirePaid(async()=>{ await persist('stage2-1', PROMPTS_STAGE2.step1.nextStep); })}>
                この内容を記録</button>
              <div className="spacer" />
              <button className="btn btn--primary" disabled={busy}
                onClick={()=>requirePaid(async()=>{ await persist('stage2-1', PROMPTS_STAGE2.step1.nextStep); setStep(2); })}>
                次の「返信の方法」に進みますか？</button>
            </div>
          )}
        >
          <pre className="prompt">{PROMPTS_STAGE2.step1.body}</pre>
          {/* 🔽 追加: ミニチャット */}
          <MiniChatBox onSend={()=>{/* 任意: ここで会話APIにPOST */}} />
        </StepCard>
      )}

      {step===2 && (
        <StepCard title={PROMPTS_STAGE2.step2.title}
          footer={(
            <div className="actions">
              <button className="btn" disabled={busy}
                onClick={()=>requirePaid(async()=>{ await persist('stage2-2', PROMPTS_STAGE2.step2.nextStep); })}>
                この内容を記録</button>
              <div className="spacer" />
              <button className="btn btn--primary" disabled={busy}
                onClick={()=>requirePaid(async()=>{ await persist('stage2-2', PROMPTS_STAGE2.step2.nextStep); setStep(3); })}>
                次の「対処法」に進みますか？</button>
            </div>
          )}
        >
          <pre className="prompt">{PROMPTS_STAGE2.step2.body}</pre>
          {/* 🔽 追加: ミニチャット */}
          <MiniChatBox onSend={()=>{/* 任意 */}} />
        </StepCard>
      )}

      {step===3 && (
        <StepCard title={PROMPTS_STAGE2.step3.title}
          footer={(
            <div className="actions">
              <button className="btn" disabled={busy}
                onClick={()=>requirePaid(async()=>{ await persist('stage2-3', PROMPTS_STAGE2.step3.nextStep); })}>
                この内容を記録</button>
              <div className="spacer" />
              <button className="btn btn--primary" disabled={busy}
                onClick={()=>requirePaid(async()=>{ await persist('stage2-3', PROMPTS_STAGE2.step3.nextStep); alert('第三段階へ進みます。'); })}>
                次の「第三段階」に進みますか？</button>
            </div>
          )}
        >
          <pre className="prompt">{PROMPTS_STAGE2.step3.body}</pre>
          {/* 🔽 追加: ミニチャット */}
          <MiniChatBox onSend={()=>{/* 任意 */}} />
        </StepCard>
      )}

      {/* 課金モーダルは既存のものをそのまま使ってOK（省略可） */}
      {/* ...PaywallModal を定義している場合はここに <PaywallModal .../> を残してください ... */}

      <style jsx global>{`
        :root { --bg:#f7f7fb; --panel:#ffffff; --panel-grad:linear-gradient(180deg,#ffffffaa,#ffffff80); --text:#2a2a35; --sub:#6b6f86; --accent:#8167ff; --accent-2:#ff7bd4; --line:rgba(73, 86, 121, .14); --glow:radial-gradient(1200px 700px at 20% -10%, #ffd6f5 0%, #e6e7ff 35%, #f7f7fb 65%); }
        .mui-stage2{ min-height:100vh; background: var(--glow), var(--bg); color:var(--text); padding:16px; }
        .head{ display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:12px; }
        .eyebrow{ font-size:12px; color:var(--sub); letter-spacing:.08em; }
        .h1{ margin:4px 0; font-size:22px; font-weight:800; }
        .muted{ color:var(--sub); margin:0; }
        .badge{ background: #fff; border:1px solid var(--line); padding:6px 10px; border-radius:999px; font-size:12px; box-shadow: 0 2px 8px rgba(129,103,255,.15); }
        .flash{ background: linear-gradient(180deg,#f0e9ff, #ffe6f6); border:1px solid rgba(129,103,255,.25); padding:10px 12px; border-radius:12px; margin:10px 0 16px; color:#3b3366; }
        .card{ background: var(--panel-grad); border:1px solid var(--line); border-radius:16px; padding:14px; margin-bottom:14px; box-shadow: 0 6px 24px rgba(129,103,255,.12), 0 2px 8px rgba(255,123,212,.10); }
        .card__title{ font-weight:800; letter-spacing:.02em; margin-bottom:6px; }
        .card__body{ white-space:pre-wrap; line-height:1.75; }
        .card__footer{ border-top:1px dashed var(--line); margin-top:10px; padding-top:10px; display:flex; gap:10px; align-items:center; }
        .prompt{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: linear-gradient(180deg,#fff6ff,#f8f9ff); border: 1px dashed rgba(129,103,255,.35); border-radius: 12px; padding: 10px; }
        .actions{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .spacer{ flex:1; }
        .btn{ appearance:none; background: #fff; border:1px solid var(--line); padding:9px 14px; border-radius:12px; color:var(--text); cursor:pointer; transition: transform .04s ease, box-shadow .2s ease, background .2s; box-shadow: 0 2px 10px rgba(0,0,0,.04); }
        .btn:hover{ background:#fafaff; box-shadow:0 6px 18px rgba(129,103,255,.18); transform: translateY(-1px); }
        .btn:active{ transform: translateY(0); } .btn:disabled{ opacity:.6; cursor:default; }
        .btn--primary{ background: radial-gradient(200% 180% at 0% 0%, #ffe1f2 0%, #e4e2ff 45%, #ffffff 100%); border-color: rgba(129,103,255,.35); color:#2a234d; font-weight:800; }
        .chatbox{ display:grid; grid-template-columns:1fr auto; gap:8px; align-items:start; margin-top:10px; }
        .chatbox__ta{ min-height:72px; background: linear-gradient(180deg,#fff,#fafaff); color:var(--text); border:1px solid var(--line); border-radius:12px; padding:10px; resize:vertical; }
      `}</style>
    </div>
  );
}
