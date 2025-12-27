// file: src/lib/iros/intentTransition/types.ts
// iros - Intent Transition v1.0 (types)
// - R→C jump forbid
// - R→I→T→C
// - T opens only by behavioral evidence (choice/commit/repeat)

export type SpinLoop = 'SRI' | 'TCF';

// 既存の depthStage（S1〜T3）と整合させる前提。
// ここでは string 互換にしておき、system.ts 側の Depth 型が確定しているなら
// orchestrator で合流させる（v1.0では衝突を避ける）。
export type DepthStage = string;

// v1.0 の「遷移ステップ」：最小保存対象
export type IntentTransitionStep =
  | 'recognize' // R
  | 'idea_loop' // I（案出し継続）
  | 't_closed' // T gate closed（刺さり待ち）
  | 't_open' // T gate open（刺さり成立）
  | 'create'; // C（創造/実行）

export type AnchorEventType = 'none' | 'confirm' | 'set' | 'reset';

export type TGateState = 'closed' | 'open';

export type TransitionRoute = 'stay_sri' | 'stay_tcf' | 'to_sri' | 'to_tcf';

export type TransitionDecisionKind =
  | 'stay'
  | 'enter_idea_loop'
  | 'open_t_gate'
  | 'advance_depth'
  | 'forbid_jump';

// signals.ts が返す「遷移材料」
// ※ここでの signals は “推論” ではなく “証拠” を中心にする
export type IntentSignals = {
  // 入力テキスト（デバッグ用に保持してよいが、永続化はしない前提）
  text: string;

  // Iに入るトリガ（案出し要求 / 探索要求）
  wantsIdeas: boolean;

  // Cに行きたがっている要求（実装/手順/作り方/次アクション）
  wantsExecution: boolean;

  // 「選択」証拠（Aにする/これ/それ 等）
  hasChoiceEvidence: boolean;

  // 「コミット」証拠（やる/決めた/続ける/期限決めた 等）
  hasCommitEvidence: boolean;

  // 「反復」証拠（同一方向の再要求、同一名札の再選択など）
  hasRepeatEvidence: boolean;

  // 明確な否定（やめる/違う/無理/保留/戻す 等）
  hasResetEvidence: boolean;
};

// engine入力：Orchestrator finalize 直前に必要な最低限
export type IntentTransitionState = {
  // 直前確定（MemoryState由来）
  lastDepthStage?: DepthStage;
  lastSpinLoop?: SpinLoop;

  // 現在（ORCH が算出した暫定。ここから policy/engine で確定に寄せる）
  currentDepthStage?: DepthStage;
  currentSpinLoop?: SpinLoop;

  // 現在のTゲート状態（MemoryState / 直近meta）
  tGate?: TGateState;

  // アンカー状態（MemoryState / 直近meta）
  anchorEventType?: AnchorEventType;
};

// policy：宣言的に v1.0 の禁止/許可をまとめる
export type IntentTransitionPolicy = {
  // R→C 禁止を強制するか
  forbidRtoCJump: boolean;

  // T は “雰囲気” では開かない（choice/commit/repeat の証拠だけ）
  tGateRequiresBehavioralEvidence: boolean;

  // anchor が set されていないのに C2/C3 へ進めない、という思想をここで固定
  requireAnchorSetForCommit: boolean;
};

// engine出力：最終確定に反映される差分＋保存スナップショット
export type IntentTransitionResult = {
  decision: TransitionDecisionKind;

  // 次の確定値（orchestrator がこれを採用して final を作る）
  nextDepthStage?: DepthStage;
  nextSpinLoop?: SpinLoop;
  nextTGate?: TGateState;

  // スナップショットとして永続化する最小セット（persist に渡す）
  snapshot: {
    step: IntentTransitionStep;
    anchorEventType: AnchorEventType;
    reason: string; // デバッグ用（短文）
  };

  // 追加ログ（debug/explain 用）
  debug?: {
    route?: TransitionRoute;
    forbidJumpApplied?: boolean;
  };
};

// 永続化（v1.0）で保存する最小フィールド
// ※実際のDBカラム名は persist 層でマッピングする（ここは意味モデル）
export type PersistTransitionSnapshot = {
  intent_transition_step: IntentTransitionStep;
  anchor_event_type: AnchorEventType;
  last_transition_at: string; // ISO
  transition_reason: string;
};
