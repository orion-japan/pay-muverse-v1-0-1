import { supabase } from '@/lib/supabase'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' })
  }

  const { email, password } = await req.body

  // ✅ Supabase 認証確認
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('click_email', email)
    .eq('Password', password)
    .single()

  if (error || !data) {
    return res.status(401).json({ success: false, message: 'メールまたはパスワードが間違っています' })
  }

  return res.status(200).json({ success: true, user: data })
}
