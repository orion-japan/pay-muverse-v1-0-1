// file: src/lib/iros/speech/decideSpeechAct.ts
// iros — SpeechAct Decider
//
// ✅ 目的：LLMを呼ぶ前に SpeechAct を確定する（= “助言したい本能” を封じる）
// - 入力/メタ/状態から deterministic に act を決める
// - act が SILENCE のときは LLM を絶対に呼ばない
//
// ✅ 重要：SpeechAct の decision は「top-level に allowLLM/oneLineOnly を持つ」
// - handleIrosReply 側の stamp は decision.allowLLM / decision.allow を参照するため
// - hint.allowLLM だけだと meta に刻めず、空返答の原因になる

import type { SpeechDecision } from './types';
import { decideSilence } from './silencePolicy';

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

  // generate 側で userText 空判定したい時のため（任意）
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

  // hasFixedAnchor は「候補」だが、ここでは commit 可能扱い（必要なら後で tighten）
  if (i.hasFixedAnchor === true) return true;

  return false;
}

/**
 * ✅ 年始/挨拶/雑談 bypass
 * - Q1_SUPPRESS 時に固定テンプレへ落ちるのを避ける
 */
function isSmalltalkBypass(userText?: string | null): boolean {
  const t = normStr(userText ?? '');
  if (!t) return false;

  const looksLikeHelp =
    /どうしたら|どうすれば|助けて|困って|不安|怖い|決められない|選択肢|教えて|相談|つらい|しんどい|無理|やめたい/.test(
      t,
    );
  if (looksLikeHelp) return false;

  const isGreetingOrSmalltalk =
    /^(こんばんは|こんにちは|おはよう(ございます)?|ことよろ|よろしく(お願いします)?|あけましておめでとう|新年(になりました|です)?|おめでとう|元気|調子どう)/.test(
      t,
    );

  const containsGreeting =
    /(こんばんは|こんにちは|おはよう(ございます)?|あけましておめでとう|ことよろ)/.test(t);

  return isGreetingOrSmalltalk || containsGreeting;
}

/**
 * ✅ SpeechDecision を返す時は top-level allowLLM/oneLineOnly/allow を必ず持つ
 * - handleIrosReply の stamp が参照するため（hint だけだと欠落する）
 */
function makeDecision(
  d: {
    act: 'SILENCE' | 'FORWARD' | 'COMMIT';
    reason: string;
    confidence: number;
    allowLLM: boolean;
    oneLineOnly: boolean;
    shouldPersistAssistant?: boolean;
  },
): SpeechDecision {
  const shouldPersistAssistant =
    typeof d.shouldPersistAssistant === 'boolean'
      ? d.shouldPersistAssistant
      : // SILENCE は汚染防止で保存しない、その他は既存仕様に任せる
        d.act === 'SILENCE'
        ? false
        : true;

  // 型が追随してなくても「実体を meta に刻む」ことを優先（as any）
  return {
    act: d.act,
    reason: d.reason,
    confidence: d.confidence,

    // ✅ stamp が見るキー
    allowLLM: d.allowLLM,
    allow: d.allowLLM, // 互換（stamp は allow も見る）
    oneLineOnly: d.oneLineOnly,
    shouldPersistAssistant,

    // ✅ 既存互換（UI側が hint を見てる可能性がある）
    hint: { allowLLM: d.allowLLM, oneLineOnly: d.oneLineOnly },
  } as any;
}

export function decideSpeechAct(input: DecideSpeechActInput): SpeechDecision {
  const oneLineOnly = input.oneLineOnly === true;

  // 1) / 2) ✅ SILENCE 判定は 1箇所（silencePolicy.ts）に委譲
  const sil = decideSilence(input);
  if (sil.shouldSilence) {
    return makeDecision({
      act: 'SILENCE',
      reason: sil.reason,
      confidence: sil.confidence,
      allowLLM: false,
      oneLineOnly: true,
      shouldPersistAssistant: false,
    });
  }

  const suppress = isQBrakeSuppress(input.brakeReleaseReason);
  const itActive = input.itActive === true;
  const tCommit = tCommitPossible(input);
  const micro = isMicroInput(input.inputKind);
  const slotsOk = hasSlots(input.slotPlanLen);

  // 3) 年始/挨拶/雑談 bypass（自然言語を許可）
  if (isSmalltalkBypass(input.userText ?? null)) {
    return makeDecision({
      act: 'FORWARD',
      reason: 'DEFAULT__NO_MIRROR',
      confidence: 0.85,
      allowLLM: true,
      oneLineOnly: false,
    });
  }

  // 4) Qブレーキ suppress：MIRRORは禁止 → FORWARD（最小の一手）
  if (suppress) {
    return makeDecision({
      act: 'FORWARD',
      reason: 'Q_BRAKE_SUPPRESS__NO_MIRROR',
      confidence: 0.9,
      allowLLM: true,
      oneLineOnly: true,
    });
  }

  // 5) IT がアクティブ：COMMIT（= IT Writer / IT書式）
  if (itActive) {
    return makeDecision({
      act: 'COMMIT',
      reason: 'IT_ACTIVE',
      confidence: 0.92,
      allowLLM: true,
      oneLineOnly: false,
    });
  }

  // 6) T条件の痕跡：COMMIT
  if (tCommit) {
    return makeDecision({
      act: 'COMMIT',
      reason: 'TLAYER_COMMIT',
      confidence: 0.75,
      allowLLM: true,
      oneLineOnly: false,
    });
  }

  // 7) MICRO入力：SILENCEにしない → 1行FORWARD
  if (micro) {
    return makeDecision({
      act: 'FORWARD',
      reason: 'MICRO_INPUT',
      confidence: 0.88,
      allowLLM: true,
      oneLineOnly: true,
    });
  }

  // 8) slotPlanが無い → FORWARD
  if (!slotsOk) {
    return makeDecision({
      act: 'FORWARD',
      reason: 'NO_SLOT_PLAN__NO_MIRROR',
      confidence: 0.85,
      allowLLM: true,
      oneLineOnly,
    });
  }

  // 9) default：FORWARD
  return makeDecision({
    act: 'FORWARD',
    reason: 'DEFAULT__NO_MIRROR',
    confidence: 0.6,
    allowLLM: true,
    oneLineOnly,
  });
}
