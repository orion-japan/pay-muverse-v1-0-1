// src/lib/iros/orchestratorState.ts
// Iros Orchestrator — MemoryState 読み書き専用ヘルパー
// - userCode ごとの「現在地」を読み込み、baseMeta に合成
// - 返信後の meta から MemoryState を1行 upsert

import type { Depth, QCode, IrosMeta } from './system';
import {
  loadIrosMemoryState,
  upsertIrosMemoryState,
  type IrosMemoryState,
} from './memoryState';

export type LoadStateResult = {
  /** MemoryState を合成した baseMeta（無ければ undefined） */
  mergedBaseMeta: Partial<IrosMeta> | undefined;
  /** 読み込んだ MemoryState（無ければ null） */
  memoryState: IrosMemoryState | null;
};

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

      mergedBaseMeta = {
        ...(mergedBaseMeta ?? {}),
        // depth / qCode：明示指定 or 既存 meta があればそちら優先
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
        // SelfAcceptance / Y / H だけを合成（phase / intent 系は一旦外す）
        // ★ selfAcceptance は「自己肯定ライン」。baseMeta に無い場合のみ MemoryState から補完
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
 * 返信後の meta / unified から MemoryState を1行 upsert する。
 * runIrosTurn の最後から呼ぶ想定。
 */
export async function saveMemoryStateFromMeta(args: {
  userCode?: string;
  meta: IrosMeta;
}): Promise<void> {
  const { userCode, meta } = args;

  if (!userCode) return;

  try {
    const depthStageForSave = meta.depth ?? null;
    const qForSave = meta.qCode ?? null;

    const saForSave =
      typeof (meta as any).selfAcceptance === 'number'
        ? (meta as any).selfAcceptance
        : null;

    const unifiedForSave = (meta as any).unified ?? null;
    const phaseForSave =
      unifiedForSave &&
      (unifiedForSave.phase === 'Inner' ||
        unifiedForSave.phase === 'Outer')
        ? unifiedForSave.phase
        : null;

    // 🆕 situation.summary / topic を安全に取り出す
    const situation = unifiedForSave?.situation ?? null;
    const situationSummaryForSave =
      situation && typeof situation.summary === 'string'
        ? situation.summary
        : null;
    const situationTopicForSave =
      situation && typeof situation.topic === 'string'
        ? situation.topic
        : null;

    const intentLayerForSave = (meta as any).intentLayer ?? null;
    const intentConfidenceForSave =
      typeof (meta as any).intentConfidence === 'number'
        ? (meta as any).intentConfidence
        : null;

    const yForSave =
      typeof (meta as any).yLevel === 'number'
        ? (meta as any).yLevel
        : null;
    const hForSave =
      typeof (meta as any).hLevel === 'number'
        ? (meta as any).hLevel
        : null;

    const sentimentForSave =
      typeof (meta as any)?.sentiment_level === 'string'
        ? (meta as any).sentiment_level
        : null;

    await upsertIrosMemoryState({
      userCode,
      depthStage: depthStageForSave,
      qPrimary: qForSave,
      selfAcceptance: saForSave,
      phase: phaseForSave,
      intentLayer: intentLayerForSave,
      intentConfidence: intentConfidenceForSave,
      yLevel: yForSave,
      hLevel: hForSave,
      // situation / sentiment も MemoryState に固定
      situationSummary: situationSummaryForSave,
      situationTopic: situationTopicForSave,
      sentiment_level: sentimentForSave,
    });
  } catch (e) {
    console.error('[IROS/STATE] upsertIrosMemoryState failed', {
      userCode,
      error: e,
    });
  }
}
