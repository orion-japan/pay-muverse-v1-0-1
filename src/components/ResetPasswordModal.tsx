'use client'
import { useState } from 'react'
import '../styles/loginmodal.css'
import { sendPasswordResetEmail } from 'firebase/auth'
import { auth } from '@/lib/firebase' // ✅ これが必要です


type Props = {
  isOpen: boolean
  onClose: () => void
}

export default function ResetPasswordModal({ isOpen, onClose }: Props) {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [isSent, setIsSent] = useState(false) // ✅ 送信後フラグ

  const handleReset = async () => {
    setMessage('')
    setError('')

    if (!email.includes('@')) {
      setError('有効なメールアドレスを入力してください')
      return
    }

    try {
      await sendPasswordResetEmail(auth, email)
      setMessage('📩 パスワード再設定メールを送信しました。メールをご確認ください。')
      setIsSent(true) // ✅ 送信済みに変更
    } catch (err: any) {
      console.error('❌ パスワード再設定エラー:', err)
      if (err.code === 'auth/user-not-found') {
        setError('このメールアドレスは登録されていません')
      } else {
        setError('再設定に失敗しました。メールアドレスを確認してください')
      }
    }
  }

  if (!isOpen) return null

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h2 className="modal-title">🔑 パスワード再発行</h2>
        <p style={{ fontSize: '13px', textAlign: 'center', marginBottom: '10px' }}>
          登録されたメールアドレスを入力してください。
        </p>

        <input
          type="email"
          placeholder="メールアドレス"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="modal-input"
        />

        {error && <p style={{ color: 'red', fontSize: '13px' }}>{error}</p>}
        {message && <p style={{ color: 'green', fontSize: '13px' }}>{message}</p>}

        <div className="modal-actions">
          {!isSent && (
            <button type="button" onClick={handleReset} className="modal-button login">
              送信
            </button>
          )}
          <button type="button" onClick={onClose} className="modal-button cancel">
            {isSent ? 'OK' : 'キャンセル'} {/* ✅ ラベル切り替え */}
          </button>
        </div>
      </div>
    </div>
  )
}
