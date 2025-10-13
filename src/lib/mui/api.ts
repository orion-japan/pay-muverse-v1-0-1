// src/lib/mui/api.ts
import type {
  AgentMuiPayload,
  AiOpening,
  AiTurn,
  ConversationStage,
  StageSaveBody,
} from './types';

const INTERNAL_URL =
  process.env.NEXT_PUBLIC_INTERNAL_URL || process.env.INTERNAL_URL || '';

export async function callAgentMui<T = any>(payload: AgentMuiPayload): Promise<T> {
  const r = await fetch(`${INTERNAL_URL}/api/agent/mui`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`agent/mui failed: ${r.status}`);
  return r.json();
}

/** 保存API（失敗してもUIは止めない） */
export async function saveStage(body: StageSaveBody) {
  try {
    await fetch(`${INTERNAL_URL}/api/agent/mui/stage/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {}
}

/** LLMのテキスト出力 → UIスキーマへ抽出 */
export function parseAgentTextToUi(text: string): {
  message: string;
  question: string;
  chips: string[];
} {
  const lines = text
    .trim()
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  // [chips] A | B | C
  const chipsLine = lines.find((l) => l.startsWith('[chips]'));
  const chips = chipsLine
    ? chipsLine
        .replace('[chips]', '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const withoutChips = lines.filter((l) => !l.startsWith('[chips]'));
  const qIdx = withoutChips.findIndex((l) => /[？?]$/.test(l));
  const question = qIdx >= 0 ? withoutChips[qIdx] : 'ここまでで質問はありますか？';
  const body = withoutChips.slice(0, qIdx >= 0 ? qIdx : 3).slice(0, 3).join('\n');

  return { message: body, question, chips };
}
