// file: src/lib/iros/orchestratorContainer.ts
// J) DescentGate + Frame + Slots（7.5）を切り出し（behavior-preserving）
// + 4軸運用：T→C / C優先 / I還りは条件付き / anchor無しの雑談はSへ

import type { IrosMeta } from './system';

import { classifyInputKind } from './language/inputKind';
import { selectFrame, type FrameKind } from './language/frameSelector';
import { decideDescentGate } from './rotation/rotationLoop';

// =========================================================
// RenderEngine v2 方針：Slot Planner は現状「無効」
// ただし orchestratorContainer が slotPlan_keys 等を期待しているため、
// buildSlots / SlotKey / NoDeltaKind を「互換スタブ」として提供する。
// - 本文は作らない
// - plan は常に空（= v2思想）
// - 形だけ既存の下流に合わせる（Record<SlotKey, string|null>）
// =========================================================

type SlotKey = 'OBS' | 'SHIFT' | 'NEXT' | 'SAFE' | 'INSIGHT';

type NoDeltaKind = 'repeat-warning' | 'short-loop' | 'stuck' | 'NONE';

function buildSlots(
  _frame: FrameKind,
  _ctx: {
    descentGate?: any;
    spinLoop?: any;
    noDelta?: boolean;
    noDeltaKind?: NoDeltaKind | null;
    iLayerDual?: boolean;
  },
): { slots: Record<SlotKey, string | null> } {
  return {
    slots: {
      OBS: null,
      SHIFT: null,
      NEXT: null,
      SAFE: null,
      INSIGHT: null,
    },
  };
}

export type ApplyContainerArgs = {
  text: string;
  meta: IrosMeta;

  // decideDescentGate に渡す継続値
  prevDescentGate: any;

  // noDelta 判定に使う
  rotationReason: string;
  spinStepNow: number | null;

  // targetKind の参照元（orchestrator は goal.kind を見てた）
  goalKind?: string | null;
};

export type ApplyContainerResult = {
  meta: IrosMeta;
  frame: FrameKind;

  // 下流の期待（slotPlan_keys など）に合わせて「キー配列」を返す
  // ※ buildSlots の実体は Record なので、ここで正規化する
  slotPlan: { slots: SlotKey[] };
};

type TargetKind = 'stabilize' | 'expand' | 'pierce' | 'uncover';

function normalizeTargetKind(v: unknown): TargetKind {
  if (typeof v !== 'string') return 'stabilize';
  const s = v.trim().toLowerCase();

  if (s === 'stabilize') return 'stabilize';
  if (s === 'expand') return 'expand';
  if (s === 'pierce') return 'pierce';
  if (s === 'uncover') return 'uncover';

  // bridge
  if (s === 'enableaction') return 'expand';
  if (s === 'action') return 'expand';
  if (s === 'create') return 'expand';

  return 'stabilize';
}

function toSlotKeys(
  plan: ReturnType<typeof buildSlots> | null | undefined,
): SlotKey[] {
  if (!plan) return [];
  const slots = (plan as any).slots;
  if (!slots || typeof slots !== 'object') return [];

  // Record<SlotKey, string|null> のうち、null でないものだけを採用
  const keys = Object.keys(slots) as SlotKey[];
  return keys.filter((k) => (slots as any)[k] != null);
}

