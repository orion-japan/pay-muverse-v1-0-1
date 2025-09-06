// src/lib/mu/state.ts
// Mu 会話の状態管理（意図確認中 → 合意済み → 完了）

import { MU_STATES } from "@/lib/mu/config";

export type MuStateKey = keyof typeof MU_STATES; // "INTENT_CHECKING" | "AGREED" | "DONE"

export type MuState = {
  key: MuStateKey;
  label: string;
  enteredAt: string;
};

/** 初期状態を返す */
export function initMuState(): MuState {
  return {
    key: "INTENT_CHECKING",
    label: MU_STATES.INTENT_CHECKING,
    enteredAt: new Date().toISOString(),
  };
}

/** 合意済みへ遷移 */
export function toAgreed(prev: MuState): MuState {
  return {
    key: "AGREED",
    label: MU_STATES.AGREED,
    enteredAt: new Date().toISOString(),
  };
}

/** 完了へ遷移 */
export function toDone(prev: MuState): MuState {
  return {
    key: "DONE",
    label: MU_STATES.DONE,
    enteredAt: new Date().toISOString(),
  };
}

/** 状態が意図確認中かどうか */
export function isIntentChecking(state: MuState): boolean {
  return state.key === "INTENT_CHECKING";
}

/** 状態が合意済みかどうか */
export function isAgreed(state: MuState): boolean {
  return state.key === "AGREED";
}

/** 状態が完了かどうか */
export function isDone(state: MuState): boolean {
  return state.key === "DONE";
}
