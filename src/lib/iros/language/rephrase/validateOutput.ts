// src/lib/iros/language/rephrase/validateOutput.ts
// iros — validateOutput extracted (pure / no side effects)
//
// 目的：rephraseEngine.full.ts 内の validateOutput を「純粋関数」として外出しし、挙動を固定する。
// NOTE:
// - 副作用なし（console / LLM / import動的 なし）
// - engine 側の依存（containsForbiddenLeakText 等）は params で注入する
// - 返却は RephraseResult と構造互換（構造的型付け）

export type ValidateOutputResult = {
  ok: boolean;
  reason?: string;
  slots?: any;
  meta?: any;
};

export function validateOutputPure(params: {
  rawText: string;

  // context
  inKeys: string[];
  wantsIdeaBand: boolean;
  lockedILines: string[];

  // deps (injected)
  safeHead: (s: any, n: number) => string;
  containsForbiddenLeakText: (s: string) => boolean;
  verifyLockedILinesPreserved: (out: string, locked: string[]) => boolean;
  recallGuardOk: (args: { slotKeys: string[]; slotsForGuard: any; llmOut: string }) => { ok: boolean };
  buildSlotsWithFirstText: (inKeys: string[], text: string) => any[];

  // for recall guard
  extractedSlotsForRecall: any; // (extracted?.slots ?? null)
}): ValidateOutputResult {
  // ✅ ILINEマーカーは “露出禁止” なので、まず除去してから検証する
  const stripILineMarkers = (s0: any) => {
    const s = String(s0 ?? '');
    return s.replace(/\[\[ILINE\]\]/g, '').replace(/\[\[\/ILINE\]\]/g, '');
  };

  const raw = stripILineMarkers(String(params.rawText ?? ''));
  const head = params.safeHead(raw, 80);

  const mkFail = (reason: string): ValidateOutputResult => ({
    ok: false,
    reason,
    meta: {
      inKeys: params.inKeys,
      rawLen: raw.length,
      rawHead: head,
    },
  });

  if (!raw.trim()) return mkFail('OUT_EMPTY');
  if (params.containsForbiddenLeakText(raw)) return mkFail('INTERNAL_MARKER_LEAKED');
  if (/@[A-Z_]+_SLOT\b/.test(raw)) return mkFail('INTERNAL_MARKER_LEAKED');

  // ✅ IDEA_BAND 最小形状チェック（ここでは“殺さない”）
  // - LLMは "1." や "・" を混ぜがちなので、この段階で弾くと矯正/正規化に進めない
  // - 最終的な契約（2〜5行・1)正規化・spotlight移動・禁止語など）は後段で担保する
  if (params.wantsIdeaBand) {
    const stripListHead = (x: any) => {
      let t = String(x ?? '').trim();
      // bullets: ・ • ● - * – —
      t = t.replace(/^\s*(?:[・•●\-\*\u2013\u2014])\s+/u, '');
      // "1." "1)" "1："など
      t = t.replace(/^\s*\d+\s*(?:[.)。：:])\s*/u, '');
      // "候補:" "選択肢:" など
      t = t.replace(/^\s*(?:候補|選択肢)\s*[:：]\s*/u, '');
      return t.trim();
    };

    const IDEA_BAND_MAX_LINES = 5;

    const lines = raw
      .split('\n')
      .map((s) => stripListHead(s))
      .map((s) => String(s ?? '').trim())
      .filter(Boolean);

    if (lines.length < 2 || lines.length > IDEA_BAND_MAX_LINES) return mkFail('IDEA_BAND_SHAPE_REJECT');
  }

  const iLineOk = params.verifyLockedILinesPreserved(raw, params.lockedILines);
  if (!iLineOk) return mkFail('ILINE_NOT_PRESERVED');

  const recallCheck = params.recallGuardOk({
    slotKeys: params.inKeys,
    slotsForGuard: params.extractedSlotsForRecall,
    llmOut: raw,
  });
  if (!recallCheck.ok) return mkFail('RECALL_GUARD_REJECT');

  // ✅ OK: slots/meta を型どおり返す（attach は meta.extra.rephraseBlocks を拾える）
  const outSlots = params.buildSlotsWithFirstText(params.inKeys, raw);

  return {
    ok: true,
    slots: outSlots,
    meta: {
      inKeys: params.inKeys,
      outKeys: params.inKeys,
      rawLen: raw.length,
      rawHead: head,
      extra: {
        rephraseBlocks: outSlots,
        rephraseHead: head,
      },
    },
  };
}
