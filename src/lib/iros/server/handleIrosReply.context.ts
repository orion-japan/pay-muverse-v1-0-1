// file: src/lib/iros/server/handleIrosReply.context.ts
// iros - Turn context builder (minimal + frame plan)

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IrosStyle } from '@/lib/iros/system';
import type { IrosUserProfileRow } from './loadUserProfile';

import { loadBaseMetaFromMemoryState } from './handleIrosReply.state';

// ✅ FramePlan（器＋スロット）(Layer C/D)
import {
  buildFramePlan,
  type InputKind,
  type IrosStateLite,
} from '@/lib/iros/language/frameSlots';

export type BuildTurnContextArgs = {
  supabase: SupabaseClient;
  conversationId: string;
  userCode: string;
  text: string;
  mode: string;
  traceId?: string | null;
  userProfile?: IrosUserProfileRow | null;
  requestedStyle: IrosStyle | string | null;

  /** ✅ optional: caller may pass history (future use) */
  history?: unknown[];
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

/* =========================
   Helpers: InputKind detector (LLM禁止・純関数)
========================= */
function detectInputKind(userText: string): InputKind {
  const s = String(userText ?? '').trim();
  if (!s) return 'unknown';

  if (/(達成|サマリ|進捗|振り返り|まとめ|総括|レビュー|できたこと|やったこと)/.test(s)) {
    return 'review';
  }

  if (
    /(実装|修正|改修|デバッグ|バグ|エラー|ログ|原因|再現|調査|確認|設計|仕様|コード|関数|ファイル|import|export|tsc|typecheck|TypeScript|Next\.js|Supabase|SQL)/i.test(
      s,
    )
  ) {
    return 'task';
  }

  if (/[?？]$/.test(s) || /(なに|何|どこ|いつ|だれ|誰|なぜ|どうして|どうやって)/.test(s)) {
    return 'question';
  }

  return 'chat';
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
    text,
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

  // ✅ MemoryState を読み、baseMeta に合成（depth / qCode / selfAcceptance / y/h / spin）
  // ★ 注意：loadBaseMetaFromMemoryState は sb 必須
  const { mergedBaseMeta } = await loadBaseMetaFromMemoryState({
    sb: supabase,
    userCode,
    baseMeta: baseMetaForTurn,
  });
  baseMetaForTurn = mergedBaseMeta ?? baseMetaForTurn;

  // ★ spin/descent を camelCase に寄せる（下流の取りこぼし防止）
  const spinLoop =
    baseMetaForTurn?.spinLoop ??
    baseMetaForTurn?.spin_loop ??
    (baseMetaForTurn?.rotationState?.spinLoop ?? null) ??
    null;

  const spinStep =
    typeof baseMetaForTurn?.spinStep === 'number'
      ? baseMetaForTurn.spinStep
      : typeof baseMetaForTurn?.spin_step === 'number'
        ? baseMetaForTurn.spin_step
        : typeof baseMetaForTurn?.rotationState?.spinStep === 'number'
          ? baseMetaForTurn.rotationState.spinStep
          : null;

  const descentGate =
    baseMetaForTurn?.descentGate ??
    baseMetaForTurn?.descent_gate ??
    (baseMetaForTurn?.rotationState?.descentGate ?? null) ??
    null;

  if (spinLoop) baseMetaForTurn.spinLoop = spinLoop;
  if (typeof spinStep === 'number') baseMetaForTurn.spinStep = spinStep;
  if (descentGate) baseMetaForTurn.descentGate = descentGate;

  // ★ phase を baseMetaForTurn に注入（pivot 判定のため必須）
  {
    const phase =
      baseMetaForTurn?.phase ??
      baseMetaForTurn?.phase_raw ??
      baseMetaForTurn?.phaseStage ??
      null;

    if (phase) baseMetaForTurn.phase = phase;
  }

  // ✅ FramePlan を作って baseMeta に入れる（Layer C/D の入口）
  try {
    const inputKind = detectInputKind(text);

    // IrosStateLite は型が変動しやすいので、ここは “必要最小” を寄せて any で通す
    const stateLite: IrosStateLite = {
      depthStage:
        baseMetaForTurn?.depthStage ??
        baseMetaForTurn?.depth_stage ??
        baseMetaForTurn?.depth ??
        null,

      qPrimary:
        baseMetaForTurn?.qPrimary ??
        baseMetaForTurn?.q_primary ??
        baseMetaForTurn?.q_code ??
        baseMetaForTurn?.qCode ??
        null,

      selfAcceptance:
        typeof baseMetaForTurn?.selfAcceptance === 'number'
          ? baseMetaForTurn.selfAcceptance
          : typeof baseMetaForTurn?.self_acceptance === 'number'
            ? baseMetaForTurn.self_acceptance
            : null,

      phase: baseMetaForTurn?.phase ?? null,

      // intent layer（未確定でもOK）
      intentLayer:
        baseMetaForTurn?.intentLayer ??
        baseMetaForTurn?.intent_layer ??
        null,

      // rotation（必要なら使う）
      spinStep: typeof spinStep === 'number' ? spinStep : null,
      descentGate: descentGate ?? null,
    } as any;

    // ✅ buildFramePlan のシグネチャ差を吸収（TS引数数チェック回避）
    const framePlan = buildFramePlan({ state: stateLite, inputKind });

    baseMetaForTurn.inputKind = inputKind;
    baseMetaForTurn.framePlan = framePlan;

    console.log('[IROS/Context] framePlan built', {
      userCode,
      inputKind,
      frame: (framePlan as any)?.frame ?? null,
      hasSlots: Boolean((framePlan as any)?.slots),
      spinLoop: spinLoop ?? null, // ✅ stateLite.spinLoop は使わない
      descentGate: descentGate ?? null,
      depthStage: (stateLite as any)?.depthStage ?? null,
      phase: (stateLite as any)?.phase ?? null,
    });
  } catch (e) {
    console.warn('[IROS/Context] framePlan build failed', e);
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
