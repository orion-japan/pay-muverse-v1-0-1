// src/app/api/agent/iros/reply/_impl/applyRenderEngineIfEnabled.ts
// iros — RenderEngine apply (single entry)
// - enableRenderEngine=true の場合は render-v2 (renderGatewayAsReply)
// - IT の場合のみ renderReply（従来）
// - 返り値は必ず { meta, extraForHandle } に統一
// - rephraseBlocks 生成は maybeAttachRephraseForRenderV2 に一本化

import { applyRulebookCompat } from '@/lib/iros/policy/rulebook';
import { buildResonanceVector } from '@/lib/iros/language/resonanceVector';
import { renderReply } from '@/lib/iros/language/renderReply';
import { renderGatewayAsReply } from '@/lib/iros/language/renderGateway';

import { sanitizeFinalContent, isEffectivelyEmptyText } from '../_helpers';
import { maybeAttachRephraseForRenderV2 } from '../_impl/rephrase';

export async function applyRenderEngineIfEnabled(params: {
  enableRenderEngine: boolean;
  isIT: boolean;
  meta: any;
  extraForHandle: any;
  resultObj: any;
  conversationId: string;
  userCode: string;
  userText: string;
  historyMessages?: unknown[] | null;
}): Promise<{ meta: any; extraForHandle: any }> {
  let {
    enableRenderEngine,
    isIT,
    meta,
    extraForHandle,
    resultObj,
    conversationId,
    userCode,
    userText,
    historyMessages,
  } = params;

  // =========================
  // IT は従来render（renderReply）
  // =========================
  if (isIT) {
    try {
      const contentBefore = String(resultObj?.content ?? '').trim();

      const fallbackFacts =
        contentBefore.length > 0
          ? contentBefore
          : String(
              (meta as any)?.situationSummary ??
                (meta as any)?.situation_summary ??
                meta?.unified?.situation?.summary ??
                '',
            ).trim() ||
            String(userText ?? '').trim() ||
            '';

      const vector = buildResonanceVector({
        qCode: (meta as any)?.qCode ?? (meta as any)?.q_code ?? meta?.unified?.q?.current ?? null,
        depth: (meta as any)?.depth ?? (meta as any)?.depth_stage ?? meta?.unified?.depth?.stage ?? null,
        phase: (meta as any)?.phase ?? meta?.unified?.phase ?? null,
        selfAcceptance:
          (meta as any)?.selfAcceptance ??
          (meta as any)?.self_acceptance ??
          meta?.unified?.selfAcceptance ??
          meta?.unified?.self_acceptance ??
          null,
        yLevel:
          (meta as any)?.yLevel ??
          (meta as any)?.y_level ??
          meta?.unified?.yLevel ??
          meta?.unified?.y_level ??
          null,
        hLevel:
          (meta as any)?.hLevel ??
          (meta as any)?.h_level ??
          meta?.unified?.hLevel ??
          meta?.unified?.h_level ??
          null,
        polarityScore:
          (meta as any)?.polarityScore ??
          (meta as any)?.polarity_score ??
          meta?.unified?.polarityScore ??
          meta?.unified?.polarity_score ??
          null,
        polarityBand:
          (meta as any)?.polarityBand ??
          (meta as any)?.polarity_band ??
          meta?.unified?.polarityBand ??
          meta?.unified?.polarity_band ??
          null,
        stabilityBand:
          (meta as any)?.stabilityBand ??
          (meta as any)?.stability_band ??
          meta?.unified?.stabilityBand ??
          meta?.unified?.stability_band ??
          null,
        situationSummary:
          (meta as any)?.situationSummary ??
          (meta as any)?.situation_summary ??
          meta?.unified?.situation?.summary ??
          null,
        situationTopic:
          (meta as any)?.situationTopic ??
          (meta as any)?.situation_topic ??
          meta?.unified?.situation?.topic ??
          null,
        intentLayer:
          (meta as any)?.intentLayer ??
          (meta as any)?.intent_layer ??
          (meta as any)?.intentLine?.focusLayer ??
          (meta as any)?.intent_line?.focusLayer ??
          meta?.unified?.intentLayer ??
          null,
        intentConfidence:
          (meta as any)?.intentConfidence ??
          (meta as any)?.intent_confidence ??
          (meta as any)?.intentLine?.confidence ??
          (meta as any)?.intent_line?.confidence ??
          null,
      });

      const baseInput = {
        facts: fallbackFacts,
        insight: null,
        nextStep: null,
        userWantsEssence: false,
        highDefensiveness: false,
        seed: String(conversationId ?? ''),
        userText: String(userText ?? ''),
      } as const;

      const baseOpts = {
        minimalEmoji: false,
        renderMode: 'IT',
        itDensity:
          (meta as any)?.itDensity ??
          (meta as any)?.density ??
          (meta as any)?.extra?.itDensity ??
          (meta as any)?.extra?.density ??
          undefined,
      } as any;

      const patched = applyRulebookCompat({
        vector,
        input: baseInput,
        opts: baseOpts,
        meta,
        extraForHandle,
      });

      const rendered = renderReply(
        (patched.vector ?? vector) as any,
        (patched.input ?? baseInput) as any,
        (patched.opts ?? baseOpts) as any,
      );

      const renderedText =
        typeof rendered === 'string'
          ? rendered
          : (rendered as any)?.text
            ? String((rendered as any).text)
            : String(rendered ?? '');

      const sanitized = sanitizeFinalContent(renderedText);

      const nextContent =
        sanitized.text.trim().length > 0
          ? sanitized.text.trimEnd()
          : contentBefore.length > 0
            ? contentBefore
            : String(fallbackFacts ?? '').trim();

      resultObj.content = nextContent;
      (resultObj as any).assistantText = nextContent;
      (resultObj as any).text = nextContent;

      const metaAfter = (patched.meta ?? meta) as any;
      metaAfter.extra = {
        ...(metaAfter.extra ?? {}),
        renderEngineApplied: true,
        renderEngineKind: 'IT',
        headerStripped: sanitized.removed.length ? sanitized.removed : null,
      };

      return { meta: metaAfter, extraForHandle: (patched.extraForHandle ?? extraForHandle) as any };
    } catch (e) {
      meta.extra = {
        ...(meta?.extra ?? {}),
        renderEngineApplied: false,
        renderEngineKind: 'IT',
        renderEngineError: String((e as any)?.message ?? e),
      };
      return { meta, extraForHandle };
    }
  }

  // render無効なら何もしない
  if (!enableRenderEngine) {
    meta.extra = { ...(meta?.extra ?? {}), renderEngineApplied: false, renderEngineKind: 'OFF' };
    return { meta, extraForHandle };
  }

  // =========================
  // render-v2（renderGatewayAsReply）
  // =========================
  try {
    const extraForRender: any = {
      ...(meta?.extra ?? {}),
      ...(extraForHandle ?? {}),
      slotPlanPolicy:
        (meta as any)?.framePlan?.slotPlanPolicy ??
        (meta as any)?.slotPlanPolicy ??
        (meta as any)?.extra?.slotPlanPolicy ??
        null,
      framePlan: (meta as any)?.framePlan ?? null,
      slotPlan: (meta as any)?.slotPlan ?? null,
      conversationId,
      userCode,
      userText: typeof userText === 'string' ? userText : null,
    };

    const maxLines =
      Number.isFinite(Number(process.env.IROS_RENDER_DEFAULT_MAXLINES)) &&
      Number(process.env.IROS_RENDER_DEFAULT_MAXLINES) > 0
        ? Number(process.env.IROS_RENDER_DEFAULT_MAXLINES)
        : 8;

    const baseText = String(
      (resultObj as any)?.assistantText ?? (resultObj as any)?.content ?? (resultObj as any)?.text ?? '',
    ).trimEnd();

// SoT
let extraSoT: any = extraForHandle ?? {};

// ✅ IMPORTANT: extractSlotsForRephrase の fallback が「hint」ではなく「本文」を拾えるようにする
// - framePlan.slots が “定義だけ” で本文が取れない時、rephraseEngine は extra.* から疑似OBSを作る
// - ここに入れないと seedDraft が 'hint 次の一歩…' に吸われてテンプレ復旧できない
if (baseText && typeof baseText === 'string' && baseText.trim().length > 0) {
  extraSoT = {
    ...extraSoT,
    assistantText: baseText,
    content: baseText,
    text: baseText,
    finalAssistantText: baseText,
    finalAssistantTextCandidate: baseText,
  };
}

// ✅ rephraseBlocks 付与はここだけ（一本化）
const attachRes: any = await maybeAttachRephraseForRenderV2({
  conversationId,
  userCode,
  userText: typeof userText === 'string' ? userText : String(userText ?? ''),
  meta,
  extraMerged: extraSoT,
  historyMessages: Array.isArray(historyMessages) ? historyMessages : undefined,
  traceId: String((meta as any)?.extra?.traceId ?? (meta as any)?.traceId ?? '').trim() || null,
  effectiveMode: (extraSoT as any)?.effectiveMode ?? (meta as any)?.extra?.effectiveMode ?? null,
});

if (attachRes && typeof attachRes === 'object') {
  if (attachRes.meta && typeof attachRes.meta === 'object') meta = attachRes.meta;

  const ex =
    attachRes.extraMerged ??
    attachRes.extraSoT ??
    attachRes.extraForHandle ??
    attachRes.extra ??
    null;

  if (ex && typeof ex === 'object') extraSoT = ex;
}


    // SoT -> render input
    if (
      Array.isArray(extraSoT?.rephraseBlocks) &&
      extraSoT.rephraseBlocks.length > 0 &&
      !Array.isArray(extraForRender?.rephraseBlocks)
    ) {
      extraForRender.rephraseBlocks = extraSoT.rephraseBlocks;
    }
    {
      const mergedHead = String(extraSoT?.rephraseHead ?? '').trim();
      if (mergedHead && !String(extraForRender?.rephraseHead ?? '').trim()) extraForRender.rephraseHead = mergedHead;
    }
    {
      const mergedFinal =
        String(extraSoT?.finalAssistantText ?? '').trim() ||
        String(extraSoT?.finalAssistantTextCandidate ?? '').trim() ||
        '';
      if (mergedFinal && !String(extraForRender?.finalAssistantText ?? '').trim()) {
        extraForRender.finalAssistantText = mergedFinal;
      }

      const mergedResolved = String(extraSoT?.resolvedText ?? '').trim();
      if (mergedResolved && !String(extraForRender?.resolvedText ?? '').trim()) {
        extraForRender.resolvedText = mergedResolved;
      }
    }

    const out = renderGatewayAsReply({ text: baseText, extra: extraForRender, maxLines }) as any;

    const outText = String(
      (typeof out === 'string' ? out : out?.text ?? out?.content ?? out?.assistantText ?? baseText) ?? '',
    ).trimEnd();

    const sanitized = sanitizeFinalContent(outText);

    // ✅ 空っぽ事故だけ最後にガード（"……" 保存問題の温床を減らす）
    const next = sanitized.text.trimEnd();
    const nextOk = !isEffectivelyEmptyText(next) ? next : baseText.trimEnd();

    resultObj.content = nextOk;
    (resultObj as any).assistantText = nextOk;
    (resultObj as any).text = nextOk;

    meta.extra = {
      ...(meta?.extra ?? {}),
      renderEngineApplied: true,
      renderEngineKind: 'V2',
      headerStripped: sanitized.removed.length ? sanitized.removed : null,
      renderV2PickedFrom: out?.pickedFrom ?? out?.meta?.pickedFrom ?? null,
      renderV2OutLen: nextOk.length,
    };

    return { meta, extraForHandle: extraSoT };
  } catch (e) {
    meta.extra = {
      ...(meta?.extra ?? {}),
      renderEngineApplied: false,
      renderEngineKind: 'V2',
      renderEngineError: String((e as any)?.message ?? e),
    };
    return { meta, extraForHandle };
  }
}
