// file: src/lib/iros/language/resonanceVector.ts

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export type Phase = 'Inner' | 'Outer';

export type IntentLayer = 'S' | 'R' | 'C' | 'I' | 'T';

export type ResonanceVector = {
  qCode: QCode | null;
  depthStage: string | null; // S1..I3 / T1..T3 などを想定（文字列で保持）
  phase: Phase | null;

  // 0.0 - 1.0
  selfAcceptance: number | null;

  // S/R/C/I/T
  intentLayer: IntentLayer | null;

  // 0.0 - 1.0（あれば）
  intentConfidence: number | null;

  // -1.0 .. +1.0 を想定（設計に合わせて自由に）
  polarityScore: number | null;
  polarityBand: string | null;

  stabilityBand: string | null;

  // 任意の補助（UI/ログ/プロンプトに使える）
  yLevel: number | null;
  hLevel: number | null;

  situationSummary: string | null;
  situationTopic: string | null;

  /**
   * ---- 互換フィールド（renderReply.ts が参照している旧名）----
   * ※ renderReply.ts が null 許容していないので、ここは「必ず number」で返す
   */
  depthLevel: number;      // 0..2
  grounding: number;       // 0..1
  transcendence: number;   // 0..1
  precision: number;       // 0..1

  // LLM 用の短いラベル
  label: string;
};

export type ResonanceVectorInput = {
  // meta / unified のどっちからでも来る想定
  qCode?: unknown;
  q_code?: unknown;

  depth?: unknown;
  depth_stage?: unknown;

  phase?: unknown;

  selfAcceptance?: unknown;
  self_acceptance?: unknown;

  intentLayer?: unknown;
  intent_layer?: unknown;

  intentConfidence?: unknown;
  intent_confidence?: unknown;

  polarityScore?: unknown;
  polarity_score?: unknown;

  polarityBand?: unknown;
  polarity_band?: unknown;

  stabilityBand?: unknown;
  stability_band?: unknown;

  yLevel?: unknown;
  y_level?: unknown;

  hLevel?: unknown;
  h_level?: unknown;

  situationSummary?: unknown;
  situationTopic?: unknown;

  // 互換入力（どこかで入ってたら拾う）
  depthLevel?: unknown;
  grounding?: unknown;
  transcendence?: unknown;
  precision?: unknown;

  // unified をそのまま渡しても拾えるように
  unified?: any;
};

