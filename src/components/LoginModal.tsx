// src/components/LoginModal.tsx
'use client';

import { useState } from 'react';
import { signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { useRouter } from 'next/navigation';
import ResetPasswordModal from './ResetPasswordModal';
import EmailVerifyModal from './EmailVerifyModal';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess?: () => void;
};

export default function LoginModal({ isOpen, onClose, onLoginSuccess }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [showResetModal, setShowResetModal] = useState(false);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [loading, setLoading] = useState(false);

  const router = useRouter();

  const hardSignOut = async () => {
    try {
      await signOut(auth);
    } catch {}
  };

  const handleLogin = async () => {
    if (loading) return;
    setError('');
    setLoading(true);

    try {
      // Firebase認証
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const user = cred.user;

      await user.reload(); // ステータス最新化

      // メール未認証 → 認証案内モーダル表示
      if (!user.emailVerified) {
        setShowVerifyModal(true);
        setLoading(false);
        return;
      }

      // 常に最新の ID トークン
      const idToken = await user.getIdToken(true);

      // 1) /api/login
      const loginRes = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({}),
      });

      if (!loginRes.ok) {
        await hardSignOut();
        const j = await loginRes.json().catch(() => null);
        const code = loginRes.status;
        throw new Error(
          (j?.error && `${j.error}`) ||
            (code === 401 ? '資格情報が無効です（401）' : `サーバー認証失敗（${code}）`),
        );
      }

      // 2) /api/account-status
      const statusRes = await fetch('/api/account-status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({}),
      });

      const statusJson = await statusRes.json().catch(() => ({}));
      if (!statusRes.ok || !statusJson?.user_code) {
        await hardSignOut();
        const code = statusRes.status;
        throw new Error(
          (statusJson?.error && `${statusJson.error}`) ||
            (code === 401 || code === 403
              ? `アカウント情報取得拒否（${code}）`
              : `アカウント情報取得失敗（${code}）`),
        );
      }

      // Supabase 側のメール認証が false なら同期（任意）
      if (statusJson.email_verified === false) {
        const verifyRes = await fetch('/api/verify-complete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({}),
        });
        if (!verifyRes.ok) {
          await hardSignOut();
          const errData = await verifyRes.json().catch(() => ({}));
          throw new Error(errData.error || 'メール認証状態の同期に失敗しました');
        }
      }

      onLoginSuccess?.();
      onClose();
      router.refresh();
    } catch (err: any) {
      console.error('❌ Login Error:', err);
      setError(
        typeof err?.message === 'string'
          ? err.message
          : 'ログインに失敗しました。メールアドレスとパスワードを確認してください。',
      );
    } finally {
      setLoading(false);
    }
  };

  // 認証メール再送信 → 成功扱いで閉じる
  const handleResendAndClose = async () => {
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('ユーザー情報がありません');

      const token = await user.getIdToken();
      const res = await fetch('/api/resend-verification', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      const data = await res.json().catch(() => ({}));
      if (data?.success) {
        setShowVerifyModal(false);
        onClose();
        alert(data.message || '✅ 認証メールを送信しました。メールをご確認ください。');
        return;
      }

      if (
        data?.error?.includes('送信済み') ||
        data?.error?.includes('TOO_MANY_ATTEMPTS_TRY_LATER')
      ) {
        setShowVerifyModal(false);
        onClose();
        alert('📩 認証メールはすでに送信済みです。メールをご確認ください。');
        return;
      }

      throw new Error(data?.error || '送信失敗');
    } catch (err) {
      console.error('再送信エラー:', err);
      alert('❌ 再送信に失敗しました。しばらくしてからお試しください。');
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="modal-overlay">
        <div className="modal-content">
          <h2 className="modal-title">🔐 ログイン</h2>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleLogin();
            }}
          >
            <input
              type="email"
              placeholder="メールアドレス"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="modal-input"
              required
              disabled={loading}
              autoComplete="email"
            />
            <input
              type="password"
              placeholder="パスワード"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="modal-input"
              required
              disabled={loading}
              autoComplete="current-password"
            />

            {error && (
              <p style={{ color: 'red', fontSize: '13px', textAlign: 'center', marginTop: '6px' }}>
                {error}
              </p>
            )}

            <p className="forgot-password-link" style={{ margin: '12px 0', textAlign: 'center' }}>
              <span onClick={() => setShowResetModal(true)} style={{ cursor: 'pointer' }}>
                🔑 パスワードをお忘れですか？
              </span>
            </p>

            <div className="modal-actions">
              <button type="submit" className="modal-button login" disabled={loading}>
                {loading ? 'ログイン中…' : 'ログイン'}
              </button>
              <button
                type="button"
                className="modal-button cancel"
                onClick={() => {
                  setShowResetModal(false);
                  onClose();
                }}
                disabled={loading}
              >
                キャンセル
              </button>
            </div>
          </form>
        </div>
      </div>

      <ResetPasswordModal isOpen={showResetModal} onClose={() => setShowResetModal(false)} />

      <EmailVerifyModal
        isOpen={showVerifyModal}
        onClose={() => setShowVerifyModal(false)}
        onResend={handleResendAndClose}
      />
    </>
  );
}
