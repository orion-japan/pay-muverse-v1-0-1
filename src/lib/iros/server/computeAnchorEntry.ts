// file: src/lib/iros/server/computeAnchorEntry.ts
// iros — Anchor Entry (evidence -> decision)
// 目的：
// - choiceId / actionId などの「証拠」を1箇所で正規化
// - anchorEvent / anchorWrite / tEntryOk を一意に決める
// - persist / unified / orchestrator が参照できる“唯一の真実”を返す

export type AnchorEvidenceSource = 'choice' | 'action' | 'both' | 'none';

export type AnchorEvidence = {
  choiceId: string | null;
  actionId: string | null;
  source: AnchorEvidenceSource;
};

export type AnchorDecisionReason = 'NO_EVIDENCE' | 'HAS_EVIDENCE';

export type AnchorEvent = 'none' | 'confirm' | 'set' | 'reset' | 'action';
export type AnchorWrite = 'keep' | 'set' | 'reset' | 'commit';

export type AnchorDecision = {
  tEntryOk: boolean;
  anchorEvent: AnchorEvent;
  anchorWrite: AnchorWrite;
  reason: AnchorDecisionReason;
};

export type AnchorEntry = {
  evidence: AnchorEvidence;
  decision: AnchorDecision;
  fixedNorthKey: string | null; // 'SUN' など
  itActive: boolean; // ITが有効（tLayerModeActive等）ならtrue
  hasAnchorAlready: boolean; // MemoryState等で既にintent_anchorがある
};

function normId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length ? s : null;
}

/**
 * meta/extra/unified から evidence を拾う
 * - 入口は「root（metaForSave全体）」を想定
 * - actionId/choiceId は複数の別名を許容
 */
function pickEvidence(root: any): AnchorEvidence {
  const core = root?.meta ?? root?.finalMeta ?? root ?? {};
  const extra = root?.extra ?? core?.extra ?? {};
  const unified = core?.unified ?? {};

  // choiceId 系
  const choiceId =
    normId(root?.choiceId) ??
    normId(root?.extractedChoiceId) ??
    normId(extra?.choiceId) ??
    normId(extra?.extractedChoiceId) ??
    normId(core?.choiceId) ??
    normId(core?.extractedChoiceId) ??
    normId(unified?.choiceId) ??
    null;

  // actionId 系（将来UI/イベントで入れてくる想定）
  const actionId =
    normId(root?.actionId) ??
    normId(extra?.actionId) ??
    normId(core?.actionId) ??
    normId(unified?.actionId) ??
    null;

  const source: AnchorEvidenceSource =
    choiceId && actionId ? 'both' : choiceId ? 'choice' : actionId ? 'action' : 'none';

  return { choiceId, actionId, source };
}

function pickFixedNorthKey(root: any): string | null {
  const core = root?.meta ?? root?.finalMeta ?? root ?? {};
  const unified = core?.unified ?? {};
  const key =
    normId(core?.fixedNorthKey) ??
    normId(core?.fixedNorth?.key) ??
    normId(unified?.fixedNorthKey) ??
    normId(unified?.fixedNorth?.key) ??
    normId(core?.intent_anchor?.key) ??
    normId(core?.intentAnchor?.key) ??
    null;
  return key;
}

function pickItActive(root: any): boolean {
  const core = root?.meta ?? root?.finalMeta ?? root ?? {};
  const extra = root?.extra ?? core?.extra ?? {};

  // ✅ itActive は “派生値” が混ざりやすいので参照しない
  // - この関数が返す itActive は「このターンでTレイヤーが有効か」の一次情報だけに限定する
  // - 一次情報：tLayerModeActive / itTrigger.tLayerModeActive / itTrigger.ok
  const coreIt = core?.itTrigger ?? null;
  const extraIt = extra?.itTrigger ?? null;

  return (
    core?.tLayerModeActive === true ||
    extra?.tLayerModeActive === true ||
    (coreIt?.tLayerModeActive === true) ||
    (extraIt?.tLayerModeActive === true) ||
    (coreIt?.ok === true) ||
    (extraIt?.ok === true)
  );
}


function pickHasAnchorAlready(root: any): boolean {
  const core = root?.meta ?? root?.finalMeta ?? root ?? {};
  const m =
    core?.hasIntentAnchor === true ||
    core?.has_intent_anchor_key === true ||
    core?.has_intentAnchorKey === true ||
    core?.has_intent_anchor_obj === true ||
    core?.has_intentAnchor_obj === true;
  return Boolean(m);
}

/**
 * decision ルール（Phase11の前進版：細かいバグは後回し）
 * - evidence が無ければ：tEntryOk=false / none+keep
 * - actionId があれば：tEntryOk=true / action+commit
 * - choiceId だけあれば：tEntryOk=true / confirm+keep（※commitはしない）
 */
function decideFromEvidence(e: AnchorEvidence): AnchorDecision {
  if (e.source === 'none') {
    return { tEntryOk: false, anchorEvent: 'none', anchorWrite: 'keep', reason: 'NO_EVIDENCE' };
  }

  if (e.actionId) {
    return { tEntryOk: true, anchorEvent: 'action', anchorWrite: 'commit', reason: 'HAS_EVIDENCE' };
  }

  // choice のみ（UI上の選択は“確認”扱い。commitは action に寄せる）
  return { tEntryOk: true, anchorEvent: 'confirm', anchorWrite: 'keep', reason: 'HAS_EVIDENCE' };
}

/**
 * 公開API：AnchorEntry を計算する
 * - persist/unified/orchestrator のどこからでも呼んでよい
 * - ログ表示は呼び出し側で行う（ここは純関数寄り）
 */
export function computeAnchorEntry(metaForSave: any): AnchorEntry {
  const root = metaForSave ?? {};
  const evidence = pickEvidence(root);
  const decision = decideFromEvidence(evidence);
  const fixedNorthKey = pickFixedNorthKey(root);
  const itActive = pickItActive(root);
  const hasAnchorAlready = pickHasAnchorAlready(root);

  return { evidence, decision, fixedNorthKey, itActive, hasAnchorAlready };
}
