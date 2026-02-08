// src/lib/iros/anchor/AnchorEntryDetector.ts
// iros — Anchor Entry Detector (T-entry)
// 目的：
// - 「言葉」ではなく「行動・選択・反復」の証拠が来た時だけ T3 を許可する
// - Orchestrator の深度判断(Q/Depth/phase)とは分離する（責務分離）
// - DBカラム追加なしで、itx_step / itx_anchor_event_type / intent_anchor(jsonb) に証拠を刻む
//
// ✅ 重要（仕様）
// - T3 は「確定」ではない（方向確定/行動証拠ではない）
// - ここでやるのは「T3へ入ってよい（密度を上げてよい）」という許可だけ
// - “確定アンカー(commit)” は別条件（ユーザーの明示的な選択・宣言・反復）でのみ立てる

export type AnchorEventType = 'choice' | 'action' | 'reconfirm' | 'none';

export type AnchorEntryInput = {
  // 観測点（どれか1つ以上が来た時だけ検討）
  choiceId?: string | null;
  actionId?: string | null;

  // 時間を使う再確認（任意）
  nowIso?: string; // default = new Date().toISOString()

  // MemoryState相当（必要最小限）
  state: {
    itx_step?: string | null; // 'T2' など
    itx_last_at?: string | null;
    intent_anchor?: any | null; // jsonb (object想定)
  };
};

// ✅ AnchorEntryDecision の定義を「T3許可」と「確定(commit)」で分離
// - tEntryOk=true は “T3へ入ってよい” を表す
// - anchorWrite は keep/commit の両方を許容（通常は keep）
// - patch は「T3許可の刻印」として任意（ここでは付ける）
export type AnchorEntryDecision =
  | {
      tEntryOk: false;
      anchorEvent: 'none';
      anchorWrite: 'keep';
      reason: 'NO_EVIDENCE' | 'ALREADY_COMMITTED' | 'INVALID_STATE';
    }
  | {
      tEntryOk: true;
      anchorEvent: Exclude<AnchorEventType, 'none'>; // choice/action/reconfirm
      anchorWrite: 'keep' | 'commit';
      reason: 'CHOICE' | 'ACTION' | 'RECONFIRM';
      patch?: {
        itx_step?: 'T3';
        itx_anchor_event_type?: Exclude<AnchorEventType, 'none'>;
        intent_anchor?: Record<string, any>;
      };
    };

function s(x: unknown): string {
  return String(x ?? '').trim();
}

function obj(x: unknown): Record<string, any> | null {
  if (!x || typeof x !== 'object') return null;
  return x as any;
}

export function detectAnchorEntry(input: AnchorEntryInput): AnchorEntryDecision {
  const nowIso = s(input.nowIso) || new Date().toISOString();
  const choiceId = s(input.choiceId);
  const actionId = s(input.actionId);

  const prev = obj(input.state?.intent_anchor) ?? {};
  const isFixed = Boolean((prev as any)?.fixed === true);

  // ✅ 確定済み（fixed）のときは開かない
  // ※ 既存 union に合わせて reason は ALREADY_COMMITTED を流用
  if (isFixed) {
    return {
      tEntryOk: false,
      anchorEvent: 'none',
      anchorWrite: 'keep',
      reason: 'ALREADY_COMMITTED',
    };
  }

  // 証拠が何もないなら絶対に開かない
  if (!choiceId && !actionId) {
    return {
      tEntryOk: false,
      anchorEvent: 'none',
      anchorWrite: 'keep',
      reason: 'NO_EVIDENCE',
    };
  }

  // ✅ intent_anchor を “ログ” として育てる（ここでは確定しない）
  const base = {
    ...prev,
    lastTouchedAt: nowIso,
  };

  // 優先順位：action > choice（ただし commit はしない）
  if (actionId) {
    return {
      tEntryOk: true,
      anchorEvent: 'action',
      anchorWrite: 'keep',
      reason: 'ACTION',
      patch: {
        itx_step: 'T3',
        itx_anchor_event_type: 'action',
        intent_anchor: {
          ...base,
          lastTouchType: 'action',
          lastActionId: actionId,
        },
      },
    };
  }

  const prevChoice = s((prev as any)?.choiceId || (prev as any)?.lastChoiceId);
  const isReconfirm = prevChoice && prevChoice === choiceId;

  if (isReconfirm) {
    return {
      tEntryOk: true,
      anchorEvent: 'reconfirm',
      anchorWrite: 'keep',
      reason: 'RECONFIRM',
      patch: {
        itx_step: 'T3',
        itx_anchor_event_type: 'reconfirm',
        intent_anchor: {
          ...base,
          lastTouchType: 'reconfirm',
          lastChoiceId: choiceId,
        },
      },
    };
  }

  return {
    tEntryOk: true,
    anchorEvent: 'choice',
    anchorWrite: 'keep',
    reason: 'CHOICE',
    patch: {
      itx_step: 'T3',
      itx_anchor_event_type: 'choice',
      intent_anchor: {
        ...base,
        lastTouchType: 'choice',
        lastChoiceId: choiceId,
      },
    },
  };
}
