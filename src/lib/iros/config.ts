// /src/lib/iros/config.ts
// 役割：古い import を壊さず、system.ts に一元化
// - 互換用に IROS_PROMPT をエイリアス提供（buildSystemPrompt()の即時値）
// - 今後は buildSystemPrompt の使用推奨

import { buildSystemPrompt, type Mode } from './system';

// 互換: 旧コードが期待する定数。実体は現行System Promptの即時生成値
export const IROS_PROMPT: string = buildSystemPrompt();

// そのまま再エクスポート（他モジュールが import しやすいように）
export { buildSystemPrompt };
export type { Mode };

// 後方互換のための最小型（既存参照があってもビルドが通る）
// 必要に応じてフィールドを増減してください
export type Analysis = {
  phase2: 'Inner' | 'Outer';
  depth2: string;
  q2: string;
  [key: string]: unknown;
};
