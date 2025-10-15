'use client';
import React, { useEffect, useMemo, useState } from 'react';
import './StageOnePanel.css';

/**
 * Mui — 第一段階 UI（リード＋①状況と状態 → ②パターンの解説 → ③落とし込み）
 * 仕様：
 * - 初期表示でリードカード（A→B→C解説）＋「フェーズ1を開始（無料）」ボタン
 * - 開始後に3ステップを順に表示
 * - フェーズ2以降で課金誘導を行う
 */

// ========= 型 =========
type Phase1Result = {
  ok: boolean;
  conv_code?: string;
  q_code: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  template_id: string;
  summary: string;
  bullets: string[];
  advice: string[];
  next_actions?: string[];
};

type SavedStagePayload = {
  user_code: string;
  seed_id: string;
  sub_id:
    | 'stage1-1'
    | 'stage1-2'
    | 'stage1-3'
    | 'stage2-1'
    | 'stage2-2'
    | 'stage2-3'
    | 'stage3-1'
    | 'stage3-2'
    | 'stage3-3'
    | 'stage4-1'
    | 'stage4-2'
    | 'stage4-3';
  phase: 'Inner' | 'Outer' | 'Mixed';
  depth_stage: string;
  q_current: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  next_step: string;
  result?: any;
  tone?: any;
};

// ========= ユーティリティ =========
function getOrCreateOcrId(): string {
  if (typeof window === 'undefined') return '';
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
  if (typeof window === 'undefined') return '';
  const k = 'mui:conv_id';
  const v = sessionStorage.getItem(k);
  if (v) return v;
  const id = `${ocrId}-${Math.random().toString(36).slice(2, 5)}`;
  sessionStorage.setItem(k, id);
  return id;
}

