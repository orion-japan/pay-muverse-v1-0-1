// file: src/lib/iros/orchestratorBaseMeta.ts
// A) BaseMeta/Memory/Continuity の抽出（behavior-preserving）
// - orchestrator.ts の「1〜2 + 連続性控え + 前回状態控え」を丸ごと関数化
// - 目的：orchestrator の前段（状態の準備）を固定化し、分岐や副作用を減らす
// - 重要：normalizeDepthStrict / normalizeQCode は orchestrator.ts 側の同実装を使う（単一ソース）

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Depth, QCode, IrosMeta, IrosStyle } from './system';
import { loadBaseMetaFromMemoryState, type LoadStateResult } from './orchestratorState';
import type { SpinLoop, SpinStep } from './types';

export type ResolveBaseMetaArgs = {
  // ★ 追加：呼び出し側が持っている Supabase client（変数名は自由）
  sb: SupabaseClient;

  userCode?: string;
  baseMeta?: Partial<IrosMeta>;
  style?: IrosStyle | string | null;

  // normalize の単一ソースを orchestrator 側から注入
  normalizeDepthStrict: (d?: Depth | null) => Depth | undefined;
  normalizeQCode: (q?: QCode) => QCode | undefined;
};

export type ResolveBaseMetaResult = {
  loadResult: LoadStateResult | null;

  mergedBaseMeta: Partial<IrosMeta>;
  memoryState: unknown;

  // MemoryState の生データ（key揺れ吸収のため保持）
  ms: any;

  // continuity（前回値）
  lastDepthForContinuity: Depth | null;
  lastQForContinuity: QCode | null;

  // 前回状態控え（回転/ヒステリシス/ゲート）
  lastSpinLoop: SpinLoop | null;
  lastSpinStep: SpinStep | null;
  lastPhaseForSpin: 'Inner' | 'Outer' | null;
  lastVolatilityRank: 'low' | 'mid' | 'high' | null;
  lastDescentGate: 'closed' | 'offered' | 'accepted' | null;

  // 前回ゴール情報（Will の連続性）
  lastGoalKind: string | null;
  previousUncoverStreak: number;
};

export async function resolveBaseMeta(
  args: ResolveBaseMetaArgs,
): Promise<ResolveBaseMetaResult> {
  const { sb, userCode, baseMeta, style, normalizeDepthStrict, normalizeQCode } = args;

  // ----------------------------------------------------------------
  // 1. MemoryState 読み込み（meta ベースのみ使用）
  // ----------------------------------------------------------------
  let loadResult: LoadStateResult | null = null;
  if (userCode) {
    loadResult = await loadBaseMetaFromMemoryState({
      sb,
      userCode,
      baseMeta,
    });
  }

  // ----------------------------------------------------------------
  // 2. baseMeta 構築（ルート引数 + Memory の統合）
  // ----------------------------------------------------------------
  const mergedBaseMeta: Partial<IrosMeta> = loadResult?.mergedBaseMeta ?? baseMeta ?? {};
  const memoryState: unknown = loadResult?.memoryState ?? null;

  // ★ CONT: 連続性用に「前回までの depth / qCode」を控えておく
  // mergedBaseMeta に無い場合は MemoryState のキー名（depthStage / qPrimary）から拾う
  const ms: any = loadResult?.memoryState ?? null;

  const lastDepthForContinuity: Depth | null =
    normalizeDepthStrict(
      ((mergedBaseMeta.depth as any) ?? (ms?.depthStage as any) ?? undefined) as any,
    ) ?? null;

  const lastQForContinuity: QCode | null =
    normalizeQCode(
      ((mergedBaseMeta.qCode as any) ?? (ms?.qPrimary as any) ?? undefined) as any,
    ) ?? null;

  // ★ style の反映：
  //   - 明示指定された style を最優先
  //   - なければ memory / baseMeta 側をそのまま使う
  if (typeof style !== 'undefined' && style !== null) {
    (mergedBaseMeta as any).style = style;
  }

  // ★ 前回ターンの Goal.kind / uncoverStreak を取得
  const previousGoal: any =
    (mergedBaseMeta as any).goal && typeof (mergedBaseMeta as any).goal === 'object'
      ? (mergedBaseMeta as any).goal
      : null;

  const lastGoalKind: string | null =
    previousGoal && typeof previousGoal.kind === 'string' ? previousGoal.kind : null;

  const previousUncoverStreak: number =
    typeof (mergedBaseMeta as any).uncoverStreak === 'number'
      ? (mergedBaseMeta as any).uncoverStreak
      : 0;

  // ----------------------------------------------------------------
  // 3. 前回の回転状態・位相・揺らぎ・ゲート（慣性・反転条件のため）
  // ----------------------------------------------------------------

  const lastSpinLoop: SpinLoop | null = (() => {
    const v = ((mergedBaseMeta as any).spinLoop ?? ms?.spinLoop ?? ms?.spin_loop) as any;
    return v === 'SRI' || v === 'TCF' ? (v as SpinLoop) : null;
  })();

  const lastSpinStep: SpinStep | null = (() => {
    const v = ((mergedBaseMeta as any).spinStep ?? ms?.spinStep ?? ms?.spin_step) as any;
    return typeof v === 'number' ? (v as SpinStep) : null;
  })();

  const lastPhaseForSpin: 'Inner' | 'Outer' | null = (() => {
    const p = ((mergedBaseMeta as any).phase ?? ms?.phase ?? ms?.phase_mode ?? ms?.phaseMode) as any;
    return p === 'Inner' || p === 'Outer' ? p : null;
  })();

  const lastVolatilityRank: 'low' | 'mid' | 'high' | null =
    (mergedBaseMeta as any).volatilityRank === 'low' ||
    (mergedBaseMeta as any).volatilityRank === 'mid' ||
    (mergedBaseMeta as any).volatilityRank === 'high'
      ? ((mergedBaseMeta as any).volatilityRank as 'low' | 'mid' | 'high')
      : null;

  const lastDescentGate: 'closed' | 'offered' | 'accepted' | null = (() => {
    const dg = ((mergedBaseMeta as any).descentGate ?? ms?.descentGate ?? ms?.descent_gate) as any;
    return dg === 'closed' || dg === 'offered' || dg === 'accepted' ? dg : null;
  })();

  return {
    loadResult,
    mergedBaseMeta,
    memoryState,
    ms,
    lastDepthForContinuity,
    lastQForContinuity,
    lastSpinLoop,
    lastSpinStep,
    lastPhaseForSpin,
    lastVolatilityRank,
    lastDescentGate,
    lastGoalKind,
    previousUncoverStreak,
  };
}
