// file: src/lib/iros/speech/decideSpeechAct.ts
// iros — SpeechAct Decider
//
// ✅ 目的：LLMを呼ぶ前に SpeechAct を確定する（= “助言したい本能” を封じる）
// - 入力/メタ/状態から deterministic に act を決める
// - act が SILENCE のときは LLM を絶対に呼ばない
//
// 優先順位（上から強い）
// 1) 「完全な空/無入力」 → SILENCE（LLM呼ばない）
// 2) Q1_SUPPRESS + micro(oneLine) → SILENCE（LLM呼ばない）※FAILSAFE差し込み防止
// 3) Qブレーキ suppress → FORWARD（最小の一手へ）※MIRROR廃止
// 4) IT_ACTIVE → COMMIT（=IT書式に渡す）
// 5) T条件成立（commit） → COMMIT
// 6) MICRO入力 → FORWARD（1行の最小返答）※SILENCEにしない（UIで吹き出しが消えるため）
// 7) slotPlan無し → FORWARD（最小の一手へ）※MIRROR廃止
// 8) default → FORWARD（最小の一手へ）※MIRROR廃止
//
// ※ MIRROR（観測のみ）は完全廃止。
//    “抑制が必要な時ほど FORWARD に倒して 1つだけ決める” を最小出力にする。
//
// ✅ 重要：SILENCE 以外は allowLLM=true を明示する
// - ここを曖昧にすると下流で default=false 扱いになり、沈黙→止血が起きる

import type { SpeechDecision } from './types';

export type DecideSpeechActInput = {
  inputKind?: string | null; // 'micro' など（大小文字や揺れを吸収）

  // 例: qBrakeRelease.ts の結果
  brakeReleaseReason?: string | null; // 'Q1_SUPPRESS' など
  generalBrake?: string | null; // 'ON'/'OFF' など（任意）

  // 例: render 計画
  slotPlanLen?: number | null; // planReply / frameSlots などのスロット数

  // 例: IT トリガー
  itActive?: boolean | null;

  // 例: T 層 commit の痕跡
  tLayerModeActive?: boolean | null;
  tLayerHint?: string | null;

  // 例: 確定アンカー（SUN固定など）
  hasFixedAnchor?: boolean | null;

  // 例: 強制1行（UI都合）
  oneLineOnly?: boolean | null;

  // ✅ generate 側で userText 空判定したい時のため（任意）
  userText?: string | null;
};

function normStr(v: unknown): string {
  return String(v ?? '').trim();
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

function hasSlots(n?: number | null): boolean {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return v > 0;
}

function tCommitPossible(i: DecideSpeechActInput): boolean {
  if (i.tLayerModeActive === true) return true;

  const hint = normStr(i.tLayerHint);
  if (hint) return true;

  if (i.hasFixedAnchor === true) return true;

  return false;
}

export function decideSpeechAct(input: DecideSpeechActInput): SpeechDecision {
  const oneLineOnly = input.oneLineOnly === true;

  const empty = isTrulyEmpty(input.userText ?? null);
  const suppress = isQBrakeSuppress(input.brakeReleaseReason);
  const itActive = input.itActive === true;
  const tCommit = tCommitPossible(input);
  const micro = isMicroInput(input.inputKind);
  const slotsOk = hasSlots(input.slotPlanLen);

  // 1) 完全な空/無入力だけ SILENCE（LLM呼ばない）
  if (empty) {
    return {
      act: 'SILENCE',
      reason: 'MICRO_INPUT', // types.ts に合わせて reason はこれを流用（空入力扱い）
      confidence: 0.98,
      hint: { allowLLM: false, oneLineOnly: true },
    };
  }

  // 2) ✅ Q1_SUPPRESS + micro(oneLine) は SILENCE 固定（LLM呼ばない）
  // - ここで止めないと、後段で empty になり FAILSAFE が走って「…。🪔」が差し込まれる
  // - 「沈黙表示（…。🪔）」を保存したい設計とも整合
  if (suppress && (micro || oneLineOnly || lower(input.inputKind) === 'micro')) {
    return {
      act: 'SILENCE',
      reason: 'Q1_SUPPRESS__MICRO_SILENCE',
      confidence: 0.95,
      hint: { allowLLM: false, oneLineOnly: true },
    };
  }

  // 3) Qブレーキ suppress：MIRRORは禁止 → FORWARD（最小の一手）
  if (suppress) {
    return {
      act: 'FORWARD',
      reason: 'Q_BRAKE_SUPPRESS__NO_MIRROR',
      confidence: 0.9,
      hint: { allowLLM: true, oneLineOnly: true },
    };
  }

  // 4) IT がアクティブ：COMMIT（= IT Writer / IT書式）
  if (itActive) {
    return {
      act: 'COMMIT',
      reason: 'IT_ACTIVE',
      confidence: 0.92,
      hint: { allowLLM: true, oneLineOnly: false },
    };
  }

  // 5) T条件の痕跡：COMMIT
  if (tCommit) {
    return {
      act: 'COMMIT',
      reason: 'TLAYER_COMMIT',
      confidence: 0.75,
      hint: { allowLLM: true, oneLineOnly: false },
    };
  }

  // 6) MICRO入力：SILENCEにしない（UIで吹き出しが消えるため）→ 1行FORWARD
  if (micro) {
    return {
      act: 'FORWARD',
      reason: 'MICRO_INPUT',
      confidence: 0.88,
      hint: { allowLLM: true, oneLineOnly: true },
    };
  }

  // 7) slotPlanが無い：構造出力が組めない → FORWARD（最小の一手）
  if (!slotsOk) {
    return {
      act: 'FORWARD',
      reason: 'NO_SLOT_PLAN__NO_MIRROR',
      confidence: 0.85,
      hint: { allowLLM: true, oneLineOnly },
    };
  }

  // 8) default：MIRRORは禁止 → FORWARD（最小の一手）
  return {
    act: 'FORWARD',
    reason: 'DEFAULT__NO_MIRROR',
    confidence: 0.6,
    hint: { allowLLM: true, oneLineOnly },
  };
}
