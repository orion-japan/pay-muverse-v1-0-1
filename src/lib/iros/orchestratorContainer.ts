// file: src/lib/iros/orchestratorContainer.ts
// J) DescentGate + Frame + Slots（7.5）を切り出し（behavior-preserving）

import type { IrosMeta } from './system';

import { buildSlots, type NoDeltaKind, type SlotKey } from './language/slotBuilder';
import { classifyInputKind } from './language/inputKind';
import { selectFrame, type FrameKind } from './language/frameSelector';
import { decideDescentGate } from './rotation/rotationLoop';

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

function toSlotKeys(plan: ReturnType<typeof buildSlots> | null | undefined): SlotKey[] {
  if (!plan) return [];
  const slots = (plan as any).slots;
  if (!slots || typeof slots !== 'object') return [];

  // Record<SlotKey, string|null> のうち、null でないものだけを採用
  const keys = Object.keys(slots) as SlotKey[];
  return keys.filter((k) => slots[k] != null);
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
    (meta as any).targetKind ??
    (meta as any).target_kind ??
    goalKind ??
    null;

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

  // frame
// frame
const itActive =
  (meta as any).tLayerModeActive === true ||
  typeof (meta as any).tLayerHint === 'string'; // 保険

const frameSelected = itActive
  ? ('T' as FrameKind) // ★ IT発火時は必ずT
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

const frame: FrameKind = frameSelected;
(meta as any).frame = frame;

// デバッグ
console.log('[IROS/frame-debug][dump] containerDecision', {
  inputKind,
  itActive,
  frameSelected,
  meta_frame_after: (meta as any).frame,
});


  // ✅ dump（ここが正しい）
  console.log('[IROS/frame-debug][dump] containerDecision', {
    inputKind,
    rawTargetKind,
    targetKindNorm,
    dg,
    frameSelected,
    meta_frame_after: (meta as any).frame,
  });

  // noDelta
  const nd = (() => {
    const t = String(text ?? '').trim();

    const isRepeatWarning =
      /同じ注意|何度も|繰り返し|変わらない|分かっている.*変わらない|わかっている.*変わらない/.test(
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

    const noDelta =
      isRepeatWarning ||
      looksStoppedByReason ||
      looksStoppedByMeta ||
      (isVeryShort && isShortLoopContext && looksStoppedByReason);

    let kind: NoDeltaKind | null = null;
    if (noDelta) {
      if (isRepeatWarning) kind = 'repeat-warning';
      else if (isVeryShort) kind = 'short-loop';
      else kind = 'stuck';
    }

    return { noDelta, kind };
  })();

  (meta as any).noDelta = nd.noDelta;
  (meta as any).noDeltaKind = nd.kind;

  // slotPlan（buildSlots は Record を返すので、ここでキー配列に正規化）
  const built = buildSlots(frame, {
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
