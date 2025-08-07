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
import { supabase } from '@/lib/supabase'

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

  // ✅ Supabaseから user_code を取得する関数（firebase_uidを使用）
  const fetchUserCode = async (uid: string) => {
    const { data, error } = await supabase
      .from('users')
      .select('user_code')
      .eq('firebase_uid', uid) // ← 修正ポイント
      .single()

    if (error || !data?.user_code) {
      console.error('❌ user_code の取得失敗:', error)
      return null
    }
    return data.user_code
  }

  // ✅ Firebaseの認証状態を常に監視
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true)
      if (firebaseUser) {
        setUser(firebaseUser)
        const code = await fetchUserCode(firebaseUser.uid)
        setUserCode(code)
      } else {
        setUser(null)
        setUserCode(null)
      }
      setLoading(false)
    })

    return () => unsubscribe()
  }, [])

  // 🔐 ログイン処理（モーダル連携対応）
  const login = async (email: string, password: string) => {
    setLoading(true)
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password)
      const currentUser = userCredential.user
      setUser(currentUser)

      const code = await fetchUserCode(currentUser.uid)
      setUserCode(code)
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
