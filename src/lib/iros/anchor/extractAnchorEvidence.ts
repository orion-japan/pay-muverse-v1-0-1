// src/lib/iros/anchor/extractAnchorEvidence.ts
// iros — Anchor Evidence Extractor
// 目的：
// - 「T3に入れる証拠(=choice/action/reconfirm)」を、meta/body/extra の揺れから1本化して取り出す
// - 現状の /messages 仕様（meta.extra.nextStepChoiceId）を正本として最優先に扱う
// - 互換：choiceId / extractedChoiceId / nextStepChoiceId / nextStepChoiceId などを吸収

export type AnchorEvidence = {
  choiceId: string | null;
  actionId: string | null;
  source: 'extra.nextStepChoiceId' | 'extra.choiceId' | 'meta.choiceId' | 'body.choiceId' | 'none';
};

function s(x: unknown): string {
  return String(x ?? '').trim();
}

function pickStr(obj: any, key: string): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const v = (obj as any)[key];
  const t = s(v);
  return t.length ? t : null;
}

// meta の入り口はだいたいこの3パターンが混在する：
// - meta (そのもの)
// - meta.extra
// - “metaForSave.extra” みたいに extra がすでにフラットな場合
export function extractAnchorEvidence(args: {
  body?: any;
  meta?: any;
  extra?: any;
}): AnchorEvidence {
  const body = args?.body ?? null;
  const meta = args?.meta ?? null;
  const extra = args?.extra ?? (meta && typeof meta === 'object' ? (meta as any).extra : null);

  // ✅ 正本：/messages が保存している nextStepChoiceId
  const c0 =
    pickStr(extra, 'nextStepChoiceId') ??
    pickStr(extra, 'nextStepChoiceID') ?? // 念のため
    null;
  if (c0) return { choiceId: c0, actionId: null, source: 'extra.nextStepChoiceId' };

  // 互換：extra.choiceId / extra.extractedChoiceId
  const c1 = pickStr(extra, 'choiceId') ?? pickStr(extra, 'extractedChoiceId') ?? null;
  if (c1) return { choiceId: c1, actionId: null, source: 'extra.choiceId' };

  // 互換：meta.choiceId / meta.extractedChoiceId
  const c2 = pickStr(meta, 'choiceId') ?? pickStr(meta, 'extractedChoiceId') ?? null;
  if (c2) return { choiceId: c2, actionId: null, source: 'meta.choiceId' };

  // 互換：body.choiceId / body.extractedChoiceId
  const c3 = pickStr(body, 'choiceId') ?? pickStr(body, 'extractedChoiceId') ?? null;
  if (c3) return { choiceId: c3, actionId: null, source: 'body.choiceId' };

  // actionId は今は未配線だと思うので、将来用の枠だけ残す
  // （ここは wiring する時に body/action の仕様を確定してから使う）
  return { choiceId: null, actionId: null, source: 'none' };
}
