// src/lib/iros/wire.orchestrator.ts

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';
import {
  runIrosTurn,
  type IrosOrchestratorArgs,
  type IrosOrchestratorResult,
} from './orchestrator';
import { applyWillDepthDrift } from './willEngine';
import type { Depth, IrosMeta, IrosMode, QCode } from '@/lib/iros/system';

// ------------------------------
// Supabase client
// ------------------------------
// NOTE:
// - orchestrator 側に sb を注入する（wire は “配線” だけ担当）
// - createClient は軽いが、1リクエスト1回で十分
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

export async function handleIrosRequest(req: IrosWireRequest): Promise<IrosWireResponse> {
  const { userCode, conversationId, text, mode, depth, qCode, baseMeta } = req;

  // ------------------------------
  // Orchestrator 呼び出し
  // ------------------------------
  const orchestratorArgs: IrosOrchestratorArgs = {
    sb: sb(),
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
  // 方針（新憲法）:
  // - WILL は unified を“候補”として加工するだけ
  // - meta.depth は「確定値」なので wire では上書きしない
  //   （深度の確定は orchestrator 側＝Rotation / ITX / 統合方針に寄せる）
  const rawMeta: any = result.meta ?? {};
  const unifiedBefore = rawMeta?.unified ?? null;

  let metaAfterWill: any = rawMeta;

  if (unifiedBefore) {
    const unifiedAfter = applyWillDepthDrift(unifiedBefore);

    // [IROS/DEPTH_WRITE] WILL drift（unified only / meta.depth is not overwritten here）
    try {
      const beforeStage = (unifiedBefore as any)?.depth?.stage ?? null;
      const afterStage = (unifiedAfter as any)?.depth?.stage ?? null;
      const gear = (unifiedAfter as any)?.willDebug?.depthDrift?.gear ?? null;
      const applied = (unifiedAfter as any)?.willDebug?.depthDrift?.appliedRequest ?? null;
      const req = (unifiedAfter as any)?.willDebug?.depthDrift?.requestedDepth ?? null;

      // eslint-disable-next-line no-console
      console.log('[IROS/DEPTH_WRITE]', {
        route: 'WILL',
        where: 'wire.orchestrator',
        conversationId,
        before: beforeStage,
        after: afterStage,
        appliedRequest: applied,
        requestedDepth: req,
        gear,
        note: 'unified drift only (meta.depth not overwritten)',
      });
    } catch {}

    metaAfterWill = {
      ...rawMeta,
      unified: unifiedAfter,
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

