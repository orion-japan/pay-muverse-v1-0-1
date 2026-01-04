// src/lib/iros/rotation/computeITTrigger.ts
// iros — IT Trigger (I→T)
//
// 目的：
// - I層の「一点収束」＋「宣言性」＋「方向性」が揃った時のみ T を開く
// - それ以外は I レイヤーに留める（言語は出すが遷移させない）

export type TLayerHint = 'T1' | 'T2' | 'T3';

export type TVector = {
  core: string;
  turningPoint: string;
  demand: string;
  nextC: string;
};

export type ITTriggerResult = {
  ok: boolean;
  reason: string;
  iLayerForce: boolean;
  tLayerModeActive?: boolean;
  tLayerHint?: TLayerHint;
  tVector?: TVector;
  flags?: {
    hasCore: boolean;
    coreRepeated: boolean;
    sunOk: boolean;
    declarationOk: boolean;
    deepenOk: boolean;
  };
};

type MetaLike = {
  depthStage?: string | null;
  intentLine?: any;
};

function norm(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim();
}

function pickRecentUserTexts(history: any[], max = 8): string[] {
  if (!Array.isArray(history)) return [];
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) continue;
    const role = String(m.role ?? '').toLowerCase();
    if (role !== 'user') continue;
    const t = norm(m.content ?? m.text ?? m.message);
    if (t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/* ============================
   核抽出ロジック
============================ */

function extractCore(meta: MetaLike | null, text: string): string {
  const fromMeta =
    norm((meta as any)?.intentLine?.core) ||
    norm((meta as any)?.intentLine?.keyPhrase) ||
    norm((meta as any)?.intentLine?.intentWord);

  if (fromMeta) return fromMeta;

  const m = text.match(/[「『](.+?)[」』]/);
  if (m?.[1]) return m[1].slice(0, 32);

  const m2 = text.match(/(.{1,18}?)(したい|したくない|やりたい|やめたい|決めた)/);
  if (m2?.[1]) return m2[1];

  return '';
}

/* ============================
   SUN / BLOCK 判定
============================ */

const SUN_WORDS = ['成長', '進化', '希望', '歓喜'];

// 明示的な「太陽 / SUN」宣言も SUN 扱い
const SUN_EXPLICIT_RE =
  /(太陽\s*SUN|SUN\s*固定|SUN\s*に\s*する|北極星\s*(?:に|を)?\s*(?:固定|する)?)/i;

const BLOCK_WORDS = ['怖い', '止まる', 'やめたい', '無理', '逃げたい'];

function hasSun(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;

  // 明示的 SUN 指定
  if (SUN_EXPLICIT_RE.test(t)) return true;

  // 抽象ワードによる判定
  return SUN_WORDS.some(w => t.includes(w));
}

function hasBlock(text: string): boolean {
  return BLOCK_WORDS.some(w => text.includes(w));
}

/* ============================
   宣言検出
============================ */

const DECLARE_RE = /(決めた|やる|続ける|進む|選ぶ)/;

function hasDeclaration(text: string): boolean {
  return DECLARE_RE.test(text);
}

function hasAffirm(text: string): boolean {
  return /(はい|うん|そう|分かった|了解)/.test(text);
}


/* ============================================================
   メイン：ITトリガー
============================================================ */

export function computeITTrigger(args: {
  text: string;
  history?: any[];
  meta?: MetaLike | null;
}): ITTriggerResult {

  const text = norm(args.text);
  const history = Array.isArray(args.history) ? args.history : [];
  const meta = args.meta ?? null;

  const historyTexts = pickRecentUserTexts(history, 8);

  // ---- 1. 核抽出 ----
  let core = extractCore(meta, text);
  if (!core) {
    for (const h of historyTexts) {
      const c = extractCore(meta, h);
      if (c) {
        core = c;
        break;
      }
    }
  }

  const hasCore = !!core;

  // ---- 2. 宣言・深度判定 ----
  const declaredNow = hasDeclaration(text);
  const affirmed = hasAffirm(text) || declaredNow;

  const coreRepeated =
    hasCore &&
    historyTexts.some(h => h.includes(core));

  const sunOk = hasSun(text) || hasBlock(text);
  const deepenOk = declaredNow || affirmed;

  // ---- 3. 判定条件 ----
  const ok =
    hasCore &&
    (coreRepeated || declaredNow) &&
    sunOk &&
    deepenOk;

  // ---- 4. 失敗時（I層に留める） ----
  if (!ok) {
    return {
      ok: false,
      reason: [
        !hasCore ? 'NO_CORE' : null,
        !sunOk ? 'NO_SUN' : null,
        !deepenOk ? 'NO_DECLARATION' : null,
      ].filter(Boolean).join('|'),
      iLayerForce: true,
      flags: {
        hasCore,
        coreRepeated,
        sunOk,
        declarationOk: declaredNow,
        deepenOk,
      },
    };
  }

  // ---- 5. 成立：T層へ ----
  const tVector: TVector = {
    core,
    turningPoint: hasBlock(text) ? 'BLOCK' : 'SUN',
    demand: hasDeclaration(text) ? '宣言' : '選択',
    nextC: `「${core}」を一つ形にする`,
  };

  return {
    ok: true,
    reason: 'IT_TRIGGER_OK',
    iLayerForce: true,
    tLayerModeActive: true,
    tLayerHint: 'T2',
    tVector,
  };
}
