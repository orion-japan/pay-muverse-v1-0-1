// src/state/resonance/ResonanceContext.tsx
'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ResonanceState,
  initialResonanceState,
  AgentMeta,
  fetchUnifiedQ,
  loadFromStorage,
  saveToStorage,
  reduceWithAgentMeta,
  reduceWithUnifiedQ,
} from './state';

type Actions = {
  /** userCode をセット（切替時にストレージからも復元） */
  setUserCode: (userCode: string | null) => void;
  /** /api/q/unified からロードして反映 */
  syncFromServer: () => Promise<void>;
  /** エージェント応答の meta をそのまま流し込む */
  syncFromAgentMeta: (meta: AgentMeta) => void;
  /** 直接パッチ（UIからの明示変更など） */
  patch: (partial: Partial<ResonanceState>) => void;
};

type Ctx = {
  state: ResonanceState;
  actions: Actions;
};

const ResonanceContext = createContext<Ctx | null>(null);

export function ResonanceProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ResonanceState>(initialResonanceState);
  const userCodeRef = useRef<string | null>(null);

  const setUserCode = useCallback((userCode: string | null) => {
    userCodeRef.current = userCode;
    setState((s) => {
      const next = { ...s, userCode };
      if (userCode) {
        const stored = loadFromStorage(userCode);
        return stored ? stored : next;
      }
      return next;
    });
  }, []);

  const persist = useCallback((s: ResonanceState) => {
    saveToStorage(s);
  }, []);

  const syncFromServer = useCallback(async () => {
    const uc = userCodeRef.current;
    if (!uc) return;
    try {
      const unified = await fetchUnifiedQ(uc);
      setState((prev) => {
        const next = reduceWithUnifiedQ(prev, unified);
        persist(next);
        return next;
      });
    } catch {
      // no-op（ネットワーク不調でもUIが落ちないように）
    }
  }, [persist]);

  const syncFromAgentMeta = useCallback(
    (meta: AgentMeta) => {
      setState((prev) => {
        const next = reduceWithAgentMeta(prev, meta);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const patch = useCallback(
    (partial: Partial<ResonanceState>) => {
      setState((prev) => {
        const next = { ...prev, ...partial, updatedAt: new Date().toISOString() };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  // 初回 & userCode 変化時にストレージ復元 + サーバ同期
  useEffect(() => {
    const uc = userCodeRef.current;
    if (!uc) return;
    const stored = loadFromStorage(uc);
    if (stored) setState(stored);
    // 背景同期（待たせない）
    syncFromServer();
  }, [syncFromServer]);

  const actions: Actions = useMemo(
    () => ({ setUserCode, syncFromServer, syncFromAgentMeta, patch }),
    [patch, setUserCode, syncFromServer, syncFromAgentMeta],
  );

  const value = useMemo<Ctx>(() => ({ state, actions }), [state, actions]);

  return <ResonanceContext.Provider value={value}>{children}</ResonanceContext.Provider>;
}

export function useResonance() {
  const ctx = useContext(ResonanceContext);
  if (!ctx) throw new Error('useResonance must be used within ResonanceProvider');
  return ctx;
}
