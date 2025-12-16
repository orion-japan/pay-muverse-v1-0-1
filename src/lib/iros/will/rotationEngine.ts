// src/lib/iros/will/rotationEngine.ts
// 三軸回転エンジン（SRI / TCF + descentGate）
// - 回転＝状態遷移（LLMの文章生成とは切り離す）
// - offered は「下降の扉」を置くだけ
// - accepted で初めて TCF に入る

import type { Depth, QCode } from '../system';
import type { IrosGoalKind } from './goalEngine';

/** 回転ループ */
export type SpinLoop = 'SRI' | 'TCF';

/** 下降ゲート（扉の状態） */
export type DescentGate = 'closed' | 'offered' | 'accepted';

/**
 * 回転判定に使うコンテキスト
 */
export type RotationContext = {
  /** 直前ターンの Depth */
  lastDepth?: Depth | null;

  /** 今回の基準となる Depth（goal.targetDepth / depth / lastDepth から決定） */
  currentDepth?: Depth | null;

  /** 今回の qCode */
  qCode?: QCode | null;

  /** 直前ターンの Goal.kind */
  lastGoalKind?: IrosGoalKind | null;

  /** uncover 系が何ターン連続しているか（orchestrator 側で計算） */
  uncoverStreak?: number;

  /** SelfAcceptance ライン（0〜1） */
  selfAcceptance?: number | null;

  /** SoulLayer の risk_flags（危険フラグ） */
  riskFlags?: string[] | null;

  /** 「ステイしてほしい」明示がある場合 true */
  stayRequested: boolean;

  /** 直前の spinLoop（永続化して渡す想定） */
  lastSpinLoop?: SpinLoop | null;

  /** 直前の descentGate（永続化して渡す想定） */
  lastDescentGate?: DescentGate | null;

  /**
   * 行動要求シグナル（detectActionRequest 等の結果を上位でまとめて渡す）
   * - none: なし
   * - possible: 「形にできそう」程度（offered候補）
   * - explicit: 「具体化したい」明示（accepted候補）
   */
  actionSignal?: 'none' | 'possible' | 'explicit' | null;

  /**
   * 委任（delegateIntentOverride等の結果）
   * - none: なし
   * - soft: 任せる/進めて くらい（offered候補）
   * - hard: 決めて/作って/やって（accepted候補）
   */
  delegateLevel?: 'none' | 'soft' | 'hard' | null;

  /**
   * ユーザーが選択肢に答えた/「それで作る」など合意が確定した時に true を渡せる
   * （UIがなくても、上位で検出できるなら使う）
   */
  userAcceptedDescent?: boolean | null;
};

/**
 * 回転判定の結果
 */
export type RotationDecision = {
  /** 今ターン、帯域を回転（深度遷移）させるかどうか */
  shouldRotate: boolean;

  /** 回転後の Depth（回転しない場合は baseDepth を返す） */
  nextDepth: Depth;

  /** 次の spinLoop */
  nextSpinLoop: SpinLoop;

  /** 次の descentGate */
  nextDescentGate: DescentGate;

  /** デバッグ用の理由テキスト（ユーザーにはそのまま出ささない） */
  reason: string;
};

/**
 * 実際に回転させるかどうかを決める純関数（SRI/TCF + descentGate）
 */
