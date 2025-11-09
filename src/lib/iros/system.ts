// src/lib/iros/system.ts
// Iros System Prompt — 互換エクスポート・シム
// - 旧実装が期待する named exports（buildSystemPrompt / naturalClose / Mode / IROS_SYSTEM）を提供
// - default export でも IROS_SYSTEM を返す（import スタイル混在対策）

export type Mode = 'Auto' | 'Reflect' | 'Resonate' | 'Diagnosis';

export interface BuildOptions {
  personaName?: string;          // 既定: "Iros"
  style?: 'gentle' | 'crisp';    // 既定: 'gentle'
  extra?: string;                // 任意追記
  modeHint?: Mode;               // 旧コード互換のためのヒント
}

// ベースのシステム・プロンプト（必要最低限。実運用の本文は別モジュールで拡張可）
const CORE_PROMPT = `
あなたは「Iros」。対話の表層ではなく、発話の背後にある意図の芯に静かに共鳴して応答する“相棒AI”です。
- 声のトーンはやわらかく、2〜3行で改行するリズムを基本とします
- 断定を避け、比喩と余白を活かし、相手の確信をそっと照らします
`.trim();

function composePrompt(opts?: BuildOptions): string {
  const persona = (opts?.personaName ?? 'Iros').trim();
  const style = opts?.style ?? 'gentle';

  const styleRule =
    style === 'crisp'
      ? `- 表現はややシャープに。箇条書き・短文重視。`
      : `- 表現はやわらかく。行間と余白を大切に。`;

  const modeHint =
    opts?.modeHint
      ? `- 参考モード: ${opts.modeHint}`
      : '';

  const extra = opts?.extra ? `\n${opts.extra}` : '';

  return [
    `# System: ${persona}`,
    CORE_PROMPT,
    styleRule,
    modeHint,
    extra,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 旧コード互換：buildSystemPrompt(options) -> string */
export function buildSystemPrompt(options?: BuildOptions): string {
  return composePrompt(options);
}

/** 旧コード互換：文末を自然に閉じる軽い整形（最低限のダミーでOK） */
export function naturalClose(text: string): string {
  if (!text) return '';
  const t = String(text).trim();
  // 句点で終わっていなければ句点を足す（日本語想定の最低限対処）
  if (/[。.!?！？」』]$/.test(t)) return t;
  return `${t}。`;
}

/** 旧実装が参照していた定数名（named & default の両対応にする） */
export const IROS_SYSTEM = composePrompt({ personaName: 'Iros', style: 'gentle' });

// default export でも同一文字列を返す（import IROS_SYSTEM from ...対策）
export default IROS_SYSTEM;
