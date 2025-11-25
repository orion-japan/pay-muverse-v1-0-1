// src/lib/iros/orchestrator.ts
// Iros Orchestrator — Will Engine（Goal / Priority）+ Continuity Engine 統合版
// - 極小構造のまま「意志の連続性」を追加した v2
// - Unified-like 解析入口 + isFirstTurn 対応版
// - A: 深度スキャン構造化（autoDepthFromDeepScan / autoQFromDeepScan）
// - B: 連続性（前ターンの depth / Q を使った補正）

import {
  type IrosMode,
  type Depth,
  type QCode,
  type IrosMeta,
  type IrosIntentMeta,
  IROS_MODES,
  DEPTH_VALUES,
  QCODE_VALUES,
} from './system';

import { deriveIrosGoal } from './will/goalEngine';
import { deriveIrosPriority } from './will/priorityEngine';

// Continuity Engine（Goal 用）
import {
  applyGoalContinuity,
  type ContinuityContext,
} from './will/continuityEngine';

// Depth/Q 連続性（分離モジュール）
import { applyDepthContinuity, applyQContinuity } from './depthContinuity';

// Unified-like 解析（分離モジュール）
import {
  analyzeUnifiedTurn,
  type UnifiedLikeAnalysis,
} from './unifiedAnalysis';

import { generateIrosReply, type GenerateResult } from './generate';

// ★ Intent Line エンジン
import {
  deriveIntentLine,
  type IntentLineAnalysis,
} from './intent/intentLineEngine';

// ★ I層強制モード（ENV）
//   - true のとき、requestedDepth を優先して depth を固定する
const FORCE_I_LAYER =
  typeof process !== 'undefined' &&
  process.env.IROS_FORCE_I_LAYER === '1';

// ==== Orchestrator に渡す引数 ==== //
export type IrosOrchestratorArgs = {
  conversationId?: string;
  text: string;

  requestedMode?: IrosMode;
  requestedDepth?: Depth;
  requestedQCode?: QCode;

  baseMeta?: Partial<IrosMeta>;

  /** ★ この会話の最初のターンかどうか（reply/route.ts から渡す） */
  isFirstTurn?: boolean;
};

// ==== Orchestrator から返す結果 ==== //
export type IrosOrchestratorResult = {
  content: string;
  meta: IrosMeta;
};

