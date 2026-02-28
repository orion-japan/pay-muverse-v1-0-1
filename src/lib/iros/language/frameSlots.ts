// src/lib/iros/language/frameSlots.ts
// iros — Layer C/D (Frame Selector + Slot Builder)
// - 本文生成はしない（LLMに依存しない）
// - IrosState と inputKind だけで「器」と「必須スロット」を決める
// - どの層から呼ばれても落ちない（undefined/null耐性を強める）

export const FRAME = {
  S: 'S',
  F: 'F', // 定着・習慣（下降/自己否定時の支え）
  R: 'R',
  C: 'C',
  I: 'I',
  T: 'T',
  MICRO: 'MICRO',
  NONE: 'NONE',
} as const;

export type FrameKind = (typeof FRAME)[keyof typeof FRAME];

export type InputKind =
  | 'micro' // 短文（「やっちゃう？」「どうする？」など）
  | 'chat' // 通常会話
  | 'task' // 実務依頼・実装依頼・作業依頼
  | 'review' // 振り返り・達成サマリ等
  | 'question' // 明確な質問
  | 'card' // ✅ カード閲覧/カードで見てほしい
  | 'unknown';

export type IrosStateLite = {
  // できるだけ薄く（どの層でも渡せる）
  depthStage?: string | null; // 'S1'..'T3' など
  phase?: 'Inner' | 'Outer' | null;
  qCode?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | null;

  // 任意：会話の目標/意図寄り判定用（無くても動く）
  targetKind?: string | null; // 'stabilize' | 'uncover' | ...

  // ✅ 下降（自己否定など）を検知したときの状態
  // 既存実装との互換のため幅を持たせる（boolean / open|closed など）
  descentGate?: boolean | 'open' | 'closed' | string | null;
};

export type SlotId = 'OBS' | 'SHIFT' | 'NEXT' | 'SAFE';

export type SlotPlan = {
  id: SlotId;
  required: true;
  hint?: string; // 本文ではなく「枠」だけ
};

export type FramePlan = {
  frame: FrameKind;
  slots: SlotPlan[];
  reason?: string;
};

/* --------------------------------
   helpers
-------------------------------- */

function safeInputKind(v: unknown): InputKind {
  if (typeof v !== 'string') return 'unknown';
  const s = v.trim().toLowerCase();
  if (
    s === 'micro' ||
    s === 'chat' ||
    s === 'task' ||
    s === 'review' ||
    s === 'question' ||
    s === 'card' ||
    s === 'unknown'
  ) {
    return s as InputKind;
  }
  return 'unknown';
}

function safeState(v: unknown): IrosStateLite {
  if (v && typeof v === 'object') return v as IrosStateLite;
  return {};
}

function isDescentOpen(v: unknown): boolean {
  if (v === true) return true;

  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();

    // 互換：open/true/1 だけを「立ってる」と扱う
    if (s === 'open' || s === 'true' || s === '1') return true;

    // ✅ iros の union を open 扱いに寄せる（重要）
    if (s === 'offered' || s === 'accepted') return true;
  }

  return false;
}


function depthLetter(
  depthStage?: string | null
): 'S' | 'F' | 'R' | 'C' | 'I' | 'T' | null {
  const d = String(depthStage ?? '').trim().toUpperCase();
  if (!d) return null;
  if (d.startsWith('S')) return 'S';
  if (d.startsWith('F')) return 'F';
  if (d.startsWith('R')) return 'R';
  if (d.startsWith('C')) return 'C';
  if (d.startsWith('I')) return 'I';
  if (d.startsWith('T')) return 'T';
  return null;
}

/* --------------------------------
   Layer C: Frame Selector
-------------------------------- */

