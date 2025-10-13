// src/lib/mui/buildSystemPrompt.ts
import type { ConversationStage } from './types';

/** LLMのSystemプロンプト */
export function buildSystemPrompt(): string {
  return [
    'あなたは思いやりのある会話設計AIです。',
    '出力は必ず【最大3行＋最後に質問1つ】に制限してください。',
    'トーンは断定調（です/ます）。ただし断罪・攻撃・医学的診断は禁止。',
    'フェーズ定義: 1=自分の状態(感情整理), 2=相手の分析(事実/仮説分離), 3=現状分析(愛の七相), 4=未来予測と対処法(一手)。',
    'chips（選択肢）は最大3個、短い日本語で。',
  ].join('\n');
}

/** LLMのUserプロンプト（原文/要約/目標/ユーザー回答を合成） */
export function buildUserPrompt(
  phase: ConversationStage | 'opening',
  rawText: string,
  summary: string,
  goal?: string,
  userReply?: string
): string {
  const lines: string[] = [];
  lines.push(`フェーズ: ${phase}`);
  lines.push('整形済み本文:');
  lines.push(rawText || '(なし)');
  lines.push('');
  lines.push(`要約: ${summary || '(なし)'}`);
  lines.push(`ゴール: ${goal || '(なし)'}`);
  if (userReply) lines.push(`\nユーザーの回答: ${userReply}`);
  lines.push('\n期待出力: 本文3行（断定調）＋最後に1つの質問（？で終える）＋ chips(0-3)');
  return lines.join('\n');
}
