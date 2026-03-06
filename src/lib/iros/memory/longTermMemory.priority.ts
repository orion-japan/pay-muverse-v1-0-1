// src/lib/iros/memory/longTermMemory.priority.ts
// iros — Long Term Memory priority updater

import { createClient } from '@supabase/supabase-js';
import { LongTermMemoryRow } from './longTermMemory.types';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function updateMemoryPriorityV1(args: {
  rows: LongTermMemoryRow[];
}) {
  const { rows } = args;

  if (!rows || rows.length === 0) return;

  for (const row of rows) {
    const newPriority = Math.min(100, (row.priority ?? 50) + 2);

    await supabase
      .from('iros_long_term_memory')
      .update({
        priority: newPriority,
        updated_at: new Date().toISOString()
      })
      .eq('id', row.id);
  }
}
