// /src/lib/iros/config.ts
// 互換レイヤ：古い import を壊さず、system.ts に一元化
export { IROS_PROMPT, buildSystemPrompt, type Mode } from './system';

// ▼ 後方互換のための最小型（使っている箇所があってもビルドが通る）
//   必要に応じてフィールドを絞る/強めるのは後でOK
export type Analysis = {
  phase?: 'Inner' | 'Outer';
  depth?: string;
  q?: string;
  [key: string]: unknown;
};
