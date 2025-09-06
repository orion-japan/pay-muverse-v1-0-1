// src/lib/applyQ.ts
import { buildSystemPrompt as buildFromQ, normalizeQ } from "./qcodes";

/** オプション（将来拡張用） */
export type BuildOpts = {
  factual?: boolean;
};

/**
 * 互換レイヤー：
 * 以前は buildFromQ(base, userCode, opts) の3引数だったが、
 * 現在の buildFromQ は Q を1引数で受け取る実装。
 * → base（"Q2" など）を正規化して1引数に畳み込む。
 */
export function buildMuSystemPrompt(
  base: string,            // 例: "Q1"|"Q2"|...|"q3" など表記ゆれOK
  _userCode?: string,      // 互換のため受け取るが未使用
  _opts?: BuildOpts        // 互換のため受け取るが未使用
): string {
  const q = normalizeQ(base) ?? "Q2";
  return buildFromQ(q);
}

/** Q文字列から直接ビルドするユーティリティ */
export function buildMuPromptFromQ(qLike: string): string {
  const q = normalizeQ(qLike) ?? "Q2";
  return buildFromQ(q);
}
// 既存のエクスポートの下に追記
export { buildMuSystemPrompt as buildSystemPrompt };
