// file: src/lib/iros/server/handleIrosReply.context.ts
// iros - Turn context builder (minimal)

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IrosStyle } from '@/lib/iros/system';
import type { IrosUserProfileRow } from './loadUserProfile';

import { loadBaseMetaFromMemoryState } from './handleIrosReply.state';

export type BuildTurnContextArgs = {
  supabase: SupabaseClient;
  conversationId: string;
  userCode: string;
  text: string;
  mode: string;
  traceId?: string | null;
  userProfile?: IrosUserProfileRow | null;
  requestedStyle: IrosStyle | string | null;
};

export type TurnContext = {
  isFirstTurn: boolean;

  // orchestrator に渡す
  requestedMode: string | undefined;
  requestedDepth: string | undefined;
  requestedQCode: string | undefined;

  baseMetaForTurn: any;

  // style
  effectiveStyle: IrosStyle | string | null;

  // 最終モードのフォールバックに使える
  finalMode: string | null;
};

async function resolveIsFirstTurn(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('iros_messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .limit(1);

    if (error) {
      console.error('[IROS/Context] resolveIsFirstTurn select failed', {
        conversationId,
        error,
      });
      return false;
    }

    return (data?.length ?? 0) === 0;
  } catch (e) {
    console.error('[IROS/Context] resolveIsFirstTurn unexpected', {
      conversationId,
      error: e,
    });
    return false;
  }
}


export async function buildTurnContext(
  args: BuildTurnContextArgs,
): Promise<TurnContext> {
  const {
    supabase,
    conversationId,
    userCode,
    mode,
    requestedStyle,
    userProfile,
  } = args;

  const isFirstTurn = await resolveIsFirstTurn(supabase, conversationId);

  const styleFromProfile =
    userProfile && typeof (userProfile as any).style === 'string'
      ? ((userProfile as any).style as string)
      : null;

  const effectiveStyle =
    (requestedStyle &&
    typeof requestedStyle === 'string' &&
    requestedStyle.trim().length > 0
      ? requestedStyle
      : null) ??
    styleFromProfile ??
    null;

  const requestedMode = mode === 'auto' ? undefined : mode;

  // ここは “後で” qTrace / will / depth 推定を入れる
  const requestedDepth = undefined;
  const requestedQCode = undefined;

  // base meta
  let baseMetaForTurn: any = {};
  if (effectiveStyle) baseMetaForTurn.style = effectiveStyle;

  // ✅ MemoryState を読み、baseMeta に合成（depth / qCode / selfAcceptance / y/h）
  const { mergedBaseMeta } = await loadBaseMetaFromMemoryState({
    userCode,
    baseMeta: baseMetaForTurn,
  });
  baseMetaForTurn = mergedBaseMeta ?? baseMetaForTurn;

  // ★ 回転状態（spin/descent）を camelCase に寄せて保持（下流の取りこぼし防止）
  {
    const spinLoop =
      baseMetaForTurn?.spinLoop ??
      baseMetaForTurn?.spin_loop ??
      null;

    const descentGate =
      baseMetaForTurn?.descentGate ??
      baseMetaForTurn?.descent_gate ??
      null;

    if (spinLoop) baseMetaForTurn.spinLoop = spinLoop;
    if (descentGate) baseMetaForTurn.descentGate = descentGate;
  }

  // ★ phase を baseMetaForTurn に注入（pivot 判定のため必須）
{
  const phase =
    baseMetaForTurn?.phase ??
    baseMetaForTurn?.phase_raw ??
    baseMetaForTurn?.phaseStage ??
    null;

  if (phase) {
    baseMetaForTurn.phase = phase;
  }
}

  return {
    isFirstTurn,
    requestedMode,
    requestedDepth,
    requestedQCode,
    baseMetaForTurn,
    effectiveStyle,
    finalMode: mode ?? null,
  };
}
