// file: src/lib/iros/server/handleIrosReply.meta.ts
// iros - Meta canonicalizer (camel/snake normalization + robust getters)

export type CanonicalPhase = 'Inner' | 'Outer';
export type CanonicalQCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export type CanonicalDepth =
  | 'S1' | 'S2' | 'S3'
  | 'R1' | 'R2' | 'R3'
  | 'C1' | 'C2' | 'C3'
  | 'I1' | 'I2' | 'I3'
  | 'T1' | 'T2' | 'T3';

export type CanonicalMeta = {
  // 3軸（canonical）
  qCode: CanonicalQCode | null;
  depth: CanonicalDepth | null;
  phase: CanonicalPhase | null;

  // 数値（canonical）
  selfAcceptance: number | null; // 0..1
  yLevel: number | null;         // int 0..3 (or null)
  hLevel: number | null;         // int 0..3 (or null)

  // 文字（canonical）
  situationSummary: string | null;
  situationTopic: string | null;

  // intent anchor（canonical）
  intent_anchor?: {
    text?: string;
    strength?: number | null;
    y_level?: number | null;
    h_level?: number | null;
  } | null;

  // unified は保持（ただし canonical 側を正として扱う）
  unified?: any;

  // 既存metaは破壊しない方針のため raw も持てる（任意）
  _raw?: any;
};

// ------------------------
// helpers
// ------------------------

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clampInt = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(v)));

const isObj = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const toNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const toStr = (v: unknown): string | null => {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length ? t : null;
  }
  return null;
};

const coerceQCode = (v: unknown): CanonicalQCode | null => {
  const s = toStr(v);
  if (!s) return null;
  const u = s.toUpperCase();
  return (u === 'Q1' || u === 'Q2' || u === 'Q3' || u === 'Q4' || u === 'Q5')
    ? (u as CanonicalQCode)
    : null;
};

const coerceDepth = (v: unknown): CanonicalDepth | null => {
  const s = toStr(v);
  if (!s) return null;
  const u = s.replace(/\s+/g, '').toUpperCase();
  return /^(S[1-3]|R[1-3]|C[1-3]|I[1-3]|T[1-3])$/.test(u)
    ? (u as CanonicalDepth)
    : null;
};

const coercePhase = (v: unknown): CanonicalPhase | null => {
  const s = toStr(v);
  if (!s) return null;
  const u = s.toLowerCase();
  if (u === 'inner') return 'Inner';
  if (u === 'outer') return 'Outer';
  return null;
};

const normalizeTextForSummary = (s: string | null, maxLen = 200): string | null => {
  if (!s) return null;

  let t = String(s).replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // “同じ文2回貼り”の圧縮
  const half = Math.floor(t.length / 2);
  if (half >= 8) {
    const a = t.slice(0, half).trim();
    const b = t.slice(half).trim();
    if (a && b && a === b) t = a;
  }

  return t.length > maxLen ? t.slice(0, maxLen) + '…' : t;
};

// ------------------------
// canonicalize
// ------------------------

/**
 * meta/unified の “候補フィールド乱立” をここで吸収して
 * 以降は canonical（qCode/depth/phase/selfAcceptance/yLevel/hLevel...）だけ読むための関数。
 *
 * - camel/snake を統一
 * - unified を最優先にしつつ、トップレベルも拾う
 * - 値の型崩れ（string number）を許容し、最低限の clamp を入れる
 * - 返り値は「読み取り用 canonical」で、元 meta を破壊しない
 */
