// src/lib/iros/server/fullAutoGuard.ts
// iros - Full-auto guard (ON/OFF conditions + safety devices)
// - Uses env flags from featureFlags.ts
// - Default deny (safety-first)
// - Gives structured decision + reasons for audit

import { readIrosFeatureFlags, type IrosFeatureFlags } from './featureFlags';

export type FullAutoFeature =
  | 'autonomous_shift'
  | 'intent_trigger'
  | 'frame_auto_switch'
  | 'leap_allowed'
  | 'reframe_meaning'
  | 'storytelling'
  | 'loop_shake';

export type FullAutoDecision = {
  ok: boolean;
  reasons: string[]; // deny理由 / clamp理由 を人間が追えるように
  scope: {
    scope: 'off' | 'dev_only' | 'allowlist';
    allowlisted: boolean;
    isDev: boolean;
  };
  gates: {
    masterOn: boolean;
    consentOk: boolean;
    stabilityOk: boolean;
    depthOk: boolean;
    qOk: boolean;
    riskClamped: boolean;
  };
};

/**
 * このターンで判定に使える最小入力
 * - consentGiven: ユーザー明示同意が取れているか（取れない場合は false）
 * - stability: 直近Nターンの欠損/矛盾など（集計が無いなら null でOK → deny）
 * - depth/q: 現在推定の depth / q（取れないなら null でOK → deny）
 */
export type FullAutoGuardInput = {
  userCode?: string | null;

  // scope
  isDev?: boolean; // dev環境かどうか（呼び出し側で渡せるなら渡す）

  // consent gate
  consentGiven?: boolean; // 明示同意がある場合のみ true

  // stability gate（集計がまだ無いなら null）
  stability?: {
    turnsObserved: number; // 直近何ターンぶんの観測か
    missingMetaCount: number; // meta欠損など
    contradictionsCount: number; // 不整合など
  } | null;

  // current state（取れないなら null）
  depth?: string | null; // 'S1'..'T3' など（現状は string で受ける）
  q?: number | null; // 1..5 想定

  // risk clamp
  riskSignals?: {
    // ここは「危機っぽい」判定があるなら入れる（無いなら空でOK）
    bodyFreeze?: boolean; // 体が固まる等
    panicLike?: boolean; // パニック/強い不安
    crisisLike?: boolean; // 自傷他害など（実装があれば）
  } | null;
};

type FeatureEnableMap = Record<FullAutoFeature, boolean>;

function normalizeUserCode(v: unknown): string {
  return String(v ?? '').trim();
}

/** Depth の順序（比較のための序数） */
const DEPTH_ORDER: string[] = [
  'S1',
  'S2',
  'S3',
  'S4',
  'R1',
  'R2',
  'R3',
  'C1',
  'C2',
  'C3',
  'I1',
  'I2',
  'I3',
  'T1',
  'T2',
  'T3',
];

function depthIndex(d?: string | null): number {
  const key = String(d ?? '').trim();
  if (!key) return -1;
  return DEPTH_ORDER.indexOf(key);
}

function isDepthGte(current?: string | null, min?: string | null): boolean {
  const ci = depthIndex(current);
  const mi = depthIndex(min);
  if (ci < 0 || mi < 0) return false;
  return ci >= mi;
}

function isQGte(current?: number | null, min?: number | null): boolean {
  if (typeof current !== 'number' || !Number.isFinite(current)) return false;
  if (typeof min !== 'number' || !Number.isFinite(min)) return false;
  return current >= min;
}

function featuresFromFlags(ff: IrosFeatureFlags): FeatureEnableMap {
  return {
    autonomous_shift: ff.enableAutonomousShift,
    intent_trigger: ff.enableIntentTrigger,
    frame_auto_switch: ff.enableFrameAutoSwitch,
    leap_allowed: ff.enableLeapAllowed,
    reframe_meaning: ff.enableReframeMeaning,
    storytelling: ff.enableStorytelling,
    loop_shake: ff.enableLoopShake,
  };
}

function computeScopeAllowed(ff: IrosFeatureFlags, userCode: string, isDev: boolean): { allowed: boolean; allowlisted: boolean } {
  const scope = ff.fullAutoScope;
  const allowlisted =
    scope === 'allowlist' && userCode ? ff.fullAutoAllowlistUserCodes.includes(userCode) : false;

  if (scope === 'dev_only') return { allowed: isDev, allowlisted };
  if (scope === 'allowlist') return { allowed: allowlisted, allowlisted };
  return { allowed: false, allowlisted };
}

/**
 * Master + Scope + Consent + Stability + Depth/Q + RiskClamp を統合して、
 * 「full-auto 許可」判定を返す。
 *
 * 重要：
 * - ok=false の場合でも、frame_auto_switch だけ許可したい等は別途 shouldEnableFeature() を使う
 */
