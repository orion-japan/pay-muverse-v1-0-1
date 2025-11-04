// src/state/resonance/state.ts
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | null;
export type Phase = 'Inner' | 'Outer' | null;
// 進行座標（S1〜I3/T3 まで。必要に応じて拡張）
export type DepthStage =
  | 'S1'
  | 'S2'
  | 'S3'
  | 'S4'
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

export type RelationLabel = 'conflict' | 'neutral' | 'harmony' | null;

export type ResonanceState = {
  userCode: string | null;

  // 主要シグナル
  currentQ: QCode;
  nextQ: QCode;
  phase: Phase; // 位相ベクトル
  depthStage: DepthStage; // 認識深度レベル（進行座標）
  selfAcceptanceScore: number | null; // 0-100 想定
  relationLabel: RelationLabel;
  relationConfidence: number | null; // 0-1

  // タイムスタンプ
  updatedAt: string | null; // ISO
  lastAt: string | null; // ISO（サーバの "last_at" 互換）
};

export const initialResonanceState: ResonanceState = {
  userCode: null,
  currentQ: null,
  nextQ: null,
  phase: null,
  depthStage: null,
  selfAcceptanceScore: null,
  relationLabel: null,
  relationConfidence: null,
  updatedAt: null,
  lastAt: null,
};

// ===== 永続化鍵（ユーザー別にスコープ） =====
const keyOf = (userCode: string) => `resonance:${userCode}`;

export function loadFromStorage(userCode: string): ResonanceState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(keyOf(userCode));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed as ResonanceState;
  } catch {
    return null;
  }
}

export function saveToStorage(state: ResonanceState) {
  if (typeof window === 'undefined') return;
  if (!state.userCode) return;
  try {
    localStorage.setItem(keyOf(state.userCode), JSON.stringify(state));
  } catch {
    // no-op
  }
}

// ====== サーバ同期（/api/q/unified）======
// 既存APIのレスポンス例：
// { ok:true, data:{ user_code, current_q, depth_stage, updated_at, q_hint, confidence, last_at } }

// ★ 追加：IDトークン取得（Firebase優先・Supabaseをフォールバック）
async function getAuthToken(): Promise<string | null> {
  try {
    if (typeof window === 'undefined') return null;

    // Firebase Auth
    const { getAuth } = await import('firebase/auth');
    const auth = getAuth();
    const user = auth.currentUser;
    if (user) {
      return await user.getIdToken(true);
    }
  } catch {
    // noop
  }

  // Supabase セッションがある場合のフォールバック
  try {
    const { supabase } = await import('@/lib/supabase');
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  } catch {
    return null;
  }
}

export async function fetchUnifiedQ(userCode: string) {
  const token = await getAuthToken();

  const res = await fetch(`/api/q/unified?user_code=${encodeURIComponent(userCode)}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), // ← ここが重要
    },
    cache: 'no-store',
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || `fetchUnifiedQ failed (${res.status})`;
    throw new Error(msg);
  }
  return json?.data ?? null;
}

// ===== エージェントから返る meta を取り込み =====
// （Mu/Iros のレスポンス meta を想定：phase/selfAcceptance/relation/nextQ/currentQ など）
export type AgentMeta = {
  phase?: Phase;
  selfAcceptance?: { score?: number };
  relation?: { label?: RelationLabel; confidence?: number };
  nextQ?: QCode | null;
  currentQ?: QCode | null;
  // 任意で depthStage / timestamps が付くケースにも対応
  depthStage?: DepthStage | null;
  updated_at?: string | null;
  last_at?: string | null;
};

export function reduceWithAgentMeta(prev: ResonanceState, meta: AgentMeta): ResonanceState {
  const next: ResonanceState = {
    ...prev,
    phase: meta.phase ?? prev.phase,
    selfAcceptanceScore: meta.selfAcceptance?.score ?? prev.selfAcceptanceScore,
    relationLabel: meta.relation?.label ?? prev.relationLabel,
    relationConfidence: meta.relation?.confidence ?? prev.relationConfidence,
    nextQ: meta.nextQ ?? prev.nextQ,
    currentQ: meta.currentQ ?? prev.currentQ,
    depthStage: meta.depthStage ?? prev.depthStage,
    updatedAt: meta.updated_at ?? new Date().toISOString(),
    lastAt: meta.last_at ?? prev.lastAt,
  };
  return next;
}

// ===== サーバ状態を取り込み（/api/q/unified → state）=====
export function reduceWithUnifiedQ(prev: ResonanceState, unified: any): ResonanceState {
  const next: ResonanceState = {
    ...prev,
    currentQ: (unified?.current_q ?? null) as QCode,
    depthStage: (unified?.depth_stage ?? null) as DepthStage,
    updatedAt: unified?.updated_at ?? prev.updatedAt,
    lastAt: unified?.last_at ?? prev.lastAt,
    // サーバの "q_hint" と "confidence" は UI 表示に使うことが多い
    // 必要に応じて nextQ / relationConfidence に流用しない設計にしておく
  };
  return next;
}
