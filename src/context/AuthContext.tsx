'use client'

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  User,
} from 'firebase/auth'
import { auth } from '@/lib/firebase'

interface AuthContextType {
  user: User | null
  userCode: string | null
  loading: boolean
  muSent: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  sendMuInfo: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  userCode: null,
  loading: true,
  muSent: false,
  login: async () => {},
  logout: async () => {},
  sendMuInfo: async () => {},
})

async function getIdTokenSafe(u: User | null) {
  try {
    if (!u) return null
    return await u.getIdToken(true)
  } catch {
    return null
  }
}

async function callAuthedApi(path: string, idToken: string, body: any = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.error || `API error: ${path}`
    throw new Error(msg)
  }
  return json
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [userCode, setUserCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [muSent, setMuSent] = useState(false)

  const ensureAndFetchUserCode = async (firebaseUser: User): Promise<string | null> => {
    const idToken = await getIdTokenSafe(firebaseUser)
    if (!idToken) return null

    try {
      await callAuthedApi('/api/login', idToken)
    } catch (e) {
      console.warn('login API warning:', e)
    }

    const status = await callAuthedApi('/api/account-status', idToken)
    const code = status?.user_code ?? null

    if (code && status?.email_verified === false) {
      try {
        await callAuthedApi('/api/verify-complete', idToken)
      } catch (e) {
        console.warn('verify-complete API warning:', e)
      }
    }
    return code
  }

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true)
      try {
        if (firebaseUser) {
          setUser(firebaseUser)
          const code = await ensureAndFetchUserCode(firebaseUser)
          setUserCode(code)
        } else {
          setUser(null)
          setUserCode(null)
        }
      } catch (e) {
        console.error('onAuthStateChanged flow error:', e)
        setUser(null)
        setUserCode(null)
      } finally {
        setLoading(false)
      }
    })
    return () => unsubscribe()
  }, [])

  // 🔹 MU送信処理（Firebaseトークン → call-mu-ai.ts経由）
  const sendMuInfo = async () => {
    if (loading || !user || muSent) {
      console.log('MU送信スキップ: 条件未達')
      return
    }

    try {
      const idToken = await getIdTokenSafe(user)
      if (!idToken) throw new Error('idToken取得失敗')

      const res = await fetch('/api/call-mu-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: idToken }),
      })

      const j2 = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j2?.error || 'MU認証API失敗')

      console.log('MU応答:', j2)
      setMuSent(true)
    } catch (e) {
      console.error('MU送信フロー失敗:', e)
    }
  }

  const login = async (email: string, password: string) => {
    setLoading(true)
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password)
      const currentUser = cred.user
      setUser(currentUser)
      const code = await ensureAndFetchUserCode(currentUser)
      setUserCode(code)
      setMuSent(false)
    } catch (error) {
      console.error('ログイン失敗:', error)
      throw error
    } finally {
      setLoading(false)
    }
  }

  const logout = async () => {
    setLoading(true)
    try {
      await signOut(auth)
      setUser(null)
      setUserCode(null)
      setMuSent(false)
      await fetch('/api/logout', { method: 'POST' })
    } catch (error) {
      console.error('ログアウト失敗:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthContext.Provider
      value={{ user, userCode, loading, muSent, login, logout, sendMuInfo }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
