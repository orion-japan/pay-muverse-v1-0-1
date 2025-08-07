'use client'
import { useState } from 'react'
import '../styles/loginmodal.css'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { useRouter } from 'next/navigation'

type Props = {
  isOpen: boolean
  onClose: () => void
  onLoginSuccess?: () => void
}

export default function LoginModal({ isOpen, onClose, onLoginSuccess }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const router = useRouter()

  const handleLogin = async () => {
    try {
      // ✅ Firebaseでログイン
      const userCredential = await signInWithEmailAndPassword(auth, email, password)
      const idToken = await userCredential.user.getIdToken()
      const firebaseUid = userCredential.user.uid

      // ✅ サーバーへIDトークン送信
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      })
      if (!res.ok) throw new Error('サーバー認証失敗')

      // ✅ Supabaseから user_code を取得（firebase_uid で検索）
      const userRes = await fetch('/api/account-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firebase_uid: firebaseUid }),
      })
      const data = await userRes.json()
      if (!userRes.ok || !data.user_code) throw new Error('user_code取得失敗')

            onLoginSuccess?.()
      onClose()
    } catch (err) {
      console.error('❌ Login Error:', err)
      setError('通信エラーが発生しました')
    }
  }

  if (!isOpen) return null

  return (
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

          {error && <p style={{ color: 'red', fontSize: '13px' }}>{error}</p>}

          <div className="modal-actions">
            <button type="submit" className="modal-button login">ログイン</button>
            <button type="button" onClick={onClose} className="modal-button cancel">キャンセル</button>
          </div>
        </form>
      </div>
    </div>
  )
}
