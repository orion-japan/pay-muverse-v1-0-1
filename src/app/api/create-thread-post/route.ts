// src/app/api/get-current-user/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabaseClient'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const user_code = body?.user_code as string | undefined

    if (!user_code) {
      // 400 の主因だったので明示
      return NextResponse.json({ error: 'user_code is required' }, { status: 400 })
    }

    // users から表示名など
    const { data: userRow, error: uerr } = await supabase
      .from('users')
      .select('user_code, click_username')
      .eq('user_code', user_code)
      .maybeSingle()

    if (uerr) {
      console.error('[get-current-user] users fetch error:', uerr)
      return NextResponse.json({ error: 'users fetch failed' }, { status: 500 })
    }

    // profiles から avatar_url
    const { data: profRow, error: perr } = await supabase
      .from('profiles')
      .select('user_code, avatar_url')
      .eq('user_code', user_code)
      .maybeSingle()

    if (perr) {
      console.error('[get-current-user] profiles fetch error:', perr)
      return NextResponse.json({ error: 'profiles fetch failed' }, { status: 500 })
    }

    return NextResponse.json({
      user_code,
      click_username: userRow?.click_username ?? null,
      avatar_url: profRow?.avatar_url ?? null,
    })
  } catch (e) {
    console.error('[get-current-user] unexpected:', e)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
