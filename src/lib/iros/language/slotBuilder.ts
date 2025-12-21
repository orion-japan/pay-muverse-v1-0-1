// src/lib/iros/language/slotBuilder.ts
// iros — Slot Builder（スロット生成）
// - Frame（器）に対して「中身の枠（slot）」を用意する（本文はまだ作らない）
// - DescentGateState は union を正とする（closed/offered/accepted）

import type { FrameKind, DescentGateState } from './frameSelector';
import type { SpinLoop } from '../types';

export type SlotKey = 'OBS' | 'SHIFT' | 'NEXT' | 'SAFE';

export type SlotPlan = {
  frame: FrameKind;
  slots: Record<SlotKey, string | null>;
};

// ✅ 追加：変化なし（No-Delta）の種別（上流で判定して渡す）
export type NoDeltaKind = 'repeat-warning' | 'short-loop' | 'stuck' | 'unknown';

export type BuildSlotsContext = {
  descentGate: DescentGateState | boolean | null | undefined; // 互換：旧booleanも許可
  spinLoop?: SpinLoop | null | undefined; // ✅ 追加：回転ループ（TCF なら下降扱い）

  // ✅ 追加：No-Delta シグナル（SlotBuilderは「タグを立てる」だけ）
  // - true のとき、OBS に :no-delta を付与して Writer に「冒頭1文=状態翻訳」を強制させる
  noDelta?: boolean | null | undefined;
  noDeltaKind?: NoDeltaKind | null | undefined;

  // ✅ 追加：I層プレゼン用（上司I層 + 自分I層など “両建て” を Writer に伝える）
  // - slotBuilder 側では本文を作らず、タグだけ立てる
  iLayerDual?: boolean | null | undefined;
};

function normalizeDescentGate(
  v: DescentGateState | boolean | null | undefined
): DescentGateState {
  if (v === true) return 'accepted';
  if (v === false) return 'closed';
  if (v === 'closed' || v === 'offered' || v === 'accepted') return v;
  return 'closed';
}

function normalizeSpinLoop(v: unknown): SpinLoop | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (s === 'SRI') return 'SRI';
  if (s === 'TCF') return 'TCF';
  return null;
}

function normalizeNoDeltaKind(v: unknown): NoDeltaKind | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'repeat-warning' || s === 'repeat') return 'repeat-warning';
  if (s === 'short-loop' || s === 'short') return 'short-loop';
  if (s === 'stuck') return 'stuck';
  if (s === 'unknown') return 'unknown';
  return null;
}

function baseSlots(): Record<SlotKey, string | null> {
  return {
    OBS: null,
    SHIFT: null,
    NEXT: null,
    SAFE: null,
  };
}

/**
 * Slot を組み立てる
 * - 値は「Writer が参照する短い指示文（タグ）」として返す
 * - truthy / falsy でログに出せるよう null を使う
 */
