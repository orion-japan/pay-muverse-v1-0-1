// src/lib/iros/orchestratorState.ts
// Iros Orchestrator — MemoryState 読み込み専用ヘルパー
// - userCode ごとの「現在地」を読み込み、baseMeta に合成
// - 保存（upsert）は handleIrosReply 側に集約する（ここではDB保存しない）

import type { Depth, QCode, IrosMeta } from './system';
import {
  loadIrosMemoryState,
  type IrosMemoryState,
} from './memoryState';

export type LoadStateResult = {
  /** MemoryState を合成した baseMeta（無ければ undefined） */
  mergedBaseMeta: Partial<IrosMeta> | undefined;
  /** 読み込んだ MemoryState（無ければ null） */
  memoryState: IrosMemoryState | null;
};

function normalizePhase(
  raw: unknown,
): 'Inner' | 'Outer' | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim().toLowerCase();
  if (p === 'inner') return 'Inner';
  if (p === 'outer') return 'Outer';
  return null;
}

function normalizeSpinLoop(raw: unknown): 'SRI' | 'TCF' | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (s === 'SRI') return 'SRI';
  if (s === 'TCF') return 'TCF';
  return null;
}

function normalizeSpinStep(raw: unknown): 0 | 1 | 2 | null {
  if (typeof raw !== 'number' || Number.isNaN(raw)) return null;
  if (raw === 0 || raw === 1 || raw === 2) return raw;
  return null;
}

/**
 * userCode ごとの MemoryState を読み込み、
 * baseMeta に depth / qCode / selfAcceptance / Y / H を合成する。
 */
export async function loadBaseMetaFromMemoryState(args: {
  userCode?: string;
  baseMeta?: Partial<IrosMeta>;
}): Promise<LoadStateResult> {
  const { userCode, baseMeta } = args;

  let mergedBaseMeta: Partial<IrosMeta> | undefined = baseMeta;
  let memoryState: IrosMemoryState | null = null;

  if (!userCode) {
    return { mergedBaseMeta, memoryState };
  }

  try {
    memoryState = await loadIrosMemoryState(userCode);

    if (
      typeof process !== 'undefined' &&
      process.env.NODE_ENV !== 'production'
    ) {
      console.log('[IROS/STATE] loaded MemoryState', {
        userCode,
        hasMemory: !!memoryState,
        depthStage: memoryState?.depthStage ?? null,
        qPrimary: memoryState?.qPrimary ?? null,
        selfAcceptance: memoryState?.selfAcceptance ?? null,
        yLevel: memoryState?.yLevel ?? null,
        hLevel: memoryState?.hLevel ?? null,
      });
    }

    if (memoryState) {
      const hasBaseSA =
        typeof (mergedBaseMeta as any)?.selfAcceptance === 'number' &&
        !Number.isNaN((mergedBaseMeta as any).selfAcceptance);

      // ★ phase / spin は MemoryState 側のキー揺れに耐える（camel / snake 両対応）
      const msAny: any = memoryState as any;

      const msPhaseRaw =
        typeof msAny.phase === 'string'
          ? msAny.phase
          : typeof msAny.phase_mode === 'string'
          ? msAny.phase_mode
          : typeof msAny.phaseMode === 'string'
          ? msAny.phaseMode
          : null;

      const msSpinLoopRaw =
        typeof msAny.spinLoop === 'string'
          ? msAny.spinLoop
          : typeof msAny.spin_loop === 'string'
          ? msAny.spin_loop
          : null;

      const msSpinStepRaw =
        typeof msAny.spinStep === 'number'
          ? msAny.spinStep
          : typeof msAny.spin_step === 'number'
          ? msAny.spin_step
          : null;

      // ★ 正規化（IrosMeta の型に合わせる）
      const normalizedPhase = normalizePhase(msPhaseRaw);
      const normalizedSpinLoop = normalizeSpinLoop(msSpinLoopRaw);
      const normalizedSpinStep = normalizeSpinStep(msSpinStepRaw);

      mergedBaseMeta = {
        ...(mergedBaseMeta ?? {}),

        // depth / qCode / phase：明示指定 or 既存 meta があればそちら優先
        ...(mergedBaseMeta?.depth
          ? {}
          : memoryState.depthStage
          ? { depth: memoryState.depthStage as Depth }
          : {}),

        ...(mergedBaseMeta?.qCode
          ? {}
          : memoryState.qPrimary
          ? { qCode: memoryState.qPrimary as QCode }
          : {}),

        // ✅ phase を追加（pivot の prev.phase を成立させるため必須）
        ...(mergedBaseMeta?.phase
          ? {}
          : (memoryState as any)?.phase
          ? { phase: (memoryState as any).phase }
          : {}),

        // ★ phase / spin：baseMeta 側に無いときだけ MemoryState から補完（正規化済み）
        ...(!(mergedBaseMeta as any)?.phase && normalizedPhase
          ? { phase: normalizedPhase }
          : {}),
        ...(!(mergedBaseMeta as any)?.spinLoop && normalizedSpinLoop
          ? { spinLoop: normalizedSpinLoop }
          : {}),
        ...(typeof (mergedBaseMeta as any)?.spinStep === 'number'
          ? {}
          : normalizedSpinStep !== null
          ? { spinStep: normalizedSpinStep }
          : {}),

        // SelfAcceptance / Y / H（baseMeta に無い場合のみ補完）
        ...(!hasBaseSA && typeof memoryState.selfAcceptance === 'number'
          ? { selfAcceptance: memoryState.selfAcceptance }
          : {}),
        ...(typeof memoryState.yLevel === 'number'
          ? { yLevel: memoryState.yLevel }
          : {}),
        ...(typeof memoryState.hLevel === 'number'
          ? { hLevel: memoryState.hLevel }
          : {}),
      };
    }
  } catch (e) {
    console.error('[IROS/STATE] loadIrosMemoryState failed', {
      userCode,
      error: e,
    });
  }

  return { mergedBaseMeta, memoryState };
}

/**
 * 互換のため残すが、ここではDB保存しない。
 * MemoryState の upsert は handleIrosReply 側に集約する。
 */
export async function saveMemoryStateFromMeta(args: {
  userCode?: string;
  meta: IrosMeta;
}): Promise<void> {
  const { userCode } = args;
  if (!userCode) return;

  if (
    typeof process !== 'undefined' &&
    process.env.NODE_ENV !== 'production'
  ) {
    console.log(
      '[IROS/STATE] saveMemoryStateFromMeta no-op (persist is handled in handleIrosReply)',
      { userCode },
    );
  }

  // no-op: 保存は handleIrosReply.persist.ts の persistMemoryStateIfAny に集約
  return;
}