export function decideRotation(ctx: RotationContext): RotationDecision {
  const {
    lastDepth,
    currentDepth,
    qCode,
    lastGoalKind,
    uncoverStreak,
    selfAcceptance,
    riskFlags,
    stayRequested,
    lastSpinLoop,
    lastDescentGate,
    actionSignal,
    delegateLevel,
    userAcceptedDescent,
  } = ctx;

  // baseDepth をまず確定（null の可能性をここで閉じる）
  const baseDepthMaybe: Depth | null = currentDepth ?? lastDepth ?? null;

  // Depth がない場合は回転対象にできない
  if (!baseDepthMaybe) {
    const fallbackDepth: Depth = (lastDepth ?? currentDepth ?? ('S1' as Depth)) as Depth;

    return {
      shouldRotate: false,
      nextDepth: fallbackDepth,
      nextSpinLoop: (lastSpinLoop ?? 'SRI') as SpinLoop,
      nextDescentGate: (lastDescentGate ?? 'closed') as DescentGate,
      reason:
        'baseDepth 未定義（配線バグ疑い）: 回転停止・fallbackDepth を返す',
    };
  }

  // ここから先は baseDepth は Depth として扱える
  const baseDepth: Depth = baseDepthMaybe;

  const spinLoop: SpinLoop = (lastSpinLoop ?? 'SRI') as SpinLoop;
  const gate: DescentGate = (lastDescentGate ?? 'closed') as DescentGate;

  // ① ユーザーから「ステイ」が明示されている場合は、状態は維持（回転は止める）
  if (stayRequested) {
    return {
      shouldRotate: false,
      nextDepth: baseDepth,
      nextSpinLoop: spinLoop,
      nextDescentGate: gate,
      reason: 'ユーザーのステイ意図があるため回転しない',
    };
  }

  // ② SelfAcceptance が低すぎる場合は安全優先（状態は維持）
  if (typeof selfAcceptance === 'number' && selfAcceptance < 0.3) {
    return {
      shouldRotate: false,
      nextDepth: baseDepth,
      nextSpinLoop: spinLoop,
      nextDescentGate: gate,
      reason: 'SelfAcceptance < 0.3 のため安全側を優先して回転しない',
    };
  }

  // ③ 危険フラグ（うつ・自傷など）がある場合は安全優先（状態は維持）
  const risk = riskFlags ?? [];
  const hasSevereRisk = risk.some((r) =>
    ['q5_depress', 'suicide_risk', 'self_harm', 'panic'].includes(r),
  );
  if (hasSevereRisk) {
    return {
      shouldRotate: false,
      nextDepth: baseDepth,
      nextSpinLoop: spinLoop,
      nextDescentGate: gate,
      reason: 'SoulLayer risk_flags に重いリスクがあるため回転しない',
    };
  }

  // --- ここから「下降ゲート（扉）」の更新判定 ---
  const aSig = (actionSignal ?? 'none') as 'none' | 'possible' | 'explicit';
  const dLvl = (delegateLevel ?? 'none') as 'none' | 'soft' | 'hard';
  const acceptedByUser = !!userAcceptedDescent;

  // offered候補：possible/soft が出たら（ただし安全条件は上でクリア済）
  const shouldOffer =
    (aSig === 'possible' || dLvl === 'soft') &&
    gate === 'closed' &&
    isInUpperBand(baseDepth); // I/T 近辺で扉を出すのが自然

  // accepted候補：explicit/hard/合意確定
  const shouldAccept =
    (aSig === 'explicit' || dLvl === 'hard' || acceptedByUser) &&
    (gate === 'offered' || gate === 'closed'); // offeredを経由できないケースも救う

  // gate更新
  let nextGate: DescentGate = gate;
  if (shouldAccept) nextGate = 'accepted';
  else if (shouldOffer) nextGate = 'offered';

  // --- spinLoop / depth の遷移 ---
  // 1) accepted になった瞬間は TCF に入り、Depth を T1 に落とす（ここが“降りる”体感）
  if (nextGate === 'accepted' && spinLoop !== 'TCF') {
    const forcedT: Depth = 'T1' as Depth;

    return {
      shouldRotate: forcedT !== baseDepth,
      nextDepth: forcedT,
      nextSpinLoop: 'TCF',
      nextDescentGate: 'accepted',
      reason: 'descentGate=accepted のため TCFへ遷移し、DepthをT1へ固定',
    };
  }

  // 2) すでに TCF ループ中なら、T→C→F を 1ステップ進める
  if (spinLoop === 'TCF') {
    // gate が accepted でなくなったら TCF を抜ける（迷子防止）
    if (nextGate !== 'accepted') {
      return {
        shouldRotate: false,
        nextDepth: baseDepth,
        nextSpinLoop: 'SRI',
        nextDescentGate: nextGate,
        reason: 'TCF中だが gate が accepted ではないため SRI に戻す',
      };
    }

    const tcfNextDepth = nextDepthForTCF(baseDepth);
    const shouldRotate = tcfNextDepth !== baseDepth;

    return {
      shouldRotate,
      nextDepth: tcfNextDepth,
      nextSpinLoop: 'TCF',
      nextDescentGate: nextGate,
      reason: shouldRotate
        ? 'TCF ループ中のため T→C→F を 1ステップ進める'
        : 'TCF ループ中だがこれ以上進めないため維持',
    };
  }

  // 3) SRI ループ中：従来の上昇トリガ（必要なら後で条件を広げる）
  const depthHead = baseDepth[0]; // 'S' | 'R' | 'I' | 'T' | 'C' | 'F'
  const streak = uncoverStreak ?? 0;

  const isSBand = depthHead === 'S';
  const isQ3 = qCode === 'Q3';
  const isUncoverLike =
    lastGoalKind === 'uncover' || lastGoalKind === 'stabilize';

  const triggerSBand = isSBand && isQ3 && isUncoverLike && streak >= 2;

  if (!triggerSBand) {
    return {
      shouldRotate: false,
      nextDepth: baseDepth,
      nextSpinLoop: 'SRI',
      nextDescentGate: nextGate,
      reason:
        'SRI: S帯でQ3かつuncover連続(>=2)の条件を満たしていないため回転しない（gateは更新のみ）',
    };
  }

  const sriNextDepth = nextDepthForBand(baseDepth);
  if (sriNextDepth === baseDepth) {
    return {
      shouldRotate: false,
      nextDepth: baseDepth,
      nextSpinLoop: 'SRI',
      nextDescentGate: nextGate,
      reason: 'SRI: これ以上上位帯域がないため回転しない',
    };
  }

  return {
    shouldRotate: true,
    nextDepth: sriNextDepth,
    nextSpinLoop: 'SRI',
    nextDescentGate: nextGate,
    reason:
      'SRI: S帯でQ3かつuncover連続(>=2)かつ安全条件クリアのため、上位帯域へ1ステップ回転',
  };
}

