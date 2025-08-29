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
      .select('date,event_id')
      .gte('date', from)
      .lte('date', to)
      .eq('user_code', user_code)
      .order('date', { ascending: true })

    if (error) throw error

    // 集計：dateごとにイベント配列
    const map = new Map<string, Set<string>>()
    for (const row of data ?? []) {
      const d = row.date
      const set = map.get(d) ?? new Set<string>()
      set.add(row.event_id)
      map.set(d, set)
    }

    const list = Array.from(map.entries()).map(([date, set]) => ({
      date,
      events: Array.from(set).sort(), // ['ainori','kyomeikai'] など
    }))

    return NextResponse.json(list)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'days failed' }, { status: 500 })
  }
}
