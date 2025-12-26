// src/lib/iros/server/featureFlags.ts
// iros - Full-auto feature flags (env controlled) + safety guards
// - default OFF
// - supports master flag + per-feature flags + safety guard configs

export type FullAutoScope = 'off' | 'dev_only' | 'allowlist';

export type IrosFeatureFlags = {
  // master
  enableFullAuto: boolean;

  // per-feature
  enableAutonomousShift: boolean;
  enableIntentTrigger: boolean;
  enableFrameAutoSwitch: boolean;
  enableLeapAllowed: boolean;
  enableReframeMeaning: boolean;
  enableStorytelling: boolean;
  enableLoopShake: boolean;

  // safety / guards
  requireConsentForFullAuto: boolean;

  stabilityMinTurns: number;
  stabilityMaxMissingMeta: number;
  stabilityMaxContradictions: number;

  minDepthForShift: string; // 'C1' など（Depth型に寄せるのは上流合流後でOK）
  minQForShift: number; // 1..5 想定

  riskClampOn: boolean;

  fullAutoScope: FullAutoScope;
  fullAutoAllowlistUserCodes: string[];

  auditLog: boolean;
};

function envBool(name: string, def = false): boolean {
  const v = String(process.env[name] ?? '').trim();
  if (!v) return def;
  if (v === '1' || v.toLowerCase() === 'true') return true;
  if (v === '0' || v.toLowerCase() === 'false') return false;
  return def;
}

function envInt(name: string, def: number, opts?: { min?: number; max?: number }): number {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  const min = opts?.min ?? -Infinity;
  const max = opts?.max ?? Infinity;
  return Math.max(min, Math.min(max, i));
}

function envStr(name: string, def: string): string {
  const v = String(process.env[name] ?? '').trim();
  return v ? v : def;
}

function parseScope(v: string): FullAutoScope {
  const s = (v ?? '').trim().toLowerCase();
  if (s === 'off' || s === 'dev_only' || s === 'allowlist') return s;
  return 'off';
}

function parseCsv(v: string): string[] {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read all flags from env.
 * NOTE: default is OFF. "enableFullAuto" alone does not activate features;
 * features still need their individual flag ON.
 */
export function readIrosFeatureFlags(): IrosFeatureFlags {
  return {
    // master
    enableFullAuto: envBool('IROS_ENABLE_FULLAUTO', false),

    // per-feature
    enableAutonomousShift: envBool('IROS_ENABLE_AUTONOMOUS_SHIFT', false),
    enableIntentTrigger: envBool('IROS_ENABLE_INTENT_TRIGGER', false),
    enableFrameAutoSwitch: envBool('IROS_ENABLE_FRAME_AUTO_SWITCH', false),
    enableLeapAllowed: envBool('IROS_ENABLE_LEAP_ALLOWED', false),
    enableReframeMeaning: envBool('IROS_ENABLE_REFRAME_MEANING', false),
    enableStorytelling: envBool('IROS_ENABLE_STORYTELLING', false),
    enableLoopShake: envBool('IROS_ENABLE_LOOP_SHAKE', false),

    // safety / guards
    requireConsentForFullAuto: envBool('IROS_REQUIRE_CONSENT_FOR_FULLAUTO', true),

    stabilityMinTurns: envInt('IROS_STABILITY_MIN_TURNS', 12, { min: 0, max: 999 }),
    stabilityMaxMissingMeta: envInt('IROS_STABILITY_MAX_MISSING_META', 0, { min: 0, max: 999 }),
    stabilityMaxContradictions: envInt('IROS_STABILITY_MAX_CONTRADICTIONS', 0, { min: 0, max: 999 }),

    minDepthForShift: envStr('IROS_MIN_DEPTH_FOR_SHIFT', 'C1'),
    minQForShift: envInt('IROS_MIN_Q_FOR_SHIFT', 3, { min: 1, max: 5 }),

    riskClampOn: envBool('IROS_RISK_CLAMP_ON', true),

    fullAutoScope: parseScope(envStr('IROS_FULLAUTO_SCOPE', 'off')),
    fullAutoAllowlistUserCodes: parseCsv(envStr('IROS_FULLAUTO_ALLOWLIST_USERCODES', '')),

    auditLog: envBool('IROS_FULLAUTO_AUDIT_LOG', true),
  };
}
