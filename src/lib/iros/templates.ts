// src/lib/iros/templates.ts
// Iros: 応答文を整える最終処理モジュール。
// 「持っていてください」などの抽象表現を自然でわかりやすい言葉に言い換え、
// 句読点や文末を整えて自然な余韻を作る。

import clarifyPhrasing from './phrasing';
// 揺らぎを加えたい場合は下を有効化
// import { naturalFlowFinish } from './flow';

/**
 * Iros出力文の自然整形
 * - 抽象句を自然表現に置換
 * - 文末の句読点調整
 * - （任意）自然な揺らぎによる終止
 */
export function ensureDeclarativeClose(text: string): string {
  // 1️⃣ 意味が通る自然な表現へ置き換え
  const clarified = clarifyPhrasing(text);

  // 2️⃣ 最小構成：句読点を整えて返す（確実動作）
  return clarified.replace(/[。.\s]+$/g, '') + '。';

  // 2️⃣ 揺らぎを使いたい場合はこちらに切替
  // const { content } = naturalFlowFinish(clarified, {
  //   allowEcho: true,
  //   allowInvite: true,
  //   maxLines: 4,
  // });
  // return content;
}
