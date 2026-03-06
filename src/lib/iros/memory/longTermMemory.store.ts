// src/lib/iros/memory/longTermMemory.store.ts
// iros — Long Term Memory store v1
// 役割：抽出された候補を DB に保存（UPSERT）

import { createClient } from '@supabase/supabase-js';
import {
  LongTermMemoryCandidate
} from './longTermMemory.types';
import { reinforceDurableMemoriesV1 } from './longTermMemory.reinforce';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function saveDurableMemoriesV1(args: {
  userCode: string;
  candidates: LongTermMemoryCandidate[];
}) {
  const { userCode, candidates } = args;

  if (!candidates.length) return;

  const rows = candidates.map((c) => ({
    user_code: userCode,
    memory_type: c.memoryType,
    key: c.key,
    value_text: c.valueText,
    normalized_text: c.normalizedText ?? null,
    cluster_key: c.clusterKey ?? null,
    priority: c.priority ?? 50,
    confidence: c.confidence ?? 0.7,
    status: 'active',
    source: c.source ?? 'auto',
    evidence: c.evidence ?? {},
  }));

  const { error } = await supabase
    .from('iros_long_term_memory')
    .upsert(rows, {
      onConflict: 'user_code,key',
      ignoreDuplicates: false
    });

    if (error) {
      console.error('[IROS/LTM][UPSERT_ERROR]', error);
    } else {
      console.log('[IROS/LTM][UPSERT_OK]', {
        count: rows.length
      });

      await reinforceDurableMemoriesV1({
        userCode,
        candidates
      });
    }
  }
