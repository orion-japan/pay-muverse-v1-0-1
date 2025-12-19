// src/lib/iros/language/frameSelector.ts
// iros — Frame Selector（器の選択）
// - 返答の「型（フレーム）」を決める
// - inputKind と IrosState だけで決める（本文は作らない）

/**
 * 入力の種類
 * - orchestrator / tests / router で共有
 */
export type InputKind =
  | 'unknown'
  | 'greeting'
  | 'debug'
  | 'request'
  | 'question'
  | 'micro'
  | 'chat';

/**
 * フレーム（器）
 */
export type FrameKind =
  | 'S'
  | 'R'
  | 'C'
  | 'F'
  | 'I'
  | 'T'
  | 'MICRO'
  | 'NONE';

/**
 * DescentGate（落下ゲート）状態：union 正
 * - closed:   降りない（安全）
 * - offered:  降下を提案する段階
 * - accepted: 降下中（/降下許可済）
 */
export type DescentGateState = 'closed' | 'offered' | 'accepted';

/**
 * FrameSelector が参照する最小状態
 */
export type FrameSelectorState = {
  depth: string | null;
  descentGate: DescentGateState | boolean | null; // ★互換：旧booleanも許可
};

/**
 * descentGate の入力（union/boolean/null）を union に正規化
 */
function normalizeDescentGate(
  v: DescentGateState | boolean | null | undefined
): DescentGateState {
  // 旧互換
  if (v === true) return 'accepted';
  if (v === false) return 'closed';

  // 正規
  if (v === 'closed' || v === 'offered' || v === 'accepted') return v;

  return 'closed';
}

function isDescending(dg: DescentGateState): boolean {
  // 「closed」以外は下降系として扱う
  return dg !== 'closed';
}

function normalizeDepthHead(
  depth: string | null
): 'S' | 'F' | 'R' | 'C' | 'I' | 'T' | null {
  if (!depth || typeof depth !== 'string') return null;
  const s = depth.trim().toUpperCase();
  if (!s) return null;

  const head = (s[0] ?? '') as any;
  if (
    head === 'S' ||
    head === 'F' ||
    head === 'R' ||
    head === 'C' ||
    head === 'I' ||
    head === 'T'
  ) {
    return head;
  }
  return null;
}

/**
 * フレーム選択
 * - 原則：短文は MICRO
 * - 降下（TCF）に入ったら T/C/F を優先する
 * - depth head が I/T/F のときは I/T/F を返しやすくする
 */
export function selectFrame(
  state: FrameSelectorState,
  inputKind: InputKind
): FrameKind {
  const dg = normalizeDescentGate(state?.descentGate);
  const depthHead = normalizeDepthHead(state?.depth);

  // 1) 超短文は器が崩れない MICRO を最優先
  if (inputKind === 'micro') return 'MICRO';

  // 2) デバッグ系は NONE（余計な装飾なし）
  if (inputKind === 'debug') return 'NONE';

  // 3) 実装依頼 / 作業依頼は C（整理された器）
  if (inputKind === 'request') return 'C';

  // 4) 挨拶は NONE（軽く）
  if (inputKind === 'greeting') return 'NONE';

  // 5) 下降中（TCF）なら T/C/F を優先
  if (isDescending(dg)) {
    if (depthHead === 'T') return 'T';
    if (depthHead === 'C') return 'C';
    if (depthHead === 'F') return 'F';

    // depth が取れない場合のフォールバック
    // - offered ＝ まだ降りる前 → T（気づき）
    // - accepted＝ 降下中       → F（支える）
    return dg === 'offered' ? 'T' : 'F';
  }

  // 6) 通常（上昇・安定側）：depth head を素直に反映
  if (depthHead === 'I') return 'I';
  if (depthHead === 'T') return 'T';
  if (depthHead === 'C') return 'C';
  if (depthHead === 'F') return 'F';
  if (depthHead === 'R') return 'R';
  if (depthHead === 'S') return 'S';

  // 7) question / chat のデフォルト
  if (inputKind === 'question') return 'R';

  return 'NONE';
}

/**
 * FramePlan reason の文字列を作る（デバッグ用）
 * - descentGate が空になる事故を防ぐため、ここで必ず normalize
 * - 呼び出し側が state を欠落で渡しても壊れない
 */
export function buildFrameReason(args: {
  frame: FrameKind;
  inputKind: InputKind;
  state: Partial<FrameSelectorState> | null | undefined;
}): string {
  const { frame, inputKind, state } = args;

  const depthStage =
    typeof state?.depth === 'string' && state.depth.trim()
      ? state.depth.trim()
      : '';

  const dg = normalizeDescentGate(state?.descentGate as any);

  return `frame=${frame} by inputKind=${inputKind} depth=${depthStage} descentGate=${dg}`;
}
