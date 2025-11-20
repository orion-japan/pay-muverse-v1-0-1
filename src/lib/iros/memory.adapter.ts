// src/lib/iros/memory.adapter.ts
// Iros Memory Adapter

import type { IrosMemory, QTrace } from './memory/types';
import { getIrosMemory, getQTrace } from './memory';

export type MemoryLoadOptions = {
  limit?: number;
};

export async function loadIrosMemoryForUser(
  userCode: string,
  options?: MemoryLoadOptions
): Promise<IrosMemory> {

  // ★ 追加：どの userCode を読みに行くかログ
  console.log('[IROS][MemoryAdapter] loadIrosMemoryForUser userCode =', userCode);

  const mem = await getIrosMemory(userCode, { limit: options?.limit });

  // ★ 追加：QTrace の snapshot を確認（currentQ, depthStage, updatedAt）
  console.log('[IROS][MemoryAdapter] QTrace snapshot =', mem.qTrace.snapshot);

  return mem;
}

export async function loadQTraceForUser(
  userCode: string,
  options?: MemoryLoadOptions
): Promise<QTrace> {
  const qTrace = await getQTrace(userCode, { limit: options?.limit });

  // ★ 追加：QTrace 取得ログ
  console.log('[IROS][MemoryAdapter] loadQTraceForUser snapshot =', qTrace.snapshot);

  return qTrace;
}

export function applyQTraceToMeta<TMeta extends { qCode?: string; depth?: string }>(
  meta: TMeta,
  qTrace: QTrace
): TMeta {
  const next = { ...meta };

  // ★ 追加：apply 時のログ
  console.log('[IROS][MemoryAdapter] applyQTraceToMeta before =', meta);

  const currentQ = qTrace.snapshot.currentQ;
  if (currentQ) {
    next.qCode = currentQ;
  }

  const stage = qTrace.snapshot.depthStage;
  if (stage && /^([SRCI][1-3])$/.test(stage)) {
    next.depth = stage;
  }

  console.log('[IROS][MemoryAdapter] applyQTraceToMeta after =', next);

  return next;
}
