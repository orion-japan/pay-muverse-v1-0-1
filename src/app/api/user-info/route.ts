import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // ← server-only
)

export async function POST(req: Request) {
  try {
    const { user_code } = await req.json()
    if (!user_code) return NextResponse.json({ error: 'user_code required' }, { status: 400 })

    const { data, error } = await supabase
      .from('users')
      .select('click_username, click_type')
      .eq('user_code', user_code)
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({}, { status: 404 })

    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'unknown' }, { status: 500 })
  }
}
