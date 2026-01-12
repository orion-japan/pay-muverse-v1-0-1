// src/lib/iros/orchestratorState.ts
// Iros Orchestrator — MemoryState 読み込み専用ヘルパー
// - userCode ごとの「現在地」を読み込み、baseMeta に合成
// - 保存（upsert）は handleIrosReply 側に集約する（ここではDB保存しない）

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Depth, QCode, IrosMeta } from './system';
import { loadIrosMemoryState, type IrosMemoryState } from './memoryState';

export type LoadStateResult = {
  /** MemoryState を合成した baseMeta（無ければ undefined） */
  mergedBaseMeta: Partial<IrosMeta> | undefined;
  /** 読み込んだ MemoryState（無ければ null） */
  memoryState: IrosMemoryState | null;
};

function normalizePhase(raw: unknown): 'Inner' | 'Outer' | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim().toLowerCase();
  if (p === 'inner') return 'Inner';
  if (p === 'outer') return 'Outer';
  return null;
}

function normalizeSpinLoop(raw: unknown): 'SRI' | 'TCF' | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (s === 'SRI') return 'SRI';
  if (s === 'TCF') return 'TCF';
  return null;
}

function normalizeSpinStep(raw: unknown): number | null {
  if (typeof raw !== 'number' || Number.isNaN(raw)) return null;
  const n = Math.round(raw);
  return Number.isFinite(n) ? n : null;
}

// ★ 追加：intentLayer 正規化（IrosMeta の intentLayer 型に合わせる）
type IntentLayer = Exclude<IrosMeta['intentLayer'], null | undefined>;

function normalizeIntentLayer(raw: unknown): IntentLayer | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (s === 'S' || s === 'R' || s === 'C' || s === 'I' || s === 'T') {
    return s as unknown as IntentLayer;
  }
  return null;
}

// ★ 追加：descentGate 正規化（IrosMeta の descentGate 型に合わせる）
type DescentGate = Exclude<IrosMeta['descentGate'], null | undefined>;

function normalizeDescentGate(raw: unknown): DescentGate | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();

  // MemoryState（memoryState.ts）側：'closed' | 'offered' | 'accepted'
  if (s === 'closed' || s === 'offered' || s === 'accepted') return s as unknown as DescentGate;

  // 互換：旧 'open' が来たら offered として扱う（必要なら）
  if (s === 'open') return 'offered' as unknown as DescentGate;

  return null;
}

// ★ 追加：intentAnchor（SUNなど）正規化
function normalizeIntentAnchorKey(raw: unknown): string | null {
  if (raw == null) return null;

  // string: 'SUN'
  if (typeof raw === 'string') {
    const s = raw.trim();
    return s.length ? s : null;
  }

  // object: { key:'SUN' } or { intent_anchor:{key:'SUN'} } etc.
  if (typeof raw === 'object') {
    const k = (raw as any).key;
    if (typeof k === 'string' && k.trim().length) return k.trim();
  }

  return null;
}

/**
 * userCode ごとの MemoryState を読み込み、
 * baseMeta に depth / qCode / selfAcceptance / Y / H / phase / spin / intentLayer / descentGate / intent_anchor を合成する。
 *
 * ✅ 注意：この関数は read only。保存は persist 側に集約。
 */
