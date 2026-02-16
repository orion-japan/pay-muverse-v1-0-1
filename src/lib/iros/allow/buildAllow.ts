// src/lib/iros/allow/buildAllow.ts
// iros — allow builder (進行圧コントローラ)
//
// 📘 spec: allow 仕様書（IROS 進行制御レイヤー）
// - allow は「今このターンでどこまで押してよいか」を決めるパラメータ
// - Digest が座標固定、allow は進行圧（表現強度 / 断定許可 / 抽象度許可）
// - lane を上書きしない：lane=何をするか / allow=どれくらい強くやるか

export type AllowStrength = 0 | 1 | 2 | 3;

export type Allow = {
  assert: boolean; // 断定OK
  narrow: boolean; // 抽象削減OK
  propose: boolean; // 提案OK
  concretize: boolean; // 具体化OK
  commit_hint: boolean; // コミット誘導OK（Tでも IT確定時のみ true）
  strength: AllowStrength; // 押し強度
};

export type BuildAllowArgs = {
  depthStage: string | null; // e.g. "R3"
  laneKey: string | null; // e.g. "IDEA_BAND" | "T_CONCRETIZE" | null
  repeatSignal?: boolean | null;
  qPrimary?: string | null; // e.g. "Q2"
  itOk?: boolean | null; // IT確定/コミット状態（true の時だけ commit_hint を許可）
};

export const ALLOW_DEFAULT: Allow = {
  assert: false,
  narrow: false,
  propose: true,
  concretize: false,
  commit_hint: false,
  strength: 1,
};

function clampStrength(n: number): AllowStrength {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n === 2) return 2;
  return 3;
}

function mergeAllow(base: Allow, patch: Partial<Allow>): Allow {
  return {
    assert: typeof patch.assert === 'boolean' ? patch.assert : base.assert,
    narrow: typeof patch.narrow === 'boolean' ? patch.narrow : base.narrow,
    propose: typeof patch.propose === 'boolean' ? patch.propose : base.propose,
    concretize: typeof patch.concretize === 'boolean' ? patch.concretize : base.concretize,
    commit_hint: typeof patch.commit_hint === 'boolean' ? patch.commit_hint : base.commit_hint,
    strength: typeof patch.strength === 'number' ? clampStrength(patch.strength) : base.strength,
  };
}

// depthStage の傾向（S/R/C/I/T）
// spec:
// - S帯 assert:false, strength:0
// - R帯 propose:true
// - C帯 narrow:true
// - I帯 assert:true(弱), strength:2
// - T帯 concretize:true, commit_hint:true（ただし commit_hint は IT確定時のみ）
function allowByDepth(depthStage: string | null): Partial<Allow> {
  const d = String(depthStage ?? '').trim().toUpperCase();
  const head = d.slice(0, 1); // "S" | "R" | "C" | "I" | "T"
  if (head === 'S') return { assert: false, strength: 0 };
  if (head === 'R') return { propose: true, strength: 1 };
  if (head === 'C') return { narrow: true, strength: 1 };
  if (head === 'I') return { assert: true, strength: 2 };
  if (head === 'T') return { concretize: true, strength: 3 };
  return {};
}

// lane の傾向
// spec:
// - IDEA_BAND: propose:true, assert:false
// - T_CONCRETIZE: concretize:true
// - GROUND: assert:false, strength:0
// - REMAKE: narrow:true
function allowByLane(laneKey: string | null): Partial<Allow> {
  const k = String(laneKey ?? '').trim().toUpperCase();
  if (k === 'IDEA_BAND') return { propose: true, assert: false };
  if (k === 'T_CONCRETIZE') return { concretize: true };
  if (k === 'GROUND') return { assert: false, strength: 0 };
  if (k === 'REMAKE') return { narrow: true };
  return {};
}

function qStrengthDelta(qPrimary: string | null): number {
  // spec:
  // - 抵抗強（Q3など） strength-1
  // - 推進強（Q2など） strength+1
  // まずは仕様書の例に合わせて最小集合で実装（必要なら後で拡張）
  const q = String(qPrimary ?? '').trim().toUpperCase();
  if (q === 'Q3') return -1;
  if (q === 'Q2') return +1;
  return 0;
}

export function buildAllow(args: BuildAllowArgs): Allow {
  const base0 = mergeAllow(ALLOW_DEFAULT, allowByDepth(args.depthStage ?? null));
  const base1 = mergeAllow(base0, allowByLane(args.laneKey ?? null));

  // repeat_signal: strength を 1 下げる（最小 0）
  const repeat = args.repeatSignal === true;
  const strengthAfterRepeat = clampStrength((base1.strength as number) + (repeat ? -1 : 0));

  // Q補正
  const strengthAfterQ = clampStrength((strengthAfterRepeat as number) + qStrengthDelta(args.qPrimary ?? null));

  // IT ok の時だけ commit_hint を許可
  const itOk = args.itOk === true;

  // ✅ commit_hint は「T帯 かつ IT確定」のときだけ true（仕様の重要事項）
  const head = String(args.depthStage ?? '').trim().toUpperCase().slice(0, 1);
  const commitHint = head === 'T' && itOk;

  return {
    ...base1,
    strength: strengthAfterQ,
    commit_hint: commitHint,

    // ✅ commit_hint が true の時だけ concretize を強制（T帯のみで自然）
    concretize: commitHint ? true : base1.concretize,
  };

}

export function formatAllowSystemText(allow: Allow): string {
  // spec: system補助として [ALLOW] + JSON/kv を渡す
  // ここは “見やすさ優先” の1ブロック（writer側でルールに使う）
  return [
    '[ALLOW]',
    `assert: ${allow.assert}`,
    `narrow: ${allow.narrow}`,
    `propose: ${allow.propose}`,
    `concretize: ${allow.concretize}`,
    `commit_hint: ${allow.commit_hint}`,
    `strength: ${allow.strength}`,
  ].join('\n');
}
