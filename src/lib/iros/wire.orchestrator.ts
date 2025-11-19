// src/lib/iros/wire.orchestrator.ts
// Iros Orchestrator の呼び出し窓口（極小版）
// - API やサーバーコンポーネントから使いやすい形にラップする
// - DB 保存やメトリクスはここでは実装しない（TODO として余白だけ残す）

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

// ==== 外部から受け取る想定のリクエスト型 ==== //
export type IrosWireRequest = {
  // 認証済みユーザーのコード（例: user_code）
  userCode: string;

  // 会話単位のID（なければ新規として扱う想定）
  conversationId?: string;

  // ユーザー発話
  text: string;

  // 呼び出し側が明示的に指定したい場合だけ使用
  mode?: IrosMode;
  depth?: Depth;
  qCode?: QCode;

  // 将来的に memory/profile から渡したい追加メタ
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

/**
 * Iros の1ターン処理をまとめて呼び出す窓口。
 *
 * 役割:
 * - 外部から受け取ったパラメータを IrosOrchestratorArgs に変換
 * - runIrosTurn を呼び出し、結果を IrosWireResponse に整形
 * - 将来、ここに「DB保存」「メトリクス記録」などを追加できる余白を残す
 */
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

  // ---- 将来のDB保存・メトリクス記録のための余白 ---- //
  // 例:
  // await saveIrosMessage({
  //   userCode,
  //   conversationId,
  //   role: 'assistant',
  //   content: result.content,
  //   meta: result.meta,
  // });
  //
  // ※ 実装は memory/store.ts や Supabase クライアントの構成を
  //    確認した上で、別途コード or SQL で明示的に追加する。

  const meta: IrosMeta & { userCode: string; conversationId?: string } = {
    ...(result.meta ?? {}),
    userCode,
    conversationId,
  };

  return {
    content: result.content,
    meta,
  };
}
