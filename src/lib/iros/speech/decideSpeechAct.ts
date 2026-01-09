// file: src/lib/iros/speech/decideSpeechAct.ts
// iros — SpeechAct Decider
//
// ✅ 目的：LLMを呼ぶ前に SpeechAct を確定する（= “助言したい本能” を封じる）
// - 入力/メタ/状態から deterministic に act を決める
// - act が SILENCE のときは LLM を絶対に呼ばない
//
// ✅ 最重要：SILENCE / FORWARD の最終仕様は speechPolicy.ts（single source）で確定する
// - FORWARD は本文固定（🪔）+ LLM禁止 + assistant保存禁止（汚染を止める）
// - SILENCE は本文固定（…）+ LLM禁止 + assistant保存禁止（UI消失を防ぐ）
//
// ✅ 重要：SpeechAct の decision は「top-level に allowLLM/oneLineOnly/allow を持つ」
// - handleIrosReply 側の stamp は decision.allowLLM / decision.allow を参照するため
// - hint.allowLLM だけだと meta に刻めず、空返答の原因になる
//
// ✅ NEW：decision.metaLite（requestedMode / mode / qCode）を添付できるようにする
// - applySpeechAct が any で decision.meta を読むため、「上流が添付すれば届く」を確実化する
//
// ✅ 注意：このファイルは “決めるだけ”
// - 本文固定（🪔/…）や bypassFallback などの詳細は speechPolicy.ts 側の metaPatch に刻まれる
// - route / handleIrosReply / postprocess は「ここで決まった結果に従うだけ」

import type { SpeechDecision } from './types';
import { decideSilence, decideSpeechPolicy } from './silencePolicy';

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

  // ✅ NEW：applySpeechAct に渡したい最小文脈（型は増やすが判定はここでは使わない）
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

  // hasFixedAnchor は “候補” に過ぎないので、ここでは commit 条件に使わない（暴発防止）
  return false;
}

/**
 * ✅ 年始/挨拶/雑談 bypass（安全側）
 * - 挨拶のみを自然言語で返すのはOK
 * - 相談/問題が混じるなら bypass しない（通常分岐に任せる）
 *
 * 注意：
 * - ここは “SILENCE/FORWARD固定” の汚染対策とは別枠
 * - 例：挨拶は LLM を許可して自然言語を返して良い
 */
function isSmalltalkBypass(userText?: string | null): boolean {
  const t = normStr(userText ?? '');
  if (!t) return false;

  // 相談/問題っぽい語が少しでも入っていたら bypass しない
  const looksLikeHelp =
    /(どうしたら|どうすれば|助けて|困って|不安|怖い|決められない|選択肢|教えて|相談|つらい|しんどい|無理|やめたい|連絡が来ない|返信がない|別れ|喧嘩|不倫|お金|借金|病院|薬|法律|訴え|投資)/.test(
      t,
    );
  if (looksLikeHelp) return false;

  // 「挨拶/雑談として完結している」ものだけ bypass
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

  // requestedMode が無い場合でも、mode は残す（デバッグ/分岐の保険）
  // 空は落とす（余計な汚染を避ける）
  const meta: any = {};
  if (requestedMode) meta.requestedMode = requestedMode;
  if (mode) meta.mode = mode;
  if (qCode) meta.qCode = qCode;

  return Object.keys(meta).length ? meta : null;
}

/**
 * ✅ SpeechDecision を返す時は top-level allowLLM/oneLineOnly/allow を必ず持つ
 * - handleIrosReply の stamp が参照するため（hint だけだと欠落する）
 *
 * ✅ decision.meta（metaLite）を添付できる
 * - applySpeechAct が any で読みに行く “meta” を確実に渡す
 */
function makeDecision(
  d: {
    act: 'SILENCE' | 'FORWARD' | 'COMMIT';
    reason: string;
    confidence: number;
    allowLLM: boolean;
    oneLineOnly: boolean;
    shouldPersistAssistant?: boolean;

    // meta は “最小文脈 + policy metaPatch” を合成して入れる
    meta?: any | null;
  },
): SpeechDecision {
  const shouldPersistAssistant =
    typeof d.shouldPersistAssistant === 'boolean'
      ? d.shouldPersistAssistant
      : // SILENCE は汚染防止で保存しない、その他は既存仕様に任せる
        d.act === 'SILENCE'
        ? false
        : true;

  const metaLite = d.meta ?? null;

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

    // ✅ applySpeechAct が any で読みに行く “meta”
    ...(metaLite ? { meta: metaLite } : {}),
  } as any;
}

