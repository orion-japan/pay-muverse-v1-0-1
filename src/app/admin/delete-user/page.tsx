'use client'

import { useState } from 'react'

type UserInfo = {
  user_code: string
  click_email: string | null
  firebase_uid: string | null
  plan_status: string | null
  email_verified: boolean
  payjp_customer_id?: string | null // 取得だけ（削除はしない）
}

export default function DeleteUserPage() {
  const [userCode, setUserCode] = useState('')
  const [user, setUser] = useState<UserInfo | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function fetchUser() {
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch(`/api/admin/fetch-user?user_code=${userCode}`)
      const data = await res.json()
      if (data.ok) {
        setUser(data.user)
      } else {
        setUser(null)
        setResult(data.error)
      }
    } catch (err) {
      setResult(`Error: ${err}`)
    } finally {
      setLoading(false)
    }
  }

  async function deleteUser() {
    if (!user) return
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch('/api/admin/delete-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: user.user_code }),
      })
      const data = await res.json()
      setResult(JSON.stringify(data, null, 2))
      setUser(null)
    } catch (err) {
      setResult(`Error: ${err}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: 20 }}>
      <h1>ユーザー削除（管理者用）</h1>
      <p>ユーザーコードを入力 → 取得 → 確認して削除します。</p>

      <input
        type="text"
        placeholder="ユーザーコード"
        value={userCode}
        onChange={(e) => setUserCode(e.target.value)}
        style={{ width: '100%', padding: 8, marginBottom: 12 }}
      />
      <button onClick={fetchUser} disabled={loading}>
        {loading ? '取得中...' : '取得'}
      </button>

      {user && (
        <div style={{ marginTop: 20, padding: 10, border: '1px solid #ccc' }}>
          <h3>確認情報</h3>
          <p><b>user_code:</b> {user.user_code}</p>
          <p><b>email:</b> {user.click_email}</p>
          <p><b>firebase_uid:</b> {user.firebase_uid ?? '(なし)'}</p>
          <p><b>plan_status:</b> {user.plan_status}</p>
          <p><b>email_verified:</b> {user.email_verified ? '✅' : '❌'}</p>
          <p><b>payjp_customer_id:</b> {user.payjp_customer_id ?? '(なし)'}</p>

          <button
            onClick={deleteUser}
            style={{ marginTop: 20, background: 'red', color: 'white', padding: '8px 12px' }}
          >
            削除する
          </button>
        </div>
      )}

      {result && (
        <pre
          style={{
            background: '#f5f5f5',
            padding: 10,
            marginTop: 20,
            whiteSpace: 'pre-wrap',
          }}
        >
          {result}
        </pre>
      )}
    </main>
  )
}
