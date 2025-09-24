// src/hooks/useCurrentUser.ts
'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

export type SofCurrentUser = {
  id: string;               // user_code or auth uid
  name: string;
  userType: string;
  credits: number;
  avatarUrl?: string | null;  // ← MessageList が読むのはコレ
};

/**
 * userCode で紐づけ（なければ auth.uid で紐づけ）して profiles から name / avatar_url を取得
 */
export function useCurrentUser(opts?: { userCode?: string }) {
  const supabase = useMemo(() => createClientComponentClient(), []);
  const [user, setUser] = useState<SofCurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);

      // 1) auth セッション（必要なら）
      const { data: sess } = await supabase.auth.getSession();
      const authUid = sess?.session?.user?.id ?? null;

      // 2) profiles を取得（user_code 優先、なければ auth uid カラムがあればそちら）
      const userCode = opts?.userCode ?? null;

      // user_code で検索する場合
      let prof = null as null | { name?: string | null; avatar_url?: string | null; user_code?: string };

      if (userCode) {
        const { data } = await supabase
          .from('profiles')
          .select('name, avatar_url, user_code')
          .eq('user_code', userCode)
          .single();
        prof = data ?? null;
      } else if (authUid) {
        // ※ プロジェクトに user_id 等のカラムがある場合はこちら
        const { data } = await supabase
          .from('profiles')
          .select('name, avatar_url')
          .eq('user_id', authUid) // ← スキーマに合わせて調整
          .maybeSingle();
        prof = data ?? null;
      }

      if (!alive) return;

      const id = userCode ?? authUid ?? 'guest';
      setUser({
        id,
        name: prof?.name ?? 'user',
        userType: 'member',
        credits: 0,
        avatarUrl: prof?.avatar_url ?? null, // ★ ここが肝
      });
      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [supabase, opts?.userCode]);

  return { user, loading };
}
