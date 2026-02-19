// src/lib/iros/language/slotBuilder.ts
// iros — RenderEngine v2: Slot Planner (Plan + anti-repeat)
// - 本文は作らない（slotを「選ぶ」だけ）
// - userTextは禁止（入力に含めない）
// - anti-repeat のため signature を生成し、衝突したら plan を変える

import type { FrameKind } from './frameSelector';

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export type Phase = 'Inner' | 'Outer';

export type DepthStage =
  | 'S1'
  | 'S2'
  | 'S3'
  | 'R1'
  | 'R2'
  | 'R3'
  | 'C1'
  | 'C2'
  | 'C3'
  | 'F1'
  | 'F2'
  | 'F3'
  | 'I1'
  | 'I2'
  | 'I3'
  | 'T1'
  | 'T2'
  | 'T3'
  | string; // 既存と揺れても落ちない

export type GoalKind =
  | 'uncover'
  | 'stabilize'
  | 'shiftRelation'
  | 'commit'
  | 'decideOne'
  | 'repair'
  | 'cooldown'
  | string;

export type SlotKey = 'OBS' | 'SHIFT' | 'NEXT' | 'SAFE' | 'INSIGHT';

export type RenderFactsV2 = {
  // ✅要約のみ（原文は禁止）
  situation?: string | null;
  riskHint?: string | null; // ブレーキ理由など（ある時だけ SAFE を許可）
};

export type HistoryDigestV2 = {
  recentSignatures: string[]; // last N
};

export type SlotPlanV2 = {
  frame: FrameKind;
  goalKind: GoalKind;
  depthStage: DepthStage;
  qCode: QCode;
  phase: Phase;

  slotsUsed: SlotKey[]; // 使うslotの順序（本文は別層）
  lexKey: string; // topic tag（安定辞書ベース）
  signature: string; // anti-repeatキー
};

/* -------------------------
 * helpers
 * ------------------------- */

function norm(s: unknown): string {
  return String(s ?? '').trim();
}

function depthHead(depthStage: string): string {
  const d = norm(depthStage).toUpperCase();
  if (!d) return '';
  return d[0]; // 'S','R','C','F','I','T'...
}

function isIorT(depthStage: string): boolean {
  const h = depthHead(depthStage);
  return h === 'I' || h === 'T';
}

function hasText(s?: string | null): boolean {
  return norm(s).length > 0;
}

/**
 * lexKey: 小さな安定辞書（LLMに任せない）
 * - ここを増やすほど anti-repeat が効きやすくなる
 */
function buildLexKey(facts: RenderFactsV2): string {
  const s = norm(facts?.situation).toLowerCase();
  if (!s) return 'general';

  if (s.includes('連絡') || s.includes('返信')) return 'contact';
  if (s.includes('迷い') || s.includes('決め') || s.includes('選べ'))
    return 'decision';
  if (s.includes('不安') || s.includes('怖') || s.includes('恐'))
    return 'anxiety';
  if (s.includes('怒') || s.includes('苛') || s.includes('イラ'))
    return 'anger';
  if (s.includes('疲') || s.includes('眠') || s.includes('限界'))
    return 'fatigue';

  return 'general';
}

function makeSignature(args: {
  frame: FrameKind;
  goalKind: GoalKind;
  depthStage: DepthStage;
  qCode: QCode;
  phase: Phase;
  slotsUsed: SlotKey[];
  lexKey: string;
}): string {
  const { frame, goalKind, depthStage, qCode, phase, slotsUsed, lexKey } = args;
  return [
    frame,
    String(goalKind ?? ''),
    String(depthStage ?? ''),
    String(qCode ?? ''),
    String(phase ?? ''),
    slotsUsed.join('+'),
    lexKey,
  ].join('|');
}

function isRepeat(sig: string, recent: string[]): boolean {
  return Array.isArray(recent) ? recent.includes(sig) : false;
}

/* -------------------------
 * plan rules
 * ------------------------- */
function basePlan(args: {
  frame: FrameKind;
  goalKind: GoalKind;
  depthStage: DepthStage;
  facts: RenderFactsV2;
}): SlotKey[] {
  const { frame, goalKind, depthStage, facts } = args;

  const plan: SlotKey[] = [];

  // OBS は situation がある時だけ
  if (hasText(facts?.situation)) plan.push('OBS');

  // SHIFT は基本入れる（視点を1段動かす）
  plan.push('SHIFT');

  // INSIGHT は I/T で入れる（ただし anti-repeat で抜くことがある）
  if (isIorT(String(depthStage))) plan.push('INSIGHT');

  // ✅ SAFE は常駐（静かな保険）
  // - ログ上 riskHint が null のケースが多く、SAFE が欠けて slotPlan=3 になっていたため
  // - slotPlan=4（OBS/SHIFT/NEXT/SAFE）を安定させる目的で常駐化する
  plan.push('SAFE');

  // NEXT は cooldown 以外は基本入れる（最小の一手）
  if (String(goalKind) !== 'cooldown') plan.push('NEXT');

  // T は短く（OBSを落としても良い）
  if (frame === 'T') {
    return plan.filter((s) => s !== 'OBS');
  }

  // MICRO / NONE は lean
  if (frame === 'MICRO' || frame === 'NONE') {
    return plan.filter((s) => s !== 'INSIGHT' && s !== 'SAFE').slice(0, 2);
  }

  // dedupe (order kept)
  return plan.filter((s, i) => plan.indexOf(s) === i);
}


