// src/lib/sofia/util/conversation.ts

/**
 * Iros / Sofia などエージェント別の会話IDを生成するユーティリティ。
 * 例:
 *  - Sofia → SF-abc123
 *  - Iros  → IR-xyz789
 */
export type ConversationPrefix = 'SF' | 'IR';

/** a-z0-9 の短いトークンを生成（6桁） */
function shortToken(len = 6) {
  // Math.random() 依存でも十分だが、将来 seedable に差し替えやすい構造に
  return Math.random()
    .toString(36)
    .slice(2, 2 + len);
}

/** 会話コードを生成。デフォルトは Iros 用 "IR-xxxxxx" */
export function generateConversationCode(prefix: ConversationPrefix = 'IR') {
  const token = shortToken(6);
  return `${prefix}-${token}`;
}

/**
 * 既存の conversationId が空なら生成して返すヘルパ。
 * Iros 用の既定 prefix は "IR"
 */
export function ensureConversationId(conversationId?: string, prefix: ConversationPrefix = 'IR') {
  return conversationId && conversationId.trim() !== ''
    ? conversationId
    : generateConversationCode(prefix);
}
