// file: src/lib/iros/server/handleIrosReply.state.ts
// iros - Server-side state helpers (MemoryState read only)
// - userCode ごとの「現在地」を読み込み、baseMeta に合成
// - 保存（upsert）は handleIrosReply.persist 側に集約する（ここではDB保存しない）

import type { Depth, QCode, IrosMeta } from '../system';
import {
  loadIrosMemoryState,
  type IrosMemoryState,
} from '../memoryState';

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
        // depth / qCode：baseMeta が優先。無ければ MemoryState で補完
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
        // selfAcceptance は「自己肯定ライン」。baseMeta に無い場合のみ補完
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
    // ✅ ログ文言を1つに統一
    console.log(
      '[IROS/STATE] saveMemoryStateFromMeta skipped (persist is handled in handleIrosReply)',
      { userCode },
    );
  }

  return;
}
