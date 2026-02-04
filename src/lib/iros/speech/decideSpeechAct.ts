// file: src/lib/iros/speech/decideSpeechAct.ts
// iros — SpeechAct Decider
//
// 方針（v2）
// - “無言アクト” は使わない（無言アクト を返さない）
// - LLM を止めたい状況でも「LLMは呼ぶ」前提で、hint によって “器(AllowSchema)” を最小化する
// - ここは「決めるだけ」：最終の allow/maxLines/抑制は applySpeechAct/enforceAllowSchema が担う
//
// 目的：
// - 入力/メタ/状態から deterministic に act を決める
// - act: FORWARD or COMMIT（必要なら将来 NAME/FLIP を追加）
// - top-level に allowLLM/oneLineOnly/allow を必ず付与（stamp/互換のため）

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

  // generate 側で userText 空判定したい時のため（任意）
  userText?: string | null;

  // applySpeechAct に渡したい最小文脈（判定はここでは使わない）
  requestedMode?: string | null; // consult / vision / mirror / recall など
  mode?: string | null; // meta.mode の実効値（requestedMode が無い場合の保険）
  qCode?: string | null; // Q1..Q5（正規化済み推奨）
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

  const hint = normStr(i.tLayerHint).toUpperCase();
  const hintOk = hint === 'T1' || hint === 'T2' || hint === 'T3';
  if (hintOk) return true;

  // hasFixedAnchor は “候補” なので commit 条件に使わない（暴発防止）
  return false;
}

/**
 * 挨拶/雑談 bypass（安全側）
 * - 挨拶のみを自然言語で返すのはOK
 * - 相談/問題が混じるなら bypass しない
 */
function isSmalltalkBypass(userText?: string | null): boolean {
  const t = normStr(userText ?? '');
  if (!t) return false;

  const looksLikeHelp =
    /(どうしたら|どうすれば|助けて|困って|不安|怖い|決められない|選択肢|教えて|相談|つらい|しんどい|無理|やめたい|連絡が来ない|返信がない|別れ|喧嘩|不倫|お金|借金|病院|薬|法律|訴え|投資)/.test(
      t,
    );
  if (looksLikeHelp) return false;

  const isGreetingOnly =
    /^(こんばんは|こんにちは|おはよう(ございます)?|ことよろ|よろしく(お願いします)?|あけましておめでとう|新年(になりました|です)?|おめでとう|元気|調子どう)[!！。．…\s]*$/.test(
      t,
    );

  return isGreetingOnly;
}

function buildMetaLite(input: DecideSpeechActInput): any {
  const requestedMode = normStr(input.requestedMode) || null;
  const mode = normStr(input.mode) || null;
  const qCode = normStr(input.qCode) || null;

  const meta: any = {};
  if (requestedMode) meta.requestedMode = requestedMode;
  if (mode) meta.mode = mode;
  if (qCode) meta.qCode = qCode;

  return Object.keys(meta).length ? meta : null;
}

/**
 * SpeechDecision を返す時は top-level allowLLM/oneLineOnly/allow を必ず持つ
 * - stamp が参照するため（hint だけだと欠落する）
 *
 * ※ act は 'FORWARD' or 'COMMIT' のみ返す（無言アクト禁止）
 */
function makeDecision(d: {
  act: 'FORWARD' | 'COMMIT';
  reason: string;
  confidence: number;

  // v2 方針：LLM は基本呼ぶ。抑制は hint で渡して “器” を縮める。
  // stamp 互換のため top-level allowLLM/allow は必ず持つ
  allowLLM: boolean;
  oneLineOnly: boolean;

  // assistant 保存は原則 true（汚染止血は postprocess/policy 側で行う）
  // 必要なときだけ明示 false にできるよう残す
  shouldPersistAssistant?: boolean;

  // hint は applySpeechAct が参照（抑制のトリガ）
  hint?: { allowLLM?: boolean; oneLineOnly?: boolean };

  // applySpeechAct が any で読みに行く “meta”
  meta?: any | null;
}): SpeechDecision {
  const shouldPersistAssistant =
    typeof d.shouldPersistAssistant === 'boolean' ? d.shouldPersistAssistant : true;

  const metaLite = d.meta ?? null;

  return {
    act: d.act,
    reason: d.reason,
    confidence: d.confidence,

    // ✅ stamp が見るキー
    allowLLM: d.allowLLM,
    allow: d.allowLLM, // 互換
    oneLineOnly: d.oneLineOnly,
    shouldPersistAssistant,

    // ✅ applySpeechAct が見るキー（抑制トリガ）
    hint: { ...(d.hint ?? {}), oneLineOnly: d.oneLineOnly },

    ...(metaLite ? { meta: metaLite } : {}),
  } as any;
}

export function decideSpeechAct(input: DecideSpeechActInput): SpeechDecision {
  const oneLineOnly = input.oneLineOnly === true;

  // ✅ metaLite は入口で一度だけ作る（分岐で漏れない）
  const metaLite = buildMetaLite(input);

  const suppress = isQBrakeSuppress(input.brakeReleaseReason);
  const itActive = input.itActive === true;
  const tCommit = tCommitPossible(input);
  const micro = isMicroInput(input.inputKind);
  const slotsOk = hasSlots(input.slotPlanLen);

  // 1) 挨拶/雑談 bypass（自然言語を許可）
  if (isSmalltalkBypass(input.userText ?? null)) {
    return makeDecision({
      act: 'FORWARD',
      reason: 'DEFAULT__NO_MIRROR',
      confidence: 0.85,
      allowLLM: true,
      oneLineOnly: false,
      meta: metaLite,
    });
  }

  // 2) IT/T条件：COMMIT
  if (itActive) {
    return makeDecision({
      act: 'COMMIT',
      reason: 'IT_ACTIVE',
      confidence: 0.92,
      allowLLM: true,
      oneLineOnly: false,
      meta: metaLite,
    });
  }

  if (tCommit) {
    return makeDecision({
      act: 'COMMIT',
      reason: 'TLAYER_COMMIT',
      confidence: 0.75,
      allowLLM: true,
      oneLineOnly: false,
      meta: metaLite,
    });
  }

  // 3) 抑制（Q1_SUPPRESS等）：LLMは呼ぶが、器を最小化（1行）に誘導
  if (suppress) {
    return makeDecision({
      act: 'FORWARD',
      reason: 'Q_BRAKE_SUPPRESS__NO_MIRROR',
      confidence: 0.9,
      allowLLM: true,
      oneLineOnly: true,
      // hint.allowLLM=false を立てると applySpeechAct 側で isSuppressed 扱いになる（ただし LLM は呼ぶ）
      hint: { allowLLM: false, oneLineOnly: true },
      meta: metaLite,
    });
  }

  // 4) micro入力：1行FORWARD（短文化）
  if (micro) {
    return makeDecision({
      act: 'FORWARD',
      reason: 'MICRO_INPUT',
      confidence: 0.88,
      allowLLM: true,
      oneLineOnly: true,
      hint: { oneLineOnly: true },
      meta: metaLite,
    });
  }

  // 5) slotPlanが無い → FORWARD（通常生成）
  if (!slotsOk) {
    return makeDecision({
      act: 'FORWARD',
      reason: 'NO_SLOT_PLAN__NO_MIRROR',
      confidence: 0.85,
      allowLLM: true,
      oneLineOnly,
      meta: metaLite,
    });
  }

  // 6) default：FORWARD
  return makeDecision({
    act: 'FORWARD',
    reason: 'DEFAULT__NO_MIRROR',
    confidence: 0.6,
    allowLLM: true,
    oneLineOnly,
    meta: metaLite,
  });
}
