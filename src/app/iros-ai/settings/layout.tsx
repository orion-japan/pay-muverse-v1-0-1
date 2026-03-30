'use client';

import { useEffect, useState } from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import LoginModal from '@/components/LoginModal';

export default function IrosSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    document.body.classList.add('page-iros-settings');
    document.body.setAttribute('data-iros', 'true');

    return () => {
      document.body.classList.remove('page-iros-settings');
      document.body.removeAttribute('data-iros');
    };
  }, []);

  return (
    <>
      <Header onLoginClick={() => setShowLogin(true)} />
      <main className="iros-settings-main">{children}</main>
      <Footer />
      <LoginModal
        isOpen={showLogin}
        onClose={() => setShowLogin(false)}
        onLoginSuccess={() => setShowLogin(false)}
      />
    </>
  );
}
