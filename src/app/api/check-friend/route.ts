import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

if (!getApps().length) initializeApp()

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const target = searchParams.get('target')
    const type = searchParams.get('type') // S, F, R, C, I など

    if (!target) return NextResponse.json({ error: 'No target' }, { status: 400 })

    const authHeader = req.headers.get('authorization')
    if (!authHeader) return NextResponse.json({ error: 'No token' }, { status: 401 })
    const token = authHeader.replace('Bearer ', '')
    const decoded = await getAuth().verifyIdToken(token)
    const myCode = decoded.user_code || decoded.uid

    // 自分 → 相手（指定のship_type）
    const { data: d1, error: e1 } = await supabase
      .from('follows')
      .select('ship_type')
      .eq('follower_code', myCode)
      .eq('following_code', target)
      .maybeSingle()

    if (e1) throw e1

    // 相手 → 自分（指定のship_type）
    const { data: d2, error: e2 } = await supabase
      .from('follows')
      .select('ship_type')
      .eq('follower_code', target)
      .eq('following_code', myCode)
      .maybeSingle()

    if (e2) throw e2

    // 両者が存在し、同じship_typeであるかを確認
    const isFriend =
      d1?.ship_type && d2?.ship_type && d1.ship_type === d2.ship_type && (!type || d1.ship_type === type)

    return NextResponse.json({
      friend: isFriend ? true : false,
      ship_type: isFriend ? d1.ship_type : null,
    })
  } catch (e: any) {
    console.error('[check-friend] error', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
