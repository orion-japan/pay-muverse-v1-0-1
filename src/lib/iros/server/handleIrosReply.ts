// file: src/lib/iros/server/handleIrosReply.ts

import type { IrosStyle } from '@/lib/iros/system';
import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';
import type { IrosUserProfileRow } from './loadUserProfile';

import { getIrosSupabaseAdmin } from './handleIrosReply.supabase';

import { runGreetingGate, runMicroGate } from './handleIrosReply.gates';

import { buildTurnContext } from './handleIrosReply.context';
import { runOrchestratorTurn } from './handleIrosReply.orchestrator';

import { postProcessReply } from './handleIrosReply.postprocess';

import {
  persistAssistantMessage,
  persistIntentAnchorIfAny,
  persistMemoryStateIfAny,
  persistUnifiedAnalysisIfAny,
  persistQCodeSnapshotIfAny,
} from './handleIrosReply.persist';

export type HandleIrosReplyInput = {
  conversationId: string;
  text: string;
  hintText?: string;
  mode: string;
  userCode: string;
  tenantId: string;
  rememberScope: RememberScopeKind | null;
  reqOrigin: string;
  authorizationHeader: string | null;
  traceId?: string | null;

  userProfile?: IrosUserProfileRow | null;
  style?: IrosStyle | string | null;
};

export type HandleIrosReplySuccess = {
  ok: true;
  result: any;
  assistantText: string;
  metaForSave: any;
  finalMode: string | null;
};

export type HandleIrosReplyError = {
  ok: false;
  error: 'generation_failed';
  detail: string;
};

export type HandleIrosReplyOutput =
  | HandleIrosReplySuccess
  | HandleIrosReplyError;

const supabase = getIrosSupabaseAdmin();

export async function handleIrosReply(
  params: HandleIrosReplyInput,
): Promise<HandleIrosReplyOutput> {
  const {
    conversationId,
    text,
    mode,
    userCode,
    tenantId,
    rememberScope,
    reqOrigin,
    authorizationHeader,
    traceId,
    userProfile,
    style,
  } = params;

  console.log('[IROS/Reply] handleIrosReply start', {
    conversationId,
    userCode,
    mode,
    tenantId,
    rememberScope,
    traceId,
    style,
  });

  try {
    // 0) 軽量ゲート（挨拶 / 超短文）
    {
      const gatedGreeting = await runGreetingGate({
        supabase,
        conversationId,
        userCode,
        text,
        userProfile,
        reqOrigin,
        authorizationHeader,
      });
      if (gatedGreeting) return gatedGreeting;

      const gatedMicro = await runMicroGate({
        supabase,
        conversationId,
        userCode,
        text,
        userProfile,
        reqOrigin,
        authorizationHeader,
        traceId,
      });
      if (gatedMicro) return gatedMicro;
    }

    // 1) 文脈を組み立てる
    const ctx = await buildTurnContext({
      supabase,
      conversationId,
      userCode,
      text,
      mode,
      traceId,
      userProfile,
      requestedStyle: style ?? null,
    });

    // 2) 司令塔：オーケストレーター呼び出し
    const orch = await runOrchestratorTurn({
      conversationId,
      userCode,
      text,
      isFirstTurn: ctx.isFirstTurn,
      requestedMode: ctx.requestedMode,
      requestedDepth: ctx.requestedDepth,
      requestedQCode: ctx.requestedQCode,
      baseMetaForTurn: ctx.baseMetaForTurn,
      userProfile: userProfile ?? null,
      effectiveStyle: ctx.effectiveStyle,
    });

    // 3) 後処理（WILL drift / Soul failsafe / renderEngine / meta補強）
    const out = await postProcessReply({
      supabase,
      userCode,
      conversationId,
      userText: text,
      effectiveStyle: ctx.effectiveStyle,
      requestedMode: ctx.requestedMode,
      orchResult: orch,
    });

    // 4) 永続化（順番だけここに残す）
    await persistQCodeSnapshotIfAny({
      userCode,
      conversationId,
      requestedMode: ctx.requestedMode,
      metaForSave: out.metaForSave,
    });

    await persistIntentAnchorIfAny({
      supabase,
      userCode,
      metaForSave: out.metaForSave,
    });

    await persistMemoryStateIfAny({
      supabase,
      userCode,
      metaForSave: out.metaForSave,
    });

    await persistUnifiedAnalysisIfAny({
      supabase,
      userCode,
      tenantId,
      userText: text,
      assistantText: out.assistantText,
      metaForSave: out.metaForSave,
      conversationId,
    });

    await persistAssistantMessage({
      supabase,
      reqOrigin,
      authorizationHeader,
      conversationId,
      userCode,
      assistantText: out.assistantText,
      metaForSave: out.metaForSave,
    });

    const finalMode =
      typeof orch?.mode === 'string' ? orch.mode : (ctx.finalMode ?? mode);

    return {
      ok: true,
      result: orch,
      assistantText: out.assistantText,
      metaForSave: out.metaForSave,
      finalMode,
    };
  } catch (e) {
    console.error('[IROS/Reply] handleIrosReply failed', {
      conversationId,
      userCode,
      error: e,
    });

    return {
      ok: false,
      error: 'generation_failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
