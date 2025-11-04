// API 専用の軽量型（UIや課金の型は既存 types.ts を使用）
export type ChatRole = 'system' | 'user' | 'assistant';
export type Msg = { role: ChatRole; content: string };

import type { ConversationStage } from '@/lib/mui/types';

// agent/mui の受け取りボディ（route の型ブレをここで一元管理）
export type MuiBody = {
  conversation_code?: string;
  messages?: Msg[];
  use_kb?: boolean;
  kb_limit?: number;
  model?: string;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  source_type?: string; // 'chat' | 'fshot' など
  vars?: any;

  // mode 切替
  mode?: 'format_only' | 'coach_from_text'; // 未指定＝通常チャット
  text?: string; // format_only / coach_from_text の入力本文
  instruction?: string; // format_only の追加指示（任意）

  // 課金関連（opening/1 は無料、2〜4で有料）
  stage?: ConversationStage | 'opening';
  payjpToken?: string;
};