/**
 * anti-repeat:
 * - signature が recent に衝突したら plan を変える
 * - 変え方：slot構成→lexKey の順
 */
function resolveAntiRepeat(args: {
  frame: FrameKind;
  goalKind: GoalKind;
  depthStage: DepthStage;
  qCode: QCode;
  phase: Phase;
  facts: RenderFactsV2;
  history: HistoryDigestV2;
  slotsUsed: SlotKey[];
  lexKey: string;
}): { slotsUsed: SlotKey[]; lexKey: string; signature: string } {
  const { frame, goalKind, depthStage, qCode, phase, history } = args;
  let slotsUsed = [...args.slotsUsed];
  let lexKey = args.lexKey;

  let signature = makeSignature({
    frame,
    goalKind,
    depthStage,
    qCode,
    phase,
    slotsUsed,
    lexKey,
  });

  if (!isRepeat(signature, history.recentSignatures)) {
    return { slotsUsed, lexKey, signature };
  }

  // 1) slot構成を変える（まず INSIGHT を抜く／OBSを抜く等）
  if (slotsUsed.includes('INSIGHT')) {
    slotsUsed = slotsUsed.filter((s) => s !== 'INSIGHT');
    signature = makeSignature({
      frame,
      goalKind,
      depthStage,
      qCode,
      phase,
      slotsUsed,
      lexKey,
    });
    if (!isRepeat(signature, history.recentSignatures)) {
      return { slotsUsed, lexKey, signature };
    }
  }

  if (slotsUsed.includes('OBS')) {
    slotsUsed = slotsUsed.filter((s) => s !== 'OBS');
    signature = makeSignature({
      frame,
      goalKind,
      depthStage,
      qCode,
      phase,
      slotsUsed,
      lexKey,
    });
    if (!isRepeat(signature, history.recentSignatures)) {
      return { slotsUsed, lexKey, signature };
    }
  }

  // 2) slot順序を変える（SHIFTとNEXT入替など）
  const hasShift = slotsUsed.includes('SHIFT');
  const hasNext = slotsUsed.includes('NEXT');
  if (hasShift && hasNext) {
    slotsUsed = slotsUsed.map((s) =>
      s === 'SHIFT' ? 'NEXT' : s === 'NEXT' ? 'SHIFT' : s,
    );
    signature = makeSignature({
      frame,
      goalKind,
      depthStage,
      qCode,
      phase,
      slotsUsed,
      lexKey,
    });
    if (!isRepeat(signature, history.recentSignatures)) {
      return { slotsUsed, lexKey, signature };
    }
  }

  // 3) lexKey を general に落とす
  if (lexKey !== 'general') lexKey = 'general';
  else lexKey = 'general2';

  signature = makeSignature({
    frame,
    goalKind,
    depthStage,
    qCode,
    phase,
    slotsUsed,
    lexKey,
  });
  return { slotsUsed, lexKey, signature };
}

/* -------------------------
 * Public API
 * ------------------------- */

/**
 * v2: slot計画（本文は作らない）
 * - userText は受け取らない（混入事故を構造的に防ぐ）
 */
export function buildSlotPlanV2(args: {
  frame: FrameKind;
  goalKind: GoalKind;
  depthStage: DepthStage;
  qCode: QCode;
  phase: Phase;
  facts: RenderFactsV2;
  history: HistoryDigestV2;
}): SlotPlanV2 {
  const { frame, goalKind, depthStage, qCode, phase, facts, history } = args;

  const lexKey0 = buildLexKey(facts);
  const slots0 = basePlan({ frame, goalKind, depthStage, facts });

  const resolved = resolveAntiRepeat({
    frame,
    goalKind,
    depthStage,
    qCode,
    phase,
    facts,
    history,
    slotsUsed: slots0,
    lexKey: lexKey0,
  });

  return {
    frame,
    goalKind,
    depthStage,
    qCode,
    phase,
    slotsUsed: resolved.slotsUsed,
    lexKey: resolved.lexKey,
    signature: resolved.signature,
  };
}
