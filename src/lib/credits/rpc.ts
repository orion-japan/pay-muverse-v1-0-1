// src/lib/credits/rpc.ts
import { adminClient } from './db';
function supa() { return adminClient(); }

/** PostgREST が探しに行く順に合わせて送る（p_amount→…→p_user_code） */
export async function rpcAuthorize(
  userCode: string,
  amount: number,
  idemRef: string,
  refConv?: string | null,
  refSub?: string | null
): Promise<boolean> {
  const args: Record<string, any> = {};
  args.p_amount    = Number(amount);
  args.p_idem      = String(idemRef);
  args.p_ref_conv  = refConv ?? null;
  args.p_ref_sub   = refSub ?? null;
  args.p_user_code = String(userCode);

  const { data, error } = await supa().rpc('credit_authorize', args);
  if (error) { console.error('[rpcAuthorize] error:', error.message); return false; }
  return !!(data ?? true);
}

/** 現状は RPC と同じ挙動のダミー。将来「テーブル直書き」に差し替えOK */
export async function rpcAuthorizeDirect(
  userCode: string,
  amount: number,
  idemRef: string,
  refConv?: string | null,
  refSub?: string | null
): Promise<boolean> {
  return rpcAuthorize(userCode, amount, idemRef, refConv, refSub);
}

export async function rpcCapture(
  userCode: string,
  amount: number,
  idemRef: string,
  opts?: { reason?: string | null; sourceId?: string | null; sourceKind?: string | null }
): Promise<boolean> {
  const { reason = 'IROS_CHAT', sourceId = idemRef, sourceKind = 'iros' } = opts || {};
  const { data, error } = await supa().rpc('credit_capture', {
    p_action: 'capture',
    p_amount: Number(amount),
    p_idem: String(idemRef),
    p_reason: reason,
    p_source_id: sourceId,
    p_source_kind: sourceKind,
    p_user_code: String(userCode),
  });
  if (error) { console.error('[rpcCapture] error:', error.message); return false; }
  return !!(data ?? true);
}

/** ダミーの Direct 実装（まずは RPC を再呼びするだけ） */
export async function rpcCaptureDirect(
  userCode: string,
  amount: number,
  idemRef: string,
  opts?: { reason?: string | null; sourceId?: string | null; sourceKind?: string | null }
): Promise<boolean> {
  return rpcCapture(userCode, amount, idemRef, opts);
}

/** /api/credits/probe-direct 用の簡易プローブ（N回試行） */
export async function rpcCaptureDirectProbe(
  userCode: string,
  amount: number,
  idemRef: string,
  tries = 1
): Promise<number> {
  let okCount = 0;
  for (let i = 0; i < Math.max(1, tries); i++) {
    const ok = await rpcCaptureDirect(userCode, amount, idemRef);
    if (ok) okCount++;
  }
  return okCount;
}

/** VOID（いまは capture の void アクションで代替） */
export async function rpcVoid(
  userCode: string,
  amount: number,
  idemRef: string,
  opts?: { reason?: string | null; sourceId?: string | null; sourceKind?: string | null }
): Promise<boolean> {
  const { reason = 'void', sourceId = idemRef, sourceKind = 'iros' } = opts || {};
  const { data, error } = await supa().rpc('credit_capture', {
    p_action: 'void',
    p_amount: Number(amount),
    p_idem: String(idemRef),
    p_reason: reason,
    p_source_id: sourceId,
    p_source_kind: sourceKind,
    p_user_code: String(userCode),
  });
  if (error) { console.error('[rpcVoid] error:', error.message); return false; }
  return !!(data ?? true);
}