export function buildSlots(frame: FrameKind, ctx: BuildSlotsContext): SlotPlan {
  const dg = normalizeDescentGate(ctx?.descentGate);
  const loop = normalizeSpinLoop(ctx?.spinLoop);

  const noDelta = ctx?.noDelta === true;
  const noDeltaKind = normalizeNoDeltaKind(ctx?.noDeltaKind) ?? null;

  const iLayerDual = ctx?.iLayerDual === true;

  const slots = baseSlots();

  // --- 下降ゲート（安全・減速） ---
  // offered/accepted のときは SAFE を必ず立てる（問いの圧を下げる/守る）
  if (dg !== 'closed') {
    slots.SAFE =
      dg === 'offered' ? 'SAFE:descent-offered' : 'SAFE:descent-accepted';
  } else {
    // ✅ dg が closed でも「TCF(下降)」なら SAFE を立てる
    if (loop === 'TCF') {
      slots.SAFE = 'SAFE:spin-tcf';
    }
  }

  // --- Frame ごとの最小スロット ---
  switch (frame) {
    case 'MICRO': {
      slots.OBS = 'OBS:micro';
      slots.NEXT = 'NEXT:one-step';
      // SHIFT は入れない（短文崩れ防止）
      break;
    }

    case 'NONE': {
      // 基本スロット無し（素の返答）
      // ただし SAFE は残りうる（下降 / 安全ギア）
      break;
    }

    case 'S': {
      slots.OBS = 'OBS:self';
      slots.SHIFT = 'SHIFT:self';
      slots.NEXT = 'NEXT:self';
      break;
    }

    case 'R': {
      slots.OBS = 'OBS:resonance';
      slots.SHIFT = 'SHIFT:resonance';
      slots.NEXT = 'NEXT:resonance';
      break;
    }

    case 'C': {
      slots.OBS = 'OBS:creation';
      // C は “動ける形” 優先なので NEXT を強める
      slots.NEXT = 'NEXT:action';
      // SHIFT は任意だが、下降中以外なら入れて良い
      if (dg === 'closed') slots.SHIFT = 'SHIFT:reframe';
      break;
    }

    case 'F': {
      // F = 定着・支える（落下や反発を抑え、足場を作る）
      slots.OBS = 'OBS:stabilize';
      slots.SHIFT = 'SHIFT:stabilize';
      slots.NEXT = 'NEXT:small-step';
      // SAFE は dg/loop 側で既に立つ。closed でも薄く保険を置きたい場合のみ上書き
      if (dg === 'closed' && !slots.SAFE) slots.SAFE = 'SAFE:stabilize';
      break;
    }

    case 'I': {
      // I = 本質 / 意図 / 未来（刺す・確信・結論寄せの器）
      slots.OBS = iLayerDual ? 'OBS:intention:dual' : 'OBS:intention';
      slots.SHIFT = iLayerDual ? 'SHIFT:intention:dual' : 'SHIFT:intention';
      slots.NEXT = iLayerDual ? 'NEXT:intention:align' : 'NEXT:intention';
      // I層プレゼン中は SAFE を邪魔しない（あれば尊重）。無ければ薄く置く
      if (!slots.SAFE) slots.SAFE = 'SAFE:intention';
      break;
    }

    case 'T': {
      slots.OBS = 'OBS:transcend';
      // T は「気づき」優先、NEXT は控えめ
      slots.SHIFT = 'SHIFT:insight';
      slots.NEXT = 'NEXT:soft';
      break;
    }

    default: {
      // 将来拡張用：何もしない
      break;
    }
  }

  // ✅ NO_DELTA_OBS（最小で効く追加）
  // - “本文”は作らない。Writer が「冒頭1文=状態翻訳」を必ず出せるようにタグを立てるだけ。
  // - MICRO/NONE は崩れやすいのでここでは触らない（必要なら上流で frame を切り替える）
  if (noDelta && frame !== 'NONE' && frame !== 'MICRO') {
    // OBS に no-delta を必ず付与
    slots.OBS = slots.OBS ? `${slots.OBS}:no-delta` : 'OBS:no-delta';

    // ★追加：stuck は「深まり注入口」
    // - ただし I層に落とさない（1行だけ刺す）
    // - SAFEテンプレに吸われないよう、Writer が拾えるタグを立てる
    if (noDeltaKind === 'stuck') {
      // S/R/F 帯は「固定前提の確定」へ寄せる（断定は1行、圧は上げない）
      if (frame === 'S' || frame === 'R' || frame === 'F') {
        slots.SHIFT = 'SHIFT:nonchange-structure';
        slots.NEXT = 'NEXT:probe-conditions';

        // ここが本丸：INSIGHT を 1行だけ許可（テンプレではなく“入口”）
        // ※ render 側で insightCandidate が null のままでも、slotPlan から拾えるようにする想定
        // 既存キーがあるなら尊重し、無ければ付与
        if (!(slots as any).INSIGHT) (slots as any).INSIGHT = 'INSIGHT:stuck:one-line';
      }

      // I層は「断定→一致点→次の一歩」へ寄せる（刺すが、圧は上げない）
      if (frame === 'I') {
        slots.SHIFT = iLayerDual ? 'SHIFT:intention:dual:pin' : 'SHIFT:intention:pin';
        slots.NEXT = iLayerDual ? 'NEXT:intention:align:one-step' : 'NEXT:intention:one-step';

        // Iフレームでも “1行だけ” は許可（長文化させない）
        if (!(slots as any).INSIGHT) (slots as any).INSIGHT = 'INSIGHT:stuck:one-line';
      }
    }

    // repeat-warning は従来どおり（責め→条件へ寄せる）
    if (noDeltaKind === 'repeat-warning') {
      if (frame === 'S' || frame === 'R' || frame === 'F') {
        slots.SHIFT = 'SHIFT:nonchange-structure';
        slots.NEXT = 'NEXT:probe-conditions';
      }
      if (frame === 'I') {
        slots.SHIFT = iLayerDual ? 'SHIFT:intention:dual:pin' : 'SHIFT:intention:pin';
        slots.NEXT = iLayerDual ? 'NEXT:intention:align:one-step' : 'NEXT:intention:one-step';
      }
    }

    // SAFE が未設定なら薄い保険だけ置く（下降SAFEがある場合は尊重）
    // ★ただし INSIGHT(stuck) がある場合は SAFE が主役にならないように「残すけど薄く」
    if (!slots.SAFE) slots.SAFE = noDeltaKind === 'stuck' ? 'SAFE:thin' : 'SAFE:no-delta';
  }

  return { frame, slots };
}

