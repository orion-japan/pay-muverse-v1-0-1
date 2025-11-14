'use client';

import { Suspense } from 'react';
import * as s from './style';

import { useIntentionPrompt } from './useIntentionPrompt';
import PromptForm from './PromptForm';
import PreviewPanel from './PreviewPanel';

function InnerIntentionPromptPage() {
  const ip = useIntentionPrompt();

  const runBase = () => ip.regenerateBasePrompt();
  const runSofia = async () => await ip.runSofia();
  const runSave = async () => await ip.saveToGallery();
  const runReset = () => window.location.reload();
  const goGallery = () => (window.location.href = '/intention-gallery');

  return (
    <div style={s.wrap}>
      <h1 style={s.h1}>Intention → Resonance Image Generator 🪔</h1>

      <div style={s.grid}>
        <PromptForm form={ip.form} onChange={ip.updateForm} />

        <div style={{ display: 'grid', gap: 16 }}>
          <PreviewPanel form={ip.form} ft={ip.ft} />
        </div>
      </div>

      <section style={s.panelWide}>
        <button style={s.buttonPrimary} disabled={ip.loading} onClick={runBase}>
          ① ベース解析（Base Prompt）
        </button>

        <button style={s.buttonAccent} disabled={ip.loading} onClick={runSofia}>
          ② Sofia プロンプト生成
        </button>

        <button
          style={s.buttonSuccess}
          disabled={ip.loading || !ip.sofiaPrompt}
          onClick={runSave}
        >
          ③ ギャラリー保存
        </button>

        <button style={s.buttonSecondary} disabled={ip.loading} onClick={runReset}>
          内容クリア
        </button>

        <button style={s.buttonTertiary} disabled={ip.loading} onClick={goGallery}>
          ギャラリーへ
        </button>
      </section>

      {ip.basePrompt && (
        <section style={s.panelMini}>
          <h3 style={s.h3}>Base Prompt</h3>
          <pre style={s.codeMini}>{ip.basePrompt}</pre>
        </section>
      )}

      {ip.sofiaPrompt && (
        <section style={s.panelMini}>
          <h3 style={s.h3}>Sofia Prompt</h3>
          <pre style={s.codeMini}>{ip.sofiaPrompt}</pre>
        </section>
      )}

      {ip.runtimeError && (
        <section style={s.panelWarn}>
          <h2 style={s.h2}>⚠️ エラー</h2>
          <div style={s.errorBox}>{ip.runtimeError}</div>
        </section>
      )}
    </div>
  );
}

export default function IntentionPromptPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <InnerIntentionPromptPage />
    </Suspense>
  );
}
