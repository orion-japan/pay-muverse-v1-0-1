// src/ui/iroschat/lib/irosApi.ts
'use client';

/**
 * iros フロント用 Facade
 * - UI はこのファイルだけを import する
 * - 実装・fetch・auth・保存などは irosApiClient.ts に閉じ込める
 */

// ✅ Public API（UI が使ってよい）
export { irosClient } from './irosApiClient';
export type { IrosAPI, IrosStyle, IrosChatHistoryItem } from './irosApiClient';

// ⚠️ Internal（UI から直に使わせたくないが、互換のため残す場合はここ）
// 使う側では `irosInternal.*` 以外を import しない運用にする
export const irosInternal = {
  retryAuth: (await import('./irosApiClient')).retryAuth,
  fetchPersonIntentState: (await import('./irosApiClient')).fetchPersonIntentState,
};
