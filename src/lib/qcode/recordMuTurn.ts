// Mu のテキスト1往復のクレジット消費を計上（失敗時は既定0課金）

import { muCreditPolicy, muQTag, type MuQTags } from './muPolicy';
import { MU_Q_LINK } from '@/lib/mu/config';

export type MuTurnStatus = 'success' | 'fail';
export type IntentTag = (typeof MU_Q_LINK.INTENT_TAGS)[number];

export type RecordMuTextTurnParams = {
  user_code: string;
  status: MuTurnStatus;
  chargeOnFailure?: boolean;
  intentTag?: IntentTag;
  conversation_id?: string;
  message_id?: string;
  meta?: Record<string, unknown>;
};

export type RecordMuTextTurnResult = {
  ok: boolean;
  used_credits: number;
  schema: string;
  tags: MuQTags;
  user_code: string;
  status: MuTurnStatus;
  at: string; // ISO
  conversation_id?: string;
  message_id?: string;
  intentTag?: string;
  meta?: Record<string, unknown>;
};

/** Mu テキスト1往復の既定コストを取得（env 連動） */
export function getMuTextTurnCost(): number {
  return muCreditPolicy.textTurn.cost;
}

/** テキスト1往復を記録（ノーコード計上版） */
export async function recordMuTextTurn(
  params: RecordMuTextTurnParams,
): Promise<RecordMuTextTurnResult> {
  const { user_code, status, chargeOnFailure = false } = params;

  const cost =
    status === 'success'
      ? muCreditPolicy.textTurn.cost
      : chargeOnFailure
        ? muCreditPolicy.textTurn.cost
        : 0;

  const tags = muQTag('textTurn');

  return {
    ok: true,
    used_credits: cost,
    schema: muCreditPolicy.textTurn.schema,
    tags,
    user_code,
    status,
    at: new Date().toISOString(),
    conversation_id: params.conversation_id,
    message_id: params.message_id,
    intentTag: params.intentTag,
    meta: params.meta,
  };
}
