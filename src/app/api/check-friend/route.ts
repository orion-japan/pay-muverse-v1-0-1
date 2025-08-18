// src/app/api/check-friend/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth } from 'firebase-admin/auth'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const target = searchParams.get('target')
    if (!target) return NextResponse.json({ error: 'No target' }, { status: 400 })

    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'No token' }, { status: 401 })
    const token = authHeader.replace('Bearer ', '')
    const decoded = await getAuth().verifyIdToken(token)
    const myCode = decoded.user_code || decoded.uid

    // 自分 → 相手
    const { data: d1, error: e1 } = await supabase
      .from('follows')
      .select('id')
      .eq('follower_code', myCode)
      .eq('following_code', target)
      .maybeSingle()

    if (e1) throw e1

    // 相手 → 自分
    const { data: d2, error: e2 } = await supabase
      .from('follows')
      .select('id')
      .eq('follower_code', target)
      .eq('following_code', myCode)
      .maybeSingle()

    if (e2) throw e2

    return NextResponse.json({
      friend: d1 && d2 ? true : false,
    })
  } catch (e: any) {
    console.error('[check-friend] error', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
