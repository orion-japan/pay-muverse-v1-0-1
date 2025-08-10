import { supabaseServer } from './supabaseServer'

export async function makeUserCode(): Promise<string> {
  // 6桁の数値を作り、被りがあれば再生成
  for (let i = 0; i < 10; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000))
    const { data, error } = await supabaseServer
      .from('users')
      .select('user_code')
      .eq('user_code', code)
      .limit(1)

    if (!error && (!data || data.length === 0)) return code
  }
  // 予備（衝突が続いた時）
  return String(Date.now()).slice(-6)
}
