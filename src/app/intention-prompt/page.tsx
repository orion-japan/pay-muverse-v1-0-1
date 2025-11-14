'use client';

import * as s from './style';

import { useIntentionPrompt } from './useIntentionPrompt';
import PromptForm from './PromptForm';
import PreviewPanel from './PreviewPanel';

export default function IntentionPromptPage() {
  const ip = useIntentionPrompt();

  /* --- 実行 --- */
  const runBase = () => {
    ip.regenerateBasePrompt();
  };

  const runSofia = async () => {
    await ip.runSofia();
  };

  const runSave = async () => {
    await ip.saveToGallery();
  };

  const runReset = () => {
    // useIntentionPrompt に reset 機能を後で追加します
    window.location.reload();
  };

  const goGallery = () => {
    window.location.href = '/intention-gallery';
  };

  return (
    <div style={s.wrap}>
      <h1 style={s.h1}>Intention → Resonance Image Generator 🪔</h1>

      {/* === 入力フォーム + プレビュー === */}
      <div style={s.grid}>

        {/* 祈りフォーム */}
        <PromptForm form={ip.form} onChange={ip.updateForm} />

        {/* プレビュー */}
        <div style={{ display: 'grid', gap: 16 }}>
          <PreviewPanel form={ip.form} ft={ip.ft} />
        </div>
      </div>

      {/* === 実行ボタン === */}
      <section style={s.panelWide}>
{/* ① ベース解析 */}
<button
  style={s.buttonPrimary}
  disabled={ip.loading}
  onClick={runBase}
>
  ① ベース解析（Base Prompt）
</button>

{/* ② Sofia プロンプト生成 */}
<button
  style={s.buttonAccent}
  disabled={ip.loading}
  onClick={runSofia}
>
  ② Sofia プロンプト生成
</button>

{/* ③ ギャラリー保存 */}
<button
  style={s.buttonSuccess}
  disabled={ip.loading || !ip.sofiaPrompt}
  onClick={runSave}
>
  ③ ギャラリー保存
</button>

{/* 内容クリア */}
<button
  style={s.buttonSecondary}
  disabled={ip.loading}
  onClick={runReset}
>
  内容クリア
</button>


        {/* ギャラリーへ */}
        <button
          style={s.buttonTertiary}
          disabled={ip.loading}
          onClick={goGallery}
        >
          ギャラリーへ
        </button>
      </section>

      {/* === Base Prompt === */}
      {ip.basePrompt && (
        <section style={s.panelMini}>
          <h3 style={s.h3}>Base Prompt</h3>
          <pre style={s.codeMini}>{ip.basePrompt}</pre>
        </section>
      )}

      {/* === Sofia Prompt === */}
      {ip.sofiaPrompt && (
        <section style={s.panelMini}>
          <h3 style={s.h3}>Sofia Prompt</h3>
          <pre style={s.codeMini}>{ip.sofiaPrompt}</pre>
        </section>
      )}

      {/* === エラー表示 === */}
      {ip.runtimeError && (
        <section style={s.panelWarn}>
          <h2 style={s.h2}>⚠️ エラー</h2>
          <div style={s.errorBox}>{ip.runtimeError}</div>
        </section>
      )}
    </div>
  );
}