async function saveStage(payload: SavedStagePayload) {
  const res = await fetch('/api/agent/mui/stage/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) throw new Error(data?.error || 'saveStage failed');
  return data;
}

// ========= 固定テキスト =========
const GUARDRAILS = ['断定禁止', '選択肢は2つ', '行動は1つ'] as const;

// ===== 導入リード =====
const LEAD = {
  title: '第1段階｜現実認識（無料）',
  body: `これから**恋愛の現実**を静かに整えます。  
**A→B→C** の3ステップで、いま起きている流れを“意図の地図”に置き換えます。  
フェーズ1は**無料**です。**フェーズ2以降（分析→応答／共鳴／再統合）は、この画面から課金**して進められます。`,
  bullets: [
    'A｜状況と状態：事実と解釈を分け、関係の温度を見える化',
    'B｜パターン解説：愛の七相で相手と自分の傾向を示唆',
    'C｜落とし込み：「わたしはどうしたい？」を1文で決める',
  ],
  cta: 'フェーズ1を開始（無料）',
} as const;

// ===== 各ステップのプロンプト =====
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

// ===== Markdown簡易変換 =====
function asHtmlWithBold(src: string) {
  const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  const [phase1, setPhase1] = useState<Phase1Result | null>(null);
  const [showIntro, setShowIntro] = useState(true);

  const [ocrId, setOcrId] = useState('');
  const [convId, setConvId] = useState('');

  useEffect(() => {
    const id = getOrCreateOcrId();
    setOcrId(id);
  }, []);

  useEffect(() => {
    if (!ocrId) return;
    if (conv && typeof conv === 'string' && conv.trim()) {
      setConvId(conv.trim());
    } else {
      const cid = getOrCreateConvId(ocrId);
      setConvId(cid);
    }
  }, [ocrId, conv]);

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

  const toneBase = useMemo(
    () => ({
      phase: 'Outer',
      layer18: 'R3',
      q_current: 'Q2',
      guardrails: GUARDRAILS,
    }),
    []
  );

  async function persist(sub_id: SavedStagePayload['sub_id'], next_step: string) {
    if (!user_code) {
      setInfo('user_code が未設定です。ログイン状態を確認してください。');
      return;
    }
    setBusy(true);
    try {
      await saveStage({
        user_code: user_code!,
        seed_id: ocrId,
        sub_id,
        phase: toneBase.phase as 'Outer',
        depth_stage: toneBase.layer18,
        q_current: toneBase.q_current as 'Q2',
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
      setPhase1(j as Phase1Result);
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
          <span className="badge">Step {step}/3</span>
        </div>
      </header>

      {info && <div className="flash">{info}</div>}

      {/* === 導入リード === */}
      {!phase1 && showIntro && (
        <StepCard
          title={LEAD.title}
          footer={
            <div className="actions">
              <button
                className="btn btn--primary"
                disabled={busy}
                onClick={() => {
                  setShowIntro(false);
                  setStep(1);
                }}
              >
                {LEAD.cta}
              </button>
            </div>
          }
        >
          <div className="lead">
            <p dangerouslySetInnerHTML={{ __html: asHtmlWithBold(LEAD.body) }} />
            <ul className="lead__list">
              {LEAD.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
            <div className="lead__note">
              フェーズ2以降は有料（購入で詳細分析／返信テンプレ／共鳴設計を解放）
            </div>
          </div>
        </StepCard>
      )}

      {/* === 結果あり時 === */}
      {phase1 && (
        <div className="card">
          <div className="card__title">フェーズ1結果（{phase1.q_code}）</div>
          <div className="card__body">
            <p><strong>概要:</strong> {phase1.summary}</p>
            {!!phase1.bullets?.length && (
              <>
                <p><strong>観測ポイント:</strong></p>
                <ul>{phase1.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
              </>
            )}
            {!!phase1.advice?.length && (
              <>
                <p><strong>注意点:</strong></p>
                <ul>{phase1.advice.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </>
            )}
            {!!phase1.next_actions?.length && (
              <>
                <p><strong>次の一手:</strong></p>
                <ul>{phase1.next_actions.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </>
            )}
          </div>
          <div className="card__footer">
            <button className="btn" disabled={busy} onClick={runAnalyze}>
              再分析する
            </button>
          </div>
        </div>
      )}

      {/* === 各ステップ === */}
      {!phase1 && !showIntro && (
        <>
          {step === 1 && (
            <StepCard
              title={PROMPTS_STAGE1.step1.title}
              footer={
                <div className="actions">
                  <button className="btn" disabled={busy} onClick={runAnalyze}>
                    分析する
                  </button>
                  <button
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={async () => {
                      await persist('stage1-1', PROMPTS_STAGE1.step1.nextStep);
                      setStep(2);
                    }}
                  >
                    次の「パターンの解説」へ進む
                  </button>
                </div>
              }
            >
              <pre
                className="prompt"
                dangerouslySetInnerHTML={{ __html: asHtmlWithBold(PROMPTS_STAGE1.step1.body) }}
              />
              <MiniChatBox onSend={() => {}} />
            </StepCard>
          )}

          {step === 2 && (
            <StepCard
              title={PROMPTS_STAGE1.step2.title}
              footer={
                <div className="actions">
                  <button className="btn" disabled={busy} onClick={runAnalyze}>
                    分析する
                  </button>
                  <button
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={async () => {
                      await persist('stage1-2', PROMPTS_STAGE1.step2.nextStep);
                      setStep(3);
                    }}
                  >
                    次の「落とし込み」へ進む
                  </button>
                </div>
              }
            >
              <pre
                className="prompt"
                dangerouslySetInnerHTML={{ __html: asHtmlWithBold(PROMPTS_STAGE1.step2.body) }}
              />
              <MiniChatBox onSend={() => {}} />
            </StepCard>
          )}

          {step === 3 && (
            <StepCard
              title={PROMPTS_STAGE1.step3.title}
              footer={
                <div className="actions">
                  <button className="btn" disabled={busy} onClick={runAnalyze}>
                    分析する
                  </button>
                  <button
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={async () => {
                      await persist('stage1-3', PROMPTS_STAGE1.step3.nextStep);
                      alert('第二段階（課金ゲート）へ進みます。');
                    }}
                  >
                    第二段階（課金）へ進む
                  </button>
                </div>
              }
            >
              <pre
                className="prompt"
                dangerouslySetInnerHTML={{ __html: asHtmlWithBold(PROMPTS_STAGE1.step3.body) }}
              />
              <MiniChatBox onSend={() => {}} />
            </StepCard>
          )}
        </>
      )}
    </div>
  );
}
