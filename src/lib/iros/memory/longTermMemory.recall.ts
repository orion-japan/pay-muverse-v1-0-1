// src/lib/iros/memory/longTermMemory.recall.ts
// iros — Long Term Memory recall v1
// 役割：DBから長期メモリーを読み出し、writer注入用の noteText を作る

import { createClient } from '@supabase/supabase-js';
import {
  BuildLongTermMemoryNoteArgs,
  BuildLongTermMemoryNoteResult,
  LoadLongTermMemoriesArgs,
  LongTermMemoryRow,
  LongTermMemoryType
} from './longTermMemory.types';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function typeLabel(type: LongTermMemoryType): string {
  switch (type) {
    case 'working_rule':
      return 'working_rule';
    case 'preference':
      return 'preference';
    case 'project_context':
      return 'project_context';
    case 'durable_fact':
      return 'durable_fact';
    case 'episodic_event':
      return 'episodic_event';
    default:
      return 'durable_fact';
  }
}

export async function loadDurableMemoriesForTurnV1(
  args: LoadLongTermMemoriesArgs
): Promise<LongTermMemoryRow[]> {
  const { userCode, limit = 12, types } = args;

  let query = supabase
    .from('iros_long_term_memory')
    .select('*')
    .eq('user_code', userCode)
    .eq('status', 'active')
    .order('priority', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (types && types.length > 0) {
    query = query.in('memory_type', types);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[IROS/LTM][RECALL_ERROR]', error);
    return [];
  }

  return (data ?? []) as LongTermMemoryRow[];
}

export function buildLongTermMemoryNoteTextV1(
  args: BuildLongTermMemoryNoteArgs
): BuildLongTermMemoryNoteResult {
  const { rows, maxItems = 8 } = args;

  if (!rows.length) {
    return {
      noteText: '',
      picked: []
    };
  }

  const picked = rows.slice(0, Math.max(1, maxItems));

  const body = picked
    .map((row) => `- ${typeLabel(row.memory_type)}: ${row.value_text}`)
    .join('\n');

  const noteText =
    '【LONG_TERM_MEMORY / DO NOT OUTPUT】\n' +
    body;

  return {
    noteText,
    picked
  };
}
