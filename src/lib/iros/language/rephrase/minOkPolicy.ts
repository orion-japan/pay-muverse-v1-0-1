// src/lib/iros/language/rephrase/minOkPolicy.ts
// iros — MIN_OK_LEN policy (pure / no side effects)
//
// 目的：rephraseEngine.full.ts 内の MIN_OK_LEN / OK_TOO_SHORT_TO_RETRY / naturalTextReady 判定を
//       「ポリシー層」として切り出す（挙動不変で外出し）。
//
// NOTE:
// - ここは “判定のみ” を担う（LLM呼び出し/副作用/ログ出力はしない）
// - shiftObj の parse は呼び出し側で行う（parseShiftJson は rephraseEngine 側に残す）
// - 判定は現状実装をそのまま写経して挙動を固定する

export type MinOkPolicyResult = {
  inputKindNow: string;
  isMicroOrGreetingNow: boolean;

  shortReplyOkRaw: any;
  shortReplyOk: boolean;

  shiftKind: string;
  isTConcretize: boolean;
  isIdeaBand: boolean;

  MIN_OK_LEN: number;
  reason:
    | 'micro_or_greeting'
    | 'idea_band_0'
    | 't_concretize_24'
    | 'chat_short_reply_ok'
    | 'chat_relaxed_40'
    | 'short_reply_ok'
    | 'default_80';
};

export function computeMinOkPolicy(params: {
  inputKind?: any;
  inputKindFromMeta?: any;
  inputKindFromCtx?: any;

  shiftSlotText?: any; // raw shift slot text (string-ish)
  shiftObj?: any; // parsed shift json (any)
  optsAllow?: any; // (opts as any)?.allow

  // for future extension: caller can override with precomputed kinds if desired
}): MinOkPolicyResult {
  const inputKindNow = String(params.inputKind ?? params.inputKindFromMeta ?? params.inputKindFromCtx ?? 'chat')
    .trim()
    .toLowerCase();

  const isMicroOrGreetingNow = inputKindNow === 'micro' || inputKindNow === 'greeting';

  const shiftObj = params.shiftObj ?? null;

  // ✅ short_reply_ok は「存在するなら false も尊重」する（Boolean OR は禁止）
  const shortReplyOkRaw =
    (shiftObj?.allow?.short_reply_ok ?? shiftObj?.allow?.shortReplyOk ?? null) ??
    (params.optsAllow?.short_reply_ok ?? params.optsAllow?.shortReplyOk ?? null);

  const shortReplyOk = shortReplyOkRaw === null ? false : Boolean(shortReplyOkRaw);

  // ✅ T_CONCRETIZE 判定（shift kind / 生テキストのどちらでも拾う）
  const shiftKind = String(shiftObj?.kind ?? '').trim().toLowerCase();

  const shiftText = String(params.shiftSlotText ?? '');

  const isTConcretize = shiftKind === 't_concretize' || /"kind"\s*:\s*"t_concretize"/.test(shiftText);

  // ✅ IDEA_BAND 判定（候補生成：2〜5行契約なので len gate はかけない）
  const isIdeaBand = shiftKind === 'idea_band' || /"kind"\s*:\s*"idea_band"/.test(shiftText);

  // ✅ MIN_OK_LEN（IDEA_BAND / T_CONCRETIZE を chat より優先）
  // - micro/greeting は短文許可（0）
  // - IDEA_BAND は「2〜5行の候補」なので文字数で縛らない（0）
  // - T_CONCRETIZE は 24（短くても成立し得るが、薄さを抑える）
  // - それ以外: short_reply_ok 明示なら 0 / chat は 40 / default 80
  const MIN_OK_LEN = isMicroOrGreetingNow
    ? 0
    : isIdeaBand
      ? 0
      : isTConcretize
        ? 24
        : shortReplyOk
          ? 0
          : inputKindNow === 'chat'
            ? 40
            : 80;

  const reason: MinOkPolicyResult['reason'] = isMicroOrGreetingNow
    ? 'micro_or_greeting'
    : isIdeaBand
      ? 'idea_band_0'
      : isTConcretize
        ? 't_concretize_24'
        : inputKindNow === 'chat'
          ? (shortReplyOk ? 'chat_short_reply_ok' : 'chat_relaxed_40')
          : (shortReplyOk ? 'short_reply_ok' : 'default_80');

  return {
    inputKindNow,
    isMicroOrGreetingNow,
    shortReplyOkRaw,
    shortReplyOk,
    shiftKind,
    isTConcretize,
    isIdeaBand,
    MIN_OK_LEN,
    reason,
  };
}

export type OkTooShortPolicyResult = {
  hasAdvanceHint: boolean;
  shouldOkTooShortToRetry: boolean;
};

export function computeOkTooShortToRetry(params: {
  candidate?: any;

  scaffoldActive: boolean;
  isDirectTask: boolean;

  vOk: boolean;
  vLevelPre: string; // already uppercased in caller (or we uppercase here)

  candidateLen: number;
  MIN_OK_LEN: number;

  isIdeaBand: boolean;
}): OkTooShortPolicyResult {
  const candidateText = String(params.candidate ?? '');

  // ✅ “前に進む気配” がある短文は retry を抑制
  const hasAdvanceHint = /NEXT|次の|一歩|やってみる|進める|試す|始め|着手|手を付け/.test(candidateText);

  const vLevelPreUp = String(params.vLevelPre ?? '').toUpperCase();

  const shouldOkTooShortToRetry =
    !params.scaffoldActive &&
    !params.isDirectTask &&
    params.vOk &&
    vLevelPreUp === 'OK' &&
    params.candidateLen > 0 &&
    params.candidateLen < params.MIN_OK_LEN &&
    !hasAdvanceHint &&
    !params.isIdeaBand;

  return { hasAdvanceHint, shouldOkTooShortToRetry };
}

export function computeNaturalTextReady(params: {
  candidate?: any;
  candidateLen: number;
  MIN_OK_LEN: number;
  scaffoldActive: boolean;
  isDirectTask: boolean;
}): boolean {
  const s = String(params.candidate ?? '');
  return (
    !params.scaffoldActive &&
    !params.isDirectTask &&
    params.candidateLen >= params.MIN_OK_LEN &&
    (/\n{2,}/.test(s) || s.split('\n').filter(Boolean).length >= 3)
  );
}
