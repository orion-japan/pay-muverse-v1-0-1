'use client';
import * as React from 'react';
import { getAuth } from 'firebase/auth';

export type UserInfo = { id: string; name: string; userType: string; credits: number };
export type Conversation = { id: string; title: string; updated_at?: string | null };

type State = {
  loading: boolean;
  error: string | null;
  userInfo: UserInfo | null;
  conversations: Conversation[];
};

export function useIrosSidebar() {
  const [state, setState] = React.useState<State>({
    loading: true,
    error: null,
    userInfo: null,
    conversations: [],
  });

  const reload = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const auth = getAuth();
      const token = await auth.currentUser?.getIdToken().catch(() => null);
      const res = await fetch('/api/agent/iros/sidebar', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(process.env.NODE_ENV !== 'production' ? { 'X-Debug-User': '669933' } : {}),
        },
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      setState({
        loading: false,
        error: null,
        userInfo: data.userInfo ?? null,
        conversations: Array.isArray(data.conversations) ? data.conversations : [],
      });
    } catch (e: any) {
      console.error('[useIrosSidebar]', e);
      setState((s) => ({ ...s, loading: false, error: e?.message || 'load_failed' }));
    }
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  return { ...state, reload };
}
