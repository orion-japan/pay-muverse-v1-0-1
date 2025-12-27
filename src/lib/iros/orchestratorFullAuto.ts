// file: src/lib/iros/orchestratorFullAuto.ts
// D) FullAuto / FeatureFlag 判定ロジック
// - fullAuto 可否判定
// - feature flag の集約
// - meta.fullAuto の生成

import { canUseFullAuto, shouldEnableFeature } from './server/fullAutoGuard';

export type ApplyFullAutoArgs = {
  userCode?: string | null;
  meta: any;
};

export type ApplyFullAutoResult = {
  meta: any;
};

export function applyFullAuto(args: ApplyFullAutoArgs): ApplyFullAutoResult {
  const { userCode, meta } = args;

  const qNum =
    typeof meta?.qCode === 'string'
      ? Number(meta.qCode.replace('Q', ''))
      : null;

  const guardInput = {
    userCode: userCode ?? null,
    isDev: process.env.NODE_ENV !== 'production',
    consentGiven: false,
    stability: null,
    depth: meta?.depth ?? null,
    q: Number.isFinite(qNum) ? qNum : null,
  };

  const fullAutoDecision = canUseFullAuto(guardInput);

  const features = {
    autonomousShift: shouldEnableFeature('autonomous_shift', guardInput).enabled,
    intentTrigger: shouldEnableFeature('intent_trigger', guardInput).enabled,
    frameAutoSwitch: shouldEnableFeature('frame_auto_switch', guardInput).enabled,
    leapAllowed: shouldEnableFeature('leap_allowed', guardInput).enabled,
    reframeMeaning: shouldEnableFeature('reframe_meaning', guardInput).enabled,
    storytelling: shouldEnableFeature('storytelling', guardInput).enabled,
  };

  meta.fullAuto = {
    decision: fullAutoDecision,
    features,
  };

  return { meta };
}
