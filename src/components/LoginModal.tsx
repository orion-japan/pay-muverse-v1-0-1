'use client';
import { useState } from 'react';
import { auth } from '@/lib/firebase';
import { signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import GenericModal from './modals/GenericModal';

export default function LoginModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isClosing, setIsClosing] = useState(false); // ✅ 閉じるアニメーション管理

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      setIsClosing(false);
      onClose(); // ✅ 完全に消す
    }, 300); // ✅ CSSアニメーションの時間と合わせる
  };

  const handleEmailLogin = async () => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
      handleClose(); // ✅ 成功時にふわっと閉じる
    } catch (err: any) {
      setError('メールまたはパスワードが間違っています');
    }
  };

  const handleGoogleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      handleClose(); // ✅ Googleログインも同じく
    } catch (err: any) {
      setError('Googleログインに失敗しました');
    }
  };

  return (
    <GenericModal
      isOpen={isOpen}
      title="ログイン"
      onCancel={handleClose}            // ✅ 閉じるボタンもフェードアウト経由
      onConfirm={handleEmailLogin}
      confirmLabel="メールでログイン"
      cancelLabel="閉じる"
    >
      <div className={`modal-content-inner ${isClosing ? 'closing' : ''}`}>
        <input
          className="w-full p-2 border rounded mb-2"
          placeholder="メールアドレス"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="w-full p-2 border rounded mb-2"
          placeholder="パスワード"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-red-500 text-sm">{error}</p>}

        <div className="flex items-center my-4">
          <div className="flex-grow h-px bg-gray-300"></div>
          <span className="px-2 text-gray-500 text-sm">または</span>
          <div className="flex-grow h-px bg-gray-300"></div>
        </div>

        <button
          className="flex items-center justify-center gap-2 border rounded p-2 w-full hover:bg-gray-50"
          onClick={handleGoogleLogin}
        >
          <img src="/google-icon.svg" alt="Google" className="w-5 h-5" />
          Googleでログイン
        </button>
      </div>

      <style jsx>{`
        .modal-content-inner {
          transition: all 0.3s ease;
          transform: scale(1);
          opacity: 1;
        }
        .modal-content-inner.closing {
          transform: scale(0.9);
          opacity: 0;
        }
      `}</style>
    </GenericModal>
  );
}