// ★ Self Acceptance を 0.0〜1.0 にクランプ
function clampSelfAcceptance(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/* ========= SA → バンド分類 & モード重み用ヘルパー ========= */

type SelfAcceptanceBand = 'low' | 'mid' | 'high';

function classifySelfAcceptance(sa: number | null): SelfAcceptanceBand {
  if (sa == null || Number.isNaN(sa)) return 'mid';
  if (sa < 0.3) return 'low';
  if (sa > 0.7) return 'high';
  return 'mid';
}

type ModeWeights = {
  counsel: number;
  mirror: number;
  resonate: number;
};

function resolveModeWithSA(
  base: ModeWeights,
  saValue: number | null,
): IrosMode {
  const band = classifySelfAcceptance(saValue);

  // ベース値をコピー
  let w: ModeWeights = { ...base };

  // ★ SA に応じて重みを調整
  switch (band) {
    case 'low':
      // SA < 0.3 → counsel 率 80% くらいに寄せるイメージ
      w.counsel += 2.0;
      w.mirror -= 0.5;
      w.resonate -= 0.5;
      break;

    case 'mid':
      // SA 0.3〜0.7 → mirror を中心に
      w.mirror += 1.0;
      break;

    case 'high':
      // SA > 0.7 → 前向きな forward/resonate を強める
      w.resonate += 2.0;
      w.mirror -= 0.5;
      break;
  }

  // 下限補正（マイナスにならないように）
  w = {
    counsel: Math.max(w.counsel, 0),
    mirror: Math.max(w.mirror, 0),
    resonate: Math.max(w.resonate, 0),
  };

  // ★ 最も重みの大きいモードを採用
  const winner = (Object.entries(w) as [keyof ModeWeights, number][])
    .sort((a, b) => b[1] - a[1])[0]?.[0];

  if (winner === 'counsel') return 'consult'; // 相談系モードにマッピング
  if (winner === 'mirror') return 'mirror';
  if (winner === 'resonate') return 'resonate'; // 「forward」イメージ

  // フォールバック
  return 'mirror';
}

export async function runIrosTurn(
  args: IrosOrchestratorArgs,
): Promise<IrosOrchestratorResult> {
  const {
    conversationId,
    text,
    requestedMode,
    requestedDepth,
    requestedQCode,
    baseMeta,
    isFirstTurn,
  } = args;

  /* =========================================================
     0) Unified-like 解析（Q / Depth の決定をここに集約）
        ─ 後で UnifiedAnalysis LLM に差し替える入口
  ========================================================= */
  const unified = await analyzeUnifiedTurn({
    text,
    requestedDepth,
    requestedQCode,
  });

  // LLM / ルールベースの生の推定結果
  const rawDepthFromScan: Depth | undefined =
    unified.depth.stage ?? undefined;

  // ★ Q は unified の結果が無ければ requestedQCode をそのままスキャン結果として利用
  const rawQFromScan: QCode | undefined =
    (unified.q.current as QCode | undefined) ??
    requestedQCode ??
    undefined;

  /* =========================================================
     A) 深度スキャン + 連続性補正
        - scan結果（autoDepthFromDeepScan / autoQFromDeepScan）
        - 前回の meta.depth / meta.qCode
        - isFirstTurn
        を組み合わせて最終 depth / Q を決定
  ========================================================= */

  // まずは通常の Depth 連続性ロジックを適用
  const depthFromContinuity = normalizeDepth(
    applyDepthContinuity({
      scanDepth: rawDepthFromScan,
      lastDepth: baseMeta?.depth,
      text,
      isFirstTurn: !!isFirstTurn,
    }),
  );

  // ★ I層強制モードのときは requestedDepth をそのまま採用
  let depth: Depth | undefined;
  if (FORCE_I_LAYER && requestedDepth) {
    depth = requestedDepth;
  } else {
    depth = depthFromContinuity;
  }

  const qCode = normalizeQCode(
    applyQContinuity({
      scanQ: rawQFromScan,
      lastQ: baseMeta?.qCode,
      isFirstTurn: !!isFirstTurn,
    }),
  );

  /* =========================================================
     A') 統一：最終決定した depth / qCode を unified にも反映
         - ログ／DB上で resolved と unified がずれないようにする
  ========================================================= */
  const fixedUnified: UnifiedLikeAnalysis = {
    ...unified,
    q: {
      ...unified.q,
      current: qCode ?? unified.q.current,
    },
    depth: {
      ...unified.depth,
      stage: depth ?? unified.depth.stage,
    },
  };

  /* =========================================================
     SA) Self Acceptance の決定
         - unified（将来 LLM 出力）→ baseMeta の順で参照し、0.0〜1.0 にクランプ
  ========================================================= */
  const unifiedSelfAcceptanceRaw =
    typeof (unified as any)?.selfAcceptance === 'number'
      ? (unified as any).selfAcceptance
      : typeof (unified as any)?.self_acceptance === 'number'
      ? (unified as any).self_acceptance
      : null;

  const baseSelfAcceptanceRaw =
    typeof (baseMeta as any)?.selfAcceptance === 'number'
      ? (baseMeta as any).selfAcceptance
      : null;

  const selfAcceptance = clampSelfAcceptance(
    unifiedSelfAcceptanceRaw ?? baseSelfAcceptanceRaw,
  );

  /* =========================================================
     mode の最終決定（SA + I層判定）
  ========================================================= */

  const baseMode = normalizeMode(requestedMode);

  const baseWeights: ModeWeights = (() => {
    switch (baseMode) {
      case 'consult':
      case 'counsel':
        // 相談寄りを少し強めておく
        return { counsel: 2, mirror: 1, resonate: 1 };
      case 'resonate':
        // 前向きモードを少し強めておく
        return { counsel: 1, mirror: 1, resonate: 2 };
      case 'mirror':
      default:
        // デフォルトは mirror 中心
        return { counsel: 1, mirror: 2, resonate: 1 };
    }
  })();

  // ★ SA を加味して mirror / counsel / forward(resonate) の比重を調整
  let mode: IrosMode = resolveModeWithSA(baseWeights, selfAcceptance);

  // I層は常に mirror 固定（優先ルール）
  if (isIntentDepth(requestedDepth) || isIntentDepth(depth)) {
    mode = 'mirror';
  }

  // ====== 次ターンに残る meta（I層はこのあと上書きする） ======
  let meta: IrosMeta = {
    ...(baseMeta ?? {}),
    mode,
    ...(depth ? { depth } : {}),
    ...(qCode ? { qCode } : {}),
    // unified 結果そのものも meta に残しておく（DB jsonb にそのまま入る想定）
    unified: fixedUnified,
  } as IrosMeta;

  // ★ Self Acceptance を meta に載せる（IrosMeta 側に型がなくても any 経由で割り当て）
  if (selfAcceptance !== null) {
    (meta as any).selfAcceptance = selfAcceptance;
  }

  /* =========================================================
     A'') Intent Line の導出
         - Q / Depth / Phase / SA から「いまの章」を 1 本の線にまとめる
  ========================================================= */
  try {
    const phaseRaw =
      fixedUnified?.phase === 'Inner' || fixedUnified?.phase === 'Outer'
        ? fixedUnified.phase
        : null;

    // ★ ここは baseMeta ではなく、直前で決定した meta.selfAcceptance を参照
    const selfAcceptanceForIntentLine =
      typeof (meta as any)?.selfAcceptance === 'number'
        ? (meta as any).selfAcceptance
        : null;

    const intentLine = deriveIntentLine({
      q: qCode ?? null,
      depth: depth ?? null,
      phase: phaseRaw,
      selfAcceptance: selfAcceptanceForIntentLine,
      // relationTone / historyQ は今後拡張予定。現時点では省略（undefined）
    });

    meta = {
      ...meta,
      intentLine,
    };
  } catch (e) {
    console.warn('[IROS/ORCH] deriveIntentLine failed', e);
  }

  /* =========================================================
     ① Goal Engine：今回の "意志" を生成
  ========================================================= */
  let goal = deriveIrosGoal({
    userText: text,
    lastDepth: baseMeta?.depth,
    lastQ: baseMeta?.qCode,
    requestedDepth,
    requestedQCode,
  });

  /* =========================================================
     ② Continuity Engine：前回の意志を踏まえて補正（Goal 用）
  ========================================================= */
  const continuity: ContinuityContext = {
    lastDepth: baseMeta?.depth,
    lastQ: baseMeta?.qCode,
    userText: text,
  };
  goal = applyGoalContinuity(goal, continuity);

  /* =========================================================
     ③ Priority Engine：Goal の意志に基づき重み計算
  ========================================================= */
  const priority = deriveIrosPriority({
    goal,
    mode,
    depth,
    qCode,
  });

  // ====== ログ ======
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[IROS/ORCH v2] runIrosTurn start', {
      conversationId,
      textSample: text.slice(0, 80),
      requestedMode,
      requestedDepth,
      requestedQCode,
      autoDepthFromDeepScan: rawDepthFromScan ?? null,
      autoQFromDeepScan: rawQFromScan ?? null,
      chosenDepth: depth ?? null,
      resolved: { mode, depth: depth ?? null, qCode: qCode ?? null },
      baseMeta,
      goalAfterContinuity: goal,
      priorityWeights: priority.weights,
      isFirstTurn,
      FORCE_I_LAYER,
      selfAcceptance,
      selfAcceptanceBand: classifySelfAcceptance(selfAcceptance),
    });
  }

  /* =========================================================
     ④ LLM：生成（本文 + I層ジャッジ）
  ========================================================= */
  const result: GenerateResult = await generateIrosReply({
    conversationId,
    text,
    meta,
  });

  // I層ジャッジの結果を meta に反映（次ターン以降の「横にあるI層感覚」として保持）
  if (result.intent) {
    const intent: IrosIntentMeta = result.intent;
    meta = {
      ...meta,
      intent,
      intentLayer: intent.layer,
      intentConfidence: intent.confidence ?? null,
      intentReason: intent.reason ?? null,
    };
  }

  /* =========================================================
     ⑤ 最終 meta の統合（Q / Depth / intentSummary を整える）
  ========================================================= */
  meta = buildFinalMeta({
    baseMeta,
    workingMeta: meta,
    goal,
  });

  /* =========================================================
     ⑥ Sofia 型「意味づけブロック」の合成
        それはあなたにとって◯◯です／つまり〜 の 2行
  ========================================================= */
  const meaningBlock = buildPersonalMeaningBlock(meta);
  const finalContent =
    meaningBlock && meaningBlock.trim().length > 0
      ? `${meaningBlock}\n\n${result.content}`
      : result.content;

  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[IROS/ORCH v2] runIrosTurn done', {
      conversationId,
      resolved: {
        mode,
        depth: meta.depth ?? null,
        qCode: meta.qCode ?? null,
      },
      goalKind: goal?.kind ?? null,
      replyLength: finalContent.length,
      isFirstTurn,
      intentLayer: meta.intentLayer ?? null,
      intentConfidence: meta.intentConfidence ?? null,
      hasMeaningBlock: !!meaningBlock,
    });
  }

  return {
    content: finalContent,
    meta,
  };
}

