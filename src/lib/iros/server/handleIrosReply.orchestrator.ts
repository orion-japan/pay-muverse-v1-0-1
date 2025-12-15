// file: src/lib/iros/server/handleIrosReply.orchestrator.ts
// iros - Orchestrator wrapper (minimal)

import { runIrosTurn } from '@/lib/iros/orchestrator';
import type { IrosStyle } from '@/lib/iros/system';
import type { IrosUserProfileRow } from './loadUserProfile';

export type RunOrchestratorTurnArgs = {
  conversationId: string;
  userCode: string;
  text: string;

  isFirstTurn: boolean;

  requestedMode: string | undefined;
  requestedDepth: string | undefined;
  requestedQCode: string | undefined;

  baseMetaForTurn: any;

  userProfile: IrosUserProfileRow | null;
  effectiveStyle: IrosStyle | string | null;
};

export async function runOrchestratorTurn(args: RunOrchestratorTurnArgs): Promise<any> {
  const {
    conversationId,
    userCode,
    text,
    isFirstTurn,
    requestedMode,
    requestedDepth,
    requestedQCode,
    baseMetaForTurn,
    userProfile,
    effectiveStyle,
  } = args;

  // runIrosTurn 側の引数型に合わせて any で渡す（段階的に厳密化する）
  return await runIrosTurn({
    conversationId,
    userCode,
    text,
    isFirstTurn,
    requestedMode: requestedMode as any,
    requestedDepth: requestedDepth as any,
    requestedQCode: requestedQCode as any,
    baseMeta: baseMetaForTurn,
    userProfile,
    style: effectiveStyle as any,
  } as any);
}
