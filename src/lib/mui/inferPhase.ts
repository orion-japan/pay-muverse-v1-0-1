export type Phase = 'Inner'|'Outer';
export const inferPhase = (text: string): Phase => {
  const t = (text||'').toLowerCase();
  const outerHints = ['会お', '行こ', 'やろ', '連絡', '予定', '返信', '写真', '共有', '招待'];
  const isOuter = outerHints.some(k => t.includes(k));
  return isOuter ? 'Outer' : 'Inner';
};
