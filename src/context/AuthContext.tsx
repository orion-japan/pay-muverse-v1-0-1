'use client';
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { auth } from '@/lib/firebase';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import { supabase } from '@/lib/supabase';

type AuthContextType = {
  user: User | null;
  userCode: string | null;    // ✅ Mu_AI などで使う
  loading: boolean;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);

      if (firebaseUser?.email) {
        // ✅ Supabase から user_code を取得
        const { data, error } = await supabase
          .from('users')
          .select('user_code')
          .eq('click_email', firebaseUser.email)
          .single();

        if (error) {
          console.error('❌ Supabaseから user_code 取得失敗:', error);
          setUserCode(null);
        } else {
          console.log('✅ Supabase user_code:', data?.user_code);
          setUserCode(data?.user_code || null);
        }
      } else {
        setUserCode(null);
      }
    });

    return () => unsubscribe();
  }, []);

  const logout = async () => {
    await signOut(auth);
    setUserCode(null);
  };

  return (
    <AuthContext.Provider value={{ user, userCode, loading, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