export function selectFrame(args: {
  state?: IrosStateLite | null;
  inputKind?: InputKind | null;
}): FrameKind {
  const state = safeState(args.state);
  const inputKind = safeInputKind(args.inputKind ?? 'unknown');

  // 1) 短文は最優先で MICRO（本文崩れ対策）
  if (inputKind === 'micro') return FRAME.MICRO;

  // 2) 実務依頼は Creation（作業/実装/設計）
  if (inputKind === 'task') return FRAME.C;

  // 3) 振り返り/レビュー系は NONE（専用ゲートがある前提）or C（整形）
  if (inputKind === 'review') return FRAME.NONE;

  // 4) 下降ゲートが立っているなら、まず F（定着）で支える
  // - I/T に上げると反発が出やすいので、F → S → R の順が安定
  if (isDescentOpen(state.descentGate)) return FRAME.F;

  // 5) 深度が取れるならそれを優先
  const dl = depthLetter(state.depthStage);
  if (dl === 'S') return FRAME.S;
  if (dl === 'F') return FRAME.F;
  if (dl === 'R') return FRAME.R;
  if (dl === 'C') return FRAME.C;
  if (dl === 'I') return FRAME.I;
  if (dl === 'T') return FRAME.T;

  // 6) それ以外は素（後段で調整）
  return FRAME.NONE;
}

/* --------------------------------
   Layer D: Slot Builder
-------------------------------- */

export function buildSlots(args: {
  frame: FrameKind;
  state?: IrosStateLite | null;
  inputKind?: InputKind | null;
}): SlotPlan[] {
  const state = safeState(args.state);
  const inputKind = safeInputKind(args.inputKind ?? 'unknown');
  const frame = args.frame;

  // フレーム共通の最小4点セット
  const base: SlotPlan[] = [
    { id: 'OBS', required: true, hint: '観測（事実/状況の再提示）' },
    { id: 'SHIFT', required: true, hint: '視点の転換（1つだけ）' },
    { id: 'NEXT', required: true, hint: '次の一歩（1つだけ）' },
    { id: 'SAFE', required: true, hint: '安全句（静かな保険）' },
  ];

  // MICRO は “短く保つ” だけを強制
  if (frame === FRAME.MICRO || inputKind === 'micro') {
    return base.map((s) => {
      if (s.id === 'OBS') return { ...s, hint: '観測（短く一行）' };
      if (s.id === 'SHIFT') return { ...s, hint: '視点転換（1フレーズ）' };
      if (s.id === 'NEXT') return { ...s, hint: '次の一歩（1つ、短く）' };
      if (s.id === 'SAFE')
        return { ...s, hint: '安全句（断定しすぎない短い保険）' };
      return s;
    });
  }

  // 下降時（F選択になりやすい）は hint だけ “支える意味” に寄せる（IDは増やさない）
  if (isDescentOpen(state.descentGate) || frame === FRAME.F) {
    return base.map((s) => {
      if (s.id === 'OBS') return { ...s, hint: '観測（ストーリー化せず、事実だけ）' };
      if (s.id === 'SHIFT') return { ...s, hint: '視点転換（評価→運用／責め→扱い）' };
      if (s.id === 'NEXT')
        return { ...s, hint: '次の一歩（極小の1手／成功確率を上げる）' };
      if (s.id === 'SAFE') return { ...s, hint: '安全句（決めつけを解除する一言）' };
      return s;
    });
  }

  // NONE は “枠を弱める” が、最低4点は維持
  return base;
}

export function buildFramePlan(args: {
  state?: IrosStateLite | null;
  inputKind?: InputKind | null;
}): FramePlan {
  const state = safeState(args.state);
  const inputKind = safeInputKind(args.inputKind ?? 'unknown');

  const frame = selectFrame({ state, inputKind });
  const slots = buildSlots({ frame, state, inputKind });

  return {
    frame,
    slots,
    reason: `frame=${frame} by inputKind=${inputKind} depth=${String(
      state.depthStage ?? ''
    )} descentGate=${String(state.descentGate ?? '')}`,
  };
}
