// src/lib/iros/wire.orchestrator.ts

import { createClient } from '@supabase/supabase-js';
import {
  runIrosTurn,
  type IrosOrchestratorArgs,
  type IrosOrchestratorResult,
} from './orchestrator';
import {
  type IrosMode,
  type Depth,
  type QCode,
  type IrosMeta,
} from '@/lib/iros/system';
import { applyWillDepthDrift } from './willEngine';
import { SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

// ------------------------------
// Supabase client
// ------------------------------
const sb = () => createClient(SUPABASE_URL!, SERVICE_ROLE!);

// ==============================
// 型定義
// ==============================

export type IrosWireRequest = {
  userCode: string;
  conversationId?: string;
  text: string;
  mode?: IrosMode;
  depth?: Depth;
  qCode?: QCode;
  baseMeta?: Partial<IrosMeta>;
};

export type IrosWireResponse = {
  content: string;
  meta: IrosMeta & {
    userCode: string;
    conversationId?: string;
  };
};

// ==============================
// メイン処理
// ==============================

export async function handleIrosRequest(
  req: IrosWireRequest,
): Promise<IrosWireResponse> {
  const {
    userCode,
    conversationId,
    text,
    mode,
    depth,
    qCode,
    baseMeta,
  } = req;

  // ------------------------------
  // Orchestrator 呼び出し
  // ------------------------------
  const orchestratorArgs: IrosOrchestratorArgs = {
    sb: sb(), // ★ ここが今回の修正ポイント
    conversationId,
    text,
    requestedMode: mode,
    requestedDepth: depth,
    requestedQCode: qCode,
    baseMeta,
  };

  const result: IrosOrchestratorResult = await runIrosTurn(orchestratorArgs);

  // ------------------------------
  // WILL（意図ドリフト）の後処理
  // ------------------------------
  const rawMeta: any = result.meta ?? {};
  const unifiedBefore = rawMeta?.unified;

  let metaAfterWill: any = rawMeta;

  if (unifiedBefore) {
    const unifiedAfter = applyWillDepthDrift(unifiedBefore);

// ★ WILL の結果から depth を引き出して、上位の meta.depth にも反映する
const depthAfter =
  ((unifiedAfter as any)?.depth?.stage as Depth | null | undefined) ??
  (rawMeta?.depth as Depth | undefined) ??
  undefined;
    metaAfterWill = {
      ...rawMeta,
      unified: unifiedAfter,
      depth: depthAfter,
    };
  }

  // ------------------------------
  // 返却
  // ------------------------------
  const meta: IrosMeta & { userCode: string; conversationId?: string } = {
    ...(metaAfterWill as IrosMeta),
    userCode,
    conversationId,
  };

  return {
    content: result.content,
    meta,
  };
}