/**
 * 互換用：旧API（shouldRotateBand）を残す
 * - 新設の decideRotation を使い、nextDepth と shouldRotate だけ返す
 */
export function shouldRotateBand(ctx: RotationContext): {
  shouldRotate: boolean;
  nextDepth?: Depth;
  reason: string;
} {
  const d = decideRotation(ctx);
  return {
    shouldRotate: d.shouldRotate,
    nextDepth: d.nextDepth,
    reason: d.reason,
  };
}

/**
 * 「帯域」単位で一段だけ上に回転させた Depth を返す（SRI用）
 *
 * S/F → R/C → I/T
 * - S帯(S1〜S3) → R帯の入口 = R1
 * - R/C帯(R1〜C3) → I帯の入口 = I1
 * - I/T帯(I1〜T3) / F帯(F1〜F3) → それ以上は回転させない
 */
export function nextDepthForBand(current: Depth): Depth {
  const head = current[0]; // 'S' | 'R' | 'I' | 'T' | 'C' | 'F'

  if (head === 'S') return 'R1' as Depth;
  if (head === 'R' || head === 'C') return 'I1' as Depth;

  // I / T / F は SRI では上がらない
  return current;
}

/**
 * TCF 用：T → C → F を 1ステップ進める
 * - T帯(T1〜T3) → C1
 * - C帯(C1〜C3) → F1
 * - F帯(F1〜F3) → 進めない（完了判定は上位で）
 */
export function nextDepthForTCF(current: Depth): Depth {
  const head = current[0]; // 'S' | 'R' | 'C' | 'I' | 'T' | 'F'

  if (head === 'T') return 'C1' as Depth;
  if (head === 'C') return 'F1' as Depth;

  // F帯（もしくは想定外）は維持
  return current;
}

/** I/T帯に近いか（下降の扉を出しやすい領域） */
function isInUpperBand(depth: Depth): boolean {
  const head = depth[0];
  return head === 'I' || head === 'T';
}