function toStr(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  return null;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function clamp01(n: number | null): number | null {
  if (n == null) return null;
  if (Number.isNaN(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  const x = Math.round(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

export function normalizeQCode(v: unknown): QCode | null {
  const s = toStr(v);
  if (!s) return null;
  const u = s.toUpperCase();
  if (u === 'Q1' || u === 'Q2' || u === 'Q3' || u === 'Q4' || u === 'Q5') {
    return u as QCode;
  }
  return null;
}

export function normalizePhase(v: unknown): Phase | null {
  const s = toStr(v);
  if (!s) return null;
  const u = s.toLowerCase();
  if (u === 'inner') return 'Inner';
  if (u === 'outer') return 'Outer';
  return null;
}

export function normalizeIntentLayer(v: unknown): IntentLayer | null {
  const s = toStr(v);
  if (!s) return null;
  const u = s.toUpperCase();
  if (u === 'S' || u === 'R' || u === 'C' || u === 'I' || u === 'T') {
    return u as IntentLayer;
  }
  return null;
}

export function normalizeDepthStage(v: unknown): string | null {
  const s = toStr(v);
  return s ? s : null;
}

function pickUnified(input: ResonanceVectorInput): any {
  return input && typeof input === 'object' ? (input as any).unified ?? null : null;
}

function buildLabel(rv: Omit<ResonanceVector, 'label'>): string {
  const parts: string[] = [];

  if (rv.qCode) parts.push(rv.qCode);
  if (rv.depthStage) parts.push(rv.depthStage);
  if (rv.phase) parts.push(rv.phase);

  if (rv.intentLayer) parts.push(`L:${rv.intentLayer}`);
  if (rv.selfAcceptance != null) parts.push(`SA:${rv.selfAcceptance.toFixed(2)}`);

  if (rv.polarityBand) parts.push(`Pol:${rv.polarityBand}`);
  if (rv.stabilityBand) parts.push(`Stb:${rv.stabilityBand}`);

  // 互換フィールドも軽く見える化（デバッグ用）
  parts.push(`DL:${rv.depthLevel}`);
  parts.push(`G:${rv.grounding.toFixed(2)}`);
  parts.push(`T:${rv.transcendence.toFixed(2)}`);
  parts.push(`P:${rv.precision.toFixed(2)}`);

  const label = parts.join(' / ');
  return label.length > 0 ? label : 'RV';
}

/**
 * depthStage (S/R/C/I/T) から粗い depthLevel(0..2) を推定
 * - 0: Seed/日常（S帯）
 * - 1: 中間（R/C帯）
 * - 2: 深い/超越（I/T帯）
 */
function inferDepthLevel(depthStage: string | null): number | null {
  if (!depthStage) return null;
  const s = depthStage.trim().toUpperCase();
  if (s.startsWith('T')) return 2;
  if (s.startsWith('I')) return 2;
  if (s.startsWith('C')) return 1;
  if (s.startsWith('R')) return 1;
  if (s.startsWith('S')) return 0;
  return null;
}

/**
 * stabilityBand / selfAcceptance から grounding(0..1) を推定
 */
function inferGrounding(params: {
  selfAcceptance: number | null;
  stabilityBand: string | null;
}): number | null {
  const { selfAcceptance, stabilityBand } = params;
  if (selfAcceptance != null) return clamp01(selfAcceptance);

  const sb = (stabilityBand ?? '').trim().toLowerCase();
  if (!sb) return null;

  if (/(high|stable|strong|a|good)/.test(sb)) return 0.7;
  if (/(mid|medium|b|ok)/.test(sb)) return 0.5;
  if (/(low|unstable|weak|c|bad)/.test(sb)) return 0.3;

  return null;
}

/**
 * depthLevel から transcendence(0..1) を推定
 */
function inferTranscendence(depthLevel: number): number {
  if (depthLevel >= 2) return 0.8;
  if (depthLevel === 1) return 0.4;
  return 0.2;
}

/**
 * intentConfidence があれば precision に寄せる（なければ中間）
 */
function inferPrecision(intentConfidence: number | null): number {
  const c = clamp01(intentConfidence);
  return c != null ? c : 0.5;
}

/**
 * meta / unified の混在入力から、1つの ResonanceVector を組み立てる
 */
export function buildResonanceVector(input: ResonanceVectorInput): ResonanceVector {
  const unified = pickUnified(input);

  // ==============================
  // ★ デバッグ：selfAcceptance 流入確認（原因確定用）
  // ==============================
  try {
    console.log('[RV][debug] selfAcceptance candidates', {
      input_selfAcceptance: (input as any)?.selfAcceptance,
      input_self_acceptance: (input as any)?.self_acceptance,
      unified_self_acceptance: unified?.self_acceptance,
      unified_all: unified,
    });
  } catch {}

  const qCode =
    normalizeQCode(input.qCode) ??
    normalizeQCode(input.q_code) ??
    normalizeQCode(unified?.q?.current) ??
    normalizeQCode(unified?.q_code) ??
    null;

  const depthStage =
    normalizeDepthStage(input.depth) ??
    normalizeDepthStage(input.depth_stage) ??
    normalizeDepthStage(unified?.depth?.stage) ??
    normalizeDepthStage(unified?.depth_stage) ??
    null;

  const phase =
    normalizePhase(input.phase) ??
    normalizePhase(unified?.phase) ??
    null;

  const selfAcceptance =
    clamp01(toNum(input.selfAcceptance)) ??
    clamp01(toNum(input.self_acceptance)) ??
    clamp01(toNum(unified?.self_acceptance)) ??
    null;

  const intentLayer =
    normalizeIntentLayer(input.intentLayer) ??
    normalizeIntentLayer(input.intent_layer) ??
    normalizeIntentLayer(input?.unified?.intentLine?.focusLayer) ??
    normalizeIntentLayer(input?.unified?.intent_line?.focusLayer) ??
    normalizeIntentLayer((input as any)?.intentLine?.focusLayer) ??
    normalizeIntentLayer((input as any)?.intent_line?.focusLayer) ??
    null;

  const intentConfidence =
    clamp01(toNum(input.intentConfidence)) ??
    clamp01(toNum(input.intent_confidence)) ??
    clamp01(toNum((input as any)?.intentLine?.confidence)) ??
    clamp01(toNum((input as any)?.intent_line?.confidence)) ??
    clamp01(toNum(unified?.intentLine?.confidence)) ??
    clamp01(toNum(unified?.intent_line?.confidence)) ??
    null;

  const polarityScore =
    toNum(input.polarityScore) ??
    toNum(input.polarity_score) ??
    toNum(unified?.polarityScore) ??
    toNum(unified?.polarity_score) ??
    null;

  const polarityBand =
    toStr(input.polarityBand) ??
    toStr(input.polarity_band) ??
    toStr(unified?.polarityBand) ??
    toStr(unified?.polarity_band) ??
    null;

  const stabilityBand =
    toStr(input.stabilityBand) ??
    toStr(input.stability_band) ??
    toStr(unified?.stabilityBand) ??
    toStr(unified?.stability_band) ??
    null;

  const yLevel =
    toNum(input.yLevel) ??
    toNum(input.y_level) ??
    toNum(unified?.yLevel) ??
    toNum(unified?.y_level) ??
    null;

  const hLevel =
    toNum(input.hLevel) ??
    toNum(input.h_level) ??
    toNum(unified?.hLevel) ??
    toNum(unified?.h_level) ??
    null;

  const situationSummary =
    toStr(input.situationSummary) ??
    toStr(unified?.situation?.summary) ??
    null;

  const situationTopic =
    toStr(input.situationTopic) ??
    toStr(unified?.situation?.topic) ??
    null;

  // ==============================
  // 互換フィールド（null 禁止）
  // ==============================
  const depthLevel =
    clampInt(
      toNum(input.depthLevel) ??
        inferDepthLevel(depthStage) ??
        0,
      0,
      2,
    );

  const grounding =
    clamp01(
      toNum(input.grounding) ??
        inferGrounding({ selfAcceptance, stabilityBand }) ??
        0.5,
    ) ?? 0.5;

  const transcendence =
    clamp01(
      toNum(input.transcendence) ??
        inferTranscendence(depthLevel) ??
        0.2,
    ) ?? 0.2;

  const precision =
    clamp01(
      toNum(input.precision) ??
        inferPrecision(intentConfidence) ??
        0.5,
    ) ?? 0.5;

  const rv: ResonanceVector = {
    qCode,
    depthStage,
    phase,
    selfAcceptance,
    intentLayer,
    intentConfidence,
    polarityScore,
    polarityBand,
    stabilityBand,
    yLevel,
    hLevel,
    situationSummary,
    situationTopic,
    depthLevel,
    grounding,
    transcendence,
    precision,
    label: '',
  };

  rv.label = buildLabel(rv);

  return rv;
}


/**
 * LLM に渡す用の短いブロック（ログ/プロンプト用）
 */
export function formatResonanceVectorForPrompt(rv: ResonanceVector): string {
  const lines: string[] = [];

  lines.push(`RV: ${rv.label}`);

  if (rv.situationTopic) lines.push(`topic: ${rv.situationTopic}`);
  if (rv.situationSummary) lines.push(`summary: ${rv.situationSummary}`);

  return lines.join('\n');
}

/**
 * メタ（metaForSave など）から直接、RV テキストを作る便利関数
 */
export function buildResonanceVectorText(metaLike: ResonanceVectorInput): string {
  const rv = buildResonanceVector(metaLike);
  return formatResonanceVectorForPrompt(rv);
}

/**
 * 互換 export（どこかで違う名前で呼ばれても死なないため）
 */
export const computeResonanceVector = buildResonanceVector;
export const toResonanceVector = buildResonanceVector;
export const formatResonanceVector = formatResonanceVectorForPrompt;
