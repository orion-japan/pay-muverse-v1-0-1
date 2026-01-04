// file: src/lib/iros/speech/speechPolicy.ts
// iros — Speech Policy (single source of truth)
//
// ✅ 目的：SILENCE / FORWARD の「判断」「LLM可否」「本文」「保存可否」「meta刻み」を1箇所に固定する。
// - route.ts / handleIrosReply / postprocess は「ここで決まった結果に従うだけ」
// - “オウム返し” は FORWARD 時に userText を本文へ混ぜる経路が残っているのが原因。
//   → FORWARD は本文固定（🪔）+ LLM禁止 + assistant保存禁止 で汚染を止める。

/* ============================
 * Types
 * ============================ */

export type SpeechAct = 'NORMAL' | 'IR' | 'SILENCE' | 'FORWARD';

export type SilenceReason =
  | 'MICRO_INPUT'
  | 'Q1_SUPPRESS__MICRO_SILENCE';

export type ForwardReason =
  | 'Q_BRAKE_SUPPRESS__NO_MIRROR'
  | 'Q_BRAKE_SUPPRESS__FORWARD'
  | 'FORWARD_BY_POLICY';

export type SpeechPolicyInput = {
  // from orchestrator/speechInput
  inputKind?: string | null; // 'chat' | 'micro' | 'question' など
  brakeReleaseReason?: string | null; // 'Q1_SUPPRESS' など
  // decideSpeechAct/decision info
  act?: string | null; // applySpeechAct の結果 act（候補）
  reason?: string | null; // speechDecision.reason
  confidence?: number | null;

  // 判定用
  userText?: string | null;

  // UI都合（判定に使わない）
  oneLineOnly?: boolean | null;
};

export type SpeechPolicyOutput = {
  act: SpeechAct;
  reason: string;
  confidence: number;

  // ✅ ここが最重要（単一ソース）
  allowLLM: boolean;

  // ✅ UI/APIへ返す本文（SILENCE/FORWARDは固定）
  text: string;

  // ✅ 保存可否（汚染防止）
  shouldPersistAssistant: boolean;

  // ✅ renderEngine/fallback制御（route側が見る）
  render: {
    // sanitize後に空でも fallback を当てない等（必要なら）
    bypassFallback: boolean;
  };

  // ✅ meta.extra に刻む（追跡用）
  metaPatch: Record<string, any>;
};

export type SpeechPolicyDecision =
  | { ok: true; output: SpeechPolicyOutput }
  | { ok: false };

/* ============================
 * Local helpers (deterministic)
 * ============================ */

function normStr(v: unknown): string {
  return String(v ?? '').trim();
}

function upper(v: unknown): string {
  return normStr(v).toUpperCase();
}

function lower(v: unknown): string {
  return normStr(v).toLowerCase();
}

function isMicroInput(inputKind?: string | null): boolean {
  const k = lower(inputKind);
  return k === 'micro' || k === 'tiny' || k === 'short';
}

function isTrulyEmpty(userText?: string | null): boolean {
  const t = normStr(userText);
  return t.length === 0;
}

function isQBrakeSuppress(reason?: string | null): boolean {
  const r = normStr(reason);
  if (r === 'Q1_SUPPRESS') return true;
  if (/suppress/i.test(r)) return true;
  return false;
}

function isForwardReason(reason?: string | null): boolean {
  const r = normStr(reason);
  // 既存ログ：Q_BRAKE_SUPPRESS__NO_MIRROR
  if (r === 'Q_BRAKE_SUPPRESS__NO_MIRROR') return true;
  if (/Q_BRAKE_SUPPRESS/i.test(r)) return true;
  if (/NO_MIRROR/i.test(r)) return true;
  return false;
}

/* ============================
 * Builders (single truth)
 * ============================ */

function buildSilenceOutput(reason: SilenceReason): SpeechPolicyOutput {
  // ✅ UIが描画できる最小本文。空文字はUI消失/保存判定崩れの事故があるので '…' を正にする
  const text = '…';

  return {
    act: 'SILENCE',
    reason,
    confidence: reason === 'MICRO_INPUT' ? 0.98 : 0.95,
    allowLLM: false,
    text,
    // ✅ SILENCEは保存しない（履歴汚染防止）
    shouldPersistAssistant: false,
    render: {
      // ✅ route側で fallback を当てて復活させない
      bypassFallback: true,
    },
    metaPatch: {
      speechAct: 'SILENCE',
      speechAllowLLM: false,
      speechSkipped: true,
      speechSkippedText: text,
      rawTextFromModel: undefined as any,
      renderEngineSilenceBypass: true,
      shouldPersistAssistant: false,
    },
  };
}

