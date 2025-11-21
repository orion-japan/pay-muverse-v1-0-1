// file: src/lib/resonance/loadResonanceState.ts

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error('[loadResonanceState] NEXT_PUBLIC_SUPABASE_URL is not set');
}
if (!serviceRoleKey) {
  throw new Error(
    '[loadResonanceState] SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set',
  );
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

export type ResonanceState = {
  last_q: string | null;
  last_depth: string | null;
  last_phase: string | null;
  last_self_acceptance: number | null;
  streak_q: string | null;
  streak_count: number;
  updated_at: string | null;
};

/**
 * ユーザーの直近の共鳴状態を取得する
 *  - tenantId を省略した場合は 'default'
 */
export async function loadResonanceState(
  userCode: string,
  options?: { tenantId?: string },
): Promise<ResonanceState> {
  const tenantId =
    options?.tenantId && options.tenantId.trim().length > 0
      ? options.tenantId.trim()
      : 'default';

  const { data, error } = await supabase
    .from('user_resonance_state')
    .select(
      'last_q, last_depth, last_phase, last_self_acceptance, streak_q, streak_count, updated_at',
    )
    .eq('user_code', userCode)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error) {
    console.error('[loadResonanceState] failed', { userCode, tenantId, error });
    throw new Error(`loadResonanceState failed: ${error.message}`);
  }

  if (!data) {
    // レコードがまだない場合のデフォルト
    return {
      last_q: null,
      last_depth: null,
      last_phase: null,
      last_self_acceptance: null,
      streak_q: null,
      streak_count: 0,
      updated_at: null,
    };
  }

  return {
    last_q: data.last_q ?? null,
    last_depth: data.last_depth ?? null,
    last_phase: data.last_phase ?? null,
    last_self_acceptance:
      typeof data.last_self_acceptance === 'number' ? data.last_self_acceptance : null,
    streak_q: data.streak_q ?? null,
    streak_count: typeof data.streak_count === 'number' ? data.streak_count : 0,
    updated_at: data.updated_at ?? null,
  };
}