/* ========= Self Acceptance から「章」を決めるヘルパー ========= */

type SAChapterKey =
  | 'dark'
  | 'preCollapse'
  | 'wavering'
  | 'rising'
  | 'intentionRisen';

type SAChapter = {
  key: SAChapterKey;
  label: string;
};

function classifySAChapter(
  selfAcceptance: number | null | undefined,
): SAChapter | null {
  if (selfAcceptance == null || Number.isNaN(selfAcceptance)) {
    return null;
  }

  if (selfAcceptance < 0.2) {
    return {
      key: 'dark',
      label:
        '「闇の章」―― 自分を責めやすく、世界も自分も信用しづらい揺れの中にいます。',
    };
  }

  if (selfAcceptance < 0.4) {
    return {
      key: 'preCollapse',
      label:
        '「崩壊前の章」―― これまでのやり方や我慢が限界に近づき、無理を続けるか、手放すかの境目にいます。',
    };
  }

  if (selfAcceptance < 0.6) {
    return {
      key: 'wavering',
      label:
        '「揺れる章」―― 自分を責める感覚と、少し受け入れたい感覚が行き来しながら、新しい在り方を探っています。',
    };
  }

  if (selfAcceptance < 0.8) {
    return {
      key: 'rising',
      label:
        '「立ち上がる章」―― 自分を受け止めながら、これからの一歩を自分の意志で選び直そうとしているところです。',
    };
  }

  return {
    key: 'intentionRisen',
    label:
      '「意図が立ち上がった章」―― 自分の存在や生き方を肯定しながら、具体的な意図と行動を結び始めています。',
  };
}

