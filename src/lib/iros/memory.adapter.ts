// src/lib/iros/memory.adapter.ts
// Iros Memory Adapter — MemoryState / QTrace をロードして meta に反映するクライアント層
// ※ DB には直接触れず、memory/ 以下の getIrosMemory / getQTrace のラッパー

import type { IrosMemory, QTrace } from './memory/types';
import { getIrosMemory, getQTrace } from './memory';

export type MemoryLoadOptions = {
  limit?: number;
};

/* ============================================================================
 * ① IrosMemory のロード（全体の記録 + QTrace + state を含む構造）
 * ============================================================================ */
export async function loadIrosMemoryForUser(
  userCode: string,
  options?: MemoryLoadOptions
): Promise<IrosMemory> {

  // ★ 追加：userCode ログ
  console.log('[IROS][MemoryAdapter] loadIrosMemoryForUser userCode =', userCode);

  const mem = await getIrosMemory(userCode, { limit: options?.limit });

  // ★ 追加：QTrace snapshot ログ
  if (mem?.qTrace?.snapshot) {
    console.log('[IROS][MemoryAdapter] QTrace snapshot =', mem.qTrace.snapshot);
  } else {
    console.log('[IROS][MemoryAdapter] QTrace snapshot = <none>');
  }

  return mem;
}

/* ============================================================================
 * ② QTrace のみをロード
 * ============================================================================ */
export async function loadQTraceForUser(
  userCode: string,
  options?: MemoryLoadOptions
): Promise<QTrace> {

  const qTrace = await getQTrace(userCode, { limit: options?.limit });

  // ★ ログ強化
  console.log(
    '[IROS][MemoryAdapter] loadQTraceForUser snapshot =',
    qTrace?.snapshot ?? '<none>'
  );

  return qTrace;
}

/* ============================================================================
 * ③ QTrace snapshot を meta（モード判定メタ）へ反映する
 * ============================================================================ */
/**
 * meta の shape は、最低限 { qCode?: string; depth?: string } を満たす必要がある。
 * Iros の meta（IrosMeta）だけでなく、LLM 呼び出し前の汎用 meta にも適用可能なように
 * ジェネリックで受け取る。
 */
export function applyQTraceToMeta<
  TMeta extends { qCode?: string; depth?: string }
>(
  meta: TMeta,
  qTrace: QTrace
): TMeta {

  // ★ before ログ
  console.log('[IROS][MemoryAdapter] applyQTraceToMeta before =', meta);

  const next = { ...meta };

  /* ---- Qコード ---- */
  const currentQ = qTrace?.snapshot?.currentQ;
  if (currentQ) {
    next.qCode = currentQ;
  }

  /* ---- depth stage ---- */
  const stage = qTrace?.snapshot?.depthStage;
  if (stage && /^([SRCI][1-3])$/.test(stage)) {
    next.depth = stage;
  }

  // ★ after ログ
  console.log('[IROS][MemoryAdapter] applyQTraceToMeta after =', next);

  return next;
}