export function applyContainerDecision(
  args: ApplyContainerArgs,
): ApplyContainerResult {
  const { text, meta, prevDescentGate, rotationReason, spinStepNow, goalKind } =
    args;

  // inputKind
  const inputKind = classifyInputKind(text);
  (meta as any).inputKind = inputKind;

  // targetKind 正規化（優先：meta → goalKind）
  const rawTargetKind =
    (meta as any).targetKind ?? (meta as any).target_kind ?? goalKind ?? null;

  const targetKindNorm = normalizeTargetKind(rawTargetKind);

  (meta as any).targetKind = targetKindNorm;
  (meta as any).target_kind = targetKindNorm;

  // descentGate
  const dg = decideDescentGate({
    qCode: meta.qCode ?? null,
    sa: typeof meta.selfAcceptance === 'number' ? meta.selfAcceptance : null,
    depthStage:
      typeof meta.depth === 'string' && meta.depth.length > 0 ? meta.depth : null,
    targetKind: targetKindNorm,
    prevDescentGate: prevDescentGate ?? null,
  });

  (meta as any).descentGate = dg.descentGate;
  (meta as any).descentGateReason = dg.reason;

  // ---------------------------
  // frame（4軸運用）
  // - anchor無しの雑談 → S
  // - IT発火 → 「T候補」になるが、実際にTへ入るのは committed（確定アンカー）時のみ
  // - anchorあり → C優先（意図に触れたい時だけ I 還り）
  // - それ以外 → 従来 selectFrame
  //
  // ✅ 重要：
  // - fixedNorth(SUN) は「北極星の前提」であって「確定アンカー」ではない
  // - IT成立(tLayerModeActive等) は「T候補」。T確定は hasCommittedAnchor が要る
  // ---------------------------

  const tText = String(text ?? '').trim();

  // IT候補（Tレイヤーを“使いたい”兆し）
  const itActive =
    (meta as any).tLayerModeActive === true ||
    typeof (meta as any).tLayerHint === 'string'; // 保険（tLayerHint が残る実装もあるため）

  // intentAnchor 判定：存在していれば「C優先」や「I還り」を許可（fixed:true までは要求しない）
// intentAnchor 判定：存在していれば「C優先」や「I還り」を許可（fixed:true までは要求しない）
const anchor = (meta as any).intentAnchor ?? (meta as any).intent_anchor ?? null;

// ✅ hasAnchor: {key:"SUN"} / {text:"..."} の両対応
const anchorKey =
  anchor && typeof anchor === 'object' && typeof (anchor as any).key === 'string'
    ? String((anchor as any).key).trim()
    : null;

const anchorText =
  anchor && typeof anchor === 'object' && typeof (anchor as any).text === 'string'
    ? String((anchor as any).text).trim()
    : null;

const hasAnchor = Boolean(
  (anchorKey && anchorKey.length > 0) || (anchorText && anchorText.length > 0),
);

// ✅ 固定北（SUN）の判定は meta.fixedNorth を正とする
const fixedNorthKey =
  typeof (meta as any)?.fixedNorth?.key === 'string'
    ? String((meta as any).fixedNorth.key)
    : typeof (meta as any)?.fixedNorth === 'string'
      ? String((meta as any).fixedNorth)
      : null;


  // ✅ “確定アンカー”と“固定北(SUN)”は意味が違うので分離して保持する
  const hasFixedNorthSUN = fixedNorthKey === 'SUN';

  // ✅ 確定アンカー（commit）の定義：intentAnchor.fixed === true のみ（SUNでは true にしない）
  const hasCommittedAnchor = hasAnchor && (anchor as any).fixed === true;

  // 互換用：旧変数名 hasFixedAnchor は「確定アンカー」に寄せる（SUNでtrueにしない）
  const hasFixedAnchor = hasCommittedAnchor;

  // 一般会話（挨拶・短文雑談）っぽい時は S へ落とす（anchor無しの時だけ）
  const looksSmallTalk =
    tText.length <= 18 &&
    /(おはよう|こんにちは|こんばんは|ありがとう|サンキュ|やあ|hey|hi|hello)/i.test(tText);

  const forceS = !hasAnchor && (inputKind === 'greeting' || looksSmallTalk);

  // I還り（本I層）条件：anchorがあり、意図に触れる言葉を「出したい」時だけ
  const wantsIReturn =
    hasAnchor && /(意図|本当は|なぜ|理由|意味|背景|存在|軸|どう生きる|核)/.test(tText);

  // anchorがあるなら基本C（I還り条件の時だけI）
  const preferCWhenAnchored = hasAnchor && !wantsIReturn;

  // ✅ T入口ゲート：IT候補があっても、commitが無ければ T には入れない
  const tEntryOk = itActive && hasCommittedAnchor;

  const frameSelected: FrameKind = forceS
    ? ('S' as FrameKind)
    : tEntryOk
      ? ('T' as FrameKind)
      : preferCWhenAnchored
        ? ('C' as FrameKind)
        : wantsIReturn
          ? ('I' as FrameKind)
          : selectFrame(
              {
                depth:
                  typeof meta.depth === 'string' && meta.depth.length > 0
                    ? meta.depth
                    : null,
                descentGate: (meta as any).descentGate ?? null,
              },
              inputKind,
            );

  (meta as any).frame = frameSelected;

// dump（1回だけ）
// console.log('[IROS/frame-debug][dump] containerDecision', {
//   inputKind,
//   rawTargetKind,
//   targetKindNorm,
//   dg,
//   itActive,          // T候補
//   tEntryOk,          // ✅ T確定
//   hasFixedNorthSUN,  // 北極星（SUN）
//   hasCommittedAnchor,// 確定アンカー（commit）
//   hasFixedAnchor,    // = hasCommittedAnchor（互換）
//   fixedNorthKey,
//   forceS,
//   wantsIReturn,
//   frameSelected,
//   meta_frame_after: (meta as any).frame,
// });

(meta as any).frameDebug_containerDecision = {
  inputKind,
  rawTargetKind,
  targetKindNorm,
  dg,
  itActive, // T候補
  // tEntryOk は “ANCHOR_ENTRY 確定後” に最終決定したいので、ここでは参考値扱いにする
  tEntryOk_pre: tEntryOk,
  hasFixedNorthSUN,
  hasCommittedAnchor,
  hasFixedAnchor,
  fixedNorthKey,
  forceS,
  wantsIReturn,
  frameSelected,
  meta_frame_after: (meta as any).frame,
};




// noDelta
const nd = (() => {
  const t = String(text ?? '').trim();

  const isRepeatWarning =
    /同じ注意|何度も|繰り返し|変わらない|分かっている.*変わらない|わかっている.*変わらない/.test(
      t,
    );

  // ✅「短いコミット宣言」は short-loop 扱いしない（＝停滞判定から除外）
  // 必要なら辞書を増やす（or 正規化して揺れを吸収してもOK）
  const isCommitShort =
    /^(継続する|続ける|やる|やります|進める|進みます|守る|守ります|決めた|決めました)$/u.test(
      t,
    );

  const isVeryShort = t.length <= 8;
  const isShortLoopContext = inputKind === 'chat' || inputKind === 'question';

  const looksStoppedByReason =
    rotationReason.length > 0 &&
    (rotationReason.includes('回転') ||
      rotationReason.includes('満たしていない') ||
      rotationReason.includes('起きない'));

  const looksStoppedByMeta = spinStepNow === 0 && rotationReason.length > 0;

  // ✅ commitShort のときは “短文だから noDelta” を発生させない
  const noDeltaByVeryShort =
    isVeryShort && isShortLoopContext && looksStoppedByReason && !isCommitShort;

  const noDelta =
    isRepeatWarning ||
    looksStoppedByReason ||
    looksStoppedByMeta ||
    noDeltaByVeryShort;

  let kind: NoDeltaKind | null = null;
  if (noDelta) {
    if (isRepeatWarning) kind = 'repeat-warning';
    else if (isVeryShort && !isCommitShort) kind = 'short-loop';
    else kind = 'stuck';
  }

  return { noDelta, kind, isCommitShort };
})();


  (meta as any).noDelta = nd.noDelta;
  (meta as any).noDeltaKind = nd.kind;

  // slotPlan（buildSlots は Record を返すので、ここでキー配列に正規化）
  const built = buildSlots(frameSelected, {
    descentGate: (meta as any).descentGate,
    spinLoop: (meta as any).spinLoop ?? null,
    noDelta: nd.noDelta === true,
    noDeltaKind: nd.kind ?? null,
    iLayerDual: (meta as any).iLayerDual === true,
  });

  const slotKeys = toSlotKeys(built);

  // meta には「キー配列」だけ入れる（下流の slotPlan_keys が復活する）
  (meta as any).slotPlan = slotKeys;

  return {
    meta,
    frame: frameSelected,
    slotPlan: { slots: slotKeys },
  };
}
