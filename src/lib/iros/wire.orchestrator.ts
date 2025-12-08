// src/lib/iros/wire.orchestrator.ts

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
} from './system';
import { applyWillDepthDrift } from './willEngine'; // ★ ここはそのまま

// ==== 外部から受け取る想定のリクエスト型 ==== //
export type IrosWireRequest = {
  userCode: string;
  conversationId?: string;
  text: string;
  mode?: IrosMode;
  depth?: Depth;
  qCode?: QCode;
  baseMeta?: Partial<IrosMeta>;
};

// ==== 外部に返すレスポンス型 ==== //
export type IrosWireResponse = {
  content: string;
  meta: IrosMeta & {
    userCode: string;
    conversationId?: string;
  };
};

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

  // ---- Iros Orchestrator 呼び出し ---- //
  const orchestratorArgs: IrosOrchestratorArgs = {
    conversationId,
    text,
    requestedMode: mode,
    requestedDepth: depth,
    requestedQCode: qCode,
    baseMeta,
  };

  const result: IrosOrchestratorResult = await runIrosTurn(orchestratorArgs);

  // ---- WILL（Depth drift／ボタン反映）を unified にだけ適用 ---- //
  const rawMeta: any = result.meta ?? {};
  const unifiedBefore: any = rawMeta.unified;

  let metaAfterWill: any = rawMeta;

  if (unifiedBefore) {
    const unifiedAfter = applyWillDepthDrift(unifiedBefore); // ★ unified だけ通す

    // ★ WILL の結果から depth を引き出して、上位の meta.depth にも反映する
    const depthAfter =
      (unifiedAfter?.depth?.stage as Depth | undefined) ??
      (rawMeta?.depth as Depth | undefined);

    metaAfterWill = {
      ...rawMeta,
      unified: unifiedAfter,
      depth: depthAfter,
    };
  }

  // ---- 将来のDB保存・メトリクス記録のための余白 ---- //
  // 例:
  // await saveIrosMessage({
  //   userCode,
  //   conversationId,
  //   role: 'assistant',
  //   content: result.content,
  //   meta: metaAfterWill,
  // });

  const meta: IrosMeta & { userCode: string; conversationId?: string } = {
    ...(metaAfterWill as IrosMeta),
    userCode,
    conversationId,
  };

  console.log('[WILL][after]', {
    depthBefore: rawMeta?.unified?.depth,
    depthAfter: metaAfterWill?.unified?.depth,
    depthTopLevel: meta.depth,
  });

  return {
    content: result.content,
    meta,
  };
}
