// src/lib/iros/policy/rulebook.ts
// Iros Policy Rulebook v1 — 全体ルール（決定権の集約）
// 目的：SILENCE を本当の無出力にし、後段の「勝手な生成/整形/保存」を禁止する。

export type SpeechAct = 'SILENCE' | 'FORWARD' | 'RENDER' | 'BLOCK' | 'ERROR';

export type PolicyReasonCode =
  | 'HARD_STOP__SILENCE'
  | 'HARD_STOP__BLOCK'
  | 'HARD_STOP__ERROR'
  | 'NO_LLM'
  | 'NO_RENDER'
  | 'EMPTY_TEXT__DROP'
  | 'NORMAL__ALLOW'
  | 'DEBUG';

export type PolicyDecision = Readonly<{
  act: SpeechAct;

  // 生成許可（LLM）
  allowLLM: boolean;

  // 固定文/レンダー許可（RenderEngineなど）
  allowRender: boolean;

  // 表示するか
  shouldDisplay: boolean;

  // 保存するか（DB message を作るか）
  shouldPersist: boolean;

  // 確定テキスト（SILENCEのときは '' を強制）
  text: string;

  // デバッグ・監査用
  reasons: ReadonlyArray<{ code: PolicyReasonCode; detail?: string }>;

  // 「以後の層は触るな」フラグ（秩序の鍵）
  frozen: true;
}>;

export type PolicyInput = {
  // upstream が決めた act（候補）
  actCandidate?: SpeechAct | null;

  // upstream が生成した text（候補）
  textCandidate?: string | null;

  // upstream で LLM を止めたい/止まっている
  allowLLM?: boolean | null;

  // upstream で render を止めたい/止まっている
  allowRender?: boolean | null;

  // すでに「沈黙にしたい」などのハードな意図
  hardStop?: SpeechAct | null; // 'SILENCE' | 'BLOCK' | 'ERROR' を想定

  // デバッグ用（任意）
  debugLabel?: string | null;
};

function freezeDecision(d: Omit<PolicyDecision, 'frozen'>): PolicyDecision {
  // Object.freeze で後段のミューテーションを防ぐ（実効性が高い）
  const frozen = Object.freeze({ ...d, frozen: true as const });
  return frozen;
}

/**
 * ✅ evaluatePolicy（最終決定）
 * ここでのみ act / allow / 表示 / 保存 / text を確定させる。
 * 後段は PolicyDecision を「読むだけ」にする（上書き禁止）。
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const reasons: Array<{ code: PolicyReasonCode; detail?: string }> = [];

  const act0: SpeechAct | null =
    (input.hardStop as SpeechAct | null) ??
    (input.actCandidate as SpeechAct | null) ??
    null;

  const allowLLM0 = input.allowLLM !== null && input.allowLLM !== undefined ? !!input.allowLLM : true;
  const allowRender0 =
    input.allowRender !== null && input.allowRender !== undefined ? !!input.allowRender : true;

  const text0 = (input.textCandidate ?? '') as string;

  if (input.debugLabel) reasons.push({ code: 'DEBUG', detail: input.debugLabel });

  // =========================================================
  // 1) HARD STOP（最上位の秩序）— 以後、誰も触れない
  // =========================================================
  if (act0 === 'SILENCE') {
    reasons.push({ code: 'HARD_STOP__SILENCE' });
    return freezeDecision({
      act: 'SILENCE',
      allowLLM: false,
      allowRender: false,
      shouldDisplay: false,
      shouldPersist: false,
      text: '', // ★ “…” を絶対に返さない
      reasons,
    });
  }

  if (act0 === 'BLOCK') {
    reasons.push({ code: 'HARD_STOP__BLOCK' });
    // BLOCK は UI/UX 方針次第だが、ここでは「表示はするが保存しない」例
    // 必要なら shouldPersist=true に変更可
    return freezeDecision({
      act: 'BLOCK',
      allowLLM: false,
      allowRender: false,
      shouldDisplay: true,
      shouldPersist: false,
      text: text0.trim() ? text0 : 'BLOCK', // ただし fallback 生成は禁止（最低限の文字のみ）
      reasons,
    });
  }

  if (act0 === 'ERROR') {
    reasons.push({ code: 'HARD_STOP__ERROR' });
    return freezeDecision({
      act: 'ERROR',
      allowLLM: false,
      allowRender: false,
      shouldDisplay: true,
      shouldPersist: true,
      text: text0.trim() ? text0 : 'ERROR',
      reasons,
    });
  }

  // =========================================================
  // 2) 生成許可（LLM/Render）の秩序
  // =========================================================
  let allowLLM = allowLLM0;
  let allowRender = allowRender0;

  if (!allowLLM) reasons.push({ code: 'NO_LLM' });
  if (!allowRender) reasons.push({ code: 'NO_RENDER' });

  // =========================================================
  // 3) 空文字は “沈黙扱い”（表示/保存しない）
  //    ※ ここが DB 汚染の止血点
  // =========================================================
  const trimmed = (text0 ?? '').trim();
  if (!trimmed) {
    reasons.push({ code: 'EMPTY_TEXT__DROP' });
    return freezeDecision({
      act: 'SILENCE', // 空は沈黙として扱う（UI/DB を静かにする）
      allowLLM: false,
      allowRender: false,
      shouldDisplay: false,
      shouldPersist: false,
      text: '',
      reasons,
    });
  }

  // =========================================================
  // 4) 通常（ここで初めて「出してよい」状態）
  // =========================================================
  reasons.push({ code: 'NORMAL__ALLOW' });

  // act が未指定なら、生成経路に応じて自動決定（最低限）
  const act: SpeechAct =
    act0 ??
    (allowRender ? 'RENDER' : allowLLM ? 'FORWARD' : 'FORWARD');

  return freezeDecision({
    act,
    allowLLM,
    allowRender,
    shouldDisplay: true,
    shouldPersist: true,
    text: text0,
    reasons,
  });
}
// ✅ rulebook compat (renderReply 直前に噛ませる最小ラッパ)
export function applyRulebookCompat(args: {
  vector: any;
  input: any;
  opts: any;
  meta: any;
  extraForHandle?: any;
}): {
  vector: any;
  input: any;
  opts: any;
  meta: any;
  extraForHandle?: any;
} {
  // いまは “通すだけ” の最小。後でここに rulebook 適用ロジックを足す。
  return args;
}