export async function loadBaseMetaFromMemoryState(args: {
  sb: SupabaseClient;
  userCode?: string;
  baseMeta?: Partial<IrosMeta>;
}): Promise<LoadStateResult> {
  const { sb, userCode, baseMeta } = args;

  let mergedBaseMeta: Partial<IrosMeta> | undefined = baseMeta;
  let memoryState: IrosMemoryState | null = null;

  if (!userCode) return { mergedBaseMeta, memoryState };

  try {
    memoryState = await loadIrosMemoryState(sb, userCode);

    // ★ 互換（camel/snake/別名）を吸収して読む
    const msAny: any = memoryState as any;

    const msPhaseRaw =
      typeof msAny?.phase === 'string'
        ? msAny.phase
        : typeof msAny?.phase_mode === 'string'
          ? msAny.phase_mode
          : typeof msAny?.phaseMode === 'string'
            ? msAny.phaseMode
            : null;

    const msSpinLoopRaw =
      typeof msAny?.spinLoop === 'string'
        ? msAny.spinLoop
        : typeof msAny?.spin_loop === 'string'
          ? msAny.spin_loop
          : null;

    const msSpinStepRaw =
      typeof msAny?.spinStep === 'number'
        ? msAny.spinStep
        : typeof msAny?.spin_step === 'number'
          ? msAny.spin_step
          : null;

    // ✅ intent_layer / intentLayer を拾う
    const msIntentLayerRaw =
      typeof msAny?.intentLayer === 'string'
        ? msAny.intentLayer
        : typeof msAny?.intent_layer === 'string'
          ? msAny.intent_layer
          : null;

    // ✅ descentGate / descent_gate を拾う
    const msDescentGateRaw =
      typeof msAny?.descentGate === 'string'
        ? msAny.descentGate
        : typeof msAny?.descent_gate === 'string'
          ? msAny.descent_gate
          : null;

    // ✅ intentAnchor（memoryState.ts で intentAnchor に詰めてる前提）
    const msIntentAnchorRaw =
      msAny?.intentAnchor != null
        ? msAny.intentAnchor
        : msAny?.intent_anchor != null
          ? msAny.intent_anchor
          : null;

    // ★ 正規化（IrosMeta の型に合わせる）
    const normalizedPhase = normalizePhase(msPhaseRaw);
    const normalizedSpinLoop = normalizeSpinLoop(msSpinLoopRaw);
    const normalizedSpinStep = normalizeSpinStep(msSpinStepRaw);
    const normalizedIntentLayer = normalizeIntentLayer(msIntentLayerRaw);
    const normalizedDescentGate = normalizeDescentGate(msDescentGateRaw);

    const intentAnchorKey = normalizeIntentAnchorKey(msIntentAnchorRaw);

    if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
      console.log('[IROS/STATE] loaded MemoryState (orchestratorState)', {
        userCode,
        hasMemory: !!memoryState,
        intentAnchor: intentAnchorKey,
        depthStage: memoryState?.depthStage ?? null,
        qPrimary: memoryState?.qPrimary ?? null,
        selfAcceptance: memoryState?.selfAcceptance ?? null,
        phase: msPhaseRaw ?? null,
        intentLayer: msIntentLayerRaw ?? null,
        yLevel: memoryState?.yLevel ?? null,
        hLevel: memoryState?.hLevel ?? null,
        spinLoop: msSpinLoopRaw ?? null,
        spinStep: msSpinStepRaw ?? null,
        descentGate: msDescentGateRaw ?? null,
      });
    }

    if (!memoryState) return { mergedBaseMeta, memoryState };

    const hasBaseSA =
    typeof (mergedBaseMeta as any)?.selfAcceptance === 'number' &&
    !Number.isNaN((mergedBaseMeta as any).selfAcceptance);

    // ✅ ここから下（rotationState〜selfAcceptance〜y/h）は
    // “mergedBaseMeta = { ... }” の **中** に入ってないとダメです。
    // いま画面だと 266 行目あたりで `};` を先に閉じちゃっていて、
    // その後の `...(` が「オブジェクト外」に出て構文エラーになっています。
    //
    // ↓ このブロックを **「mergedBaseMeta = { ...(mergedBaseMeta ?? {}), ...」の末尾」** として
    // そのまま貼り替えてください（= rotationState 以降〜最後の `};` までを置換）

    mergedBaseMeta = {
      ...(mergedBaseMeta ?? {}),

      // depth / qCode：baseMeta が優先。無ければ MemoryState で補完
      ...(mergedBaseMeta?.depth
        ? {}
        : memoryState.depthStage
          ? { depth: memoryState.depthStage as Depth }
          : {}),
      ...(mergedBaseMeta?.qCode
        ? {}
        : memoryState.qPrimary
          ? { qCode: memoryState.qPrimary as QCode }
          : {}),

      // ✅ intentLayer：baseMeta が無いときだけ補完
      ...(!(mergedBaseMeta as any)?.intentLayer && normalizedIntentLayer
        ? { intentLayer: normalizedIntentLayer }
        : {}),

      // phase / spin：baseMeta 側に無いときだけ補完
      ...(!(mergedBaseMeta as any)?.phase && normalizedPhase ? { phase: normalizedPhase } : {}),
      ...(metaMissing((mergedBaseMeta as any)?.spinLoop) && normalizedSpinLoop
        ? { spinLoop: normalizedSpinLoop }
        : {}),
      ...(typeof (mergedBaseMeta as any)?.spinStep === 'number'
        ? {}
        : normalizedSpinStep !== null
          ? { spinStep: normalizedSpinStep }
          : {}),

      // ✅ descentGate：baseMeta 側に無いときだけ補完
      ...(!(mergedBaseMeta as any)?.descentGate && normalizedDescentGate
        ? { descentGate: normalizedDescentGate }
        : {}),

      // ✅ intent_anchor：baseMeta に無いときだけ補完（LLM/IT用）
      ...(!(mergedBaseMeta as any)?.intent_anchor && intentAnchorKey
        ? { intent_anchor: { key: intentAnchorKey } as any }
        : {}),
      ...(!(mergedBaseMeta as any)?.intent_anchor_key && intentAnchorKey
        ? { intent_anchor_key: intentAnchorKey as any }
        : {}),

      // ✅ rotationState：下流取りこぼし防止（無ければ作る）
      ...(typeof (mergedBaseMeta as any)?.rotationState === 'object' &&
      (mergedBaseMeta as any).rotationState
        ? {}
        : {
            rotationState: {
              spinLoop: (mergedBaseMeta as any)?.spinLoop ?? normalizedSpinLoop ?? null,
              spinStep:
                typeof (mergedBaseMeta as any)?.spinStep === 'number'
                  ? (mergedBaseMeta as any).spinStep
                  : normalizedSpinStep ?? null,
              descentGate: (mergedBaseMeta as any)?.descentGate ?? normalizedDescentGate ?? null,
            },
          }),

      // ✅ selfAcceptance は baseMeta に無い場合のみ補完
      ...(!hasBaseSA && typeof memoryState.selfAcceptance === 'number'
        ? { selfAcceptance: memoryState.selfAcceptance }
        : {}),

      // ✅ y/h は baseMeta に無いときだけ補完（上書きしない）
      ...(typeof (mergedBaseMeta as any)?.yLevel === 'number'
        ? {}
        : typeof memoryState.yLevel === 'number'
          ? { yLevel: memoryState.yLevel }
          : {}),
      ...(typeof (mergedBaseMeta as any)?.hLevel === 'number'
        ? {}
        : typeof memoryState.hLevel === 'number'
          ? { hLevel: memoryState.hLevel }
          : {}),
    };

  } catch (e) {
    console.error('[IROS/STATE] loadIrosMemoryState failed', {
      userCode,
      error: e,
    });
  }

  return { mergedBaseMeta, memoryState };
}
function metaMissing(v: any) {
  return v == null || (typeof v === 'string' && v.trim().length === 0);
}


/**
 * 互換のため残すが、ここではDB保存しない。
 * MemoryState の upsert は handleIrosReply 側に集約する。
 */
export async function saveMemoryStateFromMeta(args: {
  userCode?: string;
  meta: IrosMeta;
}): Promise<void> {
  const { userCode } = args;
  if (!userCode) return;

  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log(
      '[IROS/STATE] saveMemoryStateFromMeta no-op (persist is handled in handleIrosReply)',
      { userCode },
    );
  }

  return;
}
