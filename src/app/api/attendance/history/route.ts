import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const from = searchParams.get('from') || ''
    const to = searchParams.get('to') || ''
    const user_code = searchParams.get('user_code') || ''

    if (!from || !to || !user_code) {
      return NextResponse.json({ error: 'from, to, user_code required' }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin
      .from('attendance')
      .select('date,event_id,title')
      .gte('date', from)
      .lte('date', to)
      .eq('user_code', user_code)
      .order('date', { ascending: true })

    if (error) throw error
    return NextResponse.json(data ?? [])
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'history failed' }, { status: 500 })
  }
}