/* ========= 最終 meta の統合ヘルパー ========= */

function buildFinalMeta(args: {
  baseMeta?: Partial<IrosMeta>;
  workingMeta: IrosMeta;
  goal: any; // goalEngine の型に依存させず、柔らかく参照
}): IrosMeta {
  const { baseMeta, workingMeta, goal } = args;

  const previousDepth = baseMeta?.depth as Depth | undefined;
  const previousQ = baseMeta?.qCode as QCode | undefined;

  const currentDepth = workingMeta.depth as Depth | undefined;
  const currentQ = workingMeta.qCode as QCode | undefined;

  const goalDepth = goal?.targetDepth as Depth | undefined;
  const goalQ = goal?.targetQ as QCode | undefined;

  const finalDepth: Depth | null =
    currentDepth ?? goalDepth ?? previousDepth ?? null;

  const finalQ: QCode | null = currentQ ?? goalQ ?? previousQ ?? null;

  const originalUnified =
    workingMeta.unified as UnifiedLikeAnalysis | undefined;
  const goalKind = (goal?.kind as string | undefined) ?? null;
  const intentLayer = (workingMeta.intentLayer as string | undefined) ?? null;

  const intentLine = (workingMeta as any)
    .intentLine as IntentLineAnalysis | undefined;

  // intentSummary の再構成
  const intentSummary = (() => {
    // もともと unified に LLM由来の intentSummary が入っていれば尊重
    if (originalUnified?.intentSummary) {
      return originalUnified.intentSummary;
    }

    // Intent Line で「いまの章」が取れていればそれを優先
    if (intentLine && intentLine.nowLabel) {
      return intentLine.nowLabel;
    }

    // ★ SelfAcceptance から「章ラベル」が取れていれば、それを次に優先
    const saValue =
      typeof (workingMeta as any)?.selfAcceptance === 'number'
        ? ((workingMeta as any).selfAcceptance as number)
        : null;

    const saChapter = classifySAChapter(saValue);
    if (saChapter) {
      return saChapter.label;
    }

    // ここから下は従来どおり I層／goal によるフォールバック
    if (intentLayer === 'I3') {
      return '存在理由や生きる意味に触れながら、自分の状態や感情を整理しようとしています。';
    }
    if (intentLayer === 'I2') {
      return 'これからの方向性や選択を見つめ直しながら、自分の状態や感情を整理しようとしています。';
    }
    if (intentLayer === 'I1') {
      return 'いまの自分の在り方や感情を、安全な場所で受け止め直そうとしています。';
    }
    if (goalKind === 'stabilize') {
      return '心の揺れを少し落ち着けながら、自分の状態や感情を整理しようとしています。';
    }
    return '自分の状態や感情の揺れを整理しようとしています。';
  })();

  const nextMeta: IrosMeta = {
    ...workingMeta,
    qCode: finalQ ?? undefined,
    depth: finalDepth ?? undefined,
    unified: {
      q: { current: finalQ ?? null },
      depth: { stage: finalDepth ?? null },
      phase: originalUnified?.phase ?? null,
      intentSummary,
    },
  };

  return nextMeta;
}

