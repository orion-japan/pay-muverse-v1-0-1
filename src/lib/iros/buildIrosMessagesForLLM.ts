// src/lib/iros/buildIrosMessagesForLLM.ts
// Iros用: MemoryFrame + History + CurrentTurn をまとめて LLM に渡すヘルパー

import type { ChatMessage } from '@/lib/llm/chatComplete';
import { IROS_SYSTEM } from './system';

/** DB から取ってくる「生の履歴」用の型（最低限） */
export type HistoryMsg = {
  role: 'user' | 'assistant';
  content: string;
};

/** Iros の状態フレーム（Q / 深度 / 意図レイヤーなど） */
export type IrosStateFrame = {
  qTrace: {
    currentQ: string | null;
    streakQ: string | null;
    streakLength: number;
  };
  depthStage: string | null;
  intentLayer: string | null;
  intentSummary: string | null;
};

/**
 * Iros の状態と直近履歴をまとめて LLM に渡す messages を構築
 *
 * - state: いまのQ/深度/意図 などの「横にある」情報
 * - history: DBから取った直近の会話ログ（流れ）
 * - userText: 今回のユーザー発話
 */
export function buildIrosMessagesForLLM(opts: {
  state: IrosStateFrame;
  history: HistoryMsg[];
  userText: string;
}): ChatMessage[] {
  const { state, history, userText } = opts;

  // ① 状態フレーム（MemoryFrame）を JSON にする
  const memoryFrameText = JSON.stringify(
    {
      type: 'IROS_MEMORY_FRAME',
      qTrace: state.qTrace,
      depthStage: state.depthStage,
      intentLayer: state.intentLayer,
      intentSummary: state.intentSummary,
    },
    null,
    2,
  );

  // ② 直近の会話ログを「流れテキスト」にまとめる
  const historyText =
    history.length === 0
      ? '(直近のログはありません)'
      : history
          .map((m) =>
            m.role === 'user' ? `User: ${m.content}` : `Iros: ${m.content}`,
          )
          .join('\n');

  // ③ LLM に渡す messages
  const messages: ChatMessage[] = [
    // Iros の在り方（既存の system）
    { role: 'system', content: IROS_SYSTEM },

    // 状態フレーム: Qコード・深度・意図レイヤーなど
    {
      role: 'system',
      content:
        '以下は、このユーザーとの最近の状態フレームです。' +
        'Qコード・深度・意図レイヤーを参考に、流れを壊さないように応答してください。\n\n' +
        memoryFrameText,
    },

    // 会話の流れ: 直近のログをまとめたもの
    {
      role: 'system',
      content:
        '以下は、この会話の直近の流れです。文脈とトーンを引き継いでください：\n\n' +
        historyText,
    },

    // 今回の発話
    { role: 'user', content: userText },
  ];

  return messages;
}
