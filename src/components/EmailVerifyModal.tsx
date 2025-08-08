'use client'

import { useState } from 'react'
import { getAuth } from 'firebase/auth'
import './email-verify-modal.css'

type Props = {
  isOpen: boolean
  onClose: () => void
  onResend?: () => void // ← 追加（LoginModalから受け取れる）
}

export default function EmailVerifyModal({ isOpen, onClose, onResend }: Props) {
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)

  if (!isOpen) return null

  const handleResend = async () => {
    setSending(true)
    setMessage('')
    setError('')

    try {
      const auth = getAuth()
      const user = auth.currentUser

      if (!user) throw new Error('ユーザー情報が取得できませんでした。')

      const token = await user.getIdToken(true)

      const res = await fetch('/api/resend-verification', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })

      const data = await res.json()

      if (!res.ok) throw new Error(data.error || '送信に失敗しました')

      // 成功時メッセージ表示
      setMessage('✅ 認証メールを再送信しました。メール内のリンクから認証を完了してください。')

      // もしLoginModal側から閉じる動作を渡されていたら呼び出す
      if (onResend) {
        onResend()
      }
    } catch (err: any) {
      console.error('再送信エラー:', err)
      setError('❌ 再送信に失敗しました。しばらくしてから再試行してください。')
    }

    setSending(false)
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <h2 className="modal-title">🧾 認証が必要です</h2>
        <p className="modal-text">
          登録されたメールアドレスに<br />確認メールを送信しています。
          <br />
          メール内のリンクをクリックして<br />認証を完了してください。
        </p>

        <p className="modal-tip">
          📌 迷惑メールフォルダも確認してください。<br />
          <code>noreply@firebaseapp.com</code> <br />などの送信元となります。
        </p>

        {message && (
          <>
            <p className="modal-message success">{message}</p>
            <div style={{ marginTop: '12px', textAlign: 'center' }}>
              <button
                className="modal-button login"
                onClick={onClose}
                style={{ padding: '8px 16px', fontSize: '14px' }}
              >
                🔐 ログインへ
              </button>
            </div>
          </>
        )}

        {error && <p className="modal-message error">{error}</p>}

        {!message && (
          <div className="modal-actions">
            <button
              className="modal-button confirm"
              onClick={handleResend}
              disabled={sending}
            >
              {sending ? '送信中...' : '📩 再送信'}
            </button>
            <button className="modal-button cancel" onClick={onClose}>
              ✖️ 閉じる
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
