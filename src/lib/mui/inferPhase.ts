// src/lib/mui/inferPhase.ts

export type Phase = 'Inner' | 'Outer' | 'Mixed';

export function inferPhase(input: { text: string }): { phase: Phase; reason?: string } {
  const t = (input.text || '').toLowerCase();

  // 簡易ルール（本実装に差し替え可）
  const selfHints = ['私', '自分', '不安', 'つらい', 'どうしたら'];
  const partnerHints = ['相手', '彼', '彼女', '既読', '未読', '返信'];

  const hasSelf = selfHints.some((k) => t.includes(k));
  const hasPartner = partnerHints.some((k) => t.includes(k));

  if (hasSelf && !hasPartner) return { phase: 'Inner', reason: 'self-centric cues' };
  if (!hasSelf && hasPartner) return { phase: 'Outer', reason: 'partner-centric cues' };
  return { phase: 'Mixed', reason: 'ambiguous' };
}

export default inferPhase;
