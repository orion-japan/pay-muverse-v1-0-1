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
// import { supabase } from '@/lib/supabase'  // ← 直接参照はやめる（RLSで詰まるため）

// 🔐 Context型定義
interface AuthContextType {
  user: User | null
  userCode: string | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

// 🧱 Context初期値
const AuthContext = createContext<AuthContextType>({
  user: null,
  userCode: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
})

// 共通：最新IDトークン取得（失敗時はnull）
async function getIdTokenSafe(u: User | null) {
  try {
    if (!u) return null
    // trueで強制リフレッシュ（権限の取りこぼし防止）
    return await u.getIdToken(true)
  } catch {
    return null
  }
}

// 共通：API呼び出し（Authorization付与）
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

// 🌱 Provider定義
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [userCode, setUserCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // ✅ サーバー経由で user_code を取得（必要なら登録も）
  const ensureAndFetchUserCode = async (firebaseUser: User): Promise<string | null> => {
    const idToken = await getIdTokenSafe(firebaseUser)
    if (!idToken) return null

    // 1) ログイン（サーバー側でユーザー行をUPSERTする想定）
    try {
      await callAuthedApi('/api/login', idToken)
    } catch (e) {
      // すでに存在している等で失敗しても、次のステップで判定するので警告のみ
      console.warn('login API warning:', e)
    }

    // 2) アカウント状態取得（ここで user_code を受け取る）
    const status = await callAuthedApi('/api/account-status', idToken)
    const code = status?.user_code ?? null

    // 3)（任意）メール認証の同期
    if (code && status?.email_verified === false) {
      try {
        await callAuthedApi('/api/verify-complete', idToken)
      } catch (e) {
        console.warn('verify-complete API warning:', e)
      }
    }

    return code
  }

  // ✅ Firebaseの認証状態を常に監視（自動ログイン/復帰）
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
        // ユーザー情報はクリアしておく
        setUser(null)
        setUserCode(null)
      } finally {
        setLoading(false)
      }
    })

    return () => unsubscribe()
  }, [])

  // 🔐 ログイン処理（構造維持：戻り値や引数はそのまま）
  const login = async (email: string, password: string) => {
    setLoading(true)
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password)
      const currentUser = cred.user
      setUser(currentUser)

      // サーバー経由で確実に user_code を取得（未登録ならUPSERT）
      const code = await ensureAndFetchUserCode(currentUser)
      setUserCode(code)
    } catch (error) {
      console.error('ログイン失敗:', error)
      throw error
    } finally {
      setLoading(false)
    }
  }

  // 🔐 ログアウト処理（構造維持）
  const logout = async () => {
    setLoading(true)
    try {
      await signOut(auth)
      setUser(null)
      setUserCode(null)
    } catch (error) {
      console.error('ログアウト失敗:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthContext.Provider
      value={{ user, userCode, loading, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// ✅ 利用フック（構造維持）
export const useAuth = () => useContext(AuthContext)
