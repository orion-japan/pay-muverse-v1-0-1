// src/lib/iros/spin/spinEngine.ts
// iros — Spin Engine
// 目的: 回転(spinLoop/spinStep)を「文章層ではなくOS(状態)」として毎ターン決める。
// - 決定はここ(=Orchestratorから呼ぶ)に集約
// - Writer/Micro/Render は参照のみ（決めない）
//
// 仕様（今回の固定）
// - spinLoop: 'SRI' or 'TCF'
// - spinStep: 0|1|2（loop内の位置）
// - 初期loop: depthStage が S/R/I → SRI、T/C/F → TCF
// - 反転条件（強条件のみ）
//   SRI→TCF: phase Inner→Outer かつ depthStage が I* または T*
//   TCF→SRI: qCode が Q3/Q4/Q5 かつ phase Outer→Inner
// - spinStep は depthStage の頭文字で決める（ループ外は「慣性=維持」）
// - ir診断ターンは shouldSuppressSpin=true（ただし meta 更新自体はしてもよい）
//
// 注意: depthStage は「点」、spin は「運動」。混ぜない。

export type SpinLoop = 'SRI' | 'TCF';
export type SpinAxis = 'S' | 'R' | 'I' | 'T' | 'C' | 'F';
export type SpinStep = 0 | 1 | 2;

export type Phase = 'Inner' | 'Outer';
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

/**
 * 回転判定に必要なメタ最小セット
 * - depthStage: 'S1'..'T3' を想定（stringで受ける）
 */
export type SpinMetaLike = {
  qCode?: QCode | null;
  depthStage?: string | null;
  phase?: Phase | null;
  spinLoop?: SpinLoop | null;
  spinStep?: number | null;
};

export type SpinEngineInput<TMeta extends SpinMetaLike = SpinMetaLike> = {
  /** 直前ターンの meta（継承用） */
  prevMeta?: TMeta | null;
  /** 今ターンで確定した meta（Q/深度/位相が入っている想定） */
  nextMeta?: TMeta | null;

  /** ir診断など、回転よりフォーマット優先のとき */
  mode?: 'normal' | 'ir';

  /** 未設定時の既定値 */
  defaults?: {
    spinLoop?: SpinLoop;
    spinStep?: SpinStep;
  };
};

export type SpinEngineOutput = {
  spinLoop: SpinLoop;
  spinStep: SpinStep;
  leadAxis: SpinAxis;
  axisOrder: SpinAxis[]; // loopごとの順
  nextSpinStep: SpinStep;
  shouldSuppressSpin: boolean;
};

const DEFAULTS_REQUIRED: Required<NonNullable<SpinEngineInput['defaults']>> = {
  spinLoop: 'SRI',
  spinStep: 0,
};

const LOOP_AXES: Record<SpinLoop, [SpinAxis, SpinAxis, SpinAxis]> = {
  SRI: ['S', 'R', 'I'],
  TCF: ['T', 'C', 'F'],
};

function clampSpinStep(n: unknown): SpinStep {
  const x = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  const i = Math.trunc(x);
  if (i <= 0) return 0;
  if (i === 1) return 1;
  return 2;
}

function normalizeLoop(loop: unknown): SpinLoop | null {
  if (loop === 'SRI' || loop === 'TCF') return loop;
  return null;
}

function headAxisFromDepth(depthStage: string | null | undefined): SpinAxis | null {
  if (!depthStage) return null;
  const ch = depthStage.trim().charAt(0).toUpperCase();
  if (ch === 'S' || ch === 'R' || ch === 'I' || ch === 'T' || ch === 'C' || ch === 'F') {
    return ch as SpinAxis;
  }
  return null;
}

function chooseInitialLoopByDepth(depthStage: string | null | undefined): SpinLoop | null {
  const axis = headAxisFromDepth(depthStage);
  if (!axis) return null;
  if (axis === 'S' || axis === 'R' || axis === 'I') return 'SRI';
  if (axis === 'T' || axis === 'C' || axis === 'F') return 'TCF';
  return null;
}

function isPhase(p: unknown): p is Phase {
  return p === 'Inner' || p === 'Outer';
}

function isQCode(q: unknown): q is QCode {
  return q === 'Q1' || q === 'Q2' || q === 'Q3' || q === 'Q4' || q === 'Q5';
}

