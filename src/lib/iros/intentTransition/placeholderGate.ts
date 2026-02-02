// src/lib/iros/intentTransition/placeholderGate.ts
// iros — PlaceholderGate (release + direction options)
//
// 目的：
// - 「仮置き解除」の判断を一箇所に集約する（single source of truth）
// - 解除後の “方向候補” と “デフォルト方向” を最大3つに絞って返す
//
// 制約：
// - LLMは使わない
// - depthStage を勝手に上げない（候補を返すだけ）
// - 既存IT/anchor commit の決定を置換しない（補助のみ）
// - ログは出さない（上位で必要なら出す）

export type DirectionKey = 'S_TO_R' | 'R_TO_I' | 'I_TO_T' | 'T_TO_C' | 'C_TO_F';

export type PlaceholderGateInput = {
  depthStage: string | null;

  // goalKindHint は nextStepOptions の世界観に寄せる（uncover/stabilize/forward）
  goalKindHint?: 'uncover' | 'stabilize' | 'forward' | null;

  // computeITTrigger.flags 互換
  itFlags?: {
    declarationOk?: boolean;
    deepenOk?: boolean;
    sunOk?: boolean;
    hasCore?: boolean;
    coreRepeated?: boolean;
  } | null;

  // intentBridge 互換
  intentBridge?: {
    intentEntered?: true;
    itReconfirmed?: true;
  } | null;
};

export type PlaceholderGateResult = {
  placeholderReleased: boolean;
  releaseReason: string;

  // 解除後のみセットされる（解除してない時は null）
  defaultDirection: DirectionKey | null;

  // 常に返す（最大3）
  directions: DirectionKey[];
};

export function decidePlaceholderGate(
  input: PlaceholderGateInput,
): PlaceholderGateResult {
  const depth = safeStr(input.depthStage);
  const goal = input.goalKindHint ?? null;

  const declOk = input.itFlags?.declarationOk === true;
  const itReconfirmed = input.intentBridge?.itReconfirmed === true;

  // --- 1) 仮置き解除判定 ---
  // v1：宣言が最優先。I→T再同期は “解除補助” として扱う
  const placeholderReleased = declOk || itReconfirmed;

  const releaseReason = placeholderReleased
    ? declOk
      ? 'DECLARATION_OK'
      : 'IT_RECONFIRMED'
    : 'HOLD';

  // --- 2) 現在位置から “基本の次矢印” を決める ---
  const baseNext = baseDirectionFromDepth(depth);

  // --- 3) 方向候補（最大3）を構成 ---
  // 基本：baseNext を中心に、goalHint に応じて 1つ前/1つ先を足す
  const dirs: DirectionKey[] = [];

  // uncover: 1つ前も候補に（掘る）
  if (goal === 'uncover') {
    const prev = prevDirection(baseNext);
    if (prev) dirs.push(prev);
  }

  dirs.push(baseNext);

  // forward: 1つ先も候補に（進める）
  if (goal === 'forward') {
    const next = nextDirection(baseNext);
    if (next) dirs.push(next);
  }

  // dedupe + cap 3
  const directions = uniq(dirs).slice(0, 3);

  // --- 4) デフォルト方向 ---
  // 解除していない間は default を決めない（誤誘導防止）
  const defaultDirection = placeholderReleased ? baseNext : null;

  // ただし I→T は “再同期” が無いならデフォルトにしない（候補止まり）
  if (
    defaultDirection === 'I_TO_T' &&
    placeholderReleased &&
    !itReconfirmed &&
    !declOk
  ) {
    // v1ではここに来ない想定だが安全策
    return {
      placeholderReleased,
      releaseReason,
      defaultDirection: null,
      directions,
    };
  }

  return {
    placeholderReleased,
    releaseReason,
    defaultDirection,
    directions,
  };
}

/* -----------------------------
   helpers
----------------------------- */

function safeStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function baseDirectionFromDepth(depthStage: string): DirectionKey {
  const d = depthStage.trim().toUpperCase();

  // ざっくり先頭文字で判定（S1/R3/C1/I2/T3 など想定）
  const head = d.length > 0 ? d[0] : '';

  if (head === 'S') return 'S_TO_R';
  if (head === 'R') return 'R_TO_I';
  if (head === 'I') return 'I_TO_T';
  if (head === 'T') return 'T_TO_C';
  if (head === 'C') return 'C_TO_F';

  // 空/未知は保守：S→R
  return 'S_TO_R';
}

function prevDirection(dir: DirectionKey): DirectionKey | null {
  if (dir === 'S_TO_R') return null;
  if (dir === 'R_TO_I') return 'S_TO_R';
  if (dir === 'I_TO_T') return 'R_TO_I';
  if (dir === 'T_TO_C') return 'I_TO_T';
  if (dir === 'C_TO_F') return 'T_TO_C';
  return null;
}

function nextDirection(dir: DirectionKey): DirectionKey | null {
  if (dir === 'S_TO_R') return 'R_TO_I';
  if (dir === 'R_TO_I') return 'I_TO_T';
  if (dir === 'I_TO_T') return 'T_TO_C';
  if (dir === 'T_TO_C') return 'C_TO_F';
  if (dir === 'C_TO_F') return null;
  return null;
}

function uniq<T>(xs: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const k = String(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}