export function canUseFullAuto(input: FullAutoGuardInput): FullAutoDecision {
  const ff = readIrosFeatureFlags();
  const reasons: string[] = [];

  const userCode = normalizeUserCode(input.userCode);
  const isDev = Boolean(input.isDev);

  // master
  const masterOn = ff.enableFullAuto;
  if (!masterOn) reasons.push('master_off:IROS_ENABLE_FULLAUTO');

  // scope
  const scope = ff.fullAutoScope; // off | dev_only | allowlist
  const { allowed: scopeAllowed, allowlisted } = computeScopeAllowed(ff, userCode, isDev);

  if (scope === 'off') reasons.push('scope_off:IROS_FULLAUTO_SCOPE=off');
  if (scope === 'dev_only' && !isDev) reasons.push('scope_dev_only:NOT_DEV');
  if (scope === 'allowlist' && !allowlisted) reasons.push('scope_allowlist:NOT_ALLOWED');

  // consent
  const consentRequired = ff.requireConsentForFullAuto;
  const consentGiven = Boolean(input.consentGiven);
  const consentOk = !consentRequired || consentGiven;
  if (!consentOk) reasons.push('consent_required:NOT_GIVEN');

  // stability
  let stabilityOk = false;
  const st = input.stability ?? null;
  if (!st) {
    // 集計が無いなら安全側で deny
    reasons.push('stability_missing:NO_METRICS');
    stabilityOk = false;
  } else {
    const enoughTurns = st.turnsObserved >= ff.stabilityMinTurns;
    const metaOk = st.missingMetaCount <= ff.stabilityMaxMissingMeta;
    const contraOk = st.contradictionsCount <= ff.stabilityMaxContradictions;

    if (!enoughTurns)
      reasons.push(`stability_turns_insufficient:${st.turnsObserved}<${ff.stabilityMinTurns}`);
    if (!metaOk)
      reasons.push(`stability_missing_meta:${st.missingMetaCount}>${ff.stabilityMaxMissingMeta}`);
    if (!contraOk)
      reasons.push(`stability_contradictions:${st.contradictionsCount}>${ff.stabilityMaxContradictions}`);

    stabilityOk = enoughTurns && metaOk && contraOk;
  }

  // depth / q thresholds
  const depthOk = isDepthGte(input.depth, ff.minDepthForShift);
  if (!depthOk) reasons.push(`depth_gate:need>=${ff.minDepthForShift}`);

  const qOk = isQGte(input.q, ff.minQForShift);
  if (!qOk) reasons.push(`q_gate:need>=${ff.minQForShift}`);

  // risk clamp
  let riskClamped = false;
  if (ff.riskClampOn) {
    const rs = input.riskSignals ?? {};
    if (rs.bodyFreeze || rs.panicLike || rs.crisisLike) {
      riskClamped = true;
      reasons.push('risk_clamp:signals_detected');
    }
  }

  const ok =
    masterOn &&
    scopeAllowed &&
    consentOk &&
    stabilityOk &&
    depthOk &&
    qOk &&
    !riskClamped;

  return {
    ok,
    reasons,
    scope: { scope, allowlisted, isDev },
    gates: { masterOn, consentOk, stabilityOk, depthOk, qOk, riskClamped },
  };
}

/**
 * 個別機能ごとに「この機能だけは許可できるか」を返す。
 * - master が OFF でも、frame_auto_switch だけは許可したい…などの設計が可能
 * - ただし、危機時は強い機能（leap/loop/reframe/story）は抑制できるようにしてある
 */
export function shouldEnableFeature(
  feature: FullAutoFeature,
  input: FullAutoGuardInput,
): { enabled: boolean; reasons: string[] } {
  const ff = readIrosFeatureFlags();
  const fmap = featuresFromFlags(ff);

  // 個別フラグがOFFなら即OFF
  if (!fmap[feature]) return { enabled: false, reasons: [`feature_off:${feature}`] };

  const decision = canUseFullAuto(input);

  // full-auto 全体OKならもちろんOK
  if (decision.ok) return { enabled: true, reasons: ['fullauto_ok'] };

  // full-auto がダメでも、機能単位で例外許可を作る
  // ※ただし例外は最小限。複雑化を避ける。
  if (feature === 'frame_auto_switch') {
    // stabilityが無いなら許可しない（安全）
    if (!input.stability) {
      return { enabled: false, reasons: ['frame_auto_switch_denied:stability_missing'] };
    }

    const st = input.stability;
    const enoughTurns = st.turnsObserved >= Math.max(3, Math.min(ff.stabilityMinTurns, 6));
    const metaOk = st.missingMetaCount <= ff.stabilityMaxMissingMeta;
    const contraOk = st.contradictionsCount <= ff.stabilityMaxContradictions;

    if (enoughTurns && metaOk && contraOk) {
      return { enabled: true, reasons: ['frame_auto_switch_exception:stability_ok'] };
    }
    return { enabled: false, reasons: ['frame_auto_switch_denied:stability_not_ok'] };
  }

  // 強い機能は、full-auto 全体がOKにならない限り許可しない
  return { enabled: false, reasons: [...decision.reasons] };
}
