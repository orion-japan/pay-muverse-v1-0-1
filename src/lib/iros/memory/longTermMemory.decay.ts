// src/lib/iros/memory/longTermMemory.decay.ts
// iros — Long Term Memory decay / archive v1

import { createClient } from '@supabase/supabase-js';
import { LongTermMemoryRow } from './longTermMemory.types';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function daysBetween(fromIso: string | null | undefined, to: Date): number {
  if (!fromIso) return 9999;
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return 9999;
  const diffMs = to.getTime() - from.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

export async function decayUnusedMemoriesV1(args: {
  allRows: LongTermMemoryRow[];
  usedRowIds: string[];
}) {
  const { allRows, usedRowIds } = args;

  if (!allRows || allRows.length === 0) return;

  const usedSet = new Set((usedRowIds ?? []).filter(Boolean));
  const now = new Date();

  for (const row of allRows) {
    if (!row?.id) continue;
    if (usedSet.has(row.id)) continue;
    if (row.status !== 'active') continue;

    const currentPriority =
      typeof row.priority === 'number' && Number.isFinite(row.priority)
        ? row.priority
        : 50;

    const ageDays = daysBetween(row.updated_at, now);

    let nextPriority = currentPriority;
    let nextStatus: 'active' | 'archived' = 'active';

    // まずは穏やかに減衰
    if (ageDays >= 7) {
      nextPriority = Math.max(10, currentPriority - 1);
    }

    // 十分古く、priority も低いものは archive
    if (ageDays >= 30 && nextPriority <= 20) {
      nextStatus = 'archived';
    }

    // 何も変わらない場合は書かない
    if (nextPriority === currentPriority && nextStatus === row.status) {
      continue;
    }

    await supabase
      .from('iros_long_term_memory')
      .update({
        priority: nextPriority,
        status: nextStatus,
        updated_at: now.toISOString(),
      })
      .eq('id', row.id);
  }
}
