// src/lib/iros/config/flags.ts

const bool = (v: string | undefined, def: boolean) => {
  if (v === undefined) return def;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return def;
};

const num = (v: string | undefined, def: number) => {
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
// --- guardEnabled は “未設定なら false” を正本にする（flagshipGuard.ts と一致） ---
function parseEnvFlag(v: unknown, defaultValue: boolean) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return defaultValue;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return defaultValue;
}
const IROS_FLAGSHIP_GUARD_ENABLED_ENV_RAW = process.env.IROS_FLAGSHIP_GUARD_ENABLED;
const IROS_FLAGSHIP_GUARD_ENABLED_PARSED = parseEnvFlag(IROS_FLAGSHIP_GUARD_ENABLED_ENV_RAW, false);
export const IROS_FLAGS = {
  // FINAL 強制リトライ
  retryFinalForceCall: bool(
    process.env.IROS_RETRY_FINAL_FORCE_CALL,
    true, // 既存挙動を壊さない初期値
  ),

  // Flagship rewrite
  flagshipRewrite: bool(
    process.env.IROS_FLAGSHIP_REWRITE,
    true,
  ),

// Guard（未設定なら false）
guardEnabled: (() => {
  const v = String(process.env.IROS_FLAGSHIP_GUARD_ENABLED ?? '')
    .trim()
    .toLowerCase();
  if (!v) return false;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
})(),

  guardSkipShort: bool(
    process.env.IROS_GUARD_SKIP_SHORT,
    false,
  ),

  guardShortMaxLen: num(
    process.env.IROS_GUARD_SHORT_MAXLEN,
    80,
  ),

  // ログ
  logFlags: bool(
    process.env.IROS_LOG_FLAGS,
    false,
  ),
} as const;

if (IROS_FLAGS.logFlags) {
  console.log('[IROS/FLAGS_ENV_HEAD]', {
    IROS_RETRY_FINAL_FORCE_CALL: process.env.IROS_RETRY_FINAL_FORCE_CALL,
    IROS_FLAGSHIP_REWRITE: process.env.IROS_FLAGSHIP_REWRITE,
    IROS_LOG_FLAGS: process.env.IROS_LOG_FLAGS,
    IROS_FLAGSHIP_GUARD_ENABLED: String(IROS_FLAGSHIP_GUARD_ENABLED_ENV_RAW ?? ''),
IROS_FLAGSHIP_GUARD_ENABLED_PARSED: IROS_FLAGSHIP_GUARD_ENABLED_PARSED,
  });
  console.log('[IROS/FLAGS]', IROS_FLAGS);
}

