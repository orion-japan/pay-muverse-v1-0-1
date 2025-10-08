'use client';
import React, { useEffect, useMemo, useState } from 'react';

/**
 * Mui — 第四段階 UI
 * ① 自分と相手の共鳴ポイント → ② 共鳴パターン → ③ 愛の育み方
 *
 * sub_id:
 *   stage4-1 = ① 自分と相手の共鳴ポイント
 *   stage4-2 = ② 共鳴パターン
 *   stage4-3 = ③ 愛の育み方
 *
 * Hydration対策：IDはSSRでは作らず、マウント後に sessionStorage から生成/取得。
 * 保存API：/api/agent/mui/stage/save
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

// ========= 固定プロンプト（第四段階） =========
const GUARDRAILS = ['断定禁止','選択肢は2つ','行動は1つ'] as const;

const PROMPTS_STAGE4 = {
  step1: {
    title: '① 自分と相手の共鳴ポイント',
    body: `【Irosガード】断定禁止 / 選択肢は2つ / 行動は1つ

第三段階までで見えた “響きやすい言い回し・価値観・タイミング” を並べ、2者の共鳴点を1つに集約します（短い一文）。

次の一歩：共鳴ポイントを「〜が大事」「〜だと落ち着く」の形で1文にする。`,
    nextStep: '共鳴ポイントを短文で1つに集約',
  },
  step2: {
    title: '② 共鳴パターン',
    body: `合意→要望→選択肢の型を、共鳴ポイントに合わせて微調整します。
例：〈合意〉その気持ちを大事にしたい → 〈要望〉私は〜できると助かる → 〈選択肢〉今/明日どちらが良い？（2択）

次の一歩：あなたの関係に合う “合意→要望→選択肢” を3文だけで作成。`,
    nextStep: '3文テンプレ（合意→要望→選択肢）を完成',
  },
  step3: {
    title: '③ 愛の育み方',
    body: `関係温度を保ちながら試す “最小の育み行動” を1つだけ決めます。
条件：24h以内・1ステップ・可逆（やめられる）・相手の尊厳を守る。

次の一歩：24h以内の1アクションを1つだけ決定。`,
    nextStep: '24h以内の最小アクションを決める',
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
export default function StageFourPanel({ user_code }: { user_code?: string }) {
  const [step,setStep] = useState<1|2|3>(1);
  const [busy,setBusy] = useState(false);
  const [info,setInfo] = useState<string|null>(null);

  // Hydration対策：IDはマウント後に
  const [ocrId,setOcrId]   = useState('');
  const [convId,setConvId] = useState('');
  useEffect(()=>{ setOcrId(getOrCreateOcrId()); },[]);
  useEffect(()=>{ if(ocrId) setConvId(getOrCreateConvId(ocrId)); },[ocrId]);

  // 第四段階は「共鳴の確立」。Inner寄りのT2トーン/Q5を既定に
  const toneBase = useMemo(()=>({
    phase:'Inner',
    layer18:'T2',
    q_current:'Q5',
    guardrails: GUARDRAILS
  }),[]);

  async function persist(sub_id:'stage4-1'|'stage4-2'|'stage4-3', next_step:string){
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
        tone: toneBase,
      });
      setInfo('保存しました。');
    }catch(e:any){
      setInfo(`保存に失敗：${e?.message||e}`);
    }finally{ setBusy(false); }
  }

  return (
    <div className="mui-stage4">
      <header className="head">
        <div>
          <div className="eyebrow">Mui · OCRケース</div>
          <h1 className="h1">第四段階 — 3ステップ</h1>
          <p className="muted">OCR_ID: <code>{ocrId || '...'}</code> ／ 会話ID: <code>{convId || '...'}</code></p>
        </div>
        <div className="head__actions"><span className="badge">Step {step}/3</span></div>
      </header>

      {info && <div className="flash">{info}</div>}

      {step===1 && (
        <StepCard
          title={PROMPTS_STAGE4.step1.title}
          footer={(
            <div className="actions">
              <button className="btn" disabled={busy}
                onClick={async()=>{ await persist('stage4-1', PROMPTS_STAGE4.step1.nextStep); }}>
                この内容を記録</button>
              <div className="spacer"/>
              <button className="btn btn--primary" disabled={busy}
                onClick={async()=>{ await persist('stage4-1', PROMPTS_STAGE4.step1.nextStep); setStep(2); }}>
                次の「共鳴パターン」に進みますか？</button>
            </div>
          )}
        >
          <pre className="prompt">{PROMPTS_STAGE4.step1.body}</pre>
          <MiniChatBox onSend={()=>{/* 任意 */}}/>
        </StepCard>
      )}

      {step===2 && (
        <StepCard
          title={PROMPTS_STAGE4.step2.title}
          footer={(
            <div className="actions">
              <button className="btn" disabled={busy}
                onClick={async()=>{ await persist('stage4-2', PROMPTS_STAGE4.step2.nextStep); }}>
                この内容を記録</button>
              <div className="spacer"/>
              <button className="btn btn--primary" disabled={busy}
                onClick={async()=>{ await persist('stage4-2', PROMPTS_STAGE4.step2.nextStep); setStep(3); }}>
                次の「愛の育み方」に進みますか？</button>
            </div>
          )}
        >
          <pre className="prompt">{PROMPTS_STAGE4.step2.body}</pre>
          <MiniChatBox onSend={()=>{/* 任意 */}}/>
        </StepCard>
      )}

      {step===3 && (
        <StepCard
          title={PROMPTS_STAGE4.step3.title}
          footer={(
            <div className="actions">
              <button className="btn" disabled={busy}
                onClick={async()=>{ await persist('stage4-3', PROMPTS_STAGE4.step3.nextStep); }}>
                この内容を記録</button>
              <div className="spacer"/>
              <button className="btn btn--primary" disabled={busy}
                onClick={async()=>{ await persist('stage4-3', PROMPTS_STAGE4.step3.nextStep); alert('おつかれさま！全段階クリアです。'); }}>
                完了する</button>
            </div>
          )}
        >
          <pre className="prompt">{PROMPTS_STAGE4.step3.body}</pre>
          <MiniChatBox onSend={()=>{/* 任意 */}}/>
        </StepCard>
      )}

      {/* 🎨 ライトパステル（Stage1/2/3と統一） */}
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
        .mui-stage4{ min-height:100vh; background: var(--glow), var(--bg); color:var(--text); padding:16px; }
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
