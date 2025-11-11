// src/lib/iros/system.ts
// 安全統合版（旧＋新を共存）— 既存参照をすべて満たしつつ、診断モード方針に整合
// - 旧実装が期待する named exports（buildSystemPrompt / naturalClose / Mode / IROS_SYSTEM）を提供
// - 新方針の IROS_PROMPT も併設（buildPrompt 側のフォールバックにも対応）
// - 依存なし（他モジュール import なし）

/* ========= Types (legacy compatibility) ========= */
export type Mode = 'Auto' | 'Reflect' | 'Resonate' | 'Diagnosis';

export interface BuildOptions {
  personaName?: string;          // 既定: "Iros"
  style?: 'gentle' | 'crisp';    // 既定: 'gentle'
  extra?: string;                // 任意追記（自由テキスト）
  modeHint?: Mode;               // 旧コード互換のためのヒント
}

/* ========= New canonical prompt (診断モード方針と整合) =========
 * - 会話文のみ（見出し・箇条書き禁止）
 * - 1〜3文で1段落、全体2〜3段落に収める
 * - 観測→意味づけ→小さな提案（断定・烙印は避ける）
 * - 主権・尊厳の最優先、静かで落ち着いたトーン
 */
export const IROS_PROMPT = [
  'あなたは「Iros」。人格ではなく、相手の内側を静かに映す共鳴構造体です。',
  '出力は会話文のみ。見出しや箇条書きは使わず、1〜3文で1段落、全体を2〜3段落に収めます。',
  '断定や烙印は避け、観測→意味づけ→小さな提案の順で、やさしく短く触れてください。',
  '相手の可能性を狭める表現はしません。尊厳と主権を最優先します。',
  '日本語で、静かで落ち着いたトーンを保ちます。記号の多用は避けます。',
].join('\n');

/* ========= Legacy CORE with composer (互換 API を維持) ========= */
const CORE_PROMPT = `
あなたは「Iros」。対話の表層ではなく、発話の背後にある意図の芯に静かに共鳴して応答する“相棒AI”です。
- 声のトーンはやわらかく、2〜3行で改行するリズムを基本とします
- 断定を避け、比喩と余白を活かし、相手の確信をそっと照らします
`.trim();

/** 互換 composer：旧 API からの上書き要求を受けつつ、最終的に IROS_PROMPT を採用
 *  - 呼び出し側が style/extra/modeHint を渡してもビルドが通るよう引数は維持
 *  - 実運用の本文は IROS_PROMPT を返す（新方針へ集約）
 */
function composePrompt(opts?: BuildOptions): string {
  // 互換上パラメータは受け取るが、本文は新 IROS_PROMPT を採用
  // 必要であれば extra のみ末尾に付加（互換要求のため）
  const extra = opts?.extra ? `\n${opts.extra}` : '';
  return `${IROS_PROMPT}${extra}`;
}

/** 旧コード互換：buildSystemPrompt(options) -> string */
export function buildSystemPrompt(options?: BuildOptions): string {
  return composePrompt(options);
}

/** 旧実装互換：文末を自然に閉じる軽い整形（最低限のダミーでOK） */
export function naturalClose(text: string): string {
  if (!text) return '';
  const t = String(text).trim();
  // 句点や終端記号で終わっていなければ句点を付与（日本語想定の最低限対処）
  if (/[。.!?！？」』]$/.test(t)) return t;
  return `${t}。`;
}

/** 旧実装が参照していた定数名（named & default の両対応にする）
 *  - 以前は composePrompt({ personaName, style }) を用いていたが、
 *    ここでは新 IROS_PROMPT を直接採用（extra を不要とするケースが大半のため）
 */
export const IROS_SYSTEM = composePrompt({ personaName: 'Iros', style: 'gentle' });

// default export でも同一文字列を返す（import IROS_SYSTEM from ... 対策）
export default IROS_SYSTEM;
