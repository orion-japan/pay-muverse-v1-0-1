'use client';

import { useEffect } from 'react';
import { auth } from '@/lib/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';

export default function AuthExpose() {
  useEffect(() => {
    // ① auth を覗けるようにする（デバッグ用）
    (window as any).auth = auth;

    // ② トークン取得ヘルパ（未ログインでも待ち合わせて取得）
    (window as any).__getIdToken = async (force = true): Promise<string | null> => {
      const user: User | null =
        auth.currentUser ??
        (await new Promise<User | null>((resolve) => {
          const off = onAuthStateChanged(auth, (u) => {
            off();
            resolve(u);
          });
        }));

      if (!user) {
        console.log('未ログインです');
        return null;
      }
      const token = await user.getIdToken(force);
      console.log('ID_TOKEN:', token);
      return token;
    };
  }, []);

  return null;
}