export function canonicalizeIrosMeta(args: {
  metaForSave: any;
  userText?: string | null;
}): CanonicalMeta {
  const raw = args?.metaForSave ?? {};
  const m = isObj(raw) ? raw : {};
  const unified = isObj(m.unified) ? m.unified : {};

  // ---- 3軸候補の集約 ----
  const qCandidate =
    m.qCode ?? m.q_code ?? unified?.q?.current ?? unified?.q_code ?? null;

  const depthCandidate =
    m.depth ?? m.depth_stage ?? unified?.depth?.stage ?? unified?.depth_stage ?? null;

  const phaseCandidate =
    m.phase ?? unified?.phase ?? unified?.phase_label ?? null;

  const qCode = coerceQCode(qCandidate);
  const depth = coerceDepth(depthCandidate);
  const phase = coercePhase(phaseCandidate);

  // ---- selfAcceptance ----
  const saCandidate =
    m.selfAcceptance ??
    m.self_acceptance ??
    unified?.self_acceptance ??
    unified?.selfAcceptance ??
    null;

  const saNum = toNum(saCandidate);
  const selfAcceptance = saNum == null ? null : clamp01(saNum);

  // ---- y/h ----
  const yCandidate =
    m.yLevel ?? m.y_level ?? unified?.yLevel ?? unified?.y_level ?? null;
  const hCandidate =
    m.hLevel ?? m.h_level ?? unified?.hLevel ?? unified?.h_level ?? null;

  const yNum = toNum(yCandidate);
  const hNum = toNum(hCandidate);

  const yLevel = yNum == null ? null : clampInt(yNum, 0, 3);
  const hLevel = hNum == null ? null : clampInt(hNum, 0, 3);

  // ---- situation summary/topic ----
  const summaryCandidate =
    toStr(m.situationSummary) ??
    toStr(m.situation_summary) ??
    toStr(unified?.situation?.summary) ??
    null;

  const userText = toStr(args?.userText ?? null);
  const situationSummary =
    normalizeTextForSummary(summaryCandidate, 200) ??
    (userText ? normalizeTextForSummary(userText, 200) : null);

  const topicCandidate =
    toStr(m.situationTopic) ??
    toStr(m.situation_topic) ??
    toStr(m.topic_label) ??
    toStr(m.topic) ??
    toStr(unified?.situation?.topic) ??
    toStr(unified?.topic) ??
    null;

  const situationTopic = topicCandidate ? topicCandidate.trim() : null;

  // ---- intent_anchor canonical ----
  const iaRaw =
    (isObj(m.intent_anchor) ? m.intent_anchor : null) ??
    (isObj(unified?.intent_anchor) ? unified.intent_anchor : null) ??
    (isObj(m.intentAnchor) ? m.intentAnchor : null) ??
    null;

  const intent_anchor = iaRaw
    ? {
        text: toStr((iaRaw as any).text ?? (iaRaw as any).anchor_text ?? null) ?? undefined,
        strength: toNum((iaRaw as any).strength ?? (iaRaw as any).intent_strength ?? null),
        y_level: (() => {
          const n = toNum((iaRaw as any).y_level ?? (iaRaw as any).yLevel ?? null);
          return n == null ? null : clampInt(n, 0, 3);
        })(),
        h_level: (() => {
          const n = toNum((iaRaw as any).h_level ?? (iaRaw as any).hLevel ?? null);
          return n == null ? null : clampInt(n, 0, 3);
        })(),
      }
    : null;

  return {
    qCode,
    depth,
    phase,
    selfAcceptance,
    yLevel,
    hLevel,
    situationSummary,
    situationTopic,
    intent_anchor,
    unified,
    _raw: raw,
  };
}

/**
 * canonical を metaForSave に “上書き反映” したい場合に使う。
 * 以降の処理が metaForSave を参照する構造でも、見通しをよくするための補助。
 *
 * 注意: 既存の metaForSave を破壊しうるので、呼び出し側で判断すること。
 */
export function applyCanonicalToMetaForSave(metaForSave: any, canonical: CanonicalMeta): any {
  const m = isObj(metaForSave) ? metaForSave : {};

  // 3軸
  m.qCode = canonical.qCode;
  m.q_code = canonical.qCode;

  m.depth = canonical.depth;
  m.depth_stage = canonical.depth;

  m.phase = canonical.phase;

  // 数値
  m.selfAcceptance = canonical.selfAcceptance;
  m.self_acceptance = canonical.selfAcceptance;

  m.yLevel = canonical.yLevel;
  m.y_level = canonical.yLevel;

  m.hLevel = canonical.hLevel;
  m.h_level = canonical.hLevel;

  // situation
  m.situationSummary = canonical.situationSummary;
  m.situation_summary = canonical.situationSummary;

  m.situationTopic = canonical.situationTopic;
  m.situation_topic = canonical.situationTopic;

  // intent anchor
  if (canonical.intent_anchor) {
    m.intent_anchor = {
      ...(isObj(m.intent_anchor) ? m.intent_anchor : {}),
      ...canonical.intent_anchor,
    };
  }

  return m;
}
