// src/ui/iroschat/IrosAiLayout.tsx
'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { useAuth } from '@/context/AuthContext';
import styles from './index.module.css';
import LoginModal from '@/components/LoginModal';

export default function IrosAiLayout({ children }: { children: React.ReactNode }) {
  const [showLogin, setShowLogin] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const { userCode } = useAuth();
  const router = useRouter();

  const handleLogout = async () => {
    try {
      await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    } catch {
      // ignore
    } finally {
      try {
        await signOut(auth);
      } catch {}
      router.refresh();
      setShowMenu(false);
    }
  };

  return (
    <div className={styles.root}>
<>
</>

      <main className={styles.content} aria-label="Iros-AI content">
        {children}
      </main>

      <LoginModal
        isOpen={showLogin}
        onClose={() => setShowLogin(false)}
        onLoginSuccess={() => setShowLogin(false)}
      />
    </div>
  );
}
