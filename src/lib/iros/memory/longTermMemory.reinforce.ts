// src/lib/iros/memory/longTermMemory.reinforce.ts
// iros — Long Term Memory reinforcement v1

import { createClient } from '@supabase/supabase-js';
import type { LongTermMemoryCandidate } from './longTermMemory.types';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function nextConfidence(current: number | string | null | undefined): number {
  const n =
    typeof current === 'number'
      ? current
      : typeof current === 'string'
        ? Number(current)
        : 0.7;

  if (!Number.isFinite(n)) return 0.72;
  return Math.min(0.98, Number((n + 0.03).toFixed(3)));
}

function nextPriority(current: number | null | undefined): number {
  const n = typeof current === 'number' && Number.isFinite(current) ? current : 50;
  return Math.min(100, n + 3);
}

export async function reinforceDurableMemoriesV1(args: {
  userCode: string;
  candidates: LongTermMemoryCandidate[];
}) {
  const { userCode, candidates } = args;

  if (!userCode || !candidates || candidates.length === 0) return;

  for (const candidate of candidates) {
    const lookupKey = String(candidate.key ?? '').trim();
    if (!lookupKey) continue;

    const { data, error } = await supabase
      .from('iros_long_term_memory')
      .select('id, priority, confidence, source, status')
      .eq('user_code', userCode)
      .eq('key', lookupKey)
      .maybeSingle();

    if (error || !data) continue;
    if (data.status !== 'active') continue;

    const { error: updateError } = await supabase
      .from('iros_long_term_memory')
      .update({
        priority: nextPriority(data.priority),
        confidence: nextConfidence(data.confidence),
        updated_at: new Date().toISOString(),
      })
      .eq('id', data.id);

    if (updateError) {
      console.warn('[IROS/LTM][REINFORCE_ERROR]', {
        key: lookupKey,
        message: updateError.message,
      });
    }
  }
}
