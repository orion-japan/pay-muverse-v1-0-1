import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const user_code = req.nextUrl.searchParams.get('user_code')
  if (!user_code) {
    return NextResponse.json({ ok: false, error: 'user_code is required' }, { status: 400 })
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('user_code, click_email, firebase_uid, plan_status, email_verified, payjp_customer_id')
    .eq('user_code', user_code)
    .single()

  if (error || !user) {
    return NextResponse.json({ ok: false, error: 'User not found' }, { status: 404 })
  }

  return NextResponse.json({ ok: true, user })
}