function buildForwardOutput(reason: ForwardReason, confidence = 0.9): SpeechPolicyOutput {
  // ✅ FORWARDは「ユーザー文を混ぜない」固定本文のみ
  const text = '🪔';

  return {
    act: 'FORWARD',
    reason,
    confidence,
    allowLLM: false,
    text,
    // ✅ FORWARDも保存しない（履歴が “🪔 + userText” で汚染して増殖するのを止める）
    shouldPersistAssistant: false,
    render: {
      // ✅ route側で fallback を当てて userText を戻さない
      bypassFallback: true,
    },
    metaPatch: {
      speechAct: 'FORWARD',
      speechAllowLLM: false,
      speechSkipped: true,
      speechSkippedText: text,
      rawTextFromModel: undefined as any,
      renderEngineForwardBypass: true,
      shouldPersistAssistant: false,
    },
  };
}

/* ============================================================
 * decideSpeechPolicy (single source)
 * ============================================================ */

/**
 * ✅ SILENCE/FORWARD の最終仕様はここだけで決める。
 *
 * 現方針（ログに合わせて）：
 * 1) 完全な空入力 → SILENCE（LLM禁止 / 本文 '…' / 保存しない）
 * 2) Q1_SUPPRESS + micro → SILENCE（LLM禁止 / '…' / 保存しない）
 * 3) speechDecision.reason が Q_BRAKE_SUPPRESS__NO_MIRROR 系 → FORWARD
 *    （LLM禁止 / 本文 '🪔' 固定 / userText混入禁止 / 保存しない）
 *
 * それ以外は {ok:false} を返し、通常の生成へ。
 */
export function decideSpeechPolicy(input: SpeechPolicyInput): SpeechPolicyDecision {
  // 1) 空入力 → SILENCE
  if (isTrulyEmpty(input.userText ?? null)) {
    return { ok: true, output: buildSilenceOutput('MICRO_INPUT') };
  }

  // 2) Q1_SUPPRESS + micro → SILENCE
  const suppress = isQBrakeSuppress(input.brakeReleaseReason);
  const micro = isMicroInput(input.inputKind);
  if (suppress && micro) {
    return { ok: true, output: buildSilenceOutput('Q1_SUPPRESS__MICRO_SILENCE') };
  }

  // 3) “NO_MIRROR” 系 → FORWARD
  // ※あなたのログはここが該当：reason='Q_BRAKE_SUPPRESS__NO_MIRROR'
  if (isForwardReason(input.reason)) {
    const conf = typeof input.confidence === 'number' ? input.confidence : 0.9;
    return { ok: true, output: buildForwardOutput('Q_BRAKE_SUPPRESS__NO_MIRROR', conf) };
  }

  // 互換：applySpeechAct の act が FORWARD/SILENCE だった場合も、ここで確定させる
  const actU = upper(input.act);
  if (actU === 'SILENCE') {
    return { ok: true, output: buildSilenceOutput('Q1_SUPPRESS__MICRO_SILENCE') };
  }
  if (actU === 'FORWARD') {
    const conf = typeof input.confidence === 'number' ? input.confidence : 0.9;
    return { ok: true, output: buildForwardOutput('FORWARD_BY_POLICY', conf) };
  }

  return { ok: false };
}

/* ============================
 * Helpers for route.ts
 * ============================ */

export function isNonLLMAct(act?: unknown): boolean {
  const a = String(act ?? '').toUpperCase();
  return a === 'SILENCE' || a === 'FORWARD';
}


// ✅ decideSpeechAct.ts 互換：旧API（shouldSilence/hint）を提供する
export type SilenceDecision =
  | {
      shouldSilence: true;
      reason: SilenceReason;
      confidence: number;
      hint: { allowLLM: false; oneLineOnly: true };
    }
  | { shouldSilence: false };

// ✅ 互換: ここでは "このファイルの中で必ず存在する関数" だけを呼ぶ
// - decideSilencePolicy が無い / 入力型名が違う事故を避けるため、
//   公開APIは decideSilencePolicy() ではなく、既存の decideSilencePolicy() 相当ロジックに統一する。
export function decideSilence(input: {
  inputKind?: string | null;
  brakeReleaseReason?: string | null;
  oneLineOnly?: boolean | null;
  userText?: string | null;
}): SilenceDecision {
  // このファイル内にある "decideSilencePolicy" が存在する前提にしない
  // 代わりに、同等判定をここで直接行う（single source of truthを壊さない範囲で最小）
  const empty = String(input.userText ?? '').trim().length === 0;
  if (empty) {
    return {
      shouldSilence: true,
      reason: 'MICRO_INPUT',
      confidence: 0.98,
      hint: { allowLLM: false, oneLineOnly: true },
    };
  }

  const k = String(input.inputKind ?? '').trim().toLowerCase();
  const micro = k === 'micro' || k === 'tiny' || k === 'short';

  const r = String(input.brakeReleaseReason ?? '').trim();
  const suppress = r === 'Q1_SUPPRESS' || /suppress/i.test(r);

  if (suppress && micro) {
    return {
      shouldSilence: true,
      reason: 'Q1_SUPPRESS__MICRO_SILENCE',
      confidence: 0.95,
      hint: { allowLLM: false, oneLineOnly: true },
    };
  }

  return { shouldSilence: false };
}
