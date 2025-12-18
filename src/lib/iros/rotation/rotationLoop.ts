// file: src/lib/iros/rotation/rotationLoop.ts
// iros — Descent Gate Judge (pure, minimal)
// - Qコード + sa(self_acceptance) + 深度の帯域で「落下/復帰」を決める
// - ヒステリシスあり（落下条件と復帰条件を分ける）
// - LLM禁止：状態メタだけ
//
// ✅ 方針：descentGate は boolean を捨てて string union に統一する
//   'closed'  : 落下していない（通常）
//   'offered' : 落下を提案/開始（下降に入ってよい）
//   'accepted': 落下を受理（下降中・保持）
//
// ※ 互換：入力側で boolean が来る場合は bridge 側で正規化する（このファイルでは扱わない）

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | null;

export type DepthStage =
  | 'S1'
  | 'S2'
  | 'S3'
  | 'F1'
  | 'F2'
  | 'F3'
  | 'R1'
  | 'R2'
  | 'R3'
  | 'C1'
  | 'C2'
  | 'C3'
  | 'I1'
  | 'I2'
  | 'I3'
  | 'T1'
  | 'T2'
  | 'T3'
  | null;

export type DescentGateState = 'closed' | 'offered' | 'accepted';

export type DescentGateInput = {
  qCode: QCode | null;
  sa: number | null;

  // ★ 修正：厳密型を要求しない
  depthStage: string | null;

  // ★ 追加：ユーザー本文（境界ワード検出に使う）
  // - Orchestrator の 7.5 から userText: text を渡す
  userText?: string | null;

  targetKind?: string | null;
  prevDescentGate?: DescentGateState | null;
};

export type DescentGateDecision = {
  descentGate: DescentGateState;
  reason: string;
};

/** 数値を 0..1 に丸める */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function depthLetter(
  depthStage: string | null
): '' | 'S' | 'F' | 'R' | 'C' | 'I' | 'T' {
  if (!depthStage) return '';
  if (depthStage === 'S4') return ''; // ★ 幽霊値は無視

  const m = depthStage.match(/^([SRCFIT])[123]$/);
  return m ? (m[1] as any) : '';
}

/**
 * ★ 境界（踏み込まれたくない）検出
 * - SA/Q が安定していても、ここが来たら「問い圧」を下げるため descentGate を offered/accepted に寄せる
 * - 目的：SAFE スロットを確実に立てる（Frame/Slots側）
 */
function detectBoundaryRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;

  const patterns: RegExp[] = [
    /踏み込(まれ)?たくない/,
    /踏み込まないで/,
    /放っておいて/,
    /放置して/,
    /もう(これ以上)?(踏み込まないで|やめて|やだ|無理)/,
    /(ひとり|一人)にして/,
    /距離(を)?(置きたい|ほしい|取りたい)/,
    /聞かないで/,
    /触れないで/,
    /詮索しないで/,
    /干渉しないで/,
  ];

  return patterns.some((re) => re.test(t));
}

/**
 * ✅ 落下ゲート判定
 * - 落下しやすい: Q3/Q4 + sa低い + (S/F/R帯にいる or targetKindが防御/未消化)
 * - 復帰しやすい: saが回復 + Q1/Q5 + (C/I/T帯に戻る)
 */
export function decideDescentGate(input: DescentGateInput): DescentGateDecision {
  const q = input.qCode;
  const sa = clamp01(typeof input.sa === 'number' ? input.sa : 0.55);
  const band = depthLetter(input.depthStage);
  const prev: DescentGateState = input.prevDescentGate ?? 'closed';

  const target = String(input.targetKind ?? '').toLowerCase();

  // ---- ざっくり帯域（今どこにいるか） ----
  const isLowBand = band === 'S' || band === 'F' || band === 'R'; // 反応/防御/反芻が起きやすい帯
  const isHighBand = band === 'C' || band === 'I' || band === 'T'; // 俯瞰/創造/超越帯

  // ---- “話の流れ”としてのQ傾向 ----
  const qIsDrop = q === 'Q3' || q === 'Q4'; // 不安/恐怖 → 反芻・自己否定に落ちやすい
  const qIsRise = q === 'Q1' || q === 'Q5'; // 意志/情熱 → 復帰しやすい（※思想に合わせて調整OK）

  // ---- targetKind（任意） ----
  const targetIsDefensive =
    target.includes('defend') ||
    target.includes('protect') ||
    target.includes('avoid') ||
    target.includes('block') ||
    target.includes('uncover') || // “未消化を掘る”は落下を誘発しやすい
    target.includes('shadow');

  // ---- 閾値（ヒステリシス）----
  // 落下開始: sa <= 0.45
  // 復帰開始: sa >= 0.58（落下より高めに設定してフラつきを防ぐ）
  const DROP_SA = 0.45;
  const RECOVER_SA = 0.58;

  const prevIsDown = prev === 'offered' || prev === 'accepted';

  // ========== 0) 境界ワードが来たら最優先で “下降ゲート” を開く ==========
  // - 初回：offered（「踏み込みません」モード）
  // - すでに下降中：accepted を保持（減速継続）
  if (detectBoundaryRequest(input.userText)) {
    if (prevIsDown) {
      return {
        descentGate: 'accepted',
        reason: `boundary-hold: prev=${prev}, sa=${sa.toFixed(
          2
        )}, q=${q ?? 'null'}, band=${band || 'NA'}`,
      };
    }
    return {
      descentGate: 'offered',
      reason: `boundary-offer: sa=${sa.toFixed(2)}, q=${q ?? 'null'}, band=${
        band || 'NA'
      }`,
    };
  }

  // ========== 1) すでに下降中なら「復帰条件」を満たすまで保持 ==========
  if (prevIsDown) {
    // 復帰条件（例）
    if ((sa >= RECOVER_SA && qIsRise) || (sa >= 0.62 && isHighBand)) {
      return {
        descentGate: 'closed',
        reason: `recover: prev=${prev}, sa=${sa.toFixed(2)}, q=${
          q ?? 'null'
        }, band=${band || 'NA'}`,
      };
    }

    // 下降中は accepted に寄せて保持（offered を保持したいならここを prev 返しにしてもOK）
    return {
      descentGate: 'accepted',
      reason: `hold: prev=${prev}, sa=${sa.toFixed(2)}, q=${
        q ?? 'null'
      }, band=${band || 'NA'}`,
    };
  }

  // ========== 2) 下降していないなら「落下開始条件」を見る ==========
  const shouldDrop =
    (sa <= DROP_SA && qIsDrop && (isLowBand || targetIsDefensive)) ||
    (sa <= 0.38 && qIsDrop) || // 強い落下
    (sa <= 0.35 && isLowBand && targetIsDefensive); // Qが欠けても落ちるケース

  if (shouldDrop) {
    return {
      descentGate: 'offered',
      reason: `drop: sa=${sa.toFixed(2)}, q=${q ?? 'null'}, band=${
        band || 'NA'
      }, target=${target || 'NA'}`,
    };
  }

  return {
    descentGate: 'closed',
    reason: `stable: sa=${sa.toFixed(2)}, q=${q ?? 'null'}, band=${band || 'NA'}`,
  };
}
