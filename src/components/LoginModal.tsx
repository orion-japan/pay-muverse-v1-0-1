'use client'

import { useState } from 'react'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { useRouter } from 'next/navigation'
import ResetPasswordModal from './ResetPasswordModal'
import EmailVerifyModal from './EmailVerifyModal'

type Props = {
  isOpen: boolean
  onClose: () => void
  onLoginSuccess?: () => void
}

export default function LoginModal({ isOpen, onClose, onLoginSuccess }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [showResetModal, setShowResetModal] = useState(false)
  const [showVerifyModal, setShowVerifyModal] = useState(false)

  const router = useRouter()

  const handleLogin = async () => {
    setError('')
    try {
      // Firebase認証
      const userCredential = await signInWithEmailAndPassword(auth, email, password)
      const user = userCredential.user

      await user.reload() // ステータス最新化

      // メール未認証 → 認証案内モーダル表示
      if (!user.emailVerified) {
        setShowVerifyModal(true)
        return
      }

      // ✅ IDトークン取得（常に最新化）
      const idToken = await user.getIdToken(true)

      // Firebase認証サーバー登録
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      })
      if (!res.ok) throw new Error('サーバー認証失敗')

      // ✅ account-status に Authorization ヘッダーを付けて呼び出し
      const userRes = await fetch('/api/account-status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({}),
      })

      const data = await userRes.json()
      if (!userRes.ok || !data.user_code) throw new Error('user_code取得失敗')

      // Supabase側のemail_verifiedがfalseなら同期（安全版）
      if (data.email_verified === false) {
        const verifyRes = await fetch('/api/verify-complete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${idToken}`,
          },
          body: JSON.stringify({}),
        })
        if (!verifyRes.ok) {
          const errData = await verifyRes.json().catch(() => ({}))
          throw new Error(errData.error || 'メール認証同期に失敗しました')
        }
      }

      onLoginSuccess?.()
      onClose()
    } catch (err) {
      console.error('❌ Login Error:', err)
      setError('ログインに失敗しました。メールアドレスとパスワードを確認してください。')
    }
  }

  // 🔹 認証メール再送信 → モーダル閉じる処理を追加
  const handleResendAndClose = async () => {
    try {
      const user = auth.currentUser
      if (!user) throw new Error('ユーザー情報がありません')

      const token = await user.getIdToken()
      const res = await fetch('/api/resend-verification', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '送信失敗')

      // 成功 → モーダルを閉じてログイン画面へ戻す
      setShowVerifyModal(false)
      onClose()
      alert('✅ 認証メールを再送信しました。メールをご確認ください。')
    } catch (err) {
      console.error('再送信エラー:', err)
      alert('❌ 再送信に失敗しました。しばらくしてからお試しください。')
    }
  }

  if (!isOpen) return null

  return (
    <>
      <div className="modal-overlay">
        <div className="modal-content">
          <h2 className="modal-title">🔐 ログイン</h2>

          <form onSubmit={(e) => { e.preventDefault(); handleLogin() }}>
            <input
              type="email"
              placeholder="メールアドレス"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="modal-input"
              required
            />
            <input
              type="password"
              placeholder="パスワード"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="modal-input"
              required
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
              <button type="submit" className="modal-button login">ログイン</button>
              <button
                type="button"
                className="modal-button cancel"
                onClick={() => {
                  setShowResetModal(false)
                  onClose()
                }}
              >
                キャンセル
              </button>
            </div>
          </form>
        </div>
      </div>

      <ResetPasswordModal
        isOpen={showResetModal}
        onClose={() => setShowResetModal(false)}
      />

      {/* 再送信時に即閉じるバージョン */}
      <EmailVerifyModal
        isOpen={showVerifyModal}
        onClose={() => setShowVerifyModal(false)}
        onResend={handleResendAndClose}
      />
    </>
  )
}
