// src/lib/iros/anchor/AnchorEntryDetector.ts
// iros — Anchor Entry Detector (T-entry)
// 目的：
// - 「言葉」ではなく「行動・選択・反復」の証拠が来た時だけ T3 を許可する
// - Orchestrator の深度判断(Q/Depth/phase)とは分離する（責務分離）
// - DBカラム追加なしで、itx_step / itx_anchor_event_type / intent_anchor(jsonb) に証拠を刻む

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
    // 参考：SUN固定などは呼び出し側で担保してもよいが、ここでも見られるように拡張可能
  };
};

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
      anchorWrite: 'commit';
      reason: 'CHOICE' | 'ACTION' | 'RECONFIRM';
      patch: {
        itx_step: 'T3';
        itx_anchor_event_type: Exclude<AnchorEventType, 'none'>;
        intent_anchor: Record<string, any>;
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

  const itxStep = s(input.state?.itx_step);
  const alreadyCommitted = itxStep === 'T3';

  if (alreadyCommitted) {
    return {
      tEntryOk: false,
      anchorEvent: 'none',
      anchorWrite: 'keep',
      reason: 'ALREADY_COMMITTED',
    };
  }

  // 証拠が何もないなら絶対に開かない（宣言反復はここに入らない）
  if (!choiceId && !actionId) {
    return {
      tEntryOk: false,
      anchorEvent: 'none',
      anchorWrite: 'keep',
      reason: 'NO_EVIDENCE',
    };
  }

  // intent_anchor を “証拠ログ” として育てる（DBカラム追加なし）
  const prev = obj(input.state?.intent_anchor) ?? {};
  const base = {
    ...prev,
    committedAt: nowIso,
  };

  // 優先順位：action > choice（行動を最優先）
  if (actionId) {
    return {
      tEntryOk: true,
      anchorEvent: 'action',
      anchorWrite: 'commit',
      reason: 'ACTION',
      patch: {
        itx_step: 'T3',
        itx_anchor_event_type: 'action',
        intent_anchor: {
          ...base,
          commitType: 'action',
          actionId,
        },
      },
    };
  }

  // choice の場合：同一choiceの“再確認”も将来ここで扱えるようにしておく
  // （現時点は「choiceが来た」だけでT3許可＝最小実装）
  const prevChoice = s(prev?.choiceId);
  const isReconfirm = prevChoice && prevChoice === choiceId;

  if (isReconfirm) {
    return {
      tEntryOk: true,
      anchorEvent: 'reconfirm',
      anchorWrite: 'commit',
      reason: 'RECONFIRM',
      patch: {
        itx_step: 'T3',
        itx_anchor_event_type: 'reconfirm',
        intent_anchor: {
          ...base,
          commitType: 'reconfirm',
          choiceId,
          prevChoiceId: prevChoice,
        },
      },
    };
  }

  return {
    tEntryOk: true,
    anchorEvent: 'choice',
    anchorWrite: 'commit',
    reason: 'CHOICE',
    patch: {
      itx_step: 'T3',
      itx_anchor_event_type: 'choice',
      intent_anchor: {
        ...base,
        commitType: 'choice',
        choiceId,
      },
    },
  };
}