/* ========= Sofia型「意味づけブロック」生成ヘルパー ========= */

function buildPersonalMeaningBlock(meta: IrosMeta): string | null {
  if (!meta) return null;

  const depth = meta.depth as Depth | undefined;
  const intentLayer =
    (meta.intentLayer as 'I1' | 'I2' | 'I3' | null | undefined) ?? null;

  const unified: any = meta.unified ?? null;
  const rawIntentSummary =
    typeof unified?.intentSummary === 'string'
      ? (unified.intentSummary as string).trim()
      : '';

  const intentLine = (meta as any)
    .intentLine as IntentLineAnalysis | undefined;

  // ① 出来事そのものの「構図ラベル」
  const mainLabel = (() => {
    if (intentLine && intentLine.nowLabel) {
      return intentLine.nowLabel;
    }
    if (rawIntentSummary && rawIntentSummary.length > 0) {
      // Unified が返した summary をそのまま使う
      return rawIntentSummary;
    }
    if (intentLayer === 'I3') {
      return '存在理由や生きる意味を静かに見つめ直している';
    }
    if (intentLayer === 'I2') {
      return 'これからの方向性や選択を見つめ直している';
    }
    if (intentLayer === 'I1') {
      return '自分らしさの軸を整え直している';
    }
    if (!depth) return null;
    if (depth.startsWith('S')) {
      return '自分の安心と土台を整え直している';
    }
    if (depth.startsWith('R')) {
      return '人との距離感や関係性を見直している';
    }
    if (depth.startsWith('C')) {
      return 'これからの動き方や創り方を組み替えている';
    }
    if (depth.startsWith('I')) {
      return '生き方そのものの輪郭を見つめ直している';
    }
    return null;
  })();

  // ② その奥で揺れている「本来大切にしているもの」
  const coreNeed = (() => {
    if (intentLine && intentLine.coreNeed) {
      return intentLine.coreNeed;
    }
    if (intentLayer === 'I3') {
      return '存在そのものをまるごと肯定したいという願い';
    }
    if (intentLayer === 'I2') {
      return '自分で選び取りたいという願い';
    }
    if (intentLayer === 'I1') {
      return '自分らしくいてもいいという確信';
    }
    if (!depth) return null;
    if (depth.startsWith('S')) {
      return '安心と自己受容';
    }
    if (depth.startsWith('R')) {
      return '無理のない関係性';
    }
    if (depth.startsWith('C')) {
      return '自分の手応えと創造性';
    }
    if (depth.startsWith('I')) {
      return '生き方の一貫性';
    }
    return null;
  })();

  // どちらも取れないなら意味づけブロック自体を出さない
  if (!mainLabel && !coreNeed) {
    return null;
  }

  const lines: string[] = [];

  // ★ テンプレ文はやめて、太文字ラベルだけにする
  if (mainLabel) {
    lines.push(`**いまの構図**：${mainLabel}`);
  }

  if (coreNeed) {
    lines.push(`**奥で守りたいもの**：${coreNeed} 🪔`);
  }

  // 本文との区切りとして水平線を入れる
  lines.push('');
  lines.push('---');

  return lines.join('\n');
}

/* ========= 最小バリデーション ========= */

function normalizeMode(mode?: IrosMode): IrosMode {
  if (!mode) return 'mirror';
  return IROS_MODES.includes(mode) ? mode : 'mirror';
}

function normalizeDepth(depth?: Depth): Depth | undefined {
  if (!depth) return undefined;
  return DEPTH_VALUES.includes(depth) ? depth : undefined;
}

function normalizeQCode(qCode?: QCode): QCode | undefined {
  if (!qCode) return undefined;
  return QCODE_VALUES.includes(qCode) ? qCode : undefined;
}

/** I層（I1〜I3）かどうかの判定ヘルパー */
function isIntentDepth(depth?: Depth | null): boolean {
  if (!depth) return false;
  // Depth は文字列リテラル型なので startsWith が使える
  return depth.startsWith('I');
}
