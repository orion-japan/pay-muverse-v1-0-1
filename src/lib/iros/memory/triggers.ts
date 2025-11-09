// 会話内容から「保存すべき区切り」を検出
export type SaveTrigger = 'decision' | 'todo' | 'milestone';

const DECISION_CUES = ['決めよう', '採用する', 'これでいく', '方針確定', '仕様確定'];
const TODO_CUES      = ['やる', '対応する', 'タスク化', 'TODO', 'やります'];
const MILESTONE_CUES = ['完了', '達成', '一区切り', '締め', 'クローズ'];

export function detectSaveTriggers(userText: string, assistantText: string): SaveTrigger[] {
  const t = `${userText}\n${assistantText}`.toLowerCase();
  const hit = new Set<SaveTrigger>();
  if (DECISION_CUES.some(w => t.includes(w.toLowerCase())))  hit.add('decision');
  if (TODO_CUES.some(w => t.includes(w.toLowerCase())))      hit.add('todo');
  if (MILESTONE_CUES.some(w => t.includes(w.toLowerCase()))) hit.add('milestone');
  return [...hit];
}
