// src/components/mui/OcrIntentPanel.tsx
'use client';

import React, { useEffect, useMemo, useState } from 'react';

/**
 * OCR 取り込み時に「目的（Intent）」を軽く記録する小パネル。
 * - 依存を排して、このファイルだけで動くように実装
 * - 保存先は /api/agent/mui/stage/save
 * - sub_id は 'ocr-intent' を使用（集計しやすいキー）
 * - seed_id はセッション単位で生成： CASE-YYYYMMDD-xxxx
 */

// ========== 小ユーティリティ ==========
function getOrCreateOcrId(): string {
  if (typeof window === 'undefined') return '';
  const k = 'mui:ocr_id';
  const v = sessionStorage.getItem(k);
  if (v) return v;
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const id = `CASE-${ymd}-${Math.random().toString(36).slice(2, 6)}`;
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

// ========== コンポーネント本体 ==========
type Props = {
  user_code: string;
  defaultText?: string;
  onSaved?: (seed_id: string) => void;
  onClose?: () => void;
};

export default function OcrIntentPanel({
  user_code,
  defaultText = '',
  onSaved,
  onClose,
}: Props) {
  const [seedId, setSeedId] = useState('');
  const [intent, setIntent] = useState<'scan' | 'analyze' | 'escalate'>('scan');
  const [memo, setMemo] = useState(defaultText);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    setSeedId(getOrCreateOcrId());
  }, []);

  const toneBase = useMemo(
    () => ({
      phase: 'Outer',
      q_current: 'Q2',
      layer18: 'R3',
      guardrails: ['断定禁止', '選択肢は2つ', '行動は1つ'],
    }),
    []
  );

  const intentLabel = useMemo(() => {
    switch (intent) {
      case 'scan':
        return 'スキャンのみ（下書き整理）';
      case 'analyze':
        return '分析（無料の棚卸し）';
      case 'escalate':
        return '詳細解析へ進めたい';
    }
  }, [intent]);

  async function handleSave() {
    if (!user_code) {
      setInfo('user_code が未設定です。ログイン状態をご確認ください。');
      return;
    }
    if (!seedId) {
      setInfo('seed_id が未準備です。ページを更新してやり直してください。');
      return;
    }
    setBusy(true);
    setInfo(null);
    try {
      await saveStage({
        user_code,
        seed_id: seedId,
        sub_id: 'ocr-intent',
        phase: toneBase.phase,
        depth_stage: toneBase.layer18,
        q_current: toneBase.q_current,
        next_step: intent,
        partner_detail: memo || '',
        tone: toneBase,
      });
      setInfo('保存しました。');
      onSaved?.(seedId);
      // そのまま閉じたい場合はここで onClose?.();
    } catch (e: any) {
      setInfo(`保存に失敗：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ocr-intent">
      <header className="head">
        <div>
          <div className="eyebrow">OCR 取り込み設定</div>
          <h2 className="h2">目的の選択とメモ</h2>
          <p className="muted">
            seed_id: <code>{seedId || '...'}</code>
          </p>
        </div>
        {onClose && (
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            閉じる
          </button>
        )}
      </header>

      {info && <div className="flash">{info}</div>}

      <section className="section">
        <div className="label">目的（Intent）</div>
        <div className="radios">
          <label className={`radio ${intent === 'scan' ? 'on' : ''}`}>
            <input
              type="radio"
              name="intent"
              value="scan"
              checked={intent === 'scan'}
              onChange={() => setIntent('scan')}
            />
            スキャンのみ（下書き整理）
          </label>
          <label className={`radio ${intent === 'analyze' ? 'on' : ''}`}>
            <input
              type="radio"
              name="intent"
              value="analyze"
              checked={intent === 'analyze'}
              onChange={() => setIntent('analyze')}
            />
            分析（無料の棚卸し）
          </label>
          <label className={`radio ${intent === 'escalate' ? 'on' : ''}`}>
            <input
              type="radio"
              name="intent"
              value="escalate"
              checked={intent === 'escalate'}
              onChange={() => setIntent('escalate')}
            />
            詳細解析へ進めたい
          </label>
        </div>
      </section>

      <section className="section">
        <div className="label">補足メモ（任意）</div>
        <textarea
          className="ta"
          placeholder="相手との関係 / いつの会話か / どこが気になるか など"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          rows={4}
        />
      </section>

      <footer className="foot">
        <button className="btn" onClick={onClose} disabled={busy}>
          キャンセル
        </button>
        <div className="spacer" />
        <button
          className="btn primary"
          onClick={handleSave}
          disabled={busy || !seedId}
          aria-label={`保存（${intentLabel}）`}
        >
          {busy ? '保存中…' : `保存：${intentLabel}`}
        </button>
      </footer>

      <style jsx>{`
        .ocr-intent{
          background: linear-gradient(180deg,#ffffff,#fafaff);
          border: 1px solid rgba(0,0,0,.06);
          border-radius: 16px;
          padding: 14px;
          box-shadow: 0 10px 28px rgba(0,0,0,.06);
        }
        .head{
          display:flex; align-items:flex-end; justify-content:space-between; gap:12px; margin-bottom:10px;
        }
        .eyebrow{ font-size:12px; color:#6b6f86; letter-spacing:.08em; }
        .h2{ margin:4px 0; font-size:18px; font-weight:800; }
        .muted{ color:#6b6f86; margin:0; }
        .flash{
          background: linear-gradient(180deg,#f0e9ff, #ffe6f6);
          border:1px solid rgba(129,103,255,.25);
          padding:8px 10px; border-radius:10px; margin:8px 0 10px; color:#3b3366;
        }
        .section{ margin: 10px 0; }
        .label{ font-weight:700; margin-bottom:6px; }
        .radios{ display: grid; gap: 6px; }
        .radio{
          display:flex; gap:8px; align-items:center;
          padding:8px 10px; border-radius:12px; border:1px solid #e5e7eb; background:#fff;
        }
        .radio.on{ border-color:#c7d2fe; background:#eef2ff; }
        .ta{
          width:100%; resize:vertical; min-height:84px;
          border:1px solid #e5e7eb; border-radius:12px; padding:10px; background:#fff;
        }
        .foot{ display:flex; align-items:center; gap:8px; margin-top:12px; }
        .spacer{ flex:1; }
        .btn{
          appearance:none; cursor:pointer; border-radius:12px; padding:9px 14px;
          background:#fff; border:1px solid #e5e7eb; color:#111827; font-weight:600;
        }
        .btn.ghost{ background:#f9fafb; }
        .btn.primary{ background:#4f46e5; border-color:#4f46e5; color:#fff; }
        .btn:disabled{ opacity:.6; cursor:default; }
      `}</style>
    </div>
  );
}