function inAxisOrder(loop: SpinLoop, axis: SpinAxis): boolean {
  return LOOP_AXES[loop].includes(axis as any);
}

function axisToStep(loop: SpinLoop, axis: SpinAxis): SpinStep | null {
  const axes = LOOP_AXES[loop];
  const idx = axes.indexOf(axis as any);
  if (idx === 0) return 0;
  if (idx === 1) return 1;
  if (idx === 2) return 2;
  return null;
}

function nextStep(step: SpinStep): SpinStep {
  return ((step + 1) % 3) as SpinStep;
}

function shouldFlipSRItoTCF(args: {
  prevPhase: Phase | null;
  nextPhase: Phase | null;
  nextDepthAxis: SpinAxis | null;
}): boolean {
  // 強条件:
  // - phase Inner -> Outer
  // - depthStage が I* または T*
  if (args.prevPhase !== 'Inner') return false;
  if (args.nextPhase !== 'Outer') return false;
  return args.nextDepthAxis === 'I' || args.nextDepthAxis === 'T';
}

function shouldFlipTCFtoSRI(args: {
  prevPhase: Phase | null;
  nextPhase: Phase | null;
  nextQ: QCode | null;
}): boolean {
  // 強条件:
  // - qCode が Q3/Q4/Q5
  // - phase Outer -> Inner
  if (args.prevPhase !== 'Outer') return false;
  if (args.nextPhase !== 'Inner') return false;
  return args.nextQ === 'Q3' || args.nextQ === 'Q4' || args.nextQ === 'Q5';
}

/**
 * decideSpin
 * Orchestratorから毎ターン呼び出し、spinを確定させる。
 */
export function decideSpin<TMeta extends SpinMetaLike = SpinMetaLike>(
  input: SpinEngineInput<TMeta>
): SpinEngineOutput {
  const defaults = { ...DEFAULTS_REQUIRED, ...(input.defaults ?? {}) };

  const prev = input.prevMeta ?? null;
  const next = input.nextMeta ?? null;

  const prevPhase: Phase | null =
    prev && isPhase(prev.phase) ? prev.phase : null;
  const nextPhase: Phase | null =
    next && isPhase(next.phase) ? next.phase : null;

  const nextDepthAxis: SpinAxis | null = headAxisFromDepth(next?.depthStage ?? null);

  const nextQ: QCode | null =
    next && isQCode(next.qCode) ? next.qCode : null;

  // 1) 継承値の取り出し（無ければdefaults）
  const inheritedLoop =
    normalizeLoop(next?.spinLoop) ??
    normalizeLoop(prev?.spinLoop) ??
    null;

  const inheritedStep =
    next?.spinStep != null
      ? clampSpinStep(next.spinStep)
      : prev?.spinStep != null
        ? clampSpinStep(prev.spinStep)
        : null;

  // 2) 初期loop決定（spinLoop無い場合のみ）
  let loop: SpinLoop =
    inheritedLoop ??
    chooseInitialLoopByDepth(next?.depthStage ?? null) ??
    defaults.spinLoop;

  // 3) 反転（強条件のみ）
  if (loop === 'SRI') {
    if (shouldFlipSRItoTCF({ prevPhase, nextPhase, nextDepthAxis })) {
      loop = 'TCF';
    }
  } else {
    if (shouldFlipTCFtoSRI({ prevPhase, nextPhase, nextQ })) {
      loop = 'SRI';
    }
  }

  // 4) step決定（深度頭文字が loop内ならそれに合わせる。外なら「慣性=維持」）
  let step: SpinStep =
    inheritedStep ?? defaults.spinStep;

  if (nextDepthAxis && inAxisOrder(loop, nextDepthAxis)) {
    const mapped = axisToStep(loop, nextDepthAxis);
    if (mapped != null) step = mapped;
  }

  const leadAxis = LOOP_AXES[loop][step];
  const nextSpinStep = nextStep(step);

  const shouldSuppressSpin = input.mode === 'ir';

  return {
    spinLoop: loop,
    spinStep: step,
    leadAxis,
    axisOrder: [...LOOP_AXES[loop]],
    nextSpinStep,
    shouldSuppressSpin,
  };
}
