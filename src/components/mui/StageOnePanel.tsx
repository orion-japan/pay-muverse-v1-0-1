'use client';
import React, { useEffect, useMemo, useState } from 'react';

/**
 * Mui — 第一段階 UI（①状況と状態 → ②パターンの解説 → ③落とし込み）
 * - OCR_ID / 会話ID は SSR では生成しない（Hydration対策）
 * - sub_id: stage1-1 / stage1-2 / stage1-3
 */

// ========= ユーティリティ =========
function getOrCreateOcrId(): string {
  if (typeof window === 'undefined') return ''; // SSRでは作らない
  const k = 'mui:ocr_id';
  const v = sessionStorage.getItem(k);
  if (v) return v;
  const d = new Date();
  const ymd = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('');
  const id = `CASE-${ymd}-${Math.random().toString(36).slice(2, 6)}`;
  sessionStorage.setItem(k, id);
  return id;
}
function getOrCreateConvId(ocrId: string): string {
  if (typeof window === 'undefined') return ''; // SSRでは作らない
  const k = 'mui:conv_id';
  const v = sessionStorage.getItem(k);
  if (v) return v;
  const id = `${ocrId}-${Math.random().toString(36).slice(2, 5)}`;
  sessionStorage.setItem(k, id);
  return id;
}
async function saveStage(payload: any) {
  const res = await fetch('/api/agent/mui/stage/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) throw new Error(data?.error || 'saveStage failed');
  return data;
}

// ========= 固定プロンプト（第一段階） =========
const GUARDRAILS = ['断定禁止', '選択肢は2つ', '行動は1つ'] as const;

const PROMPTS_STAGE1 = {
  step1: {
    title: '① 状況と状態',
    body: `【Irosガード】断定禁止 / 選択肢は2つ / 行動は1つ

あなたの状況を静かに整理します。
相手の文脈・頻度・返信間隔・語尾のトーンを観察し、今の「関係温度」を言葉にします。

次の一歩：『事実』と『解釈』を1行ずつ分けて書く。`,
    nextStep: '《事実→解釈》を1行ずつ書く',
  },
  step2: {
    title: '② パターンの解説',
    body: `7つの歪みパターン（依存/干渉/逃避/支配/投影/置換/昇華）から、
文章上の兆候（依頼/命令/回避/正当化 等）を指標に、該当しやすいものを1つだけ仮置きします。

次の一歩：当てはまると思うパターンを最大1つ選ぶ。`,
    nextStep: 'パターンを1つだけ選ぶ',
  },
  step3: {
    title: '③ 落とし込み',
    body: `選ばれたパターンが会話にどう現れているか、具体例で可視化します。
テンプレ：『合意点 → 要望 → 相手の選択肢』の3文だけで下書き。

次の一歩：下書きを1つだけ完成させる。`,
    nextStep: '『合意→要望→選択肢』の3文だけを書く',
  },
} as const;

// ====== 簡易 **太字** 変換（構造は維持して <pre> で描画） ======
function asHtmlWithBold(src: string) {
  // エスケープしてから **text** を <strong> に変換、改行は <br>
  const esc = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const bolded = esc.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return bolded.replace(/\n/g, '<br/>');
}

// ========= 簡易チャット =========
function MiniChatBox({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <div className="chatbox">
      <textarea
        className="chatbox__ta"
        placeholder="チャットで色々聞く・話す…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        className="btn btn--primary"
        onClick={() => {
          const t = text.trim();
          if (!t) return;
          onSend(t);
          setText('');
        }}
      >
        送信
      </button>
    </div>
  );
}

// ========= カード =========
function StepCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="card__title">{title}</div>
      <div className="card__body">{children}</div>
      {footer && <div className="card__footer">{footer}</div>}
    </div>
  );
}

