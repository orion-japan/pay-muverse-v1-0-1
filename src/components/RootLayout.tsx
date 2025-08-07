// src/context/AuthContext.tsx
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

// 🌱 Provider定義
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [userCode, setUserCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // ✅ Firebaseの認証状態を常に監視
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser)
      setUserCode(firebaseUser?.uid ?? null) // UIDをコードとして利用
      setLoading(false)
    })

    return () => unsubscribe()
  }, [])

  // 🔐 ログイン処理
  const login = async (email: string, password: string) => {
    setLoading(true)
    try {
      await signInWithEmailAndPassword(auth, email, password)
      // 認証成功後は自動で onAuthStateChanged が反応
    } catch (error) {
      console.error('ログイン失敗:', error)
      throw error
    } finally {
      setLoading(false)
    }
  }

  // 🔐 ログアウト処理
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

// ✅ 利用フック
export const useAuth = () => useContext(AuthContext)