export function decideSpeechAct(input: DecideSpeechActInput): SpeechDecision {
  const oneLineOnly = input.oneLineOnly === true;

  // ✅ metaLite は「入口で一度だけ」作る（分岐で漏れない）
  const metaLite = buildMetaLite(input);

  // ✅ SINGLE SOURCE（最優先）：
  // SILENCE / FORWARD を speechPolicy.ts（silencePolicy.ts 経由）で確定する。
  // - FORWARD: 🪔 固定 + allowLLM=false + shouldPersistAssistant=false
  // - SILENCE: … 固定 + allowLLM=false + shouldPersistAssistant=false
  // ※ act/reason/confidence は policy 側の決定を信頼する
  const sp = decideSpeechPolicy({
    inputKind: input.inputKind ?? null,
    brakeReleaseReason: input.brakeReleaseReason ?? null,

    // decideSpeechAct の段階では “候補 act” はまだ無いので null
    act: null,
    reason: null,
    confidence: null,

    userText: input.userText ?? null,
    oneLineOnly: input.oneLineOnly ?? null,
  });

  if (sp.ok) {
    const mergedMeta =
      metaLite || sp.output.metaPatch
        ? { ...(metaLite ?? {}), ...(sp.output.metaPatch ?? {}) }
        : null;

    // ✅ 型安全に絞る（policy が ok:true を返すのは SILENCE/FORWARD のみ、という前提をコード化）
    const act: 'SILENCE' | 'FORWARD' = sp.output.act === 'SILENCE' ? 'SILENCE' : 'FORWARD';

    return makeDecision({
      act,
      reason: sp.output.reason,
      confidence: sp.output.confidence,
      allowLLM: sp.output.allowLLM,
      oneLineOnly: true, // SILENCE/FORWARD は policy 側で固定本文運用
      shouldPersistAssistant: sp.output.shouldPersistAssistant,
      meta: mergedMeta,
    });
  }

  // 1) / 2) ✅ SILENCE 判定は 1箇所（speechPolicy の decideSilence）に委譲（互換）
  // ※ decideSpeechPolicy が {ok:false} の場合のみ通る
  const sil = decideSilence(input);
  if (sil.shouldSilence) {
    return makeDecision({
      act: 'SILENCE',
      reason: sil.reason,
      confidence: sil.confidence,
      allowLLM: false,
      oneLineOnly: true,
      shouldPersistAssistant: false,
      meta: metaLite,
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
      meta: metaLite,
    });
  }

  // 4) Qブレーキ suppress：MIRRORは禁止 → FORWARD（最小の一手）
  // ※ decideSpeechPolicy が {ok:false} の場合の保険。
  //    ここで allowLLM=true にすると “🪔+userText混入/保存汚染” が復活するので禁止。
  if (suppress) {
    return makeDecision({
      act: 'FORWARD',
      reason: 'Q_BRAKE_SUPPRESS__NO_MIRROR',
      confidence: 0.9,
      allowLLM: false,
      oneLineOnly: true,
      shouldPersistAssistant: false,
      meta: metaLite,
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
      meta: metaLite,
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
      meta: metaLite,
    });
  }

  // 7) MICRO入力：SILENCEにしない → 1行FORWARD
  // ※ ここは “空入力” ではない micro を想定（短文）
  //    ただし LLM を無制限に許可すると汚染しやすいので、基本は 1行運用。
  if (micro) {
    return makeDecision({
      act: 'FORWARD',
      reason: 'MICRO_INPUT',
      confidence: 0.88,
      allowLLM: true,
      oneLineOnly: true,
      meta: metaLite,
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
      meta: metaLite,
    });
  }

  // 9) default：FORWARD
  return makeDecision({
    act: 'FORWARD',
    reason: 'DEFAULT__NO_MIRROR',
    confidence: 0.6,
    allowLLM: true,
    oneLineOnly,
    meta: metaLite,
  });
}