// ========= メイン =========
// ★ conv を props に追加（page.tsx から渡ってくる conv クエリを受け取れるように）
export default function StageOnePanel({
  user_code,
  conv,
}: {
  user_code?: string;
  conv?: string | null;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  // ← Hydration対策：IDはマウント後に決定
  const [ocrId, setOcrId] = useState('');
  const [convId, setConvId] = useState('');

  useEffect(() => {
    const id = getOrCreateOcrId();
    setOcrId(id);
  }, []);

  // ★ conv が props で来たらそれを優先。なければ sessionStorage で発番。
  useEffect(() => {
    if (!ocrId) return;
    if (conv && typeof conv === 'string' && conv.trim()) {
      setConvId(conv.trim());
    } else {
      const cid = getOrCreateConvId(ocrId);
      setConvId(cid);
    }
  }, [ocrId, conv]);

  const toneBase = useMemo(
    () => ({
      phase: 'Outer',
      layer18: 'R3',
      q_current: 'Q2',
      guardrails: GUARDRAILS,
    }),
    []
  );

  async function persist(sub_id: 'stage1-1' | 'stage1-2' | 'stage1-3', next_step: string) {
    if (!user_code) {
      setInfo('user_code が未設定です。ログイン状態またはプロフィールを確認してください。');
      return;
    }
    setBusy(true);
    try {
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
    } catch (e: any) {
      setInfo(`保存に失敗：${e?.message || e}`);
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
          <span className="badge">Step {step}/3</span>
        </div>
      </header>

      {info && <div className="flash">{info}</div>}

      {step === 1 && (
        <StepCard
          title={PROMPTS_STAGE1.step1.title}
          footer={
            <div className="actions">
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  await persist('stage1-1', PROMPTS_STAGE1.step1.nextStep);
                }}
              >
                この内容を記録
              </button>
              <div className="spacer" />
              <button
                className="btn btn--primary"
                disabled={busy}
                onClick={async () => {
                  await persist('stage1-1', PROMPTS_STAGE1.step1.nextStep);
                  setStep(2);
                }}
              >
                次の「パターンの解説」に進みますか？
              </button>
            </div>
          }
        >
          <pre
            className="prompt"
            dangerouslySetInnerHTML={{ __html: asHtmlWithBold(PROMPTS_STAGE1.step1.body) }}
          />
          <MiniChatBox onSend={() => { /* 任意: 会話APIへ */ }} />
        </StepCard>
      )}

      {step === 2 && (
        <StepCard
          title={PROMPTS_STAGE1.step2.title}
          footer={
            <div className="actions">
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  await persist('stage1-2', PROMPTS_STAGE1.step2.nextStep);
                }}
              >
                この内容を記録
              </button>
              <div className="spacer" />
              <button
                className="btn btn--primary"
                disabled={busy}
                onClick={async () => {
                  await persist('stage1-2', PROMPTS_STAGE1.step2.nextStep);
                  setStep(3);
                }}
              >
                次の「落とし込み」に進みますか？
              </button>
            </div>
          }
        >
          <pre
            className="prompt"
            dangerouslySetInnerHTML={{ __html: asHtmlWithBold(PROMPTS_STAGE1.step2.body) }}
          />
          <MiniChatBox onSend={() => { /* 任意 */ }} />
        </StepCard>
      )}

      {step === 3 && (
        <StepCard
          title={PROMPTS_STAGE1.step3.title}
          footer={
            <div className="actions">
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  await persist('stage1-3', PROMPTS_STAGE1.step3.nextStep);
                }}
              >
                この内容を記録
              </button>
              <div className="spacer" />
              <button
                className="btn btn--primary"
                disabled={busy}
                onClick={async () => {
                  await persist('stage1-3', PROMPTS_STAGE1.step3.nextStep);
                  alert('第二段階（課金ゲート）へ進みます。');
                }}
              >
                次の「第二段階」に進みますか？（課金）
              </button>
            </div>
          }
        >
          <pre
            className="prompt"
            dangerouslySetInnerHTML={{ __html: asHtmlWithBold(PROMPTS_STAGE1.step3.body) }}
          />
          <MiniChatBox onSend={() => { /* 任意 */ }} />
        </StepCard>
      )}

      {/* 🎨 ライトテーマ（Stage2と同じトーン） */}
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
        .mui-stage1{
          min-height:100vh;
          background: var(--glow), var(--bg);
          color:var(--text);
          padding:16px;
        }
        .head{ display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:12px; }
        .eyebrow{ font-size:12px; color:var(--sub); letter-spacing:.08em; }
        .h1{ margin:4px 0; font-size:22px; font-weight:800; }
        .muted{ color:var(--sub); margin:0; }
        .badge{
          background: #fff; border:1px solid var(--line); padding:6px 10px; border-radius:999px; font-size:12px;
          box-shadow: 0 2px 8px rgba(129,103,255,.15);
        }
        .flash{
          background: linear-gradient(180deg,#f0e9ff, #ffe6f6);
          border:1px solid rgba(129,103,255,.25);
          padding:10px 12px; border-radius:12px; margin:10px 0 16px; color:#3b3366;
        }
        .card{
          background: var(--panel-grad);
          border:1px solid var(--line);
          border-radius:16px; padding:14px; margin-bottom:14px;
          box-shadow: 0 6px 24px rgba(129,103,255,.12), 0 2px 8px rgba(255,123,212,.10);
        }
        .card__title{ font-weight:800; letter-spacing:.02em; margin-bottom:6px; }
        .card__body{ white-space:pre-wrap; line-height:1.75; }
        .card__footer{ border-top:1px dashed var(--line); margin-top:10px; padding-top:10px; display:flex; gap:10px; align-items:center; }
        .prompt{
          font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
          background: linear-gradient(180deg,#fff6ff,#f8f9ff);
          border: 1px dashed rgba(129,103,255,.35);
          border-radius: 12px; padding: 10px;
        }
        .prompt strong{ font-weight:800; }
        .actions{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .spacer{ flex:1; }
        .btn{
          appearance:none; cursor:pointer;
          background: #fff;
          border:1px solid var(--line);
          padding:9px 14px; border-radius:12px; color:var(--text);
          transition: transform .04s ease, box-shadow .2s ease, background .2s;
          box-shadow: 0 2px 10px rgba(0,0,0,.04);
        }
        .btn:hover{ background:#fafaff; box-shadow:0 6px 18px rgba(129,103,255,.18); transform: translateY(-1px); }
        .btn:active{ transform: translateY(0); }
        .btn:disabled{ opacity:.6; cursor:default; }
        .btn--primary{
          background: radial-gradient(200% 180% at 0% 0%, #ffe1f2 0%, #e4e2ff 45%, #ffffff 100%);
          border-color: rgba(129,103,255,.35);
          color:#2a234d; font-weight:800;
        }
        .chatbox{ display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: start; margin-top: 10px; }
        .chatbox__ta{
          min-height: 72px; background: linear-gradient(180deg,#fff,#fafaff);
          color: var(--text); border: 1px solid var(--line); border-radius: 12px; padding: 10px; resize: vertical;
        }
      `}</style>
    </div>
  );
}
