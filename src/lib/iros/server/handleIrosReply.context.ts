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
    const { count, error } = await supabase
      .from('iros_messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId);

    if (error) {
      console.error('[IROS/Context] count messages failed', {
        conversationId,
        error,
      });
      return false;
    }
    return (count ?? 0) === 0;
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
